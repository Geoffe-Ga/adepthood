"""Pure-domain tests for :mod:`domain.contraction` — warm contraction detection.

These tests FAIL on import until the implementation-specialist creates
``backend/src/domain/contraction.py`` with the contracts pinned below.
That is the correct RED state for Gate 1.

Pinned public surface:
  FOUNDATION_UNMET_CONSECUTIVE_DAYS = 14
  FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS = 14
  RETURN_MIN_HIGHEST_STAGE = 5
  HabitFoundationSignal(habit_id, consecutive_unmet_days, consecutive_unchecked_days)
  ContractionAggregates(habits: tuple[HabitFoundationSignal, ...])
  ContractionSignal (frozen; flagged marker, minimal fields)
  ContractionInvitation(variant: ContractionVariant, message: str)  [frozen]
  ContractionVariant(StrEnum): SIMPLE_EASE_OFF, RETURN_OFFER
  detect_contraction(aggregates) -> ContractionSignal | None
  build_contraction_invitation(highest_stage_reached) -> ContractionInvitation

The detected condition is never framed as failure, a demotion, or a broken
streak — it is a warm, declinable Higher Self reflection honoring
"you choose your depth."
"""

from __future__ import annotations

import dataclasses

import pytest

from domain.contraction import (
    FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS,
    FOUNDATION_UNMET_CONSECUTIVE_DAYS,
    RETURN_MIN_HIGHEST_STAGE,
    ContractionAggregates,
    ContractionInvitation,
    ContractionSignal,
    ContractionVariant,
    HabitFoundationSignal,
    build_contraction_invitation,
    detect_contraction,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_EMPTY = ContractionAggregates(habits=())


def _agg(*, unmet: int = 0, unchecked: int = 0, habit_id: int = 1) -> ContractionAggregates:
    """Build a single-habit aggregates object for a scenario."""
    return ContractionAggregates(
        habits=(
            HabitFoundationSignal(
                habit_id=habit_id,
                consecutive_unmet_days=unmet,
                consecutive_unchecked_days=unchecked,
            ),
        )
    )


# ---------------------------------------------------------------------------
# 1. Empty aggregates -> silence by default
# ---------------------------------------------------------------------------


def test_empty_aggregates_returns_none() -> None:
    """No habits at all is a healthy/new-user state -- no contraction signal."""
    assert detect_contraction(_EMPTY) is None


def test_flagged_signal_is_a_contraction_signal_with_habit_ids() -> None:
    """A crossed window yields a ContractionSignal carrying the flagged habit ids."""
    signal = detect_contraction(_agg(unmet=FOUNDATION_UNMET_CONSECUTIVE_DAYS, habit_id=7))
    assert isinstance(signal, ContractionSignal)
    assert signal.flagged_habit_ids == (7,)


# ---------------------------------------------------------------------------
# 2 & 3. Unmet-days boundary
# ---------------------------------------------------------------------------


def test_unmet_days_below_window_returns_none() -> None:
    """One day short of the window must not flag a contraction."""
    below = _agg(unmet=FOUNDATION_UNMET_CONSECUTIVE_DAYS - 1)
    assert detect_contraction(below) is None


def test_unmet_days_at_window_flags_contraction() -> None:
    """Exactly the window of consecutive unmet days flags a contraction."""
    at_window = _agg(unmet=FOUNDATION_UNMET_CONSECUTIVE_DAYS)
    assert detect_contraction(at_window) is not None


# ---------------------------------------------------------------------------
# 4. Unchecked-days boundary (independent path)
# ---------------------------------------------------------------------------


def test_unchecked_days_at_window_flags_contraction() -> None:
    """Exactly the window of consecutive unchecked days flags a contraction."""
    at_window = _agg(unchecked=FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS)
    assert detect_contraction(at_window) is not None


def test_unchecked_days_below_window_returns_none() -> None:
    """One day short of the unchecked window must not flag a contraction."""
    below = _agg(unchecked=FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS - 1)
    assert detect_contraction(below) is None


# ---------------------------------------------------------------------------
# 5. Stage-gating via build_contraction_invitation
# ---------------------------------------------------------------------------


def test_low_stage_yields_simple_ease_off_variant() -> None:
    """Highest stage reached <= 3 gets the simple ease-off invitation."""
    invitation = build_contraction_invitation(highest_stage_reached=3)
    assert invitation.variant == ContractionVariant.SIMPLE_EASE_OFF


def test_blue_stage_itself_yields_simple_ease_off_variant() -> None:
    """Stage 4 (Blue) itself, not yet passed, still gets the simple variant."""
    invitation = build_contraction_invitation(highest_stage_reached=4)
    assert invitation.variant == ContractionVariant.SIMPLE_EASE_OFF


def test_stage_at_return_threshold_yields_return_offer_variant() -> None:
    """Having reached RETURN_MIN_HIGHEST_STAGE or beyond offers the Return."""
    invitation = build_contraction_invitation(highest_stage_reached=RETURN_MIN_HIGHEST_STAGE)
    assert invitation.variant == ContractionVariant.RETURN_OFFER


# ---------------------------------------------------------------------------
# 7. Determinism
# ---------------------------------------------------------------------------


def test_detect_contraction_is_deterministic() -> None:
    """Same aggregates in -> equal ContractionSignal out, every time."""
    agg = _agg(unmet=FOUNDATION_UNMET_CONSECUTIVE_DAYS)
    first = detect_contraction(agg)
    second = detect_contraction(agg)
    assert first == second


def test_build_contraction_invitation_is_deterministic() -> None:
    """Same stage in -> equal ContractionInvitation out, every time."""
    first = build_contraction_invitation(highest_stage_reached=2)
    second = build_contraction_invitation(highest_stage_reached=2)
    assert first == second


# ---------------------------------------------------------------------------
# 8. Frozen dataclass guard
# ---------------------------------------------------------------------------


def test_habit_foundation_signal_is_frozen() -> None:
    """HabitFoundationSignal cannot be mutated after construction."""
    signal = HabitFoundationSignal(
        habit_id=1, consecutive_unmet_days=0, consecutive_unchecked_days=0
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        signal.habit_id = 2  # type: ignore[misc]


def test_contraction_invitation_is_frozen() -> None:
    """ContractionInvitation cannot be mutated after construction."""
    invitation = ContractionInvitation(variant=ContractionVariant.SIMPLE_EASE_OFF, message="Rest.")
    with pytest.raises(dataclasses.FrozenInstanceError):
        invitation.message = "mutated"  # type: ignore[misc]


def test_contraction_aggregates_habits_are_immutable_by_content() -> None:
    """The ``habits`` tuple cannot be appended to -- a snapshot is immutable in full."""
    aggregates = _agg(unmet=FOUNDATION_UNMET_CONSECUTIVE_DAYS)
    assert isinstance(aggregates.habits, tuple)
    with pytest.raises(AttributeError):
        aggregates.habits.append(  # type: ignore[attr-defined]
            HabitFoundationSignal(
                habit_id=99, consecutive_unmet_days=0, consecutive_unchecked_days=0
            )
        )


# ---------------------------------------------------------------------------
# 9. Copy intent: warm, never shaming
# ---------------------------------------------------------------------------

_FORBIDDEN_SUBSTRINGS = (
    "streak",
    "fail",
    "failed",
    "behind",
    "lost",
    "should",
    "demot",
    "rank",
    "punish",
    "worse",
    "give up",
)


def test_simple_ease_off_message_is_warm_and_non_shaming() -> None:
    """The ease-off message contains no shame/gamification language."""
    invitation = build_contraction_invitation(highest_stage_reached=1)
    assert invitation.message
    lowered = invitation.message.lower()
    for forbidden in _FORBIDDEN_SUBSTRINGS:
        assert forbidden not in lowered, (
            f"forbidden word {forbidden!r} found in: {invitation.message!r}"
        )
    assert any(anchor in lowered for anchor in ("break", "ease", "rest"))


def test_return_offer_message_is_warm_and_non_shaming() -> None:
    """The Return-offer message contains no shame/gamification language."""
    invitation = build_contraction_invitation(highest_stage_reached=RETURN_MIN_HIGHEST_STAGE)
    assert invitation.message
    lowered = invitation.message.lower()
    for forbidden in _FORBIDDEN_SUBSTRINGS:
        assert forbidden not in lowered, (
            f"forbidden word {forbidden!r} found in: {invitation.message!r}"
        )
    assert "return" in lowered
    assert any(anchor in lowered for anchor in ("break", "ease", "rest"))


# ---------------------------------------------------------------------------
# 10. Variant-specific wording is not cross-contaminated
# ---------------------------------------------------------------------------


def test_simple_ease_off_message_does_not_mention_return() -> None:
    """The Return's specific wording is only emitted by the return variant."""
    invitation = build_contraction_invitation(highest_stage_reached=2)
    assert "return" not in invitation.message.lower()
