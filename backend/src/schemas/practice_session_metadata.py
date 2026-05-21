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

from schemas.practice_mode_config import (
    CARD_DECK_ID_MAX,
    CARD_DECK_ID_PATTERN,
    CARD_MEDITATION_CARDS_MAX,
    CARD_NAME_MAX,
    OPTION_KEY_MAX,
    OPTION_KEY_PATTERN,
    TALLIED_CATEGORIES_MAX,
    TALLIED_ROUNDS_MAX,
    TALLIED_TARGET_MAX,
    Sense,
)

_MAX_REPS = 1_000_000
_MAX_BPM = 240
_MIN_BPM = 1
_MAX_TAROT_INDEX = 21  # 22-card major arcana, zero-indexed.
_MAX_INTERVALS = 1_000
# Public ceilings derived from the authoring-side ceilings so the
# post-session cap can never silently lag a config bump (e.g. raising
# the categories limit). The cross-module guard in
# ``test_practice_session_metadata.py`` locks this derivation in case
# the underlying constants are ever inlined.
MAX_TALLIED_ROUNDS = TALLIED_ROUNDS_MAX
MAX_TALLIED_ITEMS = TALLIED_ROUNDS_MAX * TALLIED_CATEGORIES_MAX * TALLIED_TARGET_MAX
_MAX_ANCHOR_DURATION_SECONDS = 4 * 60 * 60  # 4 hours; well above any plausible mindful act.
# Index ceiling for a card_meditation deck. Derived from the authoring-
# side cap so a future bump to ``CARD_MEDITATION_CARDS_MAX`` cannot leave
# the post-session index ceiling silently stale. The cross-module guard
# in ``test_card_meditation_metadata_ceiling_matches_config_constant``
# locks this derivation in case the constant is ever inlined. Re-exported
# at module scope so the contract test asserts against the same name a
# caller would import.
MAX_CARD_INDEX = CARD_MEDITATION_CARDS_MAX - 1


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


class RandomIntervalBellMetadata(_MetadataBase):
    """How many bells a random-interval session struck, and their spacing.

    ``interval_seconds`` records the actual gaps between consecutive
    bells so a post-session reflection can show the real rhythm — the
    schedule is generated client-side and is not otherwise recoverable.
    The list may be empty (a session that struck only the start bell, or
    none at all) and is capped at the same ceiling as ``bells_struck``.
    """

    mode: Literal["random_interval_bell"] = "random_interval_bell"
    bells_struck: int = Field(ge=0, le=_MAX_INTERVALS)
    interval_seconds: list[int] = Field(default_factory=list, max_length=_MAX_INTERVALS)


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
    rounds_completed: int = Field(ge=0, le=MAX_TALLIED_ROUNDS)
    total_rounds: int = Field(ge=1, le=MAX_TALLIED_ROUNDS)
    items_completed: int = Field(ge=0, le=MAX_TALLIED_ITEMS)

    @model_validator(mode="after")
    def _check_completed_within_total(self) -> Self:
        """Reject ``rounds_completed > total_rounds``."""
        if self.rounds_completed > self.total_rounds:
            msg = "rounds_completed cannot exceed total_rounds"
            raise ValueError(msg)
        return self


class MindfulAnchorMetadata(_MetadataBase):
    """What the user picked (if anything) and how long the mindful act lasted.

    ``met_min_duration`` is emitted by the client so the analytics rollup
    can distinguish "long enough" from "abandoned early" without re-running
    the soft-floor comparison against the catalog config at every query.
    """

    mode: Literal["mindful_anchor"] = "mindful_anchor"
    chosen_option_key: str | None = Field(
        default=None, max_length=OPTION_KEY_MAX, pattern=OPTION_KEY_PATTERN
    )
    duration_seconds: int = Field(ge=0, le=_MAX_ANCHOR_DURATION_SECONDS)
    met_min_duration: bool


class CardMeditationMetadata(_MetadataBase):
    """Which card the user drew (by name and optional index).

    ``card_drawn_index`` is optional because a custom deck may shuffle on
    the client side without echoing positions back, and a bundled deck
    may identify the card purely by name. The name is the authoritative
    field; the index is a convenience for analytics that want to
    correlate sessions with deck positions.
    """

    mode: Literal["card_meditation"] = "card_meditation"
    deck_id: str = Field(min_length=1, max_length=CARD_DECK_ID_MAX, pattern=CARD_DECK_ID_PATTERN)
    card_drawn_name: str = Field(min_length=1, max_length=CARD_NAME_MAX)
    card_drawn_index: int | None = Field(default=None, ge=0, le=MAX_CARD_INDEX)


#: Discriminated union over all per-mode session metadata payloads.
SessionMetadata = Annotated[
    MeditationTimerMetadata
    | CountUpMetadata
    | MetronomeMetadata
    | IntervalBellMetadata
    | RandomIntervalBellMetadata
    | RepCounterMetadata
    | SenseGroundingMetadata
    | TarotMetadata
    | TalliedGroundingMetadata
    | MindfulAnchorMetadata
    | CardMeditationMetadata,
    Field(discriminator="mode"),
]

#: Reusable validator — instantiate once, validate many JSON payloads.
SessionMetadataAdapter: TypeAdapter[SessionMetadata] = TypeAdapter(SessionMetadata)
