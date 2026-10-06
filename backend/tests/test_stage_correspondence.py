"""The curriculum mirror agrees with the generated stage-correspondence artifact.

Issue #2667. ``src/curriculum/stage_correspondence.json`` is generated from the
vendored Complete Map CSV and the ratified supersessions, and its ``--check``
gate runs in CI. ``src/curriculum/archetypal_wavelength.json`` still carries a
hand-kept copy of the same seven correspondence fields per stage, and the
backend curriculum loader still serves it to whatever reads that dataset. Two
copies of one fact with nothing holding them
equal is how stage 2 kept a stale free-will sentence after the CSV it was meant
to follow had been vendored. This module is the parity gate the generator's
docstring promises: every shared field, every stage, no exemption list. When
#2666 retires the mirror's copy, the parity test flips to asserting the fields
are gone rather than gaining an allowlist.

It also pins the #1637 values as literals, so an upstream re-pin or a new
supersession that moves them is a visible decision in a diff rather than a
silent regeneration.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, ClassVar

import scripts.build_stage_correspondence as generator
from curriculum.stage_correspondence import CORRESPONDENCE_FIELDS
from domain.constants import TOTAL_STAGES
from scripts.build_stage_correspondence import load_supersessions

_MIRROR_PATH = (
    Path(__file__).resolve().parents[1] / "src" / "curriculum" / "archetypal_wavelength.json"
)

#: The marker reported in place of a field name when a stage is on one side only.
_MISSING_STAGE = "<missing>"

#: The ten stage numbers both sources must carry.
_ALL_STAGES = frozenset(range(1, TOTAL_STAGES + 1))


def _stages(path: Path) -> list[dict[str, Any]]:
    """Return the raw ``stages`` list of a curriculum JSON file."""
    payload: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    stages: list[dict[str, Any]] = payload["stages"]
    return stages


def _mirror_divergences(
    mirror_stages: list[dict[str, Any]], artifact_stages: list[dict[str, Any]]
) -> list[tuple[int, str]]:
    """Return ``(stage_number, field)`` for every shared field the two sources disagree on.

    Stages are joined by ``stage_number``; a stage present on only one side is
    reported as ``(n, "<missing>")`` rather than raising, so a dropped stage
    reads as drift instead of a ``KeyError``.
    """
    mirror = {stage["stage_number"]: stage for stage in mirror_stages}
    artifact = {stage["stage_number"]: stage for stage in artifact_stages}
    divergences: list[tuple[int, str]] = []
    for number in sorted(mirror.keys() | artifact.keys()):
        if number not in mirror or number not in artifact:
            divergences.append((number, _MISSING_STAGE))
            continue
        divergences.extend(
            (number, field)
            for field in CORRESPONDENCE_FIELDS
            if mirror[number].get(field) != artifact[number].get(field)
        )
    return divergences


def test_curriculum_mirror_matches_the_artifact_field_by_field() -> None:
    """All ten stages agree on all seven shared correspondence fields."""
    mirror, artifact = _stages(_MIRROR_PATH), _stages(generator.ARTIFACT_PATH)
    assert {stage["stage_number"] for stage in mirror} == _ALL_STAGES
    assert {stage["stage_number"] for stage in artifact} == _ALL_STAGES
    assert _mirror_divergences(mirror, artifact) == []


def test_the_parity_join_covers_exactly_the_seven_shared_fields() -> None:
    """The fields compared are the artifact's correspondence columns, all present in the mirror."""
    mirror = _stages(_MIRROR_PATH)
    assert len(CORRESPONDENCE_FIELDS) == len(set(CORRESPONDENCE_FIELDS))
    for stage in mirror:
        assert set(CORRESPONDENCE_FIELDS) <= stage.keys()


def test_a_drifted_mirror_names_the_stage_and_field() -> None:
    """One altered field is reported as that stage and that field, and nothing else."""
    artifact = _stages(generator.ARTIFACT_PATH)
    drifted = copy.deepcopy(artifact)
    drifted[6]["aspect"] = "Wholeness"
    assert _mirror_divergences(drifted, artifact) == [(7, "aspect")]


def test_every_shared_field_is_compared() -> None:
    """Each of the seven fields, altered alone, is caught -- the last one included."""
    artifact = _stages(generator.ARTIFACT_PATH)
    for field in CORRESPONDENCE_FIELDS:
        drifted = copy.deepcopy(artifact)
        drifted[1][field] = f"drifted {field}"
        assert _mirror_divergences(drifted, artifact) == [(2, field)]


def test_a_mirror_missing_a_stage_is_reported() -> None:
    """A stage dropped from either side is drift, not a crash and not a pass."""
    artifact = _stages(generator.ARTIFACT_PATH)
    assert _mirror_divergences(artifact[:-1], artifact) == [(TOTAL_STAGES, _MISSING_STAGE)]
    assert _mirror_divergences(artifact, artifact[1:]) == [(1, _MISSING_STAGE)]


class TestIssue1637Rulings:
    """Literal pins for the stages #1637 is about, and the ratified supersessions.

    #1637 (epic:stage-ontology) recorded that the vendored course chapters and
    the Complete Map CSV named stages 7, 9 and 10 differently. Two owner rulings
    govern it: 2026-09-05, "the source materials are authoritative" (applied to
    stage 2 by #2915); and 2026-09-16, "chapter text wins over the CSV", applied
    through ``stage_correspondence_supersessions.json``.

    The category and aspect halves were reconciled upstream at pin ``9d0f896``,
    when the Mood chapters were renamed to match the CSV, so the retired
    manifest vocabulary (Freedom, Wholeness, Free Will, Developmental
    Complexity) is asserted absent at those stages.

    The archetype half is NOT settled. ``graph/ontology-spine.md`` (Known
    Conflicts) records it "neutrally as an open decision": the chapters say
    Intentional Actor (07), Hierarchical Organizer (09) and Adept (10), and until
    the owner rules both name-sets are aliases of one stage. The archetype pins
    below are therefore change detectors only. They are not a verdict against
    the chapter names: a chapter-cited supersession adopting them is a
    legitimate future ruling, and when it lands this pin is updated on purpose.
    """

    #: stage id -> (category, aspect, relationship_to_free_will) at pin 9d0f896.
    _PINNED: ClassVar[dict[str, tuple[str, str, str]]] = {
        "yellow": ("Wisdom", "Systems Wisdom", "Despairing Analyst"),
        "ultraviolet": ("Being", "Unity", "Blissy Adept"),
        "clearlight": ("Awareness", "Emptiness", "Whole Adept"),
    }

    #: Manifest-era category/aspect names reconciled away upstream at 9d0f896.
    _RETIRED_MANIFEST_CATEGORY_ASPECT = frozenset(
        {"Freedom", "Wholeness", "Free Will", "Developmental Complexity"}
    )

    #: The ratified departures from the CSV, as (stage_id, field, csv_value, value, authority).
    _SUPERSESSIONS = frozenset(
        {
            (
                "blue",
                "aspect",
                "Universal Love",
                "Community Love",
                "markdown/04-blue/02-the-mood-of-blue-lovecommunity-love.md",
            ),
            (
                "teal",
                "aspect",
                "Transcendent Wisdom",
                "True Self Connection",
                "markdown/08-teal/02-the-mood-of-teal-wisdomtrue-self-wisdom.md",
            ),
            (
                "teal",
                "relationship_to_free_will",
                "Adept",
                "True Self Embodier",
                "markdown/08-teal/04-the-relationship-to-free-will-at-teal-true-self-embodier.md",
            ),
        }
    )
    _EXPECTED_SUPERSESSION_COUNT = 3

    @staticmethod
    def _artifact() -> dict[str, Any]:
        """Return the committed artifact as raw JSON."""
        payload: dict[str, Any] = json.loads(generator.ARTIFACT_PATH.read_text(encoding="utf-8"))
        return payload

    def _by_id(self) -> dict[str, dict[str, Any]]:
        """Return the artifact's stages keyed by colour-slug id."""
        return {stage["id"]: stage for stage in self._artifact()["stages"]}

    def test_stages_7_9_and_10_carry_the_pinned_values(self) -> None:
        """Category, aspect and archetype at the #1637 stages equal the literal pins."""
        stages = self._by_id()
        actual = {
            stage_id: (
                stages[stage_id]["category"],
                stages[stage_id]["aspect"],
                stages[stage_id]["relationship_to_free_will"],
            )
            for stage_id in self._PINNED
        }
        assert actual == self._PINNED

    def test_no_retired_manifest_category_or_aspect_survives(self) -> None:
        """The reconciled half of #1637 stays reconciled at stages 7, 9 and 10."""
        stages = self._by_id()
        for stage_id in self._PINNED:
            names = {stages[stage_id]["category"], stages[stage_id]["aspect"]}
            assert names.isdisjoint(self._RETIRED_MANIFEST_CATEGORY_ASPECT), stage_id

    def test_the_artifact_echoes_exactly_the_ratified_supersessions(self) -> None:
        """The committed artifact applied the three ratified departures and no others."""
        echoed = [
            (
                entry["stage_id"],
                entry["field"],
                entry["csv_value"],
                entry["value"],
                entry["authority"],
            )
            for entry in self._artifact()["supersessions"]
        ]
        assert len(echoed) == self._EXPECTED_SUPERSESSION_COUNT
        assert set(echoed) == self._SUPERSESSIONS

    def test_the_supersession_input_matches_the_pins(self) -> None:
        """The input file and the artifact cannot disagree unnoticed until --check runs."""
        entries = load_supersessions(generator.SUPERSESSIONS_PATH)
        assert len(entries) == self._EXPECTED_SUPERSESSION_COUNT
        assert {
            (entry.stage_id, entry.field, entry.csv_value, entry.value, entry.authority)
            for entry in entries
        } == self._SUPERSESSIONS

    def test_each_supersession_reached_its_stage(self) -> None:
        """The artifact's stage rows carry each superseding value."""
        stages = self._by_id()
        for stage_id, field, _csv_value, value, _authority in self._SUPERSESSIONS:
            assert stages[stage_id][field] == value
