"""Generate the versioned stage-correspondence artifact from vendored course data.

Issue #2664 (epic #2663): the seven per-stage correspondence attributes
(category, aspect, Spiral Dynamics colour, Growing Up stage, divine gender
polarity, relationship to free will and its description) used to be
hand-transcribed from the course's Complete Map spreadsheet into
``src/curriculum/archetypal_wavelength.json``. Hand transcription is how
stage 2 kept a free-will archetype upstream had already retired (#2915).
This script replaces transcription with generation:

    python -m scripts.build_stage_correspondence           # (re)write the artifact
    python -m scripts.build_stage_correspondence --check   # CI drift gate

``--check`` runs in the ``content-drift`` job of ``.github/workflows/backend-ci.yml``
(#2667), right after ``sync_content --check``;
``tests/scripts/test_stage_correspondence_drift_gate.py`` fails if that step is
removed, reordered, commented out or allowed to swallow its exit code.

Inputs, all local (no network, so the CI drift-check job can run it):

* ``backend/content/curriculum/aptitude_complete_map.csv``, vendored
  byte-for-byte by :mod:`scripts.sync_content` from the same pinned
  ``aptitude-course`` SHA as the rest of ``backend/content/``.
* ``backend/content/CONTENT_VERSION``, whose ``sha`` becomes the artifact's
  ``source.sha``.
* ``src/curriculum/stage_correspondence_supersessions.json``, the
  adepthood-owned list of ratified departures from the CSV. Each entry must
  name the CSV value it overrides (so a later upstream edit makes it fail as
  stale), must actually change that value (no-ops fail), and must cite
  contracted, non-backup vendored markdown that contains the new value.

Output: ``src/curriculum/stage_correspondence.json``, validated against
``stage_correspondence.schema.json`` and rendered deterministically (sorted
keys, no timestamp) so ``--check`` can compare bytes. Cell values are
normalised with ``str.strip()`` only; the pinned CSV carries edge
whitespace (``"Whole Adept "``) but no internal runs worth collapsing.

The script deliberately imports nothing from ``src/``: the CI drift-check job
installs only ``httpx`` and ``jsonschema`` and sets no ``PYTHONPATH``. Parity
between the artifact and ``archetypal_wavelength.json`` is gated in the
pytest suite instead (``tests/test_stage_correspondence.py``).

Exit codes: 0 when the artifact was written or is current, 1 on drift or on
any input the generator refuses.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from scripts.sync_content import (
    CONTENT_REPO,
    STAGE_CORRESPONDENCE_CSV_SOURCE,
    STAGE_CORRESPONDENCE_CSV_VENDORED,
    SyncContentError,
    read_content_version,
)

_BACKEND_DIR = Path(__file__).resolve().parents[1]

#: The vendored content tree (mirrors ``sync_content``'s default target).
CONTENT_DIR = _BACKEND_DIR / "content"

_CURRICULUM_DIR = _BACKEND_DIR / "src" / "curriculum"

#: The generated artifact and its contract.
ARTIFACT_PATH = _CURRICULUM_DIR / "stage_correspondence.json"
SCHEMA_PATH = _CURRICULUM_DIR / "stage_correspondence.schema.json"

#: Adepthood-owned ratified departures from the CSV.
SUPERSESSIONS_PATH = _CURRICULUM_DIR / "stage_correspondence_supersessions.json"

#: Semantic version of the artifact's shape (not of the course data).
ARTIFACT_SCHEMA_VERSION = "1.0.0"

#: Stable stage ids, in program order. They reuse upstream's ``stage_intros``
#: id prefixes; note ``clearlight`` is one word although the CSV colour reads
#: "Clear Light".
STAGE_IDS: tuple[str, ...] = (
    "beige",
    "purple",
    "red",
    "blue",
    "orange",
    "green",
    "yellow",
    "teal",
    "ultraviolet",
    "clearlight",
)
STAGE_COUNT = len(STAGE_IDS)

#: The CSV column holding each stage's start week (the source has no id).
WEEK_COLUMN = "Week"

#: Artifact field → CSV column header (headers are matched after ``strip()``).
FIELD_COLUMNS: dict[str, str] = {
    "category": "Category",
    "aspect": "Aspect",
    "spiral_dynamics_color": "Spiral Dynamics Color",
    "growing_up_stage": "Growing Up Stage",
    "divine_gender_polarity": "Gender Polarity",
    "relationship_to_free_will": "Relationship to Free Will",
    "free_will_description": "Free Will Description",
}

#: A supersession's authority must be contracted vendored markdown...
AUTHORITY_PREFIX = "markdown/"
#: ...and never the uncontracted backup copies that are vendored beside it.
AUTHORITY_EXCLUDED_PREFIX = "markdown/backup/"

#: The two prefixes as path segments, which is how they are compared.
_AUTHORITY_PREFIX_PARTS = PurePosixPath(AUTHORITY_PREFIX).parts
_AUTHORITY_EXCLUDED_PARTS = PurePosixPath(AUTHORITY_EXCLUDED_PREFIX).parts

_SUPERSESSIONS_KEY = "supersessions"


class StageCorrespondenceError(Exception):
    """The inputs cannot produce a trustworthy artifact, or it has drifted."""


@dataclass(frozen=True)
class Supersession:
    """One ratified departure from a CSV cell, with its textual authority."""

    stage_id: str
    field: str
    csv_value: str
    value: str
    authority: str


_SUPERSESSION_KEYS = frozenset(Supersession.__dataclass_fields__)


def _header_index(header: list[str]) -> dict[str, int]:
    """Map each stripped header to its column, requiring every needed column."""
    index = {name.strip(): position for position, name in enumerate(header)}
    for column in (WEEK_COLUMN, *FIELD_COLUMNS.values()):
        if column not in index:
            msg = f"stage-correspondence CSV has no {column!r} column"
            raise StageCorrespondenceError(msg)
    return index


def _parse_week(row: dict[str, str]) -> int:
    """Return the row's start week, rejecting a non-integer cell."""
    try:
        return int(row[WEEK_COLUMN])
    except ValueError as exc:
        msg = f"stage-correspondence CSV has a non-integer {WEEK_COLUMN}: {row[WEEK_COLUMN]!r}"
        raise StageCorrespondenceError(msg) from exc


def _check_weeks(rows: list[dict[str, str]]) -> None:
    """Require exactly one row per stage, each with a distinct start week."""
    weeks = [_parse_week(row) for row in rows]
    if len(set(weeks)) != len(weeks):
        msg = f"stage-correspondence CSV has duplicate {WEEK_COLUMN} values: {sorted(weeks)}"
        raise StageCorrespondenceError(msg)
    if len(rows) != STAGE_COUNT:
        msg = f"stage-correspondence CSV has {len(rows)} rows; expected {STAGE_COUNT}"
        raise StageCorrespondenceError(msg)


def _read_records(path: Path) -> list[list[str]]:
    """Parse ``path`` into raw CSV records, requiring at least a header row."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        msg = f"{path} is missing — vendor it with `python -m scripts.sync_content --ref <sha>`"
        raise StageCorrespondenceError(msg) from exc
    # newline="" keeps quoted multi-line cells intact, as the csv module requires.
    records = list(csv.reader(io.StringIO(text, newline="")))
    if not records:
        msg = f"{path} is empty: no header row"
        raise StageCorrespondenceError(msg)
    return records


def _body_records(path: Path, header: list[str], records: list[list[str]]) -> list[list[str]]:
    """Drop blank records and reject any whose width differs from the header."""
    body = [record for record in records if "".join(record).strip()]
    if {len(record) for record in body} - {len(header)}:
        msg = f"{path} has a row whose cell count differs from its header"
        raise StageCorrespondenceError(msg)
    return body


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    """Read the vendored CSV into stripped ``{column: cell}`` rows sorted by week."""
    header, *records = _read_records(path)
    index = _header_index(header)
    rows = [
        {column: record[position].strip() for column, position in index.items()}
        for record in _body_records(path, header, records)
    ]
    _check_weeks(rows)
    return sorted(rows, key=_parse_week)


def load_supersessions(path: Path) -> list[Supersession]:
    """Parse the supersession data file into :class:`Supersession` entries."""
    try:
        payload: Any = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        msg = f"{path} is not valid JSON: {exc}"
        raise StageCorrespondenceError(msg) from exc
    entries = payload.get(_SUPERSESSIONS_KEY) if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        msg = f"{path} must hold a {_SUPERSESSIONS_KEY!r} list"
        raise StageCorrespondenceError(msg)
    return [_parse_supersession(entry) for entry in entries]


def _parse_supersession(entry: object) -> Supersession:
    """Build one :class:`Supersession`, requiring exactly its five string keys."""
    if not isinstance(entry, dict) or set(entry) != _SUPERSESSION_KEYS:
        msg = f"supersession entry must have exactly the keys {sorted(_SUPERSESSION_KEYS)}"
        raise StageCorrespondenceError(msg)
    return Supersession(**{key: str(entry[key]) for key in _SUPERSESSION_KEYS})


def _collapse(text: str) -> str:
    """Case-fold and collapse whitespace, for tolerant containment checks."""
    return " ".join(text.split()).casefold()


def _authority_path(entry: Supersession, content_dir: Path) -> Path:
    """Resolve the authority, requiring contracted (non-backup) markdown.

    The containment rules are tested on the normalised path's *parts*, and
    only after requiring the authority to be spelled canonically: a raw-string
    prefix test would pass ``markdown/./backup/x.md`` or ``markdown//backup/x.md``,
    which ``PurePosixPath`` then collapses onto the excluded backup copy.
    """
    authority = PurePosixPath(entry.authority)
    if str(authority) != entry.authority:
        msg = (
            f"supersession authority {entry.authority!r} is not canonical; "
            f"write it as {str(authority)!r}"
        )
        raise StageCorrespondenceError(msg)
    parts = authority.parts
    if (
        parts[: len(_AUTHORITY_PREFIX_PARTS)] != _AUTHORITY_PREFIX_PARTS
        or len(parts) <= len(_AUTHORITY_PREFIX_PARTS)
        or ".." in parts
    ):
        msg = f"supersession authority {entry.authority!r} must be under {AUTHORITY_PREFIX}"
        raise StageCorrespondenceError(msg)
    if parts[: len(_AUTHORITY_EXCLUDED_PARTS)] == _AUTHORITY_EXCLUDED_PARTS:
        msg = f"supersession authority {entry.authority!r} is uncontracted backup copy"
        raise StageCorrespondenceError(msg)
    return content_dir / authority


def check_authority(entry: Supersession, content_dir: Path) -> None:
    """Require the authority to be contracted markdown that contains the value."""
    path = _authority_path(entry, content_dir)
    if not path.is_file():
        msg = f"supersession authority {entry.authority!r} does not exist in {content_dir}"
        raise StageCorrespondenceError(msg)
    if _collapse(entry.value) not in _collapse(path.read_text(encoding="utf-8")):
        msg = f"supersession authority {entry.authority!r} does not contain {entry.value!r}"
        raise StageCorrespondenceError(msg)


def _check_supersession(
    entry: Supersession, rows_by_id: dict[str, dict[str, str]], content_dir: Path
) -> None:
    """Reject an unknown target, a no-op, a stale CSV value or a weak authority."""
    if entry.stage_id not in rows_by_id:
        msg = f"supersession names unknown stage_id {entry.stage_id!r}"
        raise StageCorrespondenceError(msg)
    if entry.field not in FIELD_COLUMNS:
        msg = f"supersession names unknown field {entry.field!r}"
        raise StageCorrespondenceError(msg)
    if entry.csv_value == entry.value:
        msg = f"supersession {entry.stage_id}.{entry.field} is a no-op ({entry.value!r})"
        raise StageCorrespondenceError(msg)
    cell = rows_by_id[entry.stage_id][FIELD_COLUMNS[entry.field]]
    if cell != entry.csv_value:
        msg = (
            f"supersession {entry.stage_id}.{entry.field} is stale: csv_value "
            f"{entry.csv_value!r} but the CSV now says {cell!r}"
        )
        raise StageCorrespondenceError(msg)
    check_authority(entry, content_dir)


def _overrides(
    supersessions: list[Supersession],
    rows_by_id: dict[str, dict[str, str]],
    content_dir: Path,
) -> dict[tuple[str, str], str]:
    """Validate every supersession and index its value by ``(stage_id, field)``."""
    overrides: dict[tuple[str, str], str] = {}
    for entry in supersessions:
        _check_supersession(entry, rows_by_id, content_dir)
        key = (entry.stage_id, entry.field)
        if key in overrides:
            msg = f"duplicate supersession for {entry.stage_id}.{entry.field}"
            raise StageCorrespondenceError(msg)
        overrides[key] = entry.value
    return overrides


def _stage(
    stage_number: int, row: dict[str, str], overrides: dict[tuple[str, str], str]
) -> dict[str, Any]:
    """Assemble one artifact stage from its CSV row plus any overrides."""
    stage_id = STAGE_IDS[stage_number - 1]
    stage: dict[str, Any] = {
        "id": stage_id,
        "stage_number": stage_number,
        "start_week": _parse_week(row),
    }
    for field, column in FIELD_COLUMNS.items():
        stage[field] = overrides.get((stage_id, field), row[column])
    return stage


def build(content_dir: Path, supersessions_path: Path) -> dict[str, Any]:
    """Build the artifact dict from the vendored CSV and the supersession list."""
    csv_path = content_dir / STAGE_CORRESPONDENCE_CSV_VENDORED
    rows = read_csv_rows(csv_path)
    rows_by_id = dict(zip(STAGE_IDS, rows, strict=True))
    supersessions = load_supersessions(supersessions_path)
    overrides = _overrides(supersessions, rows_by_id, content_dir)
    try:
        sha = read_content_version(content_dir)["sha"]
    except SyncContentError as exc:
        raise StageCorrespondenceError(str(exc)) from exc
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "source": {
            "repo": CONTENT_REPO,
            "sha": sha,
            "csv_path": STAGE_CORRESPONDENCE_CSV_SOURCE,
            "sha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
        },
        "supersessions": [asdict(entry) for entry in supersessions],
        "stages": [_stage(number, row, overrides) for number, row in enumerate(rows, start=1)],
    }


def render(artifact: dict[str, Any]) -> str:
    """Serialise deterministically: sorted keys, two-space indent, no timestamp."""
    return json.dumps(artifact, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def validate(artifact: dict[str, Any], schema_path: Path) -> None:
    """Validate ``artifact`` against the Draft 2020-12 schema at ``schema_path``."""
    schema: Any = json.loads(schema_path.read_text(encoding="utf-8"))
    try:
        Draft202012Validator(schema).validate(artifact)
    except ValidationError as exc:
        msg = f"stage-correspondence artifact violates its schema: {exc.message}"
        raise StageCorrespondenceError(msg) from exc


def _check_current(rendered: str, artifact_path: Path) -> None:
    """Raise unless the committed artifact equals the fresh rendering byte-for-byte."""
    try:
        committed = artifact_path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        msg = f"{artifact_path} is missing — run `python -m scripts.build_stage_correspondence`"
        raise StageCorrespondenceError(msg) from exc
    if committed != rendered:
        msg = (
            f"{artifact_path} is stale: it differs from a regeneration of the vendored "
            "CSV and supersessions — run `python -m scripts.build_stage_correspondence`"
        )
        raise StageCorrespondenceError(msg)


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Parse the CLI flags; every path defaults to the committed location."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail on drift; write nothing")
    parser.add_argument("--content-dir", type=Path, default=CONTENT_DIR)
    parser.add_argument("--supersessions", type=Path, default=SUPERSESSIONS_PATH)
    parser.add_argument("--schema", type=Path, default=SCHEMA_PATH)
    parser.add_argument("--artifact", type=Path, default=ARTIFACT_PATH)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns 0 when written or current, 1 on any failure."""
    args = _parse_args(argv)
    try:
        artifact = build(args.content_dir, args.supersessions)
        validate(artifact, args.schema)
        rendered = render(artifact)
        if args.check:
            _check_current(rendered, args.artifact)
            sys.stdout.write(f"{args.artifact} is current\n")
        else:
            args.artifact.write_text(rendered, encoding="utf-8")
            sys.stdout.write(f"wrote {args.artifact}\n")
    except StageCorrespondenceError as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover — exercised by the subprocess meta-test
    sys.exit(main())
