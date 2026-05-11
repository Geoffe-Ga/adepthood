"""Tests for the per-mode practice **session** metadata discriminated union."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from schemas.practice_session_metadata import (
    CountUpMetadata,
    IntervalBellMetadata,
    MeditationTimerMetadata,
    MetronomeMetadata,
    RepCounterMetadata,
    SenseGroundingMetadata,
    SessionMetadataAdapter,
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
