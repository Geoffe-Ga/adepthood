"""The curriculum dataset carries no copy of the stage correspondences.

Issue #2667 added a parity gate here: ``src/curriculum/stage_correspondence.json``
is generated from the vendored Complete Map CSV and the ratified supersessions
(its ``--check`` gate runs in CI), while ``src/curriculum/archetypal_wavelength.json``
still carried a hand-kept copy of the same seven correspondence fields per stage.
Two copies of one fact with nothing holding them equal is how stage 2 kept a
stale free-will sentence after the CSV it was meant to follow had been vendored.

That gate promised to flip when #2666 retired the copy, rather than gain an
allowlist. It has: the dataset now owns the per-Stage titles, subtitles, Modes
and phase manifestations only, and :func:`curriculum.stage_correspondence.stage_correspondence`
(seeded into ``CourseStage`` and served by ``GET /stages``) is the one source of
the seven fields. The test below asserts the copy is gone from the committed
file and from the loader's record, so it cannot quietly come back.

It also pins the #1637 values as literals, so an upstream re-pin or a new
supersession that moves them is a visible decision in a diff rather than a
silent regeneration.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, ClassVar

import curriculum
import scripts.build_stage_correspondence as generator
from curriculum.stage_correspondence import CORRESPONDENCE_FIELDS
from domain.constants import TOTAL_STAGES
from scripts.build_stage_correspondence import load_supersessions

_DATASET_PATH = (
    Path(__file__).resolve().parents[1] / "src" / "curriculum" / "archetypal_wavelength.json"
)

#: The ten stage numbers the dataset must still carry.
_ALL_STAGES = frozenset(range(1, TOTAL_STAGES + 1))

#: Provenance keys that described the retired correspondence copy. The artifact
#: and ``stage_correspondence_supersessions.json`` own that provenance now.
_RETIRED_PROVENANCE_KEYS = frozenset(
    {
        "supersessions",
        "stage_attributes_source",
        "stage_2_free_will_source",
        "free_will_descriptions_source",
    }
)


def test_curriculum_dataset_carries_no_correspondence_fields() -> None:
    """No stage, provenance key or loader record repeats the artifact's seven fields."""
    payload: dict[str, Any] = json.loads(_DATASET_PATH.read_text(encoding="utf-8"))
    for stage in payload["stages"]:
        assert set(stage) & set(CORRESPONDENCE_FIELDS) == set(), stage["stage_number"]
    assert {stage["stage_number"] for stage in payload["stages"]} == _ALL_STAGES
    assert set(payload["provenance"]) & _RETIRED_PROVENANCE_KEYS == set()
    assert not any(
        hasattr(curriculum.stage_curriculum(number), field)
        for number in _ALL_STAGES
        for field in CORRESPONDENCE_FIELDS
    )


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
    #: The seven free-will-description rows follow #3043: chapter text wins. Teal's
    #: growing-up-stage and archetype rows retired at the b06a58e re-pin (#3135),
    #: when the upstream CSV adopted both values. Teal's aspect row retired at the
    #: 59df2a2 re-pin: the owner ruled stage 8's aspect "True Self Wisdom"
    #: (2026-10-13, #2664), which is the CSV's own cell.
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
                "beige",
                "free_will_description",
                (
                    "When Beige is the loudest note, there's no felt question of free will: "
                    "action is reactive and instinctual, steered by survival needs. This is the "
                    "Root Chakra, the base of Maslow's pyramid, Piaget's first stage, Erikson's "
                    "first task\u2014the ground every other capacity stands on, not the bottom "
                    "of a ranking."
                ),
                (
                    "When we first move through Beige we operate like a Biological Machine\u2014a "
                    "bundle of reflexes, needs, cravings, and instincts. Basically, a baby. An "
                    "addict deep in the territory of abuse. A victim of trauma, deprivation, or "
                    "circumstance struggling to survive. It\u2019s not something to feel "
                    "guilty about."
                ),
                "markdown/01-beige/04-the-relationship-to-free-will-at-beige.md",
            ),
            (
                "red",
                "free_will_description",
                (
                    "Behavior is driven by a subconscious urge to alleviate the pain of emotions "
                    "(that may or may not even be consciously noticed) that tell us that we are "
                    "not enough. Without self-love toward these aversion based feelings, the "
                    'tendency is to forge dominator "power over others."'
                ),
                (
                    "APTITUDE teaches that Free Will only becomes real when you learn to express "
                    "power differently. The Dominator believes they are acting freely, but in "
                    'truth, they are ruled by fear and shame. Their "choices" are reactions. '
                    'Their "power" is armor.'
                ),
                "markdown/03-red/04-the-relationship-to-free-will-at-red-dominator.md",
            ),
            (
                "blue",
                "free_will_description",
                (
                    "Behavior is determined by the attempt to meet the expectations of the "
                    "relationships that the individual is embedded within; we are defined by "
                    "roles: partners, parents, children, coworkers, friends, pupils, etc"
                ),
                (
                    "At Blue, you do what you're told. You follow the rules. You meet the "
                    "expectations."
                ),
                "markdown/04-blue/04-the-relationship-to-free-will-at-blue-victim.md",
            ),
            (
                "green",
                "free_will_description",
                (
                    "Behavior is driven by a desire to be virtuous, to apply rules fairly, to "
                    "reduce the influence of hierarchy, and to respect everyone's perspectives. "
                    "Free Will is still absent as behavior follows predictably from a set of "
                    "pluralistic heuristics."
                ),
                (
                    "Here's the truth: recognizing that you've been conditioned is not the same as "
                    "freeing yourself from that conditioning. Naming your trauma is not the same "
                    "as healing it. Understanding why you're afraid doesn't make you brave."
                ),
                "markdown/06-green/04-the-relationship-to-free-will-at-green-shadow-glorifier.md",
            ),
            (
                "yellow",
                "free_will_description",
                (
                    "The ability to reflect on all the influences of stages prior to Yellow "
                    "develops and the individual becomes convinced that Free Will is essentially "
                    "an illusion."
                ),
                (
                    "Yellow is where you start to see the forces. Where you develop enough "
                    "metacognitive capacity to observe your own patterns as they arise. And from "
                    "that observation, you gain the smallest sliver of space\u2014the gap between "
                    "impulse and action. And in that gap, choice becomes possible."
                ),
                (
                    "markdown/07-yellow/05-the-relationship-to-free-will-at-yellow-intentional-actor.md"
                ),
            ),
            (
                "teal",
                "free_will_description",
                (
                    "Connection with the True Self\u2014the Monad, the Higher Self, the eternal "
                    "part of you that chose to incarnate. Free Will here means getting quiet "
                    "enough to hear that deeper knowing and letting it steer: breaking patterns "
                    "that reasoning alone couldn't break, and unbridling from determinism by "
                    "acting from what you actually are rather than what you were conditioned "
                    "to be."
                ),
                (
                    "The part of you that chose to incarnate into these conditions. The part that "
                    "has a purpose, a mission, a knowing that the personality cannot access "
                    "through effort alone."
                ),
                "markdown/08-teal/04-the-relationship-to-free-will-at-teal-true-self-embodier.md",
            ),
            (
                "clearlight",
                "free_will_description",
                (
                    "The question of who is choosing loosens. When nobody is defending a self, "
                    "the body becomes a lighter instrument\u2014an empty Nobody doing what the "
                    "moment actually needs, for everyone involved. The Wavelength still turns, "
                    "so this is a capacity you keep returning to, not a finish line."
                ),
                (
                    "At Clear Light, the question of Free Will dissolves. Not because it's been "
                    "answered, but because it's been seen through."
                ),
                "markdown/10-clearlight/04-the-relationship-to-free-will-at-clear-light-adept.md",
            ),
        }
    )
    _EXPECTED_SUPERSESSION_COUNT = 8

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
        """The committed artifact applied exactly the ratified departures and no others."""
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
