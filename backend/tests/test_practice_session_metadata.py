"""Tests for the per-mode practice **session** metadata discriminated union."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from schemas.practice_mode_config import (
    TALLIED_CATEGORIES_MAX,
    TALLIED_ROUNDS_MAX,
    TALLIED_TARGET_MAX,
)
from schemas.practice_session_metadata import (
    MAX_TALLIED_ITEMS,
    MAX_TALLIED_ROUNDS,
    CountUpMetadata,
    IntervalBellMetadata,
    MeditationTimerMetadata,
    MetronomeMetadata,
    MindfulAnchorMetadata,
    RepCounterMetadata,
    SenseGroundingMetadata,
    SessionMetadataAdapter,
    TalliedGroundingMetadata,
    TarotMetadata,
)

# -- Round-trip --------------------------------------------------------------


def test_meditation_timer_round_trip() -> None:
    payload = SessionMetadataAdapter.validate_python({"mode": "meditation_timer"})
    assert isinstance(payload, MeditationTimerMetadata)


def test_count_up_round_trip() -> None:
    payload = SessionMetadataAdapter.validate_python({"mode": "count_up"})
    assert isinstance(payload, CountUpMetadata)


def test_metronome_round_trip() -> None:
    payload = SessionMetadataAdapter.validate_python({"mode": "metronome", "bpm_used": 72})
    assert isinstance(payload, MetronomeMetadata)
    assert payload.bpm_used == 72


def test_interval_bell_round_trip() -> None:
    payload = SessionMetadataAdapter.validate_python(
        {"mode": "interval_bell", "intervals_struck": 4, "total_intervals": 6}
    )
    assert isinstance(payload, IntervalBellMetadata)
    assert payload.intervals_struck == 4
    assert payload.total_intervals == 6


def test_rep_counter_round_trip() -> None:
    payload = SessionMetadataAdapter.validate_python({"mode": "rep_counter", "rep_count": 108})
    assert isinstance(payload, RepCounterMetadata)
    assert payload.rep_count == 108


def test_sense_grounding_round_trip() -> None:
    payload = SessionMetadataAdapter.validate_python(
        {"mode": "sense_grounding", "senses_completed": ["sight", "touch"]}
    )
    assert isinstance(payload, SenseGroundingMetadata)
    assert payload.senses_completed == ["sight", "touch"]


def test_sense_grounding_defaults_to_empty_list() -> None:
    payload = SessionMetadataAdapter.validate_python({"mode": "sense_grounding"})
    assert isinstance(payload, SenseGroundingMetadata)
    assert payload.senses_completed == []


def test_tarot_round_trip() -> None:
    payload = SessionMetadataAdapter.validate_python({"mode": "tarot", "card_index": 5})
    assert isinstance(payload, TarotMetadata)
    assert payload.card_index == 5


def test_tallied_grounding_round_trip() -> None:
    payload = SessionMetadataAdapter.validate_python(
        {
            "mode": "tallied_grounding",
            "rounds_completed": 2,
            "total_rounds": 3,
            "items_completed": 27,
        }
    )
    assert isinstance(payload, TalliedGroundingMetadata)
    assert payload.rounds_completed == 2
    assert payload.total_rounds == 3
    assert payload.items_completed == 27


def test_mindful_anchor_metadata_round_trip() -> None:
    payload = SessionMetadataAdapter.validate_python(
        {
            "mode": "mindful_anchor",
            "chosen_option_key": "grass",
            "duration_seconds": 120,
            "met_min_duration": True,
        }
    )
    assert isinstance(payload, MindfulAnchorMetadata)
    assert payload.chosen_option_key == "grass"
    assert payload.duration_seconds == 120
    assert payload.met_min_duration is True


def test_mindful_anchor_metadata_with_no_option_chosen() -> None:
    """Optional chooser: a session may complete without picking from the list."""
    payload = SessionMetadataAdapter.validate_python(
        {
            "mode": "mindful_anchor",
            "duration_seconds": 30,
            "met_min_duration": False,
        }
    )
    assert isinstance(payload, MindfulAnchorMetadata)
    assert payload.chosen_option_key is None
    assert payload.met_min_duration is False


# -- Validators --------------------------------------------------------------


def test_unknown_mode_rejected() -> None:
    with pytest.raises(ValidationError):
        SessionMetadataAdapter.validate_python({"mode": "telepathy"})


def test_metronome_rejects_zero_bpm() -> None:
    with pytest.raises(ValidationError):
        MetronomeMetadata(mode="metronome", bpm_used=0)


def test_metronome_rejects_excessive_bpm() -> None:
    with pytest.raises(ValidationError):
        MetronomeMetadata(mode="metronome", bpm_used=241)


def test_rep_counter_rejects_negative_count() -> None:
    with pytest.raises(ValidationError):
        RepCounterMetadata(mode="rep_counter", rep_count=-1)


def test_tarot_rejects_out_of_range_card() -> None:
    with pytest.raises(ValidationError):
        TarotMetadata(mode="tarot", card_index=22)


def test_tarot_rejects_negative_card() -> None:
    with pytest.raises(ValidationError):
        TarotMetadata(mode="tarot", card_index=-1)


def test_interval_bell_rejects_negative_counts() -> None:
    with pytest.raises(ValidationError):
        IntervalBellMetadata(mode="interval_bell", intervals_struck=-1, total_intervals=4)


def test_interval_bell_rejects_struck_greater_than_total() -> None:
    """``intervals_struck`` cannot exceed ``total_intervals`` (PR #311 review HIGH).

    Each field individually passes its ge/le bounds; only the cross-field
    invariant rejects the nonsense state of "struck more bells than were
    scheduled".
    """
    with pytest.raises(ValidationError):
        IntervalBellMetadata(mode="interval_bell", intervals_struck=10, total_intervals=4)


def test_interval_bell_accepts_equal_struck_and_total() -> None:
    """Completing every scheduled interval is valid (boundary)."""
    payload = IntervalBellMetadata(mode="interval_bell", intervals_struck=4, total_intervals=4)
    assert payload.intervals_struck == payload.total_intervals == 4


def test_tallied_grounding_rejects_rounds_completed_above_total() -> None:
    """``rounds_completed`` cannot exceed ``total_rounds`` (cross-field invariant)."""
    with pytest.raises(ValidationError):
        TalliedGroundingMetadata(
            mode="tallied_grounding",
            rounds_completed=4,
            total_rounds=3,
            items_completed=10,
        )


def test_tallied_grounding_accepts_equal_rounds() -> None:
    """Completing every scheduled round is valid (boundary)."""
    payload = TalliedGroundingMetadata(
        mode="tallied_grounding",
        rounds_completed=3,
        total_rounds=3,
        items_completed=15,
    )
    assert payload.rounds_completed == payload.total_rounds == 3


def test_tallied_grounding_rejects_negative_items_completed() -> None:
    with pytest.raises(ValidationError):
        TalliedGroundingMetadata(
            mode="tallied_grounding",
            rounds_completed=0,
            total_rounds=1,
            items_completed=-1,
        )


def test_tallied_grounding_rejects_items_above_ceiling() -> None:
    """``items_completed`` is capped at the 10-rounds * 12-categories * 20-target ceiling."""
    with pytest.raises(ValidationError):
        TalliedGroundingMetadata(
            mode="tallied_grounding",
            rounds_completed=10,
            total_rounds=10,
            items_completed=2401,
        )


def test_tallied_grounding_accepts_items_completed_at_ceiling() -> None:
    """The exact ceiling (every round * every category * every target) is valid (boundary).

    Mirrors :func:`test_interval_bell_accepts_equal_struck_and_total` — the
    rejection test pins the off-by-one, this one pins the inclusive bound.
    Computing the ceiling from the config-module constants keeps the test
    in sync with any future ceiling bump.
    """
    expected_items = TALLIED_ROUNDS_MAX * TALLIED_CATEGORIES_MAX * TALLIED_TARGET_MAX
    payload = TalliedGroundingMetadata(
        mode="tallied_grounding",
        rounds_completed=TALLIED_ROUNDS_MAX,
        total_rounds=TALLIED_ROUNDS_MAX,
        items_completed=expected_items,
    )
    assert payload.items_completed == expected_items


def test_tallied_metadata_ceilings_match_config_constants() -> None:
    """Lock the metadata ceiling to the authoring-side ceiling constants.

    The metadata module derives ``MAX_TALLIED_ROUNDS`` and
    ``MAX_TALLIED_ITEMS`` from the config module so a future bump (e.g.
    raising the categories limit) cannot leave the post-session cap
    silently stale. This test pins the contract: it fails loudly if the
    derivation is ever inlined or the underlying constants change.
    """
    assert MAX_TALLIED_ROUNDS == TALLIED_ROUNDS_MAX
    assert MAX_TALLIED_ITEMS == TALLIED_ROUNDS_MAX * TALLIED_CATEGORIES_MAX * TALLIED_TARGET_MAX


def test_tallied_grounding_rejects_total_rounds_above_max() -> None:
    with pytest.raises(ValidationError):
        TalliedGroundingMetadata(
            mode="tallied_grounding",
            rounds_completed=0,
            total_rounds=11,
            items_completed=0,
        )


def test_sense_grounding_rejects_unknown_sense() -> None:
    with pytest.raises(ValidationError):
        SessionMetadataAdapter.validate_python(
            {"mode": "sense_grounding", "senses_completed": ["aura"]}
        )


def test_extra_fields_are_forbidden() -> None:
    """``extra="forbid"`` catches typos like ``bpmUsed`` vs ``bpm_used``."""
    with pytest.raises(ValidationError):
        SessionMetadataAdapter.validate_python(
            {"mode": "metronome", "bpm_used": 72, "extra": "nope"}
        )


def test_discriminator_dispatches_to_right_subclass() -> None:
    """The union picks the right model purely from ``mode``."""
    payload = SessionMetadataAdapter.validate_python({"mode": "count_up"})
    assert type(payload) is CountUpMetadata


# -- Mindful-anchor metadata validators -------------------------------------


def test_mindful_anchor_metadata_rejects_negative_duration() -> None:
    with pytest.raises(ValidationError):
        MindfulAnchorMetadata(
            mode="mindful_anchor",
            duration_seconds=-1,
            met_min_duration=False,
        )


def test_mindful_anchor_metadata_rejects_duration_past_cap() -> None:
    """Four-hour cap guards against bogus client clocks."""
    with pytest.raises(ValidationError):
        MindfulAnchorMetadata(
            mode="mindful_anchor",
            duration_seconds=14_401,
            met_min_duration=False,
        )


def test_mindful_anchor_metadata_rejects_overlong_option_key() -> None:
    with pytest.raises(ValidationError):
        MindfulAnchorMetadata(
            mode="mindful_anchor",
            chosen_option_key="x" * 65,
            duration_seconds=10,
            met_min_duration=False,
        )
