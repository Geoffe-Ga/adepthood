"""Tests for ``backend/scripts/build_stage_correspondence.py`` (issue #2664).

The generator turns the vendored Complete Map CSV plus the adepthood-owned
supersession list into a versioned, schema-validated stage-correspondence
artifact, and ``--check`` is the drift gate that fails when the committed
artifact no longer equals a regeneration. Every test here builds its own
content tree under ``tmp_path`` so the generator's rules are exercised
without depending on the real vendored bytes.
"""

from __future__ import annotations

import copy
import csv
import hashlib
import io
import json
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

import scripts.build_stage_correspondence as generator
from domain.constants import WEEKS_PER_STAGE
from scripts.build_stage_correspondence import (
    StageCorrespondenceError,
    build,
    check_authority,
    load_supersessions,
    main,
    read_csv_rows,
    render,
    validate,
)
from scripts.sync_content import (
    CONTENT_REPO,
    STAGE_CORRESPONDENCE_CSV_SOURCE,
    STAGE_CORRESPONDENCE_CSV_VENDORED,
    read_content_version,
)

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_FIXTURE_SHA = "b" * 40
_FIXTURE_DIGEST = "sha256:" + "c" * 64

#: Required CSV columns plus two the generator must ignore; the leading space
#: on " This Period's Practice" mirrors the real upstream header.
_HEADERS = (
    "Week",
    "Category",
    "Aspect",
    "Spiral Dynamics Color",
    "Growing Up Stage",
    "Gender Polarity",
    "Relationship to Free Will",
    "Free Will Description",
    "Mode",
    " This Period's Practice",
)

_BLUE = generator.STAGE_IDS.index("blue")
_TEAL = generator.STAGE_IDS.index("teal")
_CLEARLIGHT = generator.STAGE_IDS.index("clearlight")


def _start_weeks() -> list[int]:
    """Cumulative start weeks derived from the program's stage lengths."""
    weeks = [1]
    for length in WEEKS_PER_STAGE[:-1]:
        weeks.append(weeks[-1] + length)
    return weeks


def _fixture_rows() -> list[dict[str, str]]:
    """Ten synthetic CSV rows keyed by header, in start-week order."""
    rows = []
    for index, (stage_id, week) in enumerate(zip(generator.STAGE_IDS, _start_weeks(), strict=True)):
        rows.append(
            {
                "Week": str(week),
                "Category": f"Category {stage_id}",
                "Aspect": f"Aspect {stage_id}",
                "Spiral Dynamics Color": stage_id.title(),
                "Growing Up Stage": f"Growing {index + 1}",
                "Gender Polarity": "Divine Feminine" if index % 2 else "Divine Masculine",
                "Relationship to Free Will": f"Archetype {stage_id}",
                "Free Will Description": f"Description for {stage_id}, with a comma.",
                "Mode": "Rx",
                " This Period's Practice": "On-Going  Habit",
            }
        )
    rows[_BLUE]["Aspect"] = "Universal Love"
    rows[_TEAL]["Aspect"] = "Transcendent Wisdom"
    rows[_TEAL]["Relationship to Free Will"] = "Adept"
    rows[_CLEARLIGHT]["Relationship to Free Will"] = "Whole Adept "
    return rows


def _csv_bytes(rows: list[dict[str, str]], headers: tuple[str, ...] = _HEADERS) -> bytes:
    """Serialise ``rows`` exactly as a spreadsheet export would (LF, quoted)."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(headers)
    for row in rows:
        writer.writerow([row.get(header, "") for header in headers])
    return buffer.getvalue().encode()


_SUPERSESSIONS: list[dict[str, str]] = [
    {
        "stage_id": "blue",
        "field": "aspect",
        "csv_value": "Universal Love",
        "value": "Community Love",
        "authority": "markdown/04-blue/02-community-love.md",
    },
    {
        "stage_id": "teal",
        "field": "aspect",
        "csv_value": "Transcendent Wisdom",
        "value": "True Self Connection",
        "authority": "markdown/08-teal/02-wisdom.md",
    },
    {
        "stage_id": "teal",
        "field": "relationship_to_free_will",
        "csv_value": "Adept",
        "value": "True Self Embodier",
        "authority": "markdown/08-teal/04-true-self-embodier.md",
    },
]

_AUTHORITY_TEXT = {
    "markdown/04-blue/02-community-love.md": "# Love\n\nThis is COMMUNITY\nlove, felt together.\n",
    "markdown/08-teal/02-wisdom.md": "# Wisdom\n\nA True Self connection opens.\n",
    "markdown/08-teal/04-true-self-embodier.md": "# The True Self Embodier\n",
    "markdown/backup/old.md": "Community Love\n",
}


class Workspace:
    """A self-contained content tree plus supersession, schema and artifact paths."""

    def __init__(self, root: Path) -> None:
        """Lay out a content dir, supersessions file and schema under ``root``."""
        self.content_dir = root / "content"
        self.csv_path = self.content_dir / STAGE_CORRESPONDENCE_CSV_VENDORED
        self.csv_path.parent.mkdir(parents=True)
        self.write_csv(_csv_bytes(_fixture_rows()))
        (self.content_dir / "CONTENT_VERSION").write_text(
            f"sha: {_FIXTURE_SHA}\nsynced_at: 2026-09-25T00:00:00+00:00\n"
            f"digest: {_FIXTURE_DIGEST}\n"
        )
        for rel_path, text in _AUTHORITY_TEXT.items():
            path = self.content_dir / rel_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.supersessions_path = root / "supersessions.json"
        self.write_supersessions(_SUPERSESSIONS)
        self.schema_path = root / "schema.json"
        shutil.copy(generator.SCHEMA_PATH, self.schema_path)
        self.artifact_path = root / "artifact.json"

    def write_csv(self, data: bytes) -> None:
        """Replace the vendored CSV bytes."""
        self.csv_path.write_bytes(data)

    def write_supersessions(self, entries: list[dict[str, str]]) -> None:
        """Replace the supersession data file."""
        self.supersessions_path.write_text(json.dumps({"supersessions": entries}))

    def argv(self, *extra: str) -> list[str]:
        """CLI arguments pointing every input and output at this workspace."""
        return [
            "--content-dir",
            str(self.content_dir),
            "--supersessions",
            str(self.supersessions_path),
            "--schema",
            str(self.schema_path),
            "--artifact",
            str(self.artifact_path),
            *extra,
        ]

    def build(self) -> dict[str, Any]:
        """Run the generator's pure build over this workspace."""
        return build(self.content_dir, self.supersessions_path)


@pytest.fixture
def workspace(tmp_path: Path) -> Workspace:
    """A fresh, valid generator workspace."""
    return Workspace(tmp_path)


def _schema() -> Draft202012Validator:
    """A validator over the committed artifact schema."""
    return Draft202012Validator(json.loads(generator.SCHEMA_PATH.read_text()))


# ── build ───────────────────────────────────────────────────────────────


def test_build_emits_ten_color_slug_stages_at_program_start_weeks(workspace: Workspace) -> None:
    stages = workspace.build()["stages"]

    assert [stage["id"] for stage in stages] == list(generator.STAGE_IDS)
    assert [stage["stage_number"] for stage in stages] == list(range(1, len(WEEKS_PER_STAGE) + 1))
    assert [stage["start_week"] for stage in stages] == _start_weeks()


def test_stage_ids_are_the_color_slugs_of_the_manifest_stage_intros() -> None:
    """The ids reuse upstream's own stage_intros convention ('clearlight', one word)."""
    manifest = json.loads((generator.CONTENT_DIR / "manifest.json").read_text())
    intro_ids = [
        intro["id"] for intro in sorted(manifest["stage_intros"], key=lambda i: i["stage"])
    ]
    assert [f"{stage_id}-intro" for stage_id in generator.STAGE_IDS] == intro_ids
    assert len(WEEKS_PER_STAGE) == generator.STAGE_COUNT


def test_build_carries_every_attribute_column(workspace: Workspace) -> None:
    rows = _fixture_rows()
    purple = workspace.build()["stages"][1]
    for field, column in generator.FIELD_COLUMNS.items():
        assert purple[field] == rows[1][column].strip()
    assert list(generator.FIELD_COLUMNS) == [
        "category",
        "aspect",
        "spiral_dynamics_color",
        "growing_up_stage",
        "divine_gender_polarity",
        "relationship_to_free_will",
        "free_will_description",
    ]
    assert generator.FIELD_COLUMNS["divine_gender_polarity"] == "Gender Polarity"


def test_build_strips_edge_whitespace_from_cells(workspace: Workspace) -> None:
    raw = _fixture_rows()[_CLEARLIGHT]["Relationship to Free Will"]
    assert raw != raw.strip()
    assert workspace.build()["stages"][_CLEARLIGHT]["relationship_to_free_will"] == "Whole Adept"


def test_build_applies_each_supersession_to_its_stage_and_field(workspace: Workspace) -> None:
    artifact = workspace.build()
    by_id = {stage["id"]: stage for stage in artifact["stages"]}
    for entry in _SUPERSESSIONS:
        assert by_id[entry["stage_id"]][entry["field"]] == entry["value"]
    # Untouched neighbours keep the CSV value.
    assert by_id["teal"]["spiral_dynamics_color"] == "Teal"
    assert by_id["green"]["aspect"] == "Aspect green"
    assert artifact["supersessions"] == _SUPERSESSIONS


def test_build_records_source_provenance(workspace: Workspace) -> None:
    source = workspace.build()["source"]

    assert source == {
        "repo": CONTENT_REPO,
        "sha": read_content_version(workspace.content_dir)["sha"],
        "csv_path": STAGE_CORRESPONDENCE_CSV_SOURCE,
        "sha256": hashlib.sha256(workspace.csv_path.read_bytes()).hexdigest(),
    }
    assert source["sha"] == _FIXTURE_SHA


def test_build_hashes_raw_bytes_not_normalised_text(workspace: Workspace) -> None:
    before = workspace.build()["source"]["sha256"]
    workspace.write_csv(workspace.csv_path.read_bytes().replace(b"Whole Adept ", b"Whole Adept"))
    after = workspace.build()
    assert after["source"]["sha256"] != before
    # ...even though the normalised stage data is identical.
    assert after["stages"][_CLEARLIGHT]["relationship_to_free_will"] == "Whole Adept"


def test_build_stamps_the_artifact_schema_version(workspace: Workspace) -> None:
    assert workspace.build()["schema_version"] == generator.ARTIFACT_SCHEMA_VERSION == "1.0.0"


def test_render_is_byte_identical_across_runs(workspace: Workspace) -> None:
    first = render(workspace.build())
    second = render(workspace.build())
    assert first == second
    assert first.endswith("}\n")
    assert json.loads(first) == workspace.build()


def test_built_artifact_validates_against_the_schema(workspace: Workspace) -> None:
    artifact = workspace.build()
    validate(artifact, generator.SCHEMA_PATH)  # must not raise
    _schema().validate(artifact)


# ── schema negatives ────────────────────────────────────────────────────


def _drop_stage_field(artifact: dict[str, Any]) -> None:
    del artifact["stages"][0]["aspect"]


def _unknown_top_level_key(artifact: dict[str, Any]) -> None:
    artifact["extra"] = True


def _unknown_stage_key(artifact: dict[str, Any]) -> None:
    artifact["stages"][0]["title"] = "Survival"


def _duplicate_stage_id(artifact: dict[str, Any]) -> None:
    artifact["stages"][1]["id"] = "beige"


def _eleventh_stage(artifact: dict[str, Any]) -> None:
    artifact["stages"].append(copy.deepcopy(artifact["stages"][-1]))


def _missing_stage(artifact: dict[str, Any]) -> None:
    artifact["stages"].pop()


def _edge_whitespace(artifact: dict[str, Any]) -> None:
    artifact["stages"][_CLEARLIGHT]["relationship_to_free_will"] = "Whole Adept "


def _backup_authority(artifact: dict[str, Any]) -> None:
    artifact["supersessions"][0]["authority"] = "markdown/backup/old.md"


def _drop_source_sha(artifact: dict[str, Any]) -> None:
    del artifact["source"]["sha"]


def _supersession_extra_key(artifact: dict[str, Any]) -> None:
    artifact["supersessions"][0]["note"] = "extra"


def _wrong_stage_number(artifact: dict[str, Any]) -> None:
    artifact["stages"][2]["stage_number"] = 2


@pytest.mark.parametrize(
    "mutate",
    [
        _drop_stage_field,
        _unknown_top_level_key,
        _unknown_stage_key,
        _duplicate_stage_id,
        _eleventh_stage,
        _missing_stage,
        _edge_whitespace,
        _backup_authority,
        _drop_source_sha,
        _supersession_extra_key,
        _wrong_stage_number,
    ],
)
def test_schema_rejects_malformed_artifacts(
    workspace: Workspace, mutate: Callable[[dict[str, Any]], None]
) -> None:
    artifact = workspace.build()
    mutate(artifact)
    with pytest.raises(ValidationError):
        _schema().validate(artifact)
    with pytest.raises(StageCorrespondenceError):
        validate(artifact, generator.SCHEMA_PATH)


# ── CSV reading ─────────────────────────────────────────────────────────


def test_read_csv_strips_padded_required_headers(workspace: Workspace) -> None:
    padded = tuple(f" {header} " if header == "Aspect" else header for header in _HEADERS)
    rows = _fixture_rows()
    for row in rows:
        row[" Aspect "] = row["Aspect"]
    workspace.write_csv(_csv_bytes(rows, padded))

    parsed = read_csv_rows(workspace.csv_path)
    assert parsed[0]["Aspect"] == "Aspect beige"


def test_read_csv_keeps_quoted_multiline_cells(workspace: Workspace) -> None:
    rows = _fixture_rows()
    rows[2]["Free Will Description"] = "First line,\nsecond line "
    workspace.write_csv(_csv_bytes(rows) + b"\n")
    assert read_csv_rows(workspace.csv_path)[2]["Free Will Description"] == (
        "First line,\nsecond line"
    )


def test_read_csv_sorts_rows_by_week(workspace: Workspace) -> None:
    workspace.write_csv(_csv_bytes(list(reversed(_fixture_rows()))))
    assert [int(row["Week"]) for row in read_csv_rows(workspace.csv_path)] == _start_weeks()


def _missing_column() -> bytes:
    return _csv_bytes(_fixture_rows(), tuple(h for h in _HEADERS if h != "Gender Polarity"))


def _non_integer_week() -> bytes:
    rows = _fixture_rows()
    rows[3]["Week"] = "ten"
    return _csv_bytes(rows)


def _duplicate_week() -> bytes:
    rows = _fixture_rows()
    rows[3]["Week"] = rows[2]["Week"]
    return _csv_bytes(rows)


def _eleven_rows() -> bytes:
    rows = _fixture_rows()
    extra = dict(rows[-1])
    extra["Week"] = "99"
    return _csv_bytes([*rows, extra])


def _nine_rows() -> bytes:
    return _csv_bytes(_fixture_rows()[:-1])


def _empty_file() -> bytes:
    return b""


def _ragged_row() -> bytes:
    return _csv_bytes(_fixture_rows()) + b"40,short\n"


@pytest.mark.parametrize(
    ("make_csv", "message"),
    [
        (_missing_column, "Gender Polarity"),
        (_non_integer_week, "Week"),
        (_duplicate_week, "duplicate"),
        (_eleven_rows, "expected 10"),
        (_nine_rows, "expected 10"),
        (_empty_file, "header"),
        (_ragged_row, "cell count"),
    ],
)
def test_malformed_csv_fails_the_build_and_the_cli(
    workspace: Workspace, make_csv: Callable[[], bytes], message: str
) -> None:
    workspace.write_csv(make_csv())
    with pytest.raises(StageCorrespondenceError, match=message):
        workspace.build()
    assert main(workspace.argv()) == 1
    assert not workspace.artifact_path.exists()


def test_missing_vendored_csv_fails_with_a_sync_hint(workspace: Workspace) -> None:
    workspace.csv_path.unlink()
    with pytest.raises(StageCorrespondenceError, match="sync_content"):
        workspace.build()
    assert main(workspace.argv()) == 1


def test_missing_content_version_fails_the_cli(workspace: Workspace) -> None:
    (workspace.content_dir / "CONTENT_VERSION").unlink()
    assert main(workspace.argv()) == 1


# ── supersessions ───────────────────────────────────────────────────────


def _entry(**overrides: str) -> list[dict[str, str]]:
    first = {**_SUPERSESSIONS[0], **overrides}
    return [first, *_SUPERSESSIONS[1:]]


@pytest.mark.parametrize(
    ("entries", "message"),
    [
        (_entry(stage_id="indigo"), "unknown stage_id"),
        (_entry(field="title"), "unknown field"),
        (_entry(value="Universal Love"), "no-op"),
        (_entry(csv_value="Cosmic Love"), "stale"),
        (_entry(authority="markdown/04-blue/99-missing.md"), "does not exist"),
        (_entry(authority="markdown/backup/old.md"), "backup"),
        (_entry(authority="resources/community-love.md"), "must be under markdown/"),
        # Escapes then re-enters markdown/: only the traversal rule rejects it.
        (
            _entry(authority="markdown/../markdown/04-blue/02-community-love.md"),
            "must be under markdown/",
        ),
        (_entry(authority="markdown/08-teal/02-wisdom.md"), "does not contain"),
        (
            [
                {key: value for key, value in _SUPERSESSIONS[0].items() if key != "authority"},
                *_SUPERSESSIONS[1:],
            ],
            "keys",
        ),
        ([{**_SUPERSESSIONS[0], "note": "x"}, *_SUPERSESSIONS[1:]], "keys"),
        ([_SUPERSESSIONS[0], _SUPERSESSIONS[0]], "duplicate"),
    ],
)
def test_invalid_supersession_fails_the_build_and_the_cli(
    workspace: Workspace, entries: list[dict[str, str]], message: str
) -> None:
    workspace.write_supersessions(entries)
    with pytest.raises(StageCorrespondenceError, match=message):
        workspace.build()
    assert main(workspace.argv()) == 1


@pytest.mark.parametrize(
    "authority",
    [
        # Each collapses, under PurePosixPath, onto the uncontracted
        # markdown/backup/old.md (which does contain the value), so a check on
        # the raw string would wave it through.
        "markdown/./backup/old.md",
        "markdown//backup/old.md",
        "markdown/./backup/old.md/.",
        "markdown/.//backup/old.md",
        # Non-canonical spellings of a contracted chapter are refused too: the
        # authority must be written exactly as the file is named.
        "markdown/04-blue/./02-community-love.md",
        "markdown/04-blue//02-community-love.md",
        "markdown/04-blue/02-community-love.md/",
    ],
)
def test_a_non_canonical_authority_spelling_is_refused(
    workspace: Workspace, authority: str
) -> None:
    """Only the canonical spelling is checked, so ``.`` and ``//`` cannot reach backup/."""
    workspace.write_supersessions(_entry(authority=authority))
    with pytest.raises(StageCorrespondenceError, match="canonical"):
        workspace.build()
    assert main(workspace.argv()) == 1


@pytest.mark.parametrize(
    ("authority", "message"),
    [
        ("./markdown/04-blue/02-community-love.md", "canonical"),
        ("/markdown/04-blue/02-community-love.md", "must be under markdown/"),
        ("markdown", "must be under markdown/"),
        ("markdown/", "canonical"),
    ],
)
def test_an_authority_outside_markdown_files_is_refused(
    workspace: Workspace, authority: str, message: str
) -> None:
    """Leading ``./``, absolute paths and the bare directory never name a chapter."""
    workspace.write_supersessions(_entry(authority=authority))
    with pytest.raises(StageCorrespondenceError, match=message):
        workspace.build()


def test_no_op_supersession_like_the_stale_teal_colour_is_rejected(workspace: Workspace) -> None:
    """The dropped 'stage 8 color Teal' entry would come back as a no-op; it must fail."""
    workspace.write_supersessions(
        [
            *_SUPERSESSIONS,
            {
                "stage_id": "teal",
                "field": "spiral_dynamics_color",
                "csv_value": "Teal",
                "value": "Teal",
                "authority": "markdown/08-teal/02-wisdom.md",
            },
        ]
    )
    with pytest.raises(StageCorrespondenceError, match="no-op"):
        workspace.build()


def test_supersessions_file_must_hold_a_list(workspace: Workspace) -> None:
    workspace.supersessions_path.write_text(json.dumps({"supersessions": {"blue": "x"}}))
    with pytest.raises(StageCorrespondenceError, match="list"):
        load_supersessions(workspace.supersessions_path)
    workspace.supersessions_path.write_text("{not json")
    with pytest.raises(StageCorrespondenceError, match="JSON"):
        load_supersessions(workspace.supersessions_path)


def test_authority_match_ignores_case_and_line_wrapping(workspace: Workspace) -> None:
    """A chapter reading "COMMUNITY" then "love" on the next line satisfies 'Community Love'."""
    check_authority(load_supersessions(workspace.supersessions_path)[0], workspace.content_dir)


def test_committed_supersessions_are_exactly_the_three_ratified_departures() -> None:
    entries = load_supersessions(generator.SUPERSESSIONS_PATH)
    assert {(entry.stage_id, entry.field) for entry in entries} == {
        ("blue", "aspect"),
        ("teal", "aspect"),
        ("teal", "relationship_to_free_will"),
    }


def test_committed_supersession_authorities_hold_in_the_vendored_markdown() -> None:
    """Each authority is real, contracted (non-backup) markdown containing the value."""
    for entry in load_supersessions(generator.SUPERSESSIONS_PATH):
        assert entry.csv_value != entry.value
        check_authority(entry, generator.CONTENT_DIR)


# ── CLI / drift gate ────────────────────────────────────────────────────


def test_cli_writes_the_rendered_artifact_then_check_passes(workspace: Workspace) -> None:
    assert main(workspace.argv()) == 0
    assert workspace.artifact_path.read_text() == render(workspace.build())
    assert main(workspace.argv("--check")) == 0


def test_check_fails_on_a_drifted_artifact(
    workspace: Workspace, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(workspace.argv()) == 0
    drifted = workspace.artifact_path.read_text().replace("Community Love", "Universal Love")
    workspace.artifact_path.write_text(drifted)

    assert main(workspace.argv("--check")) == 1
    assert "stale" in capsys.readouterr().err
    # --check never rewrites the artifact.
    assert workspace.artifact_path.read_text() == drifted


def test_check_fails_when_the_artifact_is_missing(workspace: Workspace) -> None:
    assert main(workspace.argv("--check")) == 1


def test_check_fails_when_inputs_change_under_a_committed_artifact(workspace: Workspace) -> None:
    assert main(workspace.argv()) == 0
    rows = _fixture_rows()
    rows[1]["Relationship to Free Will"] = "Pleasure Seeker"
    workspace.write_csv(_csv_bytes(rows))
    assert main(workspace.argv("--check")) == 1


def test_cli_rejects_output_that_violates_the_schema(workspace: Workspace) -> None:
    schema = json.loads(workspace.schema_path.read_text())
    schema["properties"]["schema_version"] = {"const": "9.9.9"}
    workspace.schema_path.write_text(json.dumps(schema))
    assert main(workspace.argv()) == 1
    assert not workspace.artifact_path.exists()


def _run_module(*args: str) -> subprocess.CompletedProcess[str]:
    """Run the generator the way CI does: ``python -m`` from ``backend/``."""
    return subprocess.run(
        [sys.executable, "-m", "scripts.build_stage_correspondence", *args],
        cwd=_BACKEND_DIR,
        capture_output=True,
        text=True,
        check=False,
    )


def test_module_entry_point_exit_code_reaches_the_shell(workspace: Workspace) -> None:
    """Meta-test: the CI step's exit status is the gate's verdict, never swallowed."""
    assert main(workspace.argv()) == 0
    clean = _run_module(*workspace.argv("--check"))
    assert clean.returncode == 0, clean.stderr

    workspace.artifact_path.write_text(workspace.artifact_path.read_text().replace("Adept", "Sage"))
    drifted = _run_module(*workspace.argv("--check"))
    assert drifted.returncode == 1
    assert "stale" in drifted.stderr
