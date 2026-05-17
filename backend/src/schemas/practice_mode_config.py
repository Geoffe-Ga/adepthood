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
# Shared with ``schemas.practice_session_metadata`` so the option-key bound
# is encoded once: ``MindfulAnchorMetadata.chosen_option_key`` mirrors the
# values the catalog config emits.
OPTION_KEY_MAX = 64
OPTION_KEY_PATTERN = r"^[a-z][a-z0-9_]*$"
_OPTION_LABEL_MAX = 255
_OPTION_DESCRIPTION_MAX = 500
_INSTRUCTION_MAX = 500
_MIN_DURATION_SECONDS_MAX = 3_600
_MINDFUL_ANCHOR_OPTIONS_MAX = 20
# Shared with ``schemas.practice_session_metadata`` so the deck slug and
# card-name caps are encoded once. ``CardMeditationMetadata`` mirrors the
# same bounds it sees coming back from sessions.
CARD_DECK_ID_MAX = 64
CARD_DECK_ID_PATTERN = r"^[a-z][a-z0-9_]*$"
CARD_NAME_MAX = 120
# Public so ``schemas.practice_session_metadata`` can derive its
# ``card_drawn_index`` ceiling without the two modules silently drifting
# (see ``test_card_meditation_metadata_ceiling_matches_config_constant``).
CARD_MEDITATION_CARDS_MAX = 200
# Sentinel deck id that signals a user-curated deck whose cards travel
# inline in the config. Public so tests and callers reference one
# canonical literal — a rename here would catch any stale string.
CARD_MEDITATION_CUSTOM_DECK_ID = "custom"
_CARD_IMAGE_ASSET_KEY_MAX = 200
_CARD_IMAGE_URI_MAX = 500
_CARD_SYMBOLISM_MAX = 500
# Allowlist mobile-local URI schemes for ``image_uri``. The server never
# fetches the URI, but the value round-trips through the API to every
# client that reads the practice, so a stored
# ``http://attacker.com/beacon`` or ``javascript:...`` would be a stored
# XSS/SSRF staging vector if a frontend ever renders the string as an
# image source without re-sanitising. Restricting to the schemes mobile
# clients actually produce (``file``, ``content``, ``ph``, ``asset``)
# closes that vector at the schema boundary.
_CARD_IMAGE_URI_PATTERN = r"^(file|content|ph|asset)://[^\s<>\"]+$"

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


class MindfulAnchorOption(_ConfigBase):
    """One pickable anchor for a single-action mindful practice.

    ``key`` is a stable machine identifier (used by session metadata to
    record which option the user chose); ``label`` is the human-facing
    string the UI renders; ``description`` is an optional hint shown
    alongside the label.
    """

    key: str = Field(min_length=1, max_length=OPTION_KEY_MAX, pattern=OPTION_KEY_PATTERN)
    label: str = Field(min_length=1, max_length=_OPTION_LABEL_MAX)
    description: str | None = Field(default=None, max_length=_OPTION_DESCRIPTION_MAX)


def _reject_duplicate_option_keys(options: list[MindfulAnchorOption]) -> None:
    """Reject any options list containing duplicate ``key`` slugs.

    Extracted from :class:`MindfulAnchorConfig` so the validator method
    stays at xenon rank A — the duplicate-key check is independent of
    the "require_option_choice ⇒ options non-empty" rule and reads more
    clearly on its own.
    """
    keys = [opt.key for opt in options]
    if len(keys) != len(set(keys)):
        msg = "options must not contain duplicate keys"
        raise ValueError(msg)


def _reject_empty_options_when_choice_required(
    options: list[MindfulAnchorOption], *, require_option_choice: bool
) -> None:
    """Reject the contradictory ``require_option_choice=True`` + empty list state."""
    if require_option_choice and not options:
        msg = "options must be non-empty when require_option_choice is True"
        raise ValueError(msg)


class MindfulAnchorConfig(_ConfigBase):
    """Single mindful act with an optional chooser and a soft duration floor.

    Covers practices like Touch Grass or Mindful Eating — one instruction,
    one "mark complete" action, an optional list of anchors to pick from,
    and a soft minimum the client can nudge against without the server
    rejecting shorter sessions.
    """

    mode: Literal["mindful_anchor"] = "mindful_anchor"
    instruction: str = Field(min_length=1, max_length=_INSTRUCTION_MAX)
    min_duration_seconds: int = Field(ge=0, le=_MIN_DURATION_SECONDS_MAX)
    options: list[MindfulAnchorOption] = Field(
        default_factory=list, max_length=_MINDFUL_ANCHOR_OPTIONS_MAX
    )
    require_option_choice: bool = False

    @model_validator(mode="after")
    def _check_options_invariants(self) -> Self:
        _reject_duplicate_option_keys(self.options)
        _reject_empty_options_when_choice_required(
            self.options, require_option_choice=self.require_option_choice
        )
        return self


class CardMeditationCard(_ConfigBase):
    """One card in a card-meditation deck — bundled or user-curated.

    ``image_asset_key`` is an opaque handle the frontend resolves against
    a bundled deck manifest (e.g. ``"rws/major/00_fool"``); the server
    never dereferences it. ``image_uri`` is a client-local URI (the most
    common case is a phone-photo ``file:///...`` path for a custom deck)
    that the server likewise never fetches. The two are mutually
    exclusive — a card either points at a curated asset *or* at a local
    file, never both — and both being unset is also valid for a text-only
    card whose meaning rides entirely on ``name`` and ``symbolism``.
    """

    name: str = Field(
        min_length=1,
        max_length=CARD_NAME_MAX,
        description="Card title shown above the image / symbolism block.",
    )
    image_asset_key: str | None = Field(
        default=None,
        min_length=1,
        max_length=_CARD_IMAGE_ASSET_KEY_MAX,
        description=(
            "Opaque handle resolved against the bundled deck manifest "
            "(e.g. ``rws/major/00_fool``). The server never dereferences it."
        ),
    )
    image_uri: str | None = Field(
        default=None,
        min_length=1,
        max_length=_CARD_IMAGE_URI_MAX,
        pattern=_CARD_IMAGE_URI_PATTERN,
        description=(
            "Mobile-local URI (``file://``, ``content://``, ``ph://``, ``asset://``). "
            "The server never fetches it and rejects network/script schemes at "
            "the schema boundary."
        ),
    )
    symbolism: str | None = Field(
        default=None,
        max_length=_CARD_SYMBOLISM_MAX,
        description="Short reflection prompt rendered alongside the card image.",
    )

    @model_validator(mode="after")
    def _check_exclusive_image_fields(self) -> Self:
        if self.image_asset_key is not None and self.image_uri is not None:
            msg = "set at most one of image_asset_key or image_uri"
            raise ValueError(msg)
        return self


class CardMeditationConfig(_ConfigBase):
    """Deck-agnostic card meditation — bundled deck *or* user-curated cards.

    ``deck_id`` is the slug the frontend uses to resolve which bundled
    deck (``"rws"``, ``"thoth"``, …) to render; the sentinel ``"custom"``
    signals a user-curated deck whose cards travel inline in ``cards``.
    For bundled decks the ``cards`` field stays ``None`` because the
    frontend already owns the canonical card list.
    """

    mode: Literal["card_meditation"] = "card_meditation"
    deck_id: str = Field(min_length=1, max_length=CARD_DECK_ID_MAX, pattern=CARD_DECK_ID_PATTERN)
    per_card_minutes: float = Field(default=5, ge=_DURATION_MIN_MINUTES, le=_DURATION_MAX_MINUTES)
    shuffle: bool = True
    reveal_after_meditation: bool = False
    hide_timer_during_meditation: bool = True
    cards: list[CardMeditationCard] | None = Field(
        default=None, max_length=CARD_MEDITATION_CARDS_MAX
    )

    @model_validator(mode="after")
    def _check_custom_deck_carries_cards(self) -> Self:
        if self.deck_id == CARD_MEDITATION_CUSTOM_DECK_ID and not self.cards:
            msg = (
                f"cards must be a non-empty list when deck_id is {CARD_MEDITATION_CUSTOM_DECK_ID!r}"
            )
            raise ValueError(msg)
        return self


#: Discriminated union over all per-mode config payloads, keyed on ``mode``.
ModeConfig = Annotated[
    MeditationTimerConfig
    | CountUpConfig
    | MetronomeConfig
    | IntervalBellConfig
    | RepCounterConfig
    | SenseGroundingConfig
    | TarotConfig
    | TalliedGroundingConfig
    | MindfulAnchorConfig
    | CardMeditationConfig,
    Field(discriminator="mode"),
]

#: Reusable validator — instantiate once, validate many JSON payloads.
ModeConfigAdapter: TypeAdapter[ModeConfig] = TypeAdapter(ModeConfig)
