"""Tests for the user-practice customization resolver."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date

import pytest

from domain.practice_resolution import effective_config, effective_name
from models.practice import Practice
from models.user_practice import UserPractice
from schemas.practice_mode_config import (
    CountUpConfig,
    IntervalBellConfig,
    MeditationTimerConfig,
    MetronomeConfig,
    RepCounterConfig,
    SenseGroundingConfig,
    TarotConfig,
)


def _practice(mode: str, mode_config: Mapping[str, object], **overrides: object) -> Practice:
    """Build a catalog Practice with the requested mode/config."""
    base: dict[str, object] = {
        "id": 1,
        "stage_number": 1,
        "name": "Catalog name",
        "description": "x",
        "instructions": "x",
        "default_duration_minutes": 10,
        "submitted_by_user_id": None,
        "approved": True,
        "mode": mode,
        "mode_config": dict(mode_config),
    }
    base.update(overrides)
    return Practice(**base)


def _user_practice(
    practice_id: int = 1,
    *,
    custom_name: str | None = None,
    mode_config_override: dict[str, object] | None = None,
) -> UserPractice:
    return UserPractice(
        id=42,
        user_id=7,
        practice_id=practice_id,
        stage_number=1,
        start_date=date(2026, 1, 1),
        end_date=None,
        custom_name=custom_name,
        mode_config_override=mode_config_override,
    )


# -- effective_name ---------------------------------------------------------


def test_effective_name_falls_back_to_catalog_when_no_override() -> None:
    practice = _practice("count_up", {"mode": "count_up"})
    assert effective_name(practice, _user_practice()) == "Catalog name"


def test_effective_name_uses_user_custom_name_when_set() -> None:
    practice = _practice("count_up", {"mode": "count_up"})
    user_practice = _user_practice(custom_name="My Morning Sit")
    assert effective_name(practice, user_practice) == "My Morning Sit"


def test_effective_name_handles_missing_user_practice() -> None:
    practice = _practice("count_up", {"mode": "count_up"})
    assert effective_name(practice, None) == "Catalog name"


# -- effective_config -------------------------------------------------------


def test_effective_config_returns_catalog_when_no_override() -> None:
    catalog_cfg = {"mode": "count_up", "soft_cap_minutes": None}
    practice = _practice("count_up", catalog_cfg)
    cfg = effective_config(practice, _user_practice())
    assert isinstance(cfg, CountUpConfig)
    assert cfg.soft_cap_minutes is None


def test_effective_config_uses_override_when_set() -> None:
    catalog_cfg = {
        "mode": "meditation_timer",
        "duration_minutes": 10,
        "start_bell": True,
        "halfway_bell": False,
        "end_bell": True,
    }
    practice = _practice("meditation_timer", catalog_cfg)
    override = {**catalog_cfg, "duration_minutes": 25, "halfway_bell": True}
    user_practice = _user_practice(mode_config_override=override)
    cfg = effective_config(practice, user_practice)
    assert isinstance(cfg, MeditationTimerConfig)
    assert cfg.duration_minutes == 25
    assert cfg.halfway_bell is True


def test_effective_config_handles_missing_user_practice() -> None:
    catalog_cfg = {"mode": "count_up", "soft_cap_minutes": 30}
    practice = _practice("count_up", catalog_cfg)
    cfg = effective_config(practice, None)
    assert isinstance(cfg, CountUpConfig)
    assert cfg.soft_cap_minutes == 30


def test_effective_config_rejects_override_with_mismatched_mode() -> None:
    catalog_cfg = {"mode": "count_up", "soft_cap_minutes": None}
    practice = _practice("count_up", catalog_cfg)
    bad_override = {
        "mode": "meditation_timer",
        "duration_minutes": 10,
    }
    user_practice = _user_practice(mode_config_override=bad_override)
    with pytest.raises(ValueError, match="mode_mismatch"):
        effective_config(practice, user_practice)


# -- Per-mode round-trip coverage -------------------------------------------


def test_effective_config_metronome_override_round_trip() -> None:
    catalog_cfg = {
        "mode": "metronome",
        "bpm": 60,
        "timer": {"mode": "meditation_timer", "duration_minutes": 30},
    }
    practice = _practice("metronome", catalog_cfg)
    override = {
        "mode": "metronome",
        "bpm": 90,
        "timer": {"mode": "meditation_timer", "duration_minutes": 20, "halfway_bell": True},
    }
    cfg = effective_config(practice, _user_practice(mode_config_override=override))
    assert isinstance(cfg, MetronomeConfig)
    assert cfg.bpm == 90
    assert cfg.timer.duration_minutes == 20


def test_effective_config_interval_bell_override_round_trip() -> None:
    catalog_cfg = {
        "mode": "interval_bell",
        "duration_minutes": 30,
        "interval_minutes": 5,
        "bell_tone": "bowl",
    }
    practice = _practice("interval_bell", catalog_cfg)
    override = {**catalog_cfg, "interval_minutes": None, "cue_offsets_minutes": [5, 10, 20]}
    cfg = effective_config(practice, _user_practice(mode_config_override=override))
    assert isinstance(cfg, IntervalBellConfig)
    assert cfg.cue_offsets_minutes == [5, 10, 20]


def test_effective_config_rep_counter_round_trip() -> None:
    catalog_cfg = {
        "mode": "rep_counter",
        "target_reps": 108,
        "unit_label": "breaths",
    }
    practice = _practice("rep_counter", catalog_cfg)
    override = {**catalog_cfg, "target_reps": 54, "unit_label": "prostrations"}
    cfg = effective_config(practice, _user_practice(mode_config_override=override))
    assert isinstance(cfg, RepCounterConfig)
    assert cfg.target_reps == 54
    assert cfg.unit_label == "prostrations"


def test_effective_config_sense_grounding_round_trip() -> None:
    catalog_cfg = {
        "mode": "sense_grounding",
        "prompts": [
            {"sense": "sight", "label": "5 things"},
            {"sense": "touch", "label": "4 things"},
        ],
    }
    practice = _practice("sense_grounding", catalog_cfg)
    cfg = effective_config(practice, _user_practice())
    assert isinstance(cfg, SenseGroundingConfig)
    assert len(cfg.prompts) == 2


def test_effective_config_tarot_round_trip() -> None:
    catalog_cfg = {"mode": "tarot", "deck": "major_arcana", "per_card_minutes": 5}
    practice = _practice("tarot", catalog_cfg)
    cfg = effective_config(practice, _user_practice())
    assert isinstance(cfg, TarotConfig)
    assert cfg.per_card_minutes == 5
