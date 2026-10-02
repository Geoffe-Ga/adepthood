"""Typed loader for the generated stage-correspondence artifact (#2665).

``stage_correspondence.json`` is written by
``scripts/build_stage_correspondence.py`` from the Complete Map CSV that
``scripts/sync_content.py`` vendors at the ``backend/content/CONTENT_VERSION``
pin, plus adepthood's ratified supersessions (#2664). It carries, per Stage,
the stable colour-slug key, the start week and the seven correspondence
fields, and at the top a ``source`` block naming the upstream repo, commit and
the CSV's sha256. That provenance is what the stage seeder stamps on every
``CourseStage`` row.

Loading is strict and ordered so the error names the real fault:

1. read and parse the JSON;
2. gate ``schema_version`` against :data:`SUPPORTED_SCHEMA_VERSION`, before
   the schema, so a version bump reads as one and not as a schema violation;
3. validate against ``stage_correspondence.schema.json``, which pins the ten
   stages by position (a duplicate, missing, extra or reordered stage fails
   there);
4. check each ``start_week`` against :data:`domain.constants.STAGE_START_WEEKS`,
   the one thing the schema cannot know.

Every failure is a :class:`StageCorrespondenceError`. Nothing here runs at
import time: :func:`stage_correspondence` parses on first call and caches, so
a malformed artifact fails the startup seeder (logged ``seed_failed``) rather
than crashing ``import main``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Final

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from curriculum import CurriculumDataError
from domain.constants import STAGE_START_WEEKS

_CURRICULUM_DIR: Final[Path] = Path(__file__).resolve().parent

#: The generated artifact the app loads by default.
ARTIFACT_PATH: Final[Path] = _CURRICULUM_DIR / "stage_correspondence.json"

#: The artifact's JSON Schema, owned alongside the generator.
SCHEMA_PATH: Final[Path] = _CURRICULUM_DIR / "stage_correspondence.schema.json"

#: The only artifact shape this loader understands. Pinned equal to the
#: generator's ``ARTIFACT_SCHEMA_VERSION`` by test.
SUPPORTED_SCHEMA_VERSION: Final[str] = "1.0.0"

#: The seven per-Stage correspondence fields, in the generator's column order.
CORRESPONDENCE_FIELDS: Final[tuple[str, ...]] = (
    "category",
    "aspect",
    "spiral_dynamics_color",
    "growing_up_stage",
    "divine_gender_polarity",
    "relationship_to_free_will",
    "free_will_description",
)


class StageCorrespondenceError(CurriculumDataError):
    """The stage-correspondence artifact is missing, malformed or inconsistent."""


@dataclass(frozen=True, slots=True)
class CorrespondenceSource:
    """Where the artifact's data came from: the upstream commit and CSV digest."""

    repo: str
    sha: str
    csv_path: str
    sha256: str


@dataclass(frozen=True, slots=True)
class StageCorrespondenceRecord:
    """One Stage's stable key, schedule position and seven correspondences."""

    stage_key: str
    stage_number: int
    start_week: int
    category: str
    aspect: str
    spiral_dynamics_color: str
    growing_up_stage: str
    divine_gender_polarity: str
    relationship_to_free_will: str
    free_will_description: str


@dataclass(frozen=True, slots=True)
class StageCorrespondenceArtifact:
    """The validated artifact: its shape version, provenance and ten Stages."""

    schema_version: str
    source: CorrespondenceSource
    stages: tuple[StageCorrespondenceRecord, ...]


def _read_payload(path: Path) -> dict[str, Any]:
    """Read ``path`` as a JSON object, mapping every failure to a typed error."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        msg = f"stage correspondence artifact not found at {path}"
        raise StageCorrespondenceError(msg) from exc
    try:
        payload: object = json.loads(text)
    except json.JSONDecodeError as exc:
        msg = f"stage correspondence artifact at {path} is not valid JSON"
        raise StageCorrespondenceError(msg) from exc
    if not isinstance(payload, dict):
        msg = f"stage correspondence artifact at {path} must be a JSON object"
        raise StageCorrespondenceError(msg)
    return payload


def _check_schema_version(payload: dict[str, Any], path: Path) -> None:
    """Refuse any shape version other than the one this loader understands."""
    version = payload.get("schema_version")
    if version != SUPPORTED_SCHEMA_VERSION:
        msg = (
            f"stage correspondence artifact at {path} has unsupported "
            f"schema_version {version!r} (expected {SUPPORTED_SCHEMA_VERSION!r})"
        )
        raise StageCorrespondenceError(msg)


def _check_schema(payload: dict[str, Any], path: Path) -> None:
    """Validate ``payload`` against the artifact's JSON Schema."""
    schema: Any = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    try:
        Draft202012Validator(schema).validate(payload)
    except ValidationError as exc:
        msg = f"stage correspondence artifact at {path} violates its schema: {exc.message}"
        raise StageCorrespondenceError(msg) from exc


def _to_record(entry: dict[str, Any]) -> StageCorrespondenceRecord:
    """Build one record from a schema-valid stage entry."""
    return StageCorrespondenceRecord(
        stage_key=entry["id"],
        stage_number=entry["stage_number"],
        start_week=entry["start_week"],
        **{field: entry[field] for field in CORRESPONDENCE_FIELDS},
    )


def _check_start_weeks(stages: tuple[StageCorrespondenceRecord, ...]) -> None:
    """Each Stage must open on the week the program schedule says it does."""
    for stage, expected in zip(stages, STAGE_START_WEEKS, strict=True):
        if stage.start_week != expected:
            msg = (
                f"stage {stage.stage_key!r} start_week {stage.start_week} "
                f"is not week {expected} of the program schedule"
            )
            raise StageCorrespondenceError(msg)


def load_stage_correspondence(path: Path) -> StageCorrespondenceArtifact:
    """Load and validate the artifact at ``path``; never cached.

    Raises :class:`StageCorrespondenceError` on any fault, before the caller
    can act on partial data.
    """
    payload = _read_payload(path)
    _check_schema_version(payload, path)
    _check_schema(payload, path)
    stages = tuple(_to_record(entry) for entry in payload["stages"])
    _check_start_weeks(stages)
    return StageCorrespondenceArtifact(
        schema_version=payload["schema_version"],
        source=CorrespondenceSource(**payload["source"]),
        stages=stages,
    )


@cache
def stage_correspondence() -> StageCorrespondenceArtifact:
    """Return the committed artifact, parsed on first call and then cached.

    Reads :data:`ARTIFACT_PATH` at call time, never at import, so a broken
    artifact is reported by whoever first asks for it.
    """
    return load_stage_correspondence(ARTIFACT_PATH)
