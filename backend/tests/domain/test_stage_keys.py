"""Tests for the stable Stage keys and the derived start-week schedule (#2665)."""

from __future__ import annotations

import pytest

from domain.constants import STAGE_START_WEEKS, TOTAL_STAGES
from domain.stage_keys import (
    STAGE_KEYS,
    UnknownStageError,
    legacy_stage_key,
    stage_key_for,
)


def test_there_is_one_key_per_stage() -> None:
    """Ten Stages, ten distinct keys."""
    assert len(STAGE_KEYS) == TOTAL_STAGES
    assert len(set(STAGE_KEYS)) == TOTAL_STAGES


def test_keys_are_the_colour_slugs_in_program_order() -> None:
    """Pinned literally, so a reorder cannot pass by rewriting both sides."""
    assert STAGE_KEYS == (
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


@pytest.mark.parametrize("stage_number", range(1, TOTAL_STAGES + 1))
def test_number_and_key_round_trip(stage_number: int) -> None:
    """Every Stage number maps to the key at its 1-based position."""
    assert STAGE_KEYS.index(stage_key_for(stage_number)) + 1 == stage_number


def test_stage_key_for_names_specific_stages() -> None:
    """Spot-check both ends and the middle against the course's own names."""
    assert stage_key_for(1) == "beige"
    assert stage_key_for(4) == "blue"
    assert stage_key_for(TOTAL_STAGES) == "clearlight"


@pytest.mark.parametrize("stage_number", [0, TOTAL_STAGES + 1, -1])
def test_stage_key_for_rejects_out_of_range(stage_number: int) -> None:
    """Out-of-range numbers are a typed lookup error, not an IndexError."""
    with pytest.raises(UnknownStageError, match=f"stage_number {stage_number} is outside"):
        stage_key_for(stage_number)


def test_legacy_stage_key_uses_the_real_key_in_range() -> None:
    """In range, the placeholder helper defers to the real key."""
    assert legacy_stage_key(4) == "blue"
    assert legacy_stage_key(1) == "beige"
    assert legacy_stage_key(TOTAL_STAGES) == "clearlight"


@pytest.mark.parametrize("stage_number", [0, 11, 12])
def test_legacy_stage_key_placeholders_out_of_range(stage_number: int) -> None:
    """Out of range, a unique ``stage-<n>`` placeholder instead of an error."""
    assert legacy_stage_key(stage_number) == f"stage-{stage_number}"


def test_stage_start_weeks_are_the_cumulative_schedule() -> None:
    """Eight 3-week stages then two 6-week ones, starting at week 1."""
    assert STAGE_START_WEEKS == (1, 4, 7, 10, 13, 16, 19, 22, 25, 31)
