"""Per-mode practice configuration as a Pydantic discriminated union.

Each mode carries its own config shape (BPM for metronome, prompts for
sense-grounding, etc.). The catalog row's ``mode_config`` JSON column stores
one of these payloads; the discriminator field ``mode`` keeps the union
self-tagged so callers never have to branch on it manually.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

_BPM_MIN = 20
_BPM_MAX = 240
_DURATION_MIN_MINUTES = 0.5
_DURATION_MAX_MINUTES = 24 * 60
_PROMPT_LABEL_MAX = 255
_UNIT_LABEL_MAX = 64

Sense = Literal["sight", "touch", "hearing", "smell", "taste"]
BellTone = Literal["bowl", "chime", "gong"]


class _ConfigBase(BaseModel):
    """Shared config for every mode-specific config model."""

    model_config = ConfigDict(extra="forbid")


class MeditationTimerConfig(_ConfigBase):
    """Plain countdown with optional start / halfway / end bell cues."""

    mode: Literal["meditation_timer"] = "meditation_timer"
    duration_minutes: float = Field(ge=_DURATION_MIN_MINUTES, le=_DURATION_MAX_MINUTES)
    start_bell: bool = True
    halfway_bell: bool = False
    end_bell: bool = True


class CountUpConfig(_ConfigBase):
    """Open-ended timer that counts up; user decides when to stop."""

    mode: Literal["count_up"] = "count_up"
    soft_cap_minutes: float | None = Field(
        default=None, ge=_DURATION_MIN_MINUTES, le=_DURATION_MAX_MINUTES
    )


class MetronomeConfig(_ConfigBase):
    """Metronome ticking at ``bpm`` inside a surrounding meditation window."""

    mode: Literal["metronome"] = "metronome"
    bpm: int = Field(ge=_BPM_MIN, le=_BPM_MAX)
    timer: MeditationTimerConfig


class IntervalBellConfig(_ConfigBase):
    """Meditation window with bells at evenly-spaced or explicit offsets.

    Exactly one of ``interval_minutes`` (evenly spaced) or
    ``cue_offsets_minutes`` (explicit list) must be set — the two are
    mutually exclusive, validated below.
    """

    mode: Literal["interval_bell"] = "interval_bell"
    duration_minutes: float = Field(ge=_DURATION_MIN_MINUTES, le=_DURATION_MAX_MINUTES)
    interval_minutes: float | None = Field(default=None, ge=_DURATION_MIN_MINUTES)
    cue_offsets_minutes: list[float] | None = None
    bell_tone: BellTone = "bowl"

    @model_validator(mode="after")
    def _check_exclusive_fields(self) -> Self:
        has_interval = self.interval_minutes is not None
        has_offsets = self.cue_offsets_minutes is not None
        if has_interval == has_offsets:
            msg = "Set exactly one of interval_minutes or cue_offsets_minutes"
            raise ValueError(msg)
        if self.cue_offsets_minutes is not None:
            if not self.cue_offsets_minutes:
                msg = "cue_offsets_minutes must contain at least one offset"
                raise ValueError(msg)
            if any(o <= 0 or o > self.duration_minutes for o in self.cue_offsets_minutes):
                msg = "cue offsets must fall within (0, duration_minutes]"
                raise ValueError(msg)
        return self


class RepCounterConfig(_ConfigBase):
    """Count manual taps toward a target (e.g. 108 breath cycles)."""

    mode: Literal["rep_counter"] = "rep_counter"
    target_reps: int = Field(ge=1)
    unit_label: str = Field(min_length=1, max_length=_UNIT_LABEL_MAX)
    time_cap_minutes: float | None = Field(
        default=None, ge=_DURATION_MIN_MINUTES, le=_DURATION_MAX_MINUTES
    )


class SensePrompt(_ConfigBase):
    """A single step in a sense-grounding sequence (e.g. 5-4-3-2-1)."""

    sense: Sense
    label: str = Field(min_length=1, max_length=_PROMPT_LABEL_MAX)


class SenseGroundingConfig(_ConfigBase):
    """Ordered list of sense-grounding prompts; the user taps through them."""

    mode: Literal["sense_grounding"] = "sense_grounding"
    prompts: list[SensePrompt] = Field(min_length=1)


class TarotConfig(_ConfigBase):
    """Meditate on one major-arcana card per day, rotating through 22."""

    mode: Literal["tarot"] = "tarot"
    deck: Literal["major_arcana"] = "major_arcana"
    per_card_minutes: float = Field(default=5, ge=_DURATION_MIN_MINUTES, le=_DURATION_MAX_MINUTES)
    hide_timer_during_meditation: bool = True


#: Discriminated union over all per-mode config payloads, keyed on ``mode``.
ModeConfig = Annotated[
    MeditationTimerConfig
    | CountUpConfig
    | MetronomeConfig
    | IntervalBellConfig
    | RepCounterConfig
    | SenseGroundingConfig
    | TarotConfig,
    Field(discriminator="mode"),
]

#: Reusable validator — instantiate once, validate many JSON payloads.
ModeConfigAdapter: TypeAdapter[ModeConfig] = TypeAdapter(ModeConfig)
