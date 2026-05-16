"""Per-mode practice **session** metadata as a Pydantic discriminated union.

The engine emits a per-mode payload at the *end* of a session (how many
reps were logged, which tarot card was up, …).  These shapes mirror the
mode-config types in :mod:`schemas.practice_mode_config` but capture
runtime *outputs* rather than authoring inputs.  Keeping them in a separate
union avoids loading the config schema with fields that only make sense
post-session.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from schemas.practice_mode_config import Sense

_MAX_REPS = 1_000_000
_MAX_BPM = 240
_MIN_BPM = 1
_MAX_TAROT_INDEX = 21  # 22-card major arcana, zero-indexed.
_MAX_INTERVALS = 1_000
_MAX_TALLIED_ROUNDS = 10
_MAX_TALLIED_ITEMS = 2_400  # 10 rounds * 12 categories * 20 target_count ceiling.


class _MetadataBase(BaseModel):
    """Shared config for every per-mode session metadata model."""

    model_config = ConfigDict(extra="forbid")


class MeditationTimerMetadata(_MetadataBase):
    """A plain countdown emits no extra data — the duration is on the row."""

    mode: Literal["meditation_timer"] = "meditation_timer"


class CountUpMetadata(_MetadataBase):
    """An open-ended count-up has no target, hence no extra outputs."""

    mode: Literal["count_up"] = "count_up"


class MetronomeMetadata(_MetadataBase):
    """Captures the BPM the metronome actually ran at (may differ from preset)."""

    mode: Literal["metronome"] = "metronome"
    bpm_used: int = Field(ge=_MIN_BPM, le=_MAX_BPM)


class IntervalBellMetadata(_MetadataBase):
    """How many of the scheduled bells the session actually struck."""

    mode: Literal["interval_bell"] = "interval_bell"
    intervals_struck: int = Field(ge=0, le=_MAX_INTERVALS)
    total_intervals: int = Field(ge=0, le=_MAX_INTERVALS)

    @model_validator(mode="after")
    def _check_struck_within_total(self) -> Self:
        """Reject ``intervals_struck > total_intervals`` (PR #311 review).

        Each field individually satisfies its ge/le bounds; only the
        cross-field invariant catches the nonsense state of striking more
        bells than were scheduled.
        """
        if self.intervals_struck > self.total_intervals:
            msg = "intervals_struck cannot exceed total_intervals"
            raise ValueError(msg)
        return self


class RepCounterMetadata(_MetadataBase):
    """Total reps the user tapped through during the session."""

    mode: Literal["rep_counter"] = "rep_counter"
    rep_count: int = Field(ge=0, le=_MAX_REPS)


class SenseGroundingMetadata(_MetadataBase):
    """Which sense prompts the user finished (an ordered, possibly-partial run)."""

    mode: Literal["sense_grounding"] = "sense_grounding"
    senses_completed: list[Sense] = Field(default_factory=list)


class TarotMetadata(_MetadataBase):
    """Major-arcana card index (0..21) the user meditated on."""

    mode: Literal["tarot"] = "tarot"
    card_index: int = Field(ge=0, le=_MAX_TAROT_INDEX)


class TalliedGroundingMetadata(_MetadataBase):
    """How many rounds the user finished, plus the total items tallied.

    The cross-field validator rejects ``rounds_completed > total_rounds``;
    each field individually satisfies its ge/le bounds, mirroring the
    invariant on :class:`IntervalBellMetadata`.
    """

    mode: Literal["tallied_grounding"] = "tallied_grounding"
    rounds_completed: int = Field(ge=0, le=_MAX_TALLIED_ROUNDS)
    total_rounds: int = Field(ge=1, le=_MAX_TALLIED_ROUNDS)
    items_completed: int = Field(ge=0, le=_MAX_TALLIED_ITEMS)

    @model_validator(mode="after")
    def _check_completed_within_total(self) -> Self:
        """Reject ``rounds_completed > total_rounds``."""
        if self.rounds_completed > self.total_rounds:
            msg = "rounds_completed cannot exceed total_rounds"
            raise ValueError(msg)
        return self


#: Discriminated union over all per-mode session metadata payloads.
SessionMetadata = Annotated[
    MeditationTimerMetadata
    | CountUpMetadata
    | MetronomeMetadata
    | IntervalBellMetadata
    | RepCounterMetadata
    | SenseGroundingMetadata
    | TarotMetadata
    | TalliedGroundingMetadata,
    Field(discriminator="mode"),
]

#: Reusable validator — instantiate once, validate many JSON payloads.
SessionMetadataAdapter: TypeAdapter[SessionMetadata] = TypeAdapter(SessionMetadata)
