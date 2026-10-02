"""Tests for the stage-correspondence artifact loader (#2665).

The loader is the one place the app reads ``stage_correspondence.json``: the
artifact ``scripts/build_stage_correspondence.py`` generates from the Complete
Map CSV vendored at the ``CONTENT_VERSION`` pin. These tests pin the happy path
to the vendored pin and walk each refusal, so a malformed artifact surfaces as
one typed error before anything is written.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

import scripts.build_stage_correspondence as generator
from curriculum import CurriculumDataError
from curriculum.stage_correspondence import (
    ARTIFACT_PATH,
    CORRESPONDENCE_FIELDS,
    SCHEMA_PATH,
    SUPPORTED_SCHEMA_VERSION,
    StageCorrespondenceError,
    load_stage_correspondence,
    stage_correspondence,
)
from domain.constants import STAGE_START_WEEKS, TOTAL_STAGES
from domain.stage_keys import STAGE_KEYS
from scripts.sync_content import read_content_version

_CONTENT_DIR = Path(__file__).resolve().parents[1] / "content"
_STAGE_INDEX_RED = 2
_STAGE_INDEX_BLUE = 3
_STAGE_INDEX_TEAL = 7


def _artifact_payload() -> dict[str, Any]:
    """A fresh, mutable copy of the committed artifact."""
    payload: dict[str, Any] = json.loads(ARTIFACT_PATH.read_text())
    return payload


def _write(tmp_path: Path, payload: object) -> Path:
    """Write ``payload`` as JSON to a scratch artifact path."""
    path = tmp_path / "stage_correspondence.json"
    path.write_text(json.dumps(payload))
    return path


def test_the_default_artifact_is_sourced_from_the_vendored_pin() -> None:
    """The artifact's source sha is the commit ``backend/content`` is vendored at."""
    artifact = stage_correspondence()

    assert artifact.source.sha == read_content_version(_CONTENT_DIR)["sha"]
    assert artifact.source.repo == "Geoffe-Ga/aptitude-course"
    assert artifact.source.csv_path == (
        "google_docs/database_of_course_curriculum/APTITUDE Complete Map.csv"
    )
    assert artifact.schema_version == SUPPORTED_SCHEMA_VERSION == "1.0.0"


def test_the_default_artifact_carries_ten_keyed_stages_on_the_schedule() -> None:
    """Keys, numbers and start weeks line up with the domain constants."""
    stages = stage_correspondence().stages

    assert len(stages) == TOTAL_STAGES
    assert tuple(s.stage_key for s in stages) == STAGE_KEYS
    assert [s.stage_number for s in stages] == list(range(1, TOTAL_STAGES + 1))
    assert tuple(s.start_week for s in stages) == STAGE_START_WEEKS


def test_supersessions_are_reflected_in_the_loaded_values() -> None:
    """The ratified departures from the CSV are what the loader returns."""
    stages = stage_correspondence().stages

    assert stages[_STAGE_INDEX_BLUE].aspect == "Community Love"
    assert stages[_STAGE_INDEX_TEAL].relationship_to_free_will == "True Self Embodier"


def test_every_record_field_equals_the_artifact() -> None:
    """The loader copies each of the seven fields verbatim, stage by stage."""
    raw = _artifact_payload()["stages"]
    for record, entry in zip(stage_correspondence().stages, raw, strict=True):
        for field in CORRESPONDENCE_FIELDS:
            assert getattr(record, field) == entry[field], (entry["id"], field)


def test_the_default_load_is_cached() -> None:
    """One parse per process: the seeder and the router share the same object."""
    assert stage_correspondence() is stage_correspondence()


def test_an_explicit_path_parses_fresh(tmp_path: Path) -> None:
    """A path argument bypasses the cache and reads the file given."""
    payload = _artifact_payload()
    payload["stages"][0]["aspect"] = "Fresh Agency"

    artifact = load_stage_correspondence(_write(tmp_path, payload))

    assert artifact.stages[0].aspect == "Fresh Agency"


def test_the_loader_keys_mirror_the_generator_and_the_schema() -> None:
    """Three copies of the stage ids and the version must agree."""
    schema = json.loads(SCHEMA_PATH.read_text())
    positional = [
        entry["allOf"][1]["properties"]["id"]["const"]
        for entry in schema["properties"]["stages"]["prefixItems"]
    ]

    assert generator.STAGE_IDS == STAGE_KEYS
    assert tuple(positional) == STAGE_KEYS
    assert generator.ARTIFACT_SCHEMA_VERSION == SUPPORTED_SCHEMA_VERSION
    assert schema["properties"]["schema_version"]["const"] == SUPPORTED_SCHEMA_VERSION
    assert generator.ARTIFACT_PATH == ARTIFACT_PATH
    assert generator.SCHEMA_PATH == SCHEMA_PATH
    assert tuple(generator.FIELD_COLUMNS) == CORRESPONDENCE_FIELDS


def test_the_error_is_a_curriculum_data_error() -> None:
    """Callers that already catch curriculum failures catch this one too."""
    assert issubclass(StageCorrespondenceError, CurriculumDataError)


def test_a_missing_artifact_is_refused(tmp_path: Path) -> None:
    """No file is a typed error, not a raw OSError."""
    with pytest.raises(StageCorrespondenceError, match="not found"):
        load_stage_correspondence(tmp_path / "absent.json")


def test_malformed_json_is_refused(tmp_path: Path) -> None:
    """Truncated JSON is a typed error, not a raw JSONDecodeError."""
    path = tmp_path / "stage_correspondence.json"
    path.write_text('{"schema_version": "1.0.0", ')

    with pytest.raises(StageCorrespondenceError, match="is not valid JSON"):
        load_stage_correspondence(path)


def test_a_non_object_document_is_refused(tmp_path: Path) -> None:
    """A bare array has no schema_version to gate on."""
    with pytest.raises(StageCorrespondenceError, match="must be a JSON object"):
        load_stage_correspondence(_write(tmp_path, []))


def test_an_unknown_schema_version_is_refused_by_name(tmp_path: Path) -> None:
    """The version gate runs before the schema, so the message names the version."""
    payload = _artifact_payload()
    payload["schema_version"] = "9.9.9"

    with pytest.raises(
        StageCorrespondenceError, match=re.escape("unsupported schema_version '9.9.9'")
    ):
        load_stage_correspondence(_write(tmp_path, payload))


def test_an_extra_key_violates_the_schema(tmp_path: Path) -> None:
    """The schema is closed: an unexpected stage key is refused."""
    payload = _artifact_payload()
    payload["stages"][0]["colour_hex"] = "#f5f5dc"

    with pytest.raises(StageCorrespondenceError, match="violates its schema"):
        load_stage_correspondence(_write(tmp_path, payload))


def test_a_duplicate_stage_is_refused(tmp_path: Path) -> None:
    """Two 'red' entries cannot both be Stage 3 and Stage 4."""
    payload = _artifact_payload()
    payload["stages"][_STAGE_INDEX_BLUE] = dict(payload["stages"][_STAGE_INDEX_RED])

    with pytest.raises(StageCorrespondenceError, match="violates its schema"):
        load_stage_correspondence(_write(tmp_path, payload))


def test_a_missing_stage_is_refused(tmp_path: Path) -> None:
    """Nine stages are not the program."""
    payload = _artifact_payload()
    payload["stages"] = payload["stages"][:-1]

    with pytest.raises(StageCorrespondenceError, match="violates its schema"):
        load_stage_correspondence(_write(tmp_path, payload))


def test_a_start_week_off_the_schedule_is_refused(tmp_path: Path) -> None:
    """The schema allows any positive week; the loader checks the real schedule."""
    payload = _artifact_payload()
    payload["stages"][_STAGE_INDEX_BLUE]["start_week"] = 11

    with pytest.raises(StageCorrespondenceError, match="stage 'blue' start_week 11 is not week 10"):
        load_stage_correspondence(_write(tmp_path, payload))
