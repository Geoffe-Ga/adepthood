"""Tests for ``backend/scripts/content_completeness.py`` (issue #3070).

The served Course is the manifest's chapters, stage intros and site resources.
Wave 33 proved that tree is byte-identical to its pinned upstream commit
(``sync_content --check``) and that the stage correspondence is generated from
it (``build_stage_correspondence --check``). Neither proves the tree is
*complete*: a heading-only chapter or a skipped chapter number passes both.

Every detector here is pointed at the real vendored tree (where it must agree
exactly with the reviewed ``content_gaps.json`` record) and at a deliberately
violating fixture tree under ``tmp_path`` (where it must fire). A detector
never observed to fire is not known to be one.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from scripts.content_completeness import (
    CHECKS,
    GAPS_PATH,
    MIN_CHAPTER_WORDS,
    NOT_A_BIBLIOGRAPHY,
    PRACTICES_PATH,
    SOURCES_PATH,
    STAGE_COUNT,
    WAIVABLE_KINDS,
    ContentCompletenessError,
    Corpus,
    Finding,
    Gap,
    audit,
    body_word_count,
    build_practice_recommendations,
    build_source_references,
    gate,
    heading_slug,
    heading_slugs,
    load_corpus,
    load_gaps,
    main,
    render,
)
from scripts.sync_content import CONTENT_VERSION_FILE

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_REAL_CONTENT = _BACKEND_DIR / "content"
_FIXTURE_SHA = "a" * 40
_BODY = " ".join(["word"] * MIN_CHAPTER_WORDS)

#: The real tree's thin chapters and numbering gaps on the pinned commit.
_REAL_THIN = {"teal-7", "orange-7"}
_REAL_NUMBERING = {"1:12"}
_REAL_PRACTICE_COUNT = 38


# --- fixture trees ------------------------------------------------------------


@dataclass
class Tree:
    """A minimal served-content tree: a manifest, its markdown and a version stamp."""

    root: Path
    manifest: dict[str, Any]

    def write(self, relative: str, text: str) -> Path:
        """Write ``text`` at ``relative`` under the content root."""
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def append(self, relative: str, text: str) -> None:
        """Append ``text`` to an existing file under the content root."""
        path = self.root / relative
        path.write_text(path.read_text(encoding="utf-8") + text, encoding="utf-8")

    def add_chapter(self, stage: int, chapter: int, body: str = _BODY, **extra: str) -> str:
        """Add a served chapter and return its markdown path."""
        relative = f"markdown/{stage:02d}/{chapter:02d}-c.md"
        self.write(relative, f"---\ntitle: x\n---\n# Chapter {chapter}\n\n{body}\n")
        entry: dict[str, Any] = {
            "id": f"s{stage}-{chapter}",
            "stage": stage,
            "chapter": chapter,
            "slug": f"c-{chapter}",
            "title": f"Chapter {chapter}",
            "path": relative,
        }
        entry.update(extra)
        self.manifest["chapters"].append(entry)
        return relative

    def save(self) -> None:
        """Persist the manifest."""
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def corpus(self) -> Corpus:
        """Persist and load the tree the way the gate does."""
        self.save()
        return load_corpus(self.root)


def _healthy_tree(root: Path) -> Tree:
    """Return a tree every check accepts: one intro and one chapter per stage."""
    tree = Tree(root, {"chapters": [], "stage_intros": [], "site_resources": []})
    for stage in range(1, STAGE_COUNT + 1):
        path = tree.add_chapter(stage, 1)
        # Upstream points every stage intro at the stage's chapter-1 file.
        tree.manifest["stage_intros"].append(
            {"stage": stage, "id": f"s{stage}-intro", "slug": f"s{stage}-i", "path": path}
        )
    tree.write("markdown/resources/about.md", "# About\n\nSee [Ref](https://example.org/a).\n")
    tree.manifest["site_resources"].append({"slug": "about", "path": "markdown/resources/about.md"})
    tree.write(CONTENT_VERSION_FILE, f"sha: {_FIXTURE_SHA}\ndigest: sha256:{'b' * 64}\n")
    tree.save()
    return tree


_FIRST = "markdown/01/01-c.md"


def _without_stage_8_intro(tree: Tree) -> None:
    tree.manifest["stage_intros"] = [i for i in tree.manifest["stage_intros"] if i["stage"] != 8]


def _duplicate_chapter_id(tree: Tree) -> None:
    tree.add_chapter(1, 2, id="s1-1")


def _thin_first_chapter(tree: Tree) -> None:
    tree.write(_FIRST, "# Heading only\n")


def _skip_chapter_two(tree: Tree) -> None:
    tree.add_chapter(1, 3)


def _missing_image(tree: Tree) -> None:
    tree.append(_FIRST, "\n![](../images/missing.png)\n")


def _dangling_anchor(tree: Tree) -> None:
    tree.append(_FIRST, "\n[jump](#nowhere)\n")


def _plain_http(tree: Tree) -> None:
    tree.append(_FIRST, "\n[site](http://example.org/)\n")


def _google_wrapper(tree: Tree) -> None:
    tree.append(_FIRST, "\n[site](https://www.google.com/url?q=https://example.org)\n")


#: One deliberately violating mutation per registered check.
VIOLATING_FIXTURES: dict[str, Callable[[Tree], None]] = {
    "stage_coverage": _without_stage_8_intro,
    "duplicate_ref": _duplicate_chapter_id,
    "thin_chapter": _thin_first_chapter,
    "numbering_gap": _skip_chapter_two,
    "broken_relative_link": _missing_image,
    "broken_anchor": _dangling_anchor,
    "insecure_external_link": _plain_http,
    "redirect_wrapper_link": _google_wrapper,
}


def _kinds(findings: list[Finding], kind: str) -> list[Finding]:
    return [finding for finding in findings if finding.kind == kind]


@pytest.fixture
def tree(tmp_path: Path) -> Tree:
    """A healthy fixture tree rooted at ``tmp_path / content``."""
    return _healthy_tree(tmp_path / "content")


@pytest.fixture(scope="module")
def real() -> Corpus:
    """The vendored Course, loaded once."""
    return load_corpus(_REAL_CONTENT)


# --- every check fires, and the healthy fixture is clean ------------------------


def test_the_healthy_fixture_has_no_findings(tree: Tree) -> None:
    """Each violating fixture below fails because of its mutation, not the builder."""
    assert audit(tree.corpus()) == []


def test_every_registered_check_has_a_violating_fixture(tmp_path: Path) -> None:
    """A check with no fixture that makes it fire could ship vacuous."""
    assert set(VIOLATING_FIXTURES) == set(CHECKS)
    for kind, violate in VIOLATING_FIXTURES.items():
        tree = _healthy_tree(tmp_path / kind)
        violate(tree)
        assert _kinds(audit(tree.corpus()), kind), kind


# --- stage coverage and identity ------------------------------------------------


def test_every_stage_has_exactly_one_intro_and_a_chapter(real: Corpus, tree: Tree) -> None:
    """Stages 1..10 each have one intro and at least one chapter."""
    assert CHECKS["stage_coverage"](real) == []

    _without_stage_8_intro(tree)
    missing_intro = CHECKS["stage_coverage"](tree.corpus())
    assert [(f.kind, f.key) for f in missing_intro] == [("stage_coverage", "8")]

    tree.manifest["chapters"] = [c for c in tree.manifest["chapters"] if c["stage"] != 7]
    without_chapters = CHECKS["stage_coverage"](tree.corpus())
    assert [f.key for f in without_chapters] == ["7", "8"]
    assert "no chapters" in without_chapters[0].detail


def test_a_second_intro_and_an_out_of_range_stage_are_reported(tree: Tree) -> None:
    """Exactly one intro, and no stage outside 1..STAGE_COUNT."""
    tree.manifest["stage_intros"].append(
        {"stage": 2, "id": "extra", "slug": "extra", "path": _FIRST}
    )
    tree.add_chapter(STAGE_COUNT + 1, 1)
    findings = CHECKS["stage_coverage"](tree.corpus())
    assert [f.key for f in findings] == ["2", str(STAGE_COUNT + 1)]
    assert "2 stage intros" in findings[0].detail
    assert "outside" in findings[1].detail


def test_duplicate_ids_and_slugs_are_reported(tree: Tree) -> None:
    """Chapter ids, per-stage chapter slugs, intro ids and resource slugs are unique."""
    tree.add_chapter(1, 2, id="s1-1")
    tree.add_chapter(2, 2, slug="c-1")
    tree.manifest["stage_intros"][1]["id"] = "s1-intro"
    tree.manifest["site_resources"].append({"slug": "about", "path": "markdown/01/01-c.md"})
    keys = {f.key for f in CHECKS["duplicate_ref"](tree.corpus())}
    assert keys == {
        "chapter-id:s1-1",
        "chapter-slug:2/c-1",
        "intro-id:s1-intro",
        "resource-slug:about",
    }


def test_the_same_slug_in_two_stages_is_not_a_duplicate(tree: Tree) -> None:
    """Slugs are unique per stage only, so every stage may have its ``c-1``."""
    assert CHECKS["duplicate_ref"](tree.corpus()) == []


# --- thin chapters ------------------------------------------------------------------


def test_thin_chapters_on_vendored_tree_are_exactly_teal_7_and_orange_7(real: Corpus) -> None:
    """teal-7 is heading-only and orange-7 is 29 words; nothing else is under the floor."""
    assert {f.key for f in CHECKS["thin_chapter"](real)} == _REAL_THIN


def test_thin_threshold_boundary(tree: Tree) -> None:
    """Under the floor is thin, the floor itself is not; frontmatter and headings never count."""
    short = " ".join(["w"] * (MIN_CHAPTER_WORDS - 1))
    tree.write(_FIRST, f"---\ntitle: many frontmatter words here\n---\n# A long heading\n{short}\n")
    findings = CHECKS["thin_chapter"](tree.corpus())
    assert [(f.key, f.detail) for f in findings] == [
        ("s1-1", f"{MIN_CHAPTER_WORDS - 1} body words, under {MIN_CHAPTER_WORDS}")
    ]
    tree.append(_FIRST, "w\n")
    assert CHECKS["thin_chapter"](tree.corpus()) == []


def test_body_word_count_excludes_frontmatter_and_headings() -> None:
    """The count grades the prose a reader is served, not its labels."""
    text = "---\ntitle: a b c\n---\n# One two\n## Three\nfour five\n  ### six\n#tag seven\n"
    assert body_word_count(text) == 4


# --- numbering ------------------------------------------------------------------------


def test_numbering_gaps_on_vendored_tree_are_exactly_1_12(real: Corpus) -> None:
    """Beige skips chapter 12; every other stage is contiguous from 1."""
    assert {f.key for f in CHECKS["numbering_gap"](real)} == _REAL_NUMBERING


def test_missing_and_duplicate_chapter_numbers_are_reported(tree: Tree) -> None:
    """Chapters 1, 2, 4 miss 3; two chapter 3s elsewhere are a duplicate."""
    tree.add_chapter(1, 2)
    tree.add_chapter(1, 4)
    tree.add_chapter(2, 2)
    tree.add_chapter(2, 3)
    tree.add_chapter(2, 3, id="s2-3b", slug="c-3b")
    findings = CHECKS["numbering_gap"](tree.corpus())
    assert [(f.key, f.detail) for f in findings] == [
        ("1:3", "chapter 3 is missing"),
        ("2:3:duplicate", "chapter 3 appears 2 times"),
    ]


# --- links ----------------------------------------------------------------------------


def test_existing_relative_image_resolves(tree: Tree) -> None:
    """A relative image that exists inside the content dir is fine."""
    tree.write("markdown/images/ok.png", "png")
    tree.append(_FIRST, "\n![](../images/ok.png)\n[about](../resources/about.md)\n")
    assert CHECKS["broken_relative_link"](tree.corpus()) == []


def test_broken_relative_image_is_reported(tree: Tree) -> None:
    """A relative image whose file is missing is reported once, keyed by file and target."""
    _missing_image(tree)
    findings = CHECKS["broken_relative_link"](tree.corpus())
    assert [f.key for f in findings] == [f"{_FIRST} -> ../images/missing.png"]


def test_relative_link_escaping_content_dir_is_reported(tree: Tree) -> None:
    """A link out of the content dir is broken even though its target exists."""
    (tree.root.parent / "outside.txt").write_text("x", encoding="utf-8")
    tree.append(_FIRST, "\n[out](../../../outside.txt)\n")
    findings = CHECKS["broken_relative_link"](tree.corpus())
    assert [f.key for f in findings] == [f"{_FIRST} -> ../../../outside.txt"]
    assert "outside the content dir" in findings[0].detail


def test_relative_md_link_fragment_must_match_target_heading(tree: Tree) -> None:
    """``other.md#nope`` is broken; ``other.md#about`` resolves to a real heading."""
    tree.append(_FIRST, "\n[a](../resources/about.md#about)\n[b](../resources/about.md#nope)\n")
    findings = CHECKS["broken_relative_link"](tree.corpus())
    assert [f.key for f in findings] == [f"{_FIRST} -> ../resources/about.md#nope"]


def test_broken_anchor_is_reported(tree: Tree) -> None:
    """An in-file ``#anchor`` must name a heading of the same file."""
    tree.append(_FIRST, "\n[ok](#chapter-1)\n")
    assert CHECKS["broken_anchor"](tree.corpus()) == []
    _dangling_anchor(tree)
    assert [f.key for f in CHECKS["broken_anchor"](tree.corpus())] == [f"{_FIRST} -> #nowhere"]


@pytest.mark.parametrize(
    ("heading", "slug"),
    [
        ("What is Beige?", "what-is-beige"),
        ("Blue's Divine Gender", "blues-divine-gender"),
        ("The Practice of Blue: Metta Meditation", "the-practice-of-blue-metta-meditation"),
        ("Yes-And-Ness, Love", "yes-and-ness-love"),
        ("**Bold** move_on", "bold-move_on"),
        ("Stuff  ", "stuff"),
    ],
)
def test_heading_slug_cases(heading: str, slug: str) -> None:
    """GitHub-style slugs: lowercase, punctuation dropped, spaces become hyphens."""
    assert heading_slug(heading) == slug


def test_duplicate_headings_get_numbered_slugs() -> None:
    """The second and third ``# A`` are ``a-1`` and ``a-2``."""
    assert heading_slugs("# A\ntext\n## A\n### A #\n") == {"a", "a-1", "a-2"}


@pytest.mark.parametrize(
    ("line", "url"),
    [
        ("[site](http://example.org/)", "http://example.org/"),
        ('![img](http://example.org/x.png "a title")', "http://example.org/x.png"),
        ("<http://example.org/auto>", "http://example.org/auto"),
    ],
    ids=["inline", "image", "autolink"],
)
def test_http_link_is_reported(tree: Tree, line: str, url: str) -> None:
    """Plain http is reported in every link form the gate parses."""
    tree.append(_FIRST, f"\n{line}\n")
    findings = CHECKS["insecure_external_link"](tree.corpus())
    assert [f.key for f in findings] == [f"{_FIRST} -> {url}"]


@pytest.mark.parametrize(
    "url",
    ["https://www.google.com/url?q=https://example.org", "https://google.com/url?q=x"],
)
def test_google_redirect_link_is_reported(tree: Tree, url: str) -> None:
    """A Google Docs export redirect wrapper is reported, with or without ``www.``."""
    tree.append(_FIRST, f"\n[site]({url})\n")
    assert [f.key for f in CHECKS["redirect_wrapper_link"](tree.corpus())] == [f"{_FIRST} -> {url}"]


def test_a_google_page_that_is_not_a_redirect_is_fine(tree: Tree) -> None:
    """Only the ``/url`` wrapper is a redirect; a plain Google link is not."""
    tree.append(_FIRST, "\n[maps](https://www.google.com/maps)\n")
    assert CHECKS["redirect_wrapper_link"](tree.corpus()) == []


def test_unserved_files_are_not_graded(tree: Tree) -> None:
    """Vendored files the manifest does not serve (``backup/``) are out of scope."""
    tree.write("markdown/backup/x.md", "[a](http://www.google.com/url?q=x) [b](#nope)\n")
    assert audit(tree.corpus()) == []


def test_intro_sharing_chapter_file_is_reported_once(tree: Tree) -> None:
    """The intro and chapter 1 share a file: one finding, one inventory entry, both refs."""
    _plain_http(tree)
    corpus = tree.corpus()
    assert len(CHECKS["insecure_external_link"](corpus)) == 1
    entries = build_source_references(corpus)["entries"]
    shared = [entry for entry in entries if entry["path"] == _FIRST]
    assert len(shared) == 1
    assert shared[0]["refs"] == ["s1-1", "s1-intro"]


def test_a_manifest_path_outside_the_content_dir_is_refused(tree: Tree) -> None:
    """The gate never reads a file the manifest points outside its tree."""
    tree.manifest["chapters"][0]["path"] = "../escape.md"
    (tree.root.parent / "escape.md").write_text(_BODY, encoding="utf-8")
    with pytest.raises(ContentCompletenessError, match="outside"):
        tree.corpus()


def test_an_unreadable_manifest_is_refused(tmp_path: Path) -> None:
    """A missing or malformed manifest is an error, not an empty Course."""
    with pytest.raises(ContentCompletenessError, match="manifest"):
        load_corpus(tmp_path)
    (tmp_path / "manifest.json").write_text("{", encoding="utf-8")
    with pytest.raises(ContentCompletenessError, match="manifest"):
        load_corpus(tmp_path)


def test_a_missing_served_file_is_refused(tree: Tree) -> None:
    """A manifest entry with no file is an error (sync_content also catches it)."""
    tree.manifest["chapters"][0]["path"] = "markdown/01/missing.md"
    with pytest.raises(ContentCompletenessError, match="missing"):
        tree.corpus()


def test_real_tree_has_no_link_findings(real: Corpus) -> None:
    """Link, anchor, http and redirect failures are hard failures, and there are none."""
    for kind in (
        "broken_relative_link",
        "broken_anchor",
        "insecure_external_link",
        "redirect_wrapper_link",
        "duplicate_ref",
    ):
        assert CHECKS[kind](real) == [], kind


# --- the gaps record and the gate ----------------------------------------------------


def _gap(kind: str = "thin_chapter", key: str = "s1-1", **extra: str) -> dict[str, str]:
    entry = {
        "kind": kind,
        "key": key,
        "reason": "heading only",
        "owner_review": "pending",
        "upstream": "Geoffe-Ga/aptitude-course",
        "issue": "#3070",
    }
    entry.update(extra)
    return entry


def _write_gaps(path: Path, *gaps: dict[str, Any]) -> Path:
    path.write_text(json.dumps({"gaps": list(gaps)}), encoding="utf-8")
    return path


def test_vendored_findings_reconcile_exactly_with_recorded_gaps(real: Corpus) -> None:
    """Today's real gaps are recorded, and every record still reproduces."""
    assert gate(audit(real), load_gaps(GAPS_PATH)) == ([], [])


def test_every_recorded_gap_is_pending_owner_review_and_names_upstream() -> None:
    """The record is a to-do list for the owner, not a permanent waiver."""
    gaps = load_gaps(GAPS_PATH)
    assert {(gap.kind, gap.key) for gap in gaps} == {
        ("thin_chapter", "teal-7"),
        ("thin_chapter", "orange-7"),
        ("numbering_gap", "1:12"),
    }
    for gap in gaps:
        assert gap.owner_review == "pending"
        assert gap.upstream == "Geoffe-Ga/aptitude-course"
        assert gap.issue == "#3070"
        assert gap.reason.strip()


def test_unrecorded_finding_fails_the_gate() -> None:
    """A finding with no matching record is reported."""
    finding = Finding("thin_chapter", "s1-1", "3 body words")
    assert gate([finding], []) == ([finding], [])


def test_resolved_gap_left_in_record_is_stale(tmp_path: Path) -> None:
    """A recorded gap that no longer reproduces fails, so the record cannot rot."""
    gaps = load_gaps(_write_gaps(tmp_path / "gaps.json", _gap()))
    assert gate([], gaps) == ([], gaps)


def test_a_recorded_finding_passes_the_gate(tmp_path: Path) -> None:
    """A finding that matches a record on (kind, key) is waived."""
    gaps = load_gaps(_write_gaps(tmp_path / "gaps.json", _gap()))
    assert gate([Finding("thin_chapter", "s1-1", "x")], gaps) == ([], [])


@pytest.mark.parametrize(
    "kind",
    sorted(set(VIOLATING_FIXTURES) - {"thin_chapter", "numbering_gap"}),
)
def test_gaps_record_rejects_non_waivable_kind(tmp_path: Path, kind: str) -> None:
    """Only thin chapters and numbering gaps can be recorded; links must be fixed."""
    assert kind not in WAIVABLE_KINDS
    with pytest.raises(ContentCompletenessError, match="not waivable"):
        load_gaps(_write_gaps(tmp_path / "gaps.json", _gap(kind=kind)))


def test_waivable_kinds_are_exactly_thin_chapters_and_numbering_gaps() -> None:
    """Widening the waiver is a reviewed change to this test."""
    assert frozenset({"thin_chapter", "numbering_gap"}) == WAIVABLE_KINDS


@pytest.mark.parametrize(
    ("entry", "message"),
    [
        (_gap(reason="  "), "reason"),
        (_gap(extra="x"), "unknown"),
        ({k: v for k, v in _gap().items() if k != "issue"}, "missing"),
        (_gap(owner_review="approved"), "owner_review"),
        (_gap(upstream=""), "upstream"),
    ],
    ids=["blank-reason", "unknown-key", "missing-key", "not-pending", "blank-upstream"],
)
def test_gaps_record_rejects_malformed_entries(
    tmp_path: Path, entry: dict[str, Any], message: str
) -> None:
    """Every entry is complete, pending, explained and attributable."""
    with pytest.raises(ContentCompletenessError, match=message):
        load_gaps(_write_gaps(tmp_path / "gaps.json", entry))


def test_gaps_record_rejects_a_duplicate(tmp_path: Path) -> None:
    """One record per (kind, key)."""
    with pytest.raises(ContentCompletenessError, match="duplicate"):
        load_gaps(_write_gaps(tmp_path / "gaps.json", _gap(), _gap(reason="again")))


@pytest.mark.parametrize(
    "text",
    ["{", "[]", '{"gaps": {}}', '{"gaps": [], "other": 1}', '{"gaps": ["x"]}'],
    ids=["not-json", "not-object", "gaps-not-list", "unknown-top-key", "entry-not-object"],
)
def test_gaps_record_rejects_a_malformed_document(tmp_path: Path, text: str) -> None:
    """The record's own shape is validated before any entry."""
    path = tmp_path / "gaps.json"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(ContentCompletenessError, match=r"gaps\.json"):
        load_gaps(path)


def test_a_missing_gaps_record_is_an_error(tmp_path: Path) -> None:
    """No record is not the same as an empty record."""
    with pytest.raises(ContentCompletenessError, match="not found"):
        load_gaps(tmp_path / "absent.json")


# --- inventories ----------------------------------------------------------------------


def test_source_reference_inventory_is_current_and_not_a_bibliography(real: Corpus) -> None:
    """The committed inventory is a fresh regeneration and says what it is not."""
    inventory = build_source_references(real)
    assert SOURCES_PATH.read_text(encoding="utf-8") == render(inventory)
    assert "not a bibliography" in inventory["notice"].lower()
    assert inventory["notice"] == NOT_A_BIBLIOGRAPHY
    assert (
        inventory["source"]["sha"]
        == (_REAL_CONTENT / CONTENT_VERSION_FILE)
        .read_text(encoding="utf-8")
        .split("sha: ")[1]
        .split("\n")[0]
    )


def test_every_served_https_url_is_inventoried(real: Corpus) -> None:
    """An independent bare-URL sweep finds nothing the link parser missed."""
    inventoried = {
        link["url"] for entry in build_source_references(real)["entries"] for link in entry["links"]
    }
    swept = {
        match.rstrip(".,")
        for document in real.documents
        # Independent of the link grammar: any scheme-led run up to whitespace or
        # a closing delimiter (no served URL contains a parenthesis or bracket).
        for match in re.findall(r"https?://[^\s)>\]]+", document.body)
    }
    assert swept
    assert swept <= inventoried


def test_source_inventory_dedupes_and_sorts_links(tree: Tree) -> None:
    """A URL cited twice in one file is listed once; files without links are omitted."""
    tree.append(
        _FIRST, "\n[z](https://z.example/) [a](https://a.example/) [a](https://a.example/)\n"
    )
    entries = build_source_references(tree.corpus())["entries"]
    assert [entry["path"] for entry in entries] == [_FIRST, "markdown/resources/about.md"]
    assert entries[0]["links"] == [
        {"text": "a", "url": "https://a.example/"},
        {"text": "z", "url": "https://z.example/"},
    ]
    assert entries[1]["refs"] == ["resource:about"]


def test_source_inventory_needs_a_content_version(tree: Tree) -> None:
    """The inventory cites the pinned commit; an unpinned tree is an error."""
    (tree.root / CONTENT_VERSION_FILE).unlink()
    with pytest.raises(ContentCompletenessError, match=CONTENT_VERSION_FILE):
        build_source_references(tree.corpus())


def test_practice_recommendation_inventory_is_current(real: Corpus) -> None:
    """Every practice-titled chapter is listed, unreviewed, keyed by a manifest id."""
    inventory = build_practice_recommendations(real)
    assert PRACTICES_PATH.read_text(encoding="utf-8") == render(inventory)
    entries = inventory["entries"]
    ids = [entry["id"] for entry in entries]
    assert len(entries) == _REAL_PRACTICE_COUNT
    assert {"beige-6", "orange-7", "teal-7", "blue-6"} <= set(ids)
    assert {entry["status"] for entry in entries} == {"unreviewed"}
    chapter_ids = {chapter.id for chapter in real.chapters}
    assert set(ids) <= chapter_ids
    assert set(entries[0]) == {"id", "stage", "chapter", "title", "status"}


def test_practice_inventory_matches_titles_not_bodies(tree: Tree) -> None:
    """Titles naming a practice or protocol are listed, in manifest order."""
    tree.add_chapter(1, 2, title="The Practice of Beige")
    tree.add_chapter(1, 3, title="The Grounding Protocol")
    tree.add_chapter(1, 4, title="Practicing patience", body=f"practice {_BODY}")
    entries = build_practice_recommendations(tree.corpus())["entries"]
    assert [entry["id"] for entry in entries] == ["s1-2", "s1-3"]


# --- the CLI --------------------------------------------------------------------------


@dataclass
class Workspace:
    """A fixture tree plus its own gaps record and inventories."""

    tree: Tree
    gaps: Path
    sources: Path
    practices: Path

    def argv(self, *flags: str) -> list[str]:
        """Return CLI flags pointing every path at this workspace."""
        return [
            *flags,
            "--content-dir",
            str(self.tree.root),
            "--gaps",
            str(self.gaps),
            "--sources",
            str(self.sources),
            "--practices",
            str(self.practices),
        ]


@pytest.fixture
def workspace(tree: Tree, tmp_path: Path) -> Workspace:
    """A healthy tree with an empty gaps record and freshly written inventories."""
    space = Workspace(
        tree,
        _write_gaps(tmp_path / "gaps.json"),
        tmp_path / "sources.json",
        tmp_path / "practices.json",
    )
    assert main(space.argv()) == 0
    return space


def _stat(path: Path) -> tuple[bytes, int]:
    return path.read_bytes(), path.stat().st_mtime_ns


def test_check_mode_returns_zero_on_vendored_tree_and_writes_nothing() -> None:
    """In-process and as CI runs it (``python -m`` from backend/, no PYTHONPATH)."""
    before = [_stat(path) for path in (GAPS_PATH, SOURCES_PATH, PRACTICES_PATH)]
    assert main(["--check"]) == 0
    env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
    result = subprocess.run(
        [sys.executable, "-m", "scripts.content_completeness", "--check"],
        cwd=_BACKEND_DIR,
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert [_stat(path) for path in (GAPS_PATH, SOURCES_PATH, PRACTICES_PATH)] == before


def test_module_exit_code_reaches_the_shell(workspace: Workspace) -> None:
    """The CI step's exit status is the gate's verdict, never swallowed."""
    _thin_first_chapter(workspace.tree)
    workspace.tree.save()
    result = subprocess.run(
        [sys.executable, "-m", "scripts.content_completeness", *workspace.argv("--check")],
        cwd=_BACKEND_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "thin_chapter s1-1" in result.stderr


def test_check_mode_returns_one_on_unrecorded_thin_chapter(
    workspace: Workspace, capsys: pytest.CaptureFixture[str]
) -> None:
    """An unrecorded thin chapter fails ``--check`` and is named on stderr."""
    _thin_first_chapter(workspace.tree)
    workspace.tree.save()
    assert main(workspace.argv("--check")) == 1
    assert "unrecorded finding: thin_chapter s1-1" in capsys.readouterr().err


def test_check_mode_returns_one_on_stale_gap(
    workspace: Workspace, capsys: pytest.CaptureFixture[str]
) -> None:
    """A recorded gap the tree no longer has fails ``--check``."""
    _write_gaps(workspace.gaps, _gap(key="s9-9"))
    assert main(workspace.argv("--check")) == 1
    assert "stale gap: thin_chapter s9-9" in capsys.readouterr().err


@pytest.mark.parametrize("which", ["sources", "practices"])
def test_check_mode_returns_one_on_drifted_inventory(
    workspace: Workspace, capsys: pytest.CaptureFixture[str], which: str
) -> None:
    """A hand-edited or missing inventory fails ``--check``."""
    path: Path = getattr(workspace, which)
    path.write_text(path.read_text(encoding="utf-8") + " ", encoding="utf-8")
    assert main(workspace.argv("--check")) == 1
    assert f"{path} is stale" in capsys.readouterr().err
    path.unlink()
    assert main(workspace.argv("--check")) == 1
    assert f"{path} is missing" in capsys.readouterr().err


def test_write_mode_regenerates_inventories_and_never_touches_gaps(workspace: Workspace) -> None:
    """Default mode rewrites only the generated files; the reviewed record is hand-owned."""
    before = _stat(workspace.gaps)
    workspace.sources.write_text("stale", encoding="utf-8")
    workspace.practices.unlink()
    assert main(workspace.argv()) == 0
    assert _stat(workspace.gaps) == before
    assert main(workspace.argv("--check")) == 0


def test_write_mode_still_fails_on_an_unrecorded_finding(workspace: Workspace) -> None:
    """Regenerating the inventories never waves a gap through."""
    _thin_first_chapter(workspace.tree)
    workspace.tree.save()
    assert main(workspace.argv()) == 1


def test_malformed_gaps_file_returns_one(
    workspace: Workspace, capsys: pytest.CaptureFixture[str]
) -> None:
    """A record error is caught in ``main`` and reported, not raised."""
    _write_gaps(workspace.gaps, _gap(kind="broken_anchor"))
    assert main(workspace.argv("--check")) == 1
    assert "not waivable" in capsys.readouterr().err


def test_gap_dataclass_round_trips(tmp_path: Path) -> None:
    """``load_gaps`` returns typed records carrying every field."""
    (gap,) = load_gaps(_write_gaps(tmp_path / "gaps.json", _gap()))
    assert gap == Gap(
        kind="thin_chapter",
        key="s1-1",
        reason="heading only",
        owner_review="pending",
        upstream="Geoffe-Ga/aptitude-course",
        issue="#3070",
    )
