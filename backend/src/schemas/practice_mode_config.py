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
_TALLIED_KEY_MAX = 64
_TALLIED_LABEL_MAX = 255
_TALLIED_KEY_PATTERN = r"^[a-z][a-z0-9_]*$"
# Public ceilings: imported by ``schemas.practice_session_metadata`` to
# derive its post-session caps so the two modules cannot silently diverge
# when these values change. Treat any new ceiling that the metadata
# module also needs as part of the same public contract.
TALLIED_TARGET_MAX = 20
TALLIED_ROUNDS_MAX = 10
TALLIED_CATEGORIES_MAX = 12

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


def _validate_interval_bell_offsets(offsets: list[float], duration_minutes: float) -> None:
    """Validate an explicit ``cue_offsets_minutes`` list.

    Extracted from :class:`IntervalBellConfig` so the validator method
    stays at xenon rank A — the offset-content rules are independent of
    the "set exactly one field" check and read more clearly side by side.
    """
    if not offsets:
        msg = "cue_offsets_minutes must contain at least one offset"
        raise ValueError(msg)
    if any(o <= 0 or o > duration_minutes for o in offsets):
        msg = "cue offsets must fall within (0, duration_minutes]"
        raise ValueError(msg)


def _validate_interval_bell_spacing(interval_minutes: float, duration_minutes: float) -> None:
    """Reject even-spacing settings whose first bell falls outside the window."""
    if interval_minutes >= duration_minutes:
        msg = "interval_minutes must be less than duration_minutes"
        raise ValueError(msg)


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
        if self.interval_minutes is not None:
            _validate_interval_bell_spacing(self.interval_minutes, self.duration_minutes)
        if self.cue_offsets_minutes is not None:
            _validate_interval_bell_offsets(self.cue_offsets_minutes, self.duration_minutes)
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


class TalliedCategory(_ConfigBase):
    """One category in a tallied-grounding round (e.g. "shapes", "colors")."""

    key: str = Field(
        min_length=1,
        max_length=_TALLIED_KEY_MAX,
        pattern=_TALLIED_KEY_PATTERN,
        description=(
            "Snake-case analytics slug matching ``^[a-z][a-z0-9_]*$`` "
            "(hyphens and uppercase are rejected)."
        ),
    )
    label: str = Field(min_length=1, max_length=_TALLIED_LABEL_MAX)
    target_count: int = Field(ge=1, le=TALLIED_TARGET_MAX)


class TalliedGroundingConfig(_ConfigBase):
    """Rounds-by-categories-by-target-count shape shared by Find Shapes / Find Colors.

    Each round walks every category in order; the user tallies up to
    ``target_count`` items per category before advancing. ``key`` is the
    machine slug used for analytics and translation lookups; ``label`` is
    the display string.
    """

    mode: Literal["tallied_grounding"] = "tallied_grounding"
    rounds: int = Field(ge=1, le=TALLIED_ROUNDS_MAX)
    categories: list[TalliedCategory] = Field(min_length=1, max_length=TALLIED_CATEGORIES_MAX)

    @model_validator(mode="after")
    def _check_unique_category_keys(self) -> Self:
        """Reject duplicate ``key`` values — analytics rely on uniqueness."""
        seen: set[str] = set()
        for category in self.categories:
            if category.key in seen:
                msg = f"duplicate category key: {category.key!r}"
                raise ValueError(msg)
            seen.add(category.key)
        return self


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
    | TarotConfig
    | TalliedGroundingConfig,
    Field(discriminator="mode"),
]

#: Reusable validator — instantiate once, validate many JSON payloads.
ModeConfigAdapter: TypeAdapter[ModeConfig] = TypeAdapter(ModeConfig)
