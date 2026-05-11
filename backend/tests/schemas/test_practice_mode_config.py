"""Tests for the per-mode practice config discriminated union."""

from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from schemas.practice_mode_config import (
    CountUpConfig,
    IntervalBellConfig,
    MeditationTimerConfig,
    MetronomeConfig,
    ModeConfig,
    ModeConfigAdapter,
    RepCounterConfig,
    SenseGroundingConfig,
    TarotConfig,
)

_ADAPTER: TypeAdapter[ModeConfig] = ModeConfigAdapter


# -- Discriminated round-trip ------------------------------------------------


def test_meditation_timer_round_trip() -> None:
    cfg = _ADAPTER.validate_python(
        {
            "mode": "meditation_timer",
            "duration_minutes": 10,
            "start_bell": True,
            "halfway_bell": True,
            "end_bell": True,
        }
    )
    assert isinstance(cfg, MeditationTimerConfig)
    assert cfg.duration_minutes == 10
    assert cfg.halfway_bell is True


def test_count_up_round_trip() -> None:
    cfg = _ADAPTER.validate_python({"mode": "count_up", "soft_cap_minutes": None})
    assert isinstance(cfg, CountUpConfig)
    assert cfg.soft_cap_minutes is None


def test_metronome_round_trip_with_embedded_timer() -> None:
    cfg = _ADAPTER.validate_python(
        {
            "mode": "metronome",
            "bpm": 72,
            "timer": {
                "mode": "meditation_timer",
                "duration_minutes": 30,
                "halfway_bell": True,
            },
        }
    )
    assert isinstance(cfg, MetronomeConfig)
    assert cfg.bpm == 72
    assert cfg.timer.duration_minutes == 30


def test_interval_bell_round_trip_with_even_intervals() -> None:
    cfg = _ADAPTER.validate_python(
        {
            "mode": "interval_bell",
            "duration_minutes": 20,
            "interval_minutes": 5,
            "bell_tone": "bowl",
        }
    )
    assert isinstance(cfg, IntervalBellConfig)
    assert cfg.interval_minutes == 5
    assert cfg.cue_offsets_minutes is None


def test_interval_bell_round_trip_with_custom_offsets() -> None:
    cfg = _ADAPTER.validate_python(
        {
            "mode": "interval_bell",
            "duration_minutes": 30,
            "cue_offsets_minutes": [5, 12, 20],
            "bell_tone": "chime",
        }
    )
    assert isinstance(cfg, IntervalBellConfig)
    assert cfg.cue_offsets_minutes == [5, 12, 20]


def test_rep_counter_round_trip() -> None:
    cfg = _ADAPTER.validate_python(
        {
            "mode": "rep_counter",
            "target_reps": 108,
            "unit_label": "breath cycles",
            "time_cap_minutes": 15,
        }
    )
    assert isinstance(cfg, RepCounterConfig)
    assert cfg.target_reps == 108


def test_sense_grounding_default_prompts_round_trip() -> None:
    cfg = _ADAPTER.validate_python(
        {
            "mode": "sense_grounding",
            "prompts": [
                {"sense": "sight", "label": "Name 5 things you can see"},
                {"sense": "touch", "label": "Name 4 things you can touch"},
                {"sense": "hearing", "label": "Name 3 things you can hear"},
                {"sense": "smell", "label": "Name 2 things you can smell"},
                {"sense": "taste", "label": "Name 1 thing you can taste"},
            ],
        }
    )
    assert isinstance(cfg, SenseGroundingConfig)
    assert [p.sense for p in cfg.prompts] == ["sight", "touch", "hearing", "smell", "taste"]


def test_tarot_round_trip() -> None:
    cfg = _ADAPTER.validate_python(
        {
            "mode": "tarot",
            "deck": "major_arcana",
            "per_card_minutes": 5,
            "hide_timer_during_meditation": True,
        }
    )
    assert isinstance(cfg, TarotConfig)
    assert cfg.deck == "major_arcana"


# -- Validators --------------------------------------------------------------


def test_unknown_mode_is_rejected() -> None:
    with pytest.raises(ValidationError):
        _ADAPTER.validate_python({"mode": "telepathy"})


def test_meditation_timer_rejects_subminimum_duration() -> None:
    with pytest.raises(ValidationError):
        MeditationTimerConfig(mode="meditation_timer", duration_minutes=0.1)


def test_metronome_bpm_lower_bound() -> None:
    with pytest.raises(ValidationError):
        MetronomeConfig(
            mode="metronome",
            bpm=19,
            timer=MeditationTimerConfig(mode="meditation_timer", duration_minutes=5),
        )


def test_metronome_bpm_upper_bound() -> None:
    with pytest.raises(ValidationError):
        MetronomeConfig(
            mode="metronome",
            bpm=241,
            timer=MeditationTimerConfig(mode="meditation_timer", duration_minutes=5),
        )


def test_metronome_bpm_zero_rejected() -> None:
    with pytest.raises(ValidationError):
        MetronomeConfig(
            mode="metronome",
            bpm=0,
            timer=MeditationTimerConfig(mode="meditation_timer", duration_minutes=5),
        )


def test_interval_bell_rejects_both_fields() -> None:
    with pytest.raises(ValidationError):
        IntervalBellConfig(
            mode="interval_bell",
            duration_minutes=20,
            interval_minutes=5,
            cue_offsets_minutes=[5, 10],
            bell_tone="bowl",
        )


def test_interval_bell_rejects_neither_field() -> None:
    with pytest.raises(ValidationError):
        IntervalBellConfig(
            mode="interval_bell",
            duration_minutes=20,
            interval_minutes=None,
            cue_offsets_minutes=None,
            bell_tone="bowl",
        )


def test_interval_bell_rejects_interval_at_or_past_duration() -> None:
    """An interval ≥ duration would never fire inside the session window."""
    with pytest.raises(ValidationError):
        IntervalBellConfig(
            mode="interval_bell",
            duration_minutes=10,
            interval_minutes=10,
            bell_tone="bowl",
        )
    with pytest.raises(ValidationError):
        IntervalBellConfig(
            mode="interval_bell",
            duration_minutes=10,
            interval_minutes=15,
            bell_tone="bowl",
        )


def test_interval_bell_rejects_empty_offsets_list() -> None:
    """An empty offsets list is set-but-meaningless; reject it explicitly."""
    with pytest.raises(ValidationError):
        IntervalBellConfig(
            mode="interval_bell",
            duration_minutes=20,
            cue_offsets_minutes=[],
            bell_tone="bowl",
        )


def test_interval_bell_rejects_offsets_beyond_duration() -> None:
    """A cue offset past the session end is meaningless and must be rejected."""
    with pytest.raises(ValidationError):
        IntervalBellConfig(
            mode="interval_bell",
            duration_minutes=10,
            cue_offsets_minutes=[5, 15],
            bell_tone="bowl",
        )


def test_sense_grounding_rejects_empty_prompts() -> None:
    with pytest.raises(ValidationError):
        SenseGroundingConfig(mode="sense_grounding", prompts=[])


def test_sense_grounding_rejects_unknown_sense_literal() -> None:
    with pytest.raises(ValidationError):
        _ADAPTER.validate_python(
            {
                "mode": "sense_grounding",
                "prompts": [{"sense": "aura", "label": "x"}],
            }
        )


def test_rep_counter_rejects_zero_target() -> None:
    with pytest.raises(ValidationError):
        RepCounterConfig(mode="rep_counter", target_reps=0, unit_label="reps")


def test_tarot_rejects_zero_per_card_minutes() -> None:
    with pytest.raises(ValidationError):
        TarotConfig(mode="tarot", deck="major_arcana", per_card_minutes=0)


def test_discriminator_keyed_payload_dispatches_to_right_model() -> None:
    """The union adapter picks the right subclass purely from ``mode``."""
    cfg = _ADAPTER.validate_python({"mode": "count_up"})
    assert type(cfg) is CountUpConfig
