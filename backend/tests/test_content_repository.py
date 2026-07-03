"""Unit tests for the local-file ContentRepository (issue #390).

The repository is the app's only content source: it loads
``manifest.json`` once, validates it against the frozen contract from
issue #389, and serves chapter metadata plus raw Markdown bodies from the
vendored content directory.  These tests cover the full public surface —
including the path-traversal guard on every body read.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from services.content_repository import (
    ContentNotFoundError,
    ContentRepository,
    ContentRepositoryError,
    content_version_info,
    get_content_repository,
    reset_content_repository_for_tests,
    set_content_repository_for_tests,
)

_VALID_MANIFEST: dict[str, Any] = {
    "schema_version": "1.1.0",
    "chapters": [
        {
            "id": "beige-1",
            "stage": 1,
            "chapter": 1,
            "slug": "survival",
            "title": "Survival",
            "content_type": "chapter",
            "release_day": 0,
            "order": 1,
            "path": "markdown/01-beige/01-survival.md",
        },
        {
            "id": "beige-2",
            "stage": 1,
            "chapter": 2,
            "slug": "breath",
            "title": "Breath as Anchor",
            "content_type": "essay",
            "release_day": 3,
            "order": 2,
            "path": "markdown/01-beige/02-breath.md",
        },
    ],
    "site_resources": [
        {
            "slug": "getting-started",
            "title": "Getting Started",
            "description": "Orientation guide.",
            "path": "markdown/site/getting-started.md",
        }
    ],
    "stage_intros": [
        {
            "stage": 2,
            "id": "purple-intro",
            "slug": "purple-introduction",
            "title": "Welcome to Purple",
            "path": "markdown/02-purple/00-introduction.md",
        },
        {
            "stage": 1,
            "id": "beige-intro",
            "slug": "beige-introduction",
            "title": "Welcome to Beige",
            "path": "markdown/01-beige/00-introduction.md",
            "summary": "What Beige is about.",
        },
    ],
}


def _write_content_dir(root: Path, manifest: dict[str, Any]) -> Path:
    """Materialise a content dir with the manifest and matching Markdown files."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(json.dumps(manifest))
    for chapter in manifest.get("chapters", []):
        md = root / chapter["path"]
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(f"# {chapter.get('title', chapter['id'])}\n\nBody of {chapter['id']}.\n")
    for resource in manifest.get("site_resources", []):
        md = root / resource["path"]
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(f"# {resource['title']}\n")
    for intro in manifest.get("stage_intros", []):
        md = root / intro["path"]
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(f"# {intro['title']}\n\nIntro for stage {intro['stage']}.\n")
    return root


@pytest.fixture
def content_dir(tmp_path: Path) -> Path:
    return _write_content_dir(tmp_path / "content", copy.deepcopy(_VALID_MANIFEST))


# ── Happy path ──────────────────────────────────────────────────────────


def test_lists_chapters_in_stage_then_order(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    chapters = repo.list_chapters()
    assert [c.id for c in chapters] == ["beige-1", "beige-2"]
    assert chapters[0].title == "Survival"
    assert chapters[0].content_type == "chapter"


def test_get_chapter_by_id(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    chapter = repo.get_chapter("beige-2")
    assert chapter is not None
    assert chapter.slug == "breath"
    assert repo.get_chapter("nope") is None


def test_read_body_returns_markdown_with_metadata(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    body = repo.read_body("beige-1")
    assert body.title == "Survival"
    assert body.content_type == "chapter"
    assert "Body of beige-1." in body.body


def test_read_resource_body(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    body = repo.read_resource_body("getting-started")
    assert body.title == "Getting Started"
    assert "# Getting Started" in body.body


# ── Error paths ─────────────────────────────────────────────────────────


def test_unknown_chapter_id_raises_not_found(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    with pytest.raises(ContentNotFoundError):
        repo.read_body("missing-id")


def test_unknown_resource_slug_raises_not_found(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    with pytest.raises(ContentNotFoundError):
        repo.read_resource_body("missing-slug")


def test_duplicate_chapter_id_raises_repository_error(tmp_path: Path) -> None:
    """A duplicate id passes the schema but must not silently drop a chapter."""
    doubled = copy.deepcopy(_VALID_MANIFEST)
    doubled["chapters"][1]["id"] = doubled["chapters"][0]["id"]
    root = _write_content_dir(tmp_path / "content", doubled)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_duplicate_resource_slug_raises_repository_error(tmp_path: Path) -> None:
    """Duplicate slugs must fail loudly, consistent with chapter ids."""
    doubled = copy.deepcopy(_VALID_MANIFEST)
    doubled["site_resources"].append(dict(doubled["site_resources"][0]))
    root = _write_content_dir(tmp_path / "content", doubled)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_missing_markdown_for_known_resource_raises_repository_error(
    content_dir: Path,
) -> None:
    (content_dir / "markdown/site/getting-started.md").unlink()
    repo = ContentRepository(content_dir)
    with pytest.raises(ContentRepositoryError):
        repo.read_resource_body("getting-started")


def test_malformed_json_manifest_raises_repository_error(tmp_path: Path) -> None:
    root = tmp_path / "content"
    root.mkdir()
    (root / "manifest.json").write_text("{not valid json")
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_non_object_json_manifest_raises_repository_error(tmp_path: Path) -> None:
    root = tmp_path / "content"
    root.mkdir()
    (root / "manifest.json").write_text("[]")
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_missing_manifest_raises_repository_error(tmp_path: Path) -> None:
    (tmp_path / "empty").mkdir()
    with pytest.raises(ContentRepositoryError):
        ContentRepository(tmp_path / "empty")


def test_invalid_manifest_raises_repository_error(tmp_path: Path) -> None:
    broken = copy.deepcopy(_VALID_MANIFEST)
    broken["chapters"][0].pop("title")
    root = _write_content_dir(tmp_path / "content", broken)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_wrong_major_schema_version_is_rejected(tmp_path: Path) -> None:
    """ADR 0001 change control: readers reject a different major version."""
    future = copy.deepcopy(_VALID_MANIFEST)
    future["schema_version"] = "2.0.0"
    root = _write_content_dir(tmp_path / "content", future)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_path_traversal_is_rejected(tmp_path: Path) -> None:
    """The LFI guard analogous to the old client's _validate_url."""
    evil = copy.deepcopy(_VALID_MANIFEST)
    evil["chapters"][0]["path"] = "../../etc/passwd"
    root = _write_content_dir(tmp_path / "content", evil)
    # The escape target genuinely exists, so only the guard stops the read.
    outside = tmp_path / "etc"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "passwd").write_text("root:x:0:0\n")
    repo = ContentRepository(root)
    with pytest.raises(ContentRepositoryError):
        repo.read_body("beige-1")


def test_missing_markdown_for_known_id_raises_repository_error(content_dir: Path) -> None:
    (content_dir / "markdown/01-beige/01-survival.md").unlink()
    repo = ContentRepository(content_dir)
    with pytest.raises(ContentRepositoryError):
        repo.read_body("beige-1")


def test_list_resources_in_manifest_order(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    resources = repo.list_resources()
    assert [r.slug for r in resources] == ["getting-started"]
    assert resources[0].title == "Getting Started"
    assert resources[0].description == "Orientation guide."


def test_list_resources_empty_manifest(tmp_path: Path) -> None:
    manifest: dict[str, Any] = {"schema_version": "1.0.0", "chapters": [], "site_resources": []}
    root = _write_content_dir(tmp_path / "content", manifest)
    assert ContentRepository(root).list_resources() == []


def test_resource_missing_description_is_rejected_at_construction(tmp_path: Path) -> None:
    """A sparse resource entry never reaches ``list_resources()``.

    The schema requires every resource field (slug/title/description/path),
    so construction fails validation first — direct ``raw[...]`` access in
    ``list_resources`` cannot KeyError.
    """
    sparse = copy.deepcopy(_VALID_MANIFEST)
    del sparse["site_resources"][0]["description"]
    root = _write_content_dir(tmp_path / "content", sparse)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


# ── Stage introductions (issue #718) ────────────────────────────────────


def test_get_stage_intro_returns_meta(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    intro = repo.get_stage_intro(1)
    assert intro is not None
    assert intro.id == "beige-intro"


def test_get_stage_intro_returns_none_for_unseeded_stage(content_dir: Path) -> None:
    """Optional lookup mirrors ``get_chapter`` — no intro for stage 3."""
    repo = ContentRepository(content_dir)
    assert repo.get_stage_intro(3) is None


def test_read_intro_body_returns_markdown_with_metadata(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    body = repo.read_intro_body(1)
    assert body.title == "Welcome to Beige"
    assert body.content_type == "introduction"
    assert "Intro for stage 1." in body.body


def test_unknown_stage_intro_raises_not_found(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    with pytest.raises(ContentNotFoundError):
        repo.read_intro_body(99)


def test_duplicate_stage_intro_raises_repository_error(tmp_path: Path) -> None:
    doubled = copy.deepcopy(_VALID_MANIFEST)
    doubled["stage_intros"].append(
        {
            "stage": 1,
            "id": "beige-intro-2",
            "slug": "beige-introduction-2",
            "title": "Another Beige Intro",
            "path": "markdown/01-beige/00-introduction.md",
        }
    )
    root = _write_content_dir(tmp_path / "content", doubled)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_intro_path_traversal_is_rejected(tmp_path: Path) -> None:
    evil = copy.deepcopy(_VALID_MANIFEST)
    evil["stage_intros"][0]["path"] = "../secret.md"
    root = _write_content_dir(tmp_path / "content", evil)
    (tmp_path / "secret.md").write_text("classified")
    repo = ContentRepository(root)
    with pytest.raises(ContentRepositoryError):
        repo.read_intro_body(2)  # stage 2 is the first entry, with the evil path


def test_content_version_info_parses_stamp(content_dir: Path) -> None:
    (content_dir / "CONTENT_VERSION").write_text(
        "sha: " + "a" * 40 + "\nsynced_at: 2026-06-10T00:00:00+00:00\ndigest: sha256:abc\n"
    )
    info = content_version_info(content_dir)
    assert info is not None
    assert info["sha"] == "a" * 40
    assert info["digest"] == "sha256:abc"


def test_content_version_info_none_when_missing(content_dir: Path) -> None:
    assert content_version_info(content_dir) is None


def test_content_version_info_none_when_malformed(content_dir: Path) -> None:
    (content_dir / "CONTENT_VERSION").write_text("free-form text\n")
    assert content_version_info(content_dir) is None


# ── Singleton trio ──────────────────────────────────────────────────────


def test_singleton_set_and_reset_for_tests(content_dir: Path) -> None:
    custom = ContentRepository(content_dir)
    set_content_repository_for_tests(custom)
    try:
        assert get_content_repository() is custom
    finally:
        reset_content_repository_for_tests()


def test_lazy_singleton_builds_from_content_dir_env(
    content_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """First call constructs from CONTENT_DIR; later calls reuse the instance."""
    monkeypatch.setenv("CONTENT_DIR", str(content_dir))
    reset_content_repository_for_tests()
    try:
        first = get_content_repository()
        assert get_content_repository() is first
        assert [c.id for c in first.list_chapters()] == ["beige-1", "beige-2"]
    finally:
        reset_content_repository_for_tests()


# ── Frontmatter stripping ───────────────────────────────────────────────


def test_frontmatter_stripped_from_chapter_body(content_dir: Path) -> None:
    # overwrite chapter file with YAML frontmatter before constructing the repo
    md = content_dir / "markdown/01-beige/01-survival.md"
    md.write_text("---\nslug: survival\ntitle: Survival\nmedia: x\n---\n\n# Survival\n\nBody.\n")
    repo = ContentRepository(content_dir)
    body = repo.read_body("beige-1").body
    assert "# Survival" in body
    assert "Body." in body
    assert "slug:" not in body
    assert "title:" not in body
    assert "media:" not in body
    assert not body.startswith("---")


def test_no_frontmatter_body_returned_byte_for_byte(content_dir: Path) -> None:
    # characterization guard: prose-first file must come back unchanged
    raw = "# Heading\n\nProse.\n"
    md = content_dir / "markdown/01-beige/01-survival.md"
    md.write_text(raw)
    repo = ContentRepository(content_dir)
    assert repo.read_body("beige-1").body == raw


def test_mid_body_thematic_break_survives(content_dir: Path) -> None:
    # characterization guard: only a line-1 fence is stripped; mid-doc --- must survive
    raw = "# H\n\nBefore.\n\n---\n\nAfter.\n"
    md = content_dir / "markdown/01-beige/01-survival.md"
    md.write_text(raw)
    repo = ContentRepository(content_dir)
    body = repo.read_body("beige-1").body
    assert "---" in body
    assert "Before." in body
    assert "After." in body


def test_frontmatter_value_containing_dashes_not_mistaken_for_fence(
    content_dir: Path,
) -> None:
    # closing fence is the first lone --- line; a value like "a --- b" must not close it
    md = content_dir / "markdown/01-beige/01-survival.md"
    md.write_text('---\ntitle: "a --- b"\nnote: c:d\n---\n\nProse.\n')
    repo = ContentRepository(content_dir)
    body = repo.read_body("beige-1").body
    assert "Prose." in body
    assert "title:" not in body
    assert "note:" not in body
    assert not body.startswith("---")


def test_frontmatter_stripped_across_all_three_read_paths(content_dir: Path) -> None:
    # all three public read methods share _read_markdown; verify each strips frontmatter
    chapter_md = content_dir / "markdown/01-beige/01-survival.md"
    chapter_md.write_text("---\nslug: survival\n---\n\n# Survival body.\n")
    resource_md = content_dir / "markdown/site/getting-started.md"
    resource_md.write_text("---\nslug: getting-started\n---\n\n# Resource body.\n")
    intro_md = content_dir / "markdown/01-beige/00-introduction.md"
    intro_md.write_text("---\nstage: 1\n---\n\n# Intro body.\n")
    repo = ContentRepository(content_dir)
    chapter_body = repo.read_body("beige-1").body
    assert "slug:" not in chapter_body
    assert "# Survival body." in chapter_body
    resource_body = repo.read_resource_body("getting-started").body
    assert "slug:" not in resource_body
    assert "# Resource body." in resource_body
    intro_body = repo.read_intro_body(1).body
    assert "stage:" not in intro_body
    assert "# Intro body." in intro_body


def test_bom_prefixed_frontmatter_is_stripped(content_dir: Path) -> None:
    # UTF-8 BOM before the opening --- must still trigger stripping
    md = content_dir / "markdown/01-beige/01-survival.md"
    md.write_bytes("﻿---\nslug: x\n---\n\nProse.\n".encode())
    repo = ContentRepository(content_dir)
    body = repo.read_body("beige-1").body
    assert "Prose." in body
    assert "slug:" not in body


def test_unterminated_frontmatter_returned_unchanged(content_dir: Path) -> None:
    # defensive guard: no closing fence means the file is returned verbatim
    raw = "---\nslug: x\nno closing fence here\n"
    md = content_dir / "markdown/01-beige/01-survival.md"
    md.write_text(raw)
    repo = ContentRepository(content_dir)
    assert repo.read_body("beige-1").body == raw
