"""Tests for the vendored Archetypal Wavelength curriculum dataset."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from curriculum import (
    CurriculumDataError,
    WavelengthPhase,
    all_stages,
    load_curriculum,
    manifestation,
    stage_curriculum,
)

CANONICAL_PHASE_ORDER = (
    WavelengthPhase.RISING,
    WavelengthPhase.PEAKING,
    WavelengthPhase.WITHDRAWAL,
    WavelengthPhase.DIMINISHING,
    WavelengthPhase.BOTTOMING_OUT,
    WavelengthPhase.RESTORATION,
)

_CANONICAL_STAGE_ONTOLOGY: dict[int, dict[str, str]] = {
    1: {
        "category": "Yes-And-Ness",
        "aspect": "Agency",
        "spiral_dynamics_color": "Beige",
        "growing_up_stage": "Survival",
        "divine_gender_polarity": "Divine Masculine",
        "relationship_to_free_will": "Biological Machine",
    },
    2: {
        "category": "Yes-And-Ness",
        "aspect": "Receptivity",
        "spiral_dynamics_color": "Purple",
        "growing_up_stage": "Magic",
        "divine_gender_polarity": "Divine Feminine",
        "relationship_to_free_will": "Archetype Embodier",
    },
    3: {
        "category": "Love",
        "aspect": "Self-Love",
        "spiral_dynamics_color": "Red",
        "growing_up_stage": "Ego-centrism",
        "divine_gender_polarity": "Divine Masculine",
        "relationship_to_free_will": "Dominator",
    },
    4: {
        "category": "Love",
        "aspect": "Community Love",
        "spiral_dynamics_color": "Blue",
        "growing_up_stage": "Conformity",
        "divine_gender_polarity": "Divine Feminine",
        "relationship_to_free_will": "Victim",
    },
    5: {
        "category": "Understanding",
        "aspect": "Intellectual Understanding",
        "spiral_dynamics_color": "Orange",
        "growing_up_stage": "Achievest",
        "divine_gender_polarity": "Divine Masculine",
        "relationship_to_free_will": "Status Seeker",
    },
    6: {
        "category": "Understanding",
        "aspect": "Embodied Understanding",
        "spiral_dynamics_color": "Green",
        "growing_up_stage": "Pluralistic",
        "divine_gender_polarity": "Divine Feminine",
        "relationship_to_free_will": "Shadow Glorifier",
    },
    7: {
        "category": "Wisdom",
        "aspect": "Systems Wisdom",
        "spiral_dynamics_color": "Yellow",
        "growing_up_stage": "Integrative",
        "divine_gender_polarity": "Divine Masculine",
        "relationship_to_free_will": "Despairing Analyst",
    },
    8: {
        "category": "Wisdom",
        "aspect": "True Self Connection",
        "spiral_dynamics_color": "Teal",
        "growing_up_stage": "Nonduality",
        "divine_gender_polarity": "Divine Feminine",
        "relationship_to_free_will": "True Self Embodier",
    },
    9: {
        "category": "Being",
        "aspect": "Unity",
        "spiral_dynamics_color": "Ultraviolet",
        "growing_up_stage": "Effortless Being",
        "divine_gender_polarity": "Divine Hermaphrodite",
        "relationship_to_free_will": "Blissy Adept",
    },
    10: {
        "category": "Awareness",
        "aspect": "Emptiness",
        "spiral_dynamics_color": "Clear Light",
        "growing_up_stage": "Pure Awareness",
        "divine_gender_polarity": "Divine Hermaphrodite",
        "relationship_to_free_will": "Whole Adept",
    },
}


def test_wavelength_phase_values_are_human_strings() -> None:
    """Enum values are the human-readable phase names, not member names."""
    assert WavelengthPhase.RISING.value == "Rising"
    assert WavelengthPhase.PEAKING.value == "Peaking"
    assert WavelengthPhase.WITHDRAWAL.value == "Withdrawal"
    assert WavelengthPhase.DIMINISHING.value == "Diminishing"
    assert WavelengthPhase.BOTTOMING_OUT.value == "Bottoming Out"
    assert WavelengthPhase.RESTORATION.value == "Restoration"


def test_all_stages_returns_ten_stages_in_order() -> None:
    """all_stages() resolves exactly stage_numbers 1..10, in order."""
    stages = all_stages()
    assert len(stages) == 10
    assert [s.stage_number for s in stages] == list(range(1, 11))


def test_each_stage_has_six_phases_in_canonical_order() -> None:
    """Every stage carries exactly six manifestations in canonical phase order."""
    for stage in all_stages():
        assert len(stage.manifestations) == 6
        phases = tuple(m.phase for m in stage.manifestations)
        assert phases == CANONICAL_PHASE_ORDER


def test_each_manifestation_has_nonempty_integrated_and_shadow() -> None:
    """Every manifestation's integrated/shadow expressions are fully populated."""
    for stage in all_stages():
        for phase_manifestation in stage.manifestations:
            for expression in (
                phase_manifestation.integrated,
                phase_manifestation.shadow,
            ):
                assert expression.name != ""
                assert expression.description != ""


def test_all_ten_stages_and_six_phases_resolve_from_dataset() -> None:
    """Headline seed assertion: all 10 stages x 6 phases fully resolve."""
    stages = all_stages()
    assert len(stages) == 10
    for stage_number in range(1, 11):
        resolved = stage_curriculum(stage_number)
        assert resolved.stage_number == stage_number
        for phase in CANONICAL_PHASE_ORDER:
            found = manifestation(stage_number, phase)
            assert found.phase == phase


def test_stage_curriculum_returns_beige_survival() -> None:
    """stage_curriculum(1) is Survival/Beige with known Rising Rx/OD values."""
    stage = stage_curriculum(1)
    assert stage.stage_number == 1
    assert stage.title == "Survival"
    assert stage.subtitle == "Active Yes-And-Ness"
    assert stage.aspect == "Agency"
    assert stage.spiral_dynamics_color == "Beige"

    rising = stage.manifestations[0]
    assert rising.phase == WavelengthPhase.RISING
    assert rising.integrated.name == "Commitment"
    assert rising.shadow.name == "Over-commitment"


def test_stage_attributes_match_canonical_ontology() -> None:
    """Every stage's short attribute fields match the canonical APTITUDE ontology."""
    fields = (
        "category",
        "aspect",
        "spiral_dynamics_color",
        "growing_up_stage",
        "divine_gender_polarity",
        "relationship_to_free_will",
    )
    for stage in all_stages():
        canonical = _CANONICAL_STAGE_ONTOLOGY[stage.stage_number]
        for field in fields:
            msg = f"stage {stage.stage_number} field {field!r} mismatch"
            assert getattr(stage, field) == canonical[field], msg


def test_manifestation_returns_beige_rising() -> None:
    """manifestation(1, RISING) matches the vendored Beige Rising Rx/OD."""
    result = manifestation(1, WavelengthPhase.RISING)
    assert result.phase == WavelengthPhase.RISING
    assert result.integrated.name == "Commitment"
    assert result.shadow.name == "Over-commitment"


def test_stage_curriculum_unknown_stage_number_raises() -> None:
    """An unknown stage_number raises CurriculumDataError, not KeyError."""
    with pytest.raises(CurriculumDataError):
        stage_curriculum(99)


def test_load_curriculum_is_deterministic() -> None:
    """Two default-path loads return equal data."""
    first = load_curriculum()
    second = load_curriculum()
    assert first == second


def _write_json(tmp_path: Path, name: str, payload: object) -> Path:
    fixture_path = tmp_path / name
    fixture_path.write_text(json.dumps(payload), encoding="utf-8")
    return fixture_path


def _valid_manifestations() -> list[dict[str, object]]:
    return [
        {
            "phase": phase.value,
            "integrated": {"name": "Name", "description": "Desc"},
            "shadow": {"name": "ShadowName", "description": "ShadowDesc"},
        }
        for phase in CANONICAL_PHASE_ORDER
    ]


def _valid_stage(stage_number: int) -> dict[str, object]:
    return {
        "stage_number": stage_number,
        "title": f"Stage {stage_number}",
        "subtitle": "Subtitle",
        "category": "Category",
        "aspect": "Aspect",
        "spiral_dynamics_color": "Color",
        "growing_up_stage": "Growing",
        "divine_gender_polarity": "Polarity",
        "relationship_to_free_will": "Relationship",
        "free_will_description": "Description",
        "manifestations": _valid_manifestations(),
    }


def test_load_curriculum_rejects_wrong_stage_count(tmp_path: Path) -> None:
    """A dataset with fewer or more than 10 stages is invalid."""
    payload = [_valid_stage(n) for n in range(1, 10)]
    fixture_path = _write_json(tmp_path, "nine_stages.json", payload)

    with pytest.raises(CurriculumDataError):
        load_curriculum(path=fixture_path)


def test_load_curriculum_rejects_duplicate_stage_number(tmp_path: Path) -> None:
    """Duplicate stage_number values must be rejected (BUG-SEED-002 regression)."""
    payload = [_valid_stage(n) for n in range(1, 10)]
    payload.append(_valid_stage(1))
    fixture_path = _write_json(tmp_path, "dupe_stage.json", payload)

    with pytest.raises(CurriculumDataError):
        load_curriculum(path=fixture_path)


def test_load_curriculum_rejects_missing_phase(tmp_path: Path) -> None:
    """A stage with fewer than six phases (or the wrong phase set) is invalid."""
    payload = [_valid_stage(n) for n in range(1, 11)]
    payload[0]["manifestations"] = _valid_manifestations()[:-1]
    fixture_path = _write_json(tmp_path, "missing_phase.json", payload)

    with pytest.raises(CurriculumDataError):
        load_curriculum(path=fixture_path)


def test_load_curriculum_rejects_empty_string_field(tmp_path: Path) -> None:
    """An empty-string required field is invalid."""
    payload = [_valid_stage(n) for n in range(1, 11)]
    payload[0]["title"] = ""
    fixture_path = _write_json(tmp_path, "empty_title.json", payload)

    with pytest.raises(CurriculumDataError):
        load_curriculum(path=fixture_path)


def test_load_curriculum_rejects_unknown_phase(tmp_path: Path) -> None:
    """A manifestation naming a phase outside the canonical six is invalid."""
    manifestations = _valid_manifestations()
    manifestations[0]["phase"] = "Ascending"
    first_stage = _valid_stage(1)
    first_stage["manifestations"] = manifestations
    payload = [first_stage, *(_valid_stage(n) for n in range(2, 11))]
    fixture_path = _write_json(tmp_path, "unknown_phase.json", payload)

    with pytest.raises(CurriculumDataError):
        load_curriculum(path=fixture_path)


def test_load_curriculum_rejects_non_integer_stage_number(tmp_path: Path) -> None:
    """A non-integer (or boolean) stage_number is invalid."""
    payload = [_valid_stage(n) for n in range(1, 11)]
    payload[0]["stage_number"] = "1"
    fixture_path = _write_json(tmp_path, "str_stage_number.json", payload)

    with pytest.raises(CurriculumDataError):
        load_curriculum(path=fixture_path)


def test_load_curriculum_rejects_non_object_stage(tmp_path: Path) -> None:
    """A stage entry that is not a JSON object is invalid."""
    payload: list[object] = [_valid_stage(n) for n in range(1, 10)]
    payload.append("not a stage")
    fixture_path = _write_json(tmp_path, "scalar_stage.json", payload)

    with pytest.raises(CurriculumDataError):
        load_curriculum(path=fixture_path)


def test_load_curriculum_rejects_missing_file(tmp_path: Path) -> None:
    """A path that does not exist raises the typed error, not OSError."""
    with pytest.raises(CurriculumDataError):
        load_curriculum(path=tmp_path / "does_not_exist.json")


def test_load_curriculum_rejects_object_without_stages(tmp_path: Path) -> None:
    """A wrapped object missing its ``stages`` array raises the typed error."""
    fixture_path = _write_json(tmp_path, "no_stages.json", {"provenance": {}})

    with pytest.raises(CurriculumDataError):
        load_curriculum(path=fixture_path)


def test_load_curriculum_rejects_malformed_json(tmp_path: Path) -> None:
    """Syntactically invalid JSON raises CurriculumDataError, not a raw JSONDecodeError."""
    fixture_path = tmp_path / "broken.json"
    fixture_path.write_text("{not valid json", encoding="utf-8")

    with pytest.raises(CurriculumDataError):
        load_curriculum(path=fixture_path)


_REPO_ROOT = Path(__file__).resolve().parents[2]
_DATASET_PATH = (
    Path(__file__).resolve().parents[1] / "src" / "curriculum" / "archetypal_wavelength.json"
)


def _dataset_payload() -> dict[str, object]:
    data: object = json.loads(_DATASET_PATH.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def _provenance() -> dict[str, object]:
    provenance = _dataset_payload()["provenance"]
    assert isinstance(provenance, dict)
    return provenance


def _refresh_doc() -> str:
    refresh_doc = _provenance()["refresh_doc"]
    assert isinstance(refresh_doc, str)
    return refresh_doc


def _require_nonempty_str(value: object) -> None:
    assert isinstance(value, str)
    assert value.strip()


def test_dataset_carries_provenance_pointer() -> None:
    """The vendored dataset records where its copy came from (sources + extraction)."""
    provenance = _provenance()
    _require_nonempty_str(provenance["stage_attributes_source"])
    _require_nonempty_str(provenance["manifestations_source"])
    _require_nonempty_str(provenance["extracted_from"])
    _require_nonempty_str(provenance["refresh_doc"])


def test_provenance_refresh_doc_exists() -> None:
    """The refresh-path doc named in provenance actually ships in the repo."""
    refresh_doc = _refresh_doc()
    resolved = _REPO_ROOT / refresh_doc
    assert resolved.is_file(), f"refresh doc missing: {refresh_doc}"


def test_refresh_doc_documents_the_dataset_and_path() -> None:
    """The refresh doc points at the vendored dataset and its loader."""
    text = (_REPO_ROOT / _refresh_doc()).read_text(encoding="utf-8")
    assert "archetypal_wavelength.json" in text
    assert "Archetypal Wavelength" in text
