"""Pins the week-to-prompt mapping against the vendored curriculum.

The old table hardcoded twelve fabricated bands (Turquoise, Coral, Indigo)
tiled three weeks each, and thirty-six invented prompt questions. Both are
gone: the bands are now the ten canonical colours and the prompt text comes
from ``backend/content``. These tests assert the *content*, not just the
range, because a range-only suite is exactly what let the fabrication through.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from domain import weekly_prompts
from domain.constants import STAGE_DURATIONS_DAYS
from domain.frequencies import FREQUENCY_COLORS, frequency_for_color
from domain.journal_prompt_parser import prompts_for_color, stage_number_for_color
from domain.weekly_prompts import (
    PROMPT_BANDS,
    TOTAL_WEEKS,
    WEEKS_PER_STAGE,
    get_prompt_for_week,
    prompt_title_for_week,
    resolve_week_prompt,
    stage_prompts,
)

_MANIFEST = Path(__file__).resolve().parents[2] / "content" / "manifest.json"

# Names the old table invented; none of the ten is called any of these.
_FABRICATED_BANDS = ("Turquoise", "Coral", "Indigo")

_DAYS_PER_WEEK = 7
_EXPECTED_STAGE_COUNT = 10

# Ten stages, but eight run three weeks and two run six: 8*3 + 2*6 == 36.
_EXPECTED_TOTAL_WEEKS = 36
_LAST_STAGE_FIRST_WEEK = 31

# Beige is the shortest chapter in the snapshot; Red is the first stage that
# carries four prompts, and Orange is the one whose four all state a cadence.
_BEIGE_PROMPT_COUNT = 3
_RED_STAGE_NUMBER = 3
_RED_FIRST_WEEK = 7
_ORANGE_STAGE_NUMBER = 5

# Each stage's first program week, in stage order: eight three-week stages
# then two six-week ones.
_STAGE_FIRST_WEEKS = [1, 4, 7, 10, 13, 16, 19, 22, 25, 31]


def _manifest_stages() -> set[int]:
    """Every stage number the content manifest indexes a chapter for."""
    manifest = json.loads(_MANIFEST.read_text())
    return {chapter["stage"] for chapter in manifest["chapters"]}


def test_prompt_bands_are_the_ten_canonical_colours() -> None:
    canonical = tuple(FREQUENCY_COLORS.values())

    assert canonical == PROMPT_BANDS
    assert len(PROMPT_BANDS) == _EXPECTED_STAGE_COUNT
    assert PROMPT_BANDS[-1] == "Clear Light"


@pytest.mark.parametrize("fabricated", _FABRICATED_BANDS)
def test_fabricated_bands_are_gone(fabricated: str) -> None:
    assert fabricated not in PROMPT_BANDS
    assert frequency_for_color(fabricated) is None


def test_bands_match_manifest_stages() -> None:
    """A future fabricated stage name has to fail here, not in production."""
    stages = _manifest_stages()

    assert len(PROMPT_BANDS) == len(stages) == _EXPECTED_STAGE_COUNT
    assert {stage_number_for_color(band) for band in PROMPT_BANDS} == stages


def test_total_weeks_follows_the_ratified_stage_schedule() -> None:
    """The week count is derived from the cross-stack stage durations.

    Ten stages, but not thirty weeks: two of them run six weeks, which is why
    ``STAGE_DURATIONS_DAYS`` sums to 252 days rather than 210.
    """
    from_schedule = tuple(duration // _DAYS_PER_WEEK for duration in STAGE_DURATIONS_DAYS)

    assert from_schedule == WEEKS_PER_STAGE
    assert TOTAL_WEEKS == sum(WEEKS_PER_STAGE) == _EXPECTED_TOTAL_WEEKS


@pytest.mark.parametrize(
    ("week_number", "expected_title"),
    [
        (1, "Beige week 1 Prompt #1"),
        (3, "Beige week 3 Prompt #3"),
        (4, "Purple week 1 Prompt #1"),
        (8, "Red week 2 Prompt #2"),
        (10, "Blue week 1 Prompt #1"),
        (13, "Orange week 1 Prompt #1"),
        (16, "Green week 1 Prompt #1"),
        (19, "Yellow week 1 Prompt #1"),
        # The four weeks the old twelve-band table got wrong start here.
        (22, "Teal week 1 Prompt #1"),
        (25, "Ultraviolet week 1 Prompt #1"),
        (30, "Ultraviolet week 6 Prompt #2"),
        (31, "Clear Light week 1 Prompt #1"),
        (36, "Clear Light week 6 Prompt #2"),
    ],
)
def test_prompt_title_for_week_uses_the_canonical_band(
    week_number: int, expected_title: str
) -> None:
    assert prompt_title_for_week(week_number) == expected_title


@pytest.mark.parametrize("week_number", [0, -1, 37])
def test_prompt_title_for_week_out_of_range_is_none(week_number: int) -> None:
    assert prompt_title_for_week(week_number) is None


@pytest.mark.parametrize("week_number", [0, -1, 37])
def test_get_prompt_for_week_out_of_range_is_none(week_number: int) -> None:
    assert get_prompt_for_week(week_number) is None


def test_get_prompt_for_week_returns_real_curriculum_text() -> None:
    """Week 14 is Orange's second week, so it carries Orange's second prompt."""
    prompt = get_prompt_for_week(14)

    assert prompt is not None
    assert prompt.startswith("Make a List of 25 Curiosities")
    assert "polyvagal theory" in prompt


def test_every_week_resolves_to_a_prompt_from_its_own_stage() -> None:
    """No week is orphaned, and none borrows another stage's prompt."""
    for week_number in range(1, TOTAL_WEEKS + 1):
        prompt = get_prompt_for_week(week_number)
        assert prompt, f"week {week_number} has no prompt"
        band = prompt_title_for_week(week_number)
        assert band is not None
        colour = band.rsplit(" week ", maxsplit=1)[0]
        assert prompt in {p.text for p in prompts_for_color(colour)}


def test_weeks_31_to_36_are_still_reachable() -> None:
    """Stored responses for the final six weeks are not orphaned.

    The ten-stage correction changes which *band* those weeks belong to, not
    whether they exist: the program is still thirty-six weeks long, so every
    persisted ``PromptResponse`` row keeps a live week to hang from.
    """
    for week_number in range(_LAST_STAGE_FIRST_WEEK, _EXPECTED_TOTAL_WEEKS + 1):
        assert get_prompt_for_week(week_number)
        title = prompt_title_for_week(week_number)
        assert title is not None
        assert title.startswith("Clear Light")


def test_module_hardcodes_no_prompt_text_or_stage_name() -> None:
    """The second hand-maintained copy of the curriculum must stay deleted."""
    source = Path(weekly_prompts.__file__).read_text()

    assert "WEEKLY_PROMPTS" not in source
    assert "What does safety mean to you right now" not in source
    assert "25 Curiosities" not in source
    for fabricated in _FABRICATED_BANDS:
        assert fabricated not in source


# ── Stage-scoped resolution (all of a stage's prompts, with cadence) ─────


def test_stage_prompts_returns_every_prompt_of_a_four_prompt_stage() -> None:
    """Red is the first stage whose chapter carries four prompts."""
    stage = stage_prompts(_RED_STAGE_NUMBER)

    assert stage is not None
    assert stage.band == "Red"
    assert stage.first_week == _RED_FIRST_WEEK
    assert [p.ordinal for p in stage.prompts] == [1, 2, 3, 4]


def test_stage_prompts_returns_beiges_three() -> None:
    """Beige is the floor: three prompts, not the four a fixed count would assume."""
    stage = stage_prompts(1)

    assert stage is not None
    assert stage.band == "Beige"
    assert stage.first_week == 1
    assert len(stage.prompts) == _BEIGE_PROMPT_COUNT


def test_stage_prompts_carries_the_cadence_the_chapter_states() -> None:
    """Cadence is opaque display prose, passed through from the content."""
    stage = stage_prompts(_ORANGE_STAGE_NUMBER)

    assert stage is not None
    assert [p.cadence for p in stage.prompts] == ["At least 4x per week"] * 4


def test_stage_prompts_first_week_tiles_the_whole_program() -> None:
    """Each stage starts the week after the previous one ends, with no gap."""
    boundaries = [stage_prompts(number) for number in range(1, len(PROMPT_BANDS) + 1)]

    assert all(stage is not None for stage in boundaries)
    starts = [stage.first_week for stage in boundaries if stage is not None]
    assert starts == _STAGE_FIRST_WEEKS


@pytest.mark.parametrize("stage_number", [0, -1, 11])
def test_stage_prompts_out_of_range_is_none(stage_number: int) -> None:
    """An eleventh stage is an ontology change, not a lookup that returns something."""
    assert stage_prompts(stage_number) is None


# ── Addressing a specific prompt within a week's stage ──────────────────


def test_resolve_week_prompt_defaults_to_the_prompt_the_week_draws() -> None:
    resolved = resolve_week_prompt(1)

    assert resolved is not None
    assert resolved.band == "Beige"
    assert resolved.prompt.ordinal == 1
    assert resolved.default_title == "Beige week 1 Prompt #1"


def test_resolve_week_prompt_honours_an_explicit_ordinal() -> None:
    """A user in Beige week 1 may answer Beige's third prompt instead of its first."""
    resolved = resolve_week_prompt(1, ordinal=_BEIGE_PROMPT_COUNT)

    assert resolved is not None
    assert resolved.prompt.ordinal == _BEIGE_PROMPT_COUNT
    assert resolved.default_title == f"Beige week 1 Prompt #{_BEIGE_PROMPT_COUNT}"
    assert resolved.question == prompts_for_color("Beige")[_BEIGE_PROMPT_COUNT - 1].text


def test_resolve_week_prompt_rejects_an_ordinal_the_stage_does_not_carry() -> None:
    """Beige has three prompts, so its fourth does not exist."""
    assert resolve_week_prompt(1, ordinal=_BEIGE_PROMPT_COUNT + 1) is None


@pytest.mark.parametrize("week_number", [0, 37])
def test_resolve_week_prompt_out_of_range_is_none(week_number: int) -> None:
    assert resolve_week_prompt(week_number, ordinal=1) is None


def test_get_prompt_for_week_accepts_an_ordinal() -> None:
    """The week-scoped accessor stays week-scoped, and gains an optional ordinal."""
    default = get_prompt_for_week(1)
    third = get_prompt_for_week(1, ordinal=_BEIGE_PROMPT_COUNT)

    assert default is not None
    assert third is not None
    assert third != default
    assert get_prompt_for_week(1, ordinal=_BEIGE_PROMPT_COUNT + 1) is None


def test_prompt_title_for_week_names_the_addressed_prompt() -> None:
    assert prompt_title_for_week(1, ordinal=2) == "Beige week 1 Prompt #2"
    assert prompt_title_for_week(1, ordinal=_BEIGE_PROMPT_COUNT + 1) is None
