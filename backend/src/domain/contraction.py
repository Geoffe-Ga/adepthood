"""Pure contraction detection — naming a natural ebb, never scoring a failure.

Given a snapshot of how a user's habit *foundation* has behaved over a recent
window, decide whether the moment warrants a warm, declinable Higher Self
reflection that gently *names* a contraction — a season of easing off — and, for
someone who has already travelled far, offers the optional five-week Return.

This module encodes NO shaming and NO gamification. It never counts a "broken
streak", never compares the user to anyone, never demotes, and stays silent by
default. An absent signal is the expected, healthy case — not a deficiency. A
contraction is framed exactly as the product philosophy frames it: *Contraction
follows Expansion; it is ok to need a break from progress.* The thresholds below
are deliberately long so a reflection only surfaces once a foundation has
genuinely thinned for a sustained stretch, honoring "you choose your depth"
before a single word is spoken.

Pure by design: no session, no I/O, no clock. The caller gathers the aggregates
(that is where the DB lives) and hands them in; every function here is a
deterministic map from value objects to value objects, trivial to unit-test
without fixtures.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from domain.metta_return import RETURN_MINIMUM_STAGE

# How many consecutive days a scheduled goal can go *logged-but-unmet* (a
# check-in recorded, but at zero units) before the foundation is named as
# thinning. Two full weeks is long enough that this reads as a genuine season,
# not a bad day or a busy week -- the reflection lands as recognition of a real
# ebb, never as a nag after a single slip.
FOUNDATION_UNMET_CONSECUTIVE_DAYS = 14

# How many consecutive days an established goal can go entirely *unchecked* (no
# check-in at all) before the same naming applies. Held equal to the unmet
# window so the two paths agree on what "a sustained stretch" means; silence and
# zero-effort days are treated with the same patience.
FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS = 14

# The highest stage a user must have *reached* before the reflection offers the
# five-week Return rather than the simple ease-off. This is the same threshold
# that gates Return eligibility everywhere else, so it is sourced from the one
# canonical constant rather than re-declared: Orange (stage 5) reached means Blue
# (stage 4) has been passed, and only someone who has integrated the earlier arc
# is invited into the deeper, more structured Return.
RETURN_MIN_HIGHEST_STAGE = RETURN_MINIMUM_STAGE

# The ease-off invitation for someone still early on the path: no elaborate
# structure, just permission to soften. Names the contraction plainly and hands
# back agency -- smaller goals, fewer habits, or simple rest -- so the moment is
# an open door, never a verdict. Deliberately avoids the word "return" so the
# five-week Return remains the higher-stage variant's distinct offer.
_SIMPLE_EASE_OFF_MESSAGE = (
    "It looks like your foundation has grown quiet lately, and that is completely ok. "
    "Contraction follows expansion as naturally as an out-breath follows an in-breath. "
    "You might ease off for a while -- keep only the habits that still feel alive, shrink "
    "a goal or two, or simply rest. Nothing here slips away when you take a break; the path "
    "waits for you, exactly as it is."
)

# The Return offer for someone who has already travelled far: the same warm
# naming, plus the specific, optional invitation to walk the gentle five-week
# Return. The Return is named and offered only -- never built or assumed -- so
# the user chooses whether to step into it.
_RETURN_OFFER_MESSAGE = (
    "It looks like your foundation has grown quiet lately, and after all the ground you have "
    "covered, that is completely ok. Contraction follows expansion; it is ok to need a break "
    "from progress. When it feels right, you are warmly invited to ease into the five-week "
    "Return -- a slower, gentler arc back toward the practices that steadied you. It is here "
    "whenever you want it, and just as welcome to set aside for now."
)


class ContractionVariant(StrEnum):
    """Which warm reflection a flagged contraction warrants.

    ``SIMPLE_EASE_OFF`` is for a user still early on the path -- a plain
    invitation to soften. ``RETURN_OFFER`` is for a user who has reached
    :data:`RETURN_MIN_HIGHEST_STAGE` or beyond, adding the optional five-week
    Return as a declinable next step.
    """

    SIMPLE_EASE_OFF = "simple_ease_off"
    RETURN_OFFER = "return_offer"


@dataclass(frozen=True)
class HabitFoundationSignal:
    """One habit's recent foundation behavior, gathered from persistence.

    ``consecutive_unmet_days`` counts days the goal was checked in at zero units;
    ``consecutive_unchecked_days`` counts days with no check-in at all. Both are
    measured from today backwards over a bounded window.
    """

    habit_id: int
    consecutive_unmet_days: int
    consecutive_unchecked_days: int


@dataclass(frozen=True)
class ContractionAggregates:
    """A snapshot of one user's habit-foundation signals for detection.

    ``habits`` is a tuple so the value object is immutable by content, not just
    by attribute binding: a frozen dataclass forbids reassigning the field but
    would still let a caller mutate a list in place, which a pure snapshot must
    not permit.
    """

    habits: tuple[HabitFoundationSignal, ...]


@dataclass(frozen=True)
class ContractionSignal:
    """A flagged contraction -- the marker that a warm reflection is warranted.

    Carries the ids of the habits whose foundation crossed a window, purely as
    useful context; detection callers only distinguish ``None`` (silent) from an
    instance (flagged). Frozen and value-equal so repeated detection over the
    same aggregates yields an equal signal.
    """

    flagged_habit_ids: tuple[int, ...]


@dataclass(frozen=True)
class ContractionInvitation:
    """The warm, declinable reflection copy chosen for a flagged contraction."""

    variant: ContractionVariant
    message: str


def _habit_crosses_window(habit: HabitFoundationSignal) -> bool:
    """Return True when either window is met exactly (window-1 stays silent)."""
    return (
        habit.consecutive_unmet_days >= FOUNDATION_UNMET_CONSECUTIVE_DAYS
        or habit.consecutive_unchecked_days >= FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS
    )


def detect_contraction(aggregates: ContractionAggregates) -> ContractionSignal | None:
    """Name a contraction when any habit's foundation has thinned for a full window.

    Silent by default: empty or healthy aggregates return ``None``. A single
    habit crossing either window (unmet *or* unchecked) is enough to flag, since
    a thinning foundation is worth naming even when only one thread has gone
    quiet. The boundary is exact -- one day short of a window never flags.
    """
    flagged = tuple(h.habit_id for h in aggregates.habits if _habit_crosses_window(h))
    if not flagged:
        return None
    return ContractionSignal(flagged_habit_ids=flagged)


def build_contraction_invitation(highest_stage_reached: int) -> ContractionInvitation:
    """Choose the warm reflection copy for a flagged contraction, gated by stage.

    A user below :data:`RETURN_MIN_HIGHEST_STAGE` receives the simple ease-off
    invitation; one who has reached it or beyond additionally receives the
    optional five-week Return. The precondition is that a contraction has already
    been detected (:func:`detect_contraction` returned a signal); the copy itself
    depends only on the user's furthest reach, so the signal is not an input here.
    """
    if highest_stage_reached >= RETURN_MIN_HIGHEST_STAGE:
        return ContractionInvitation(
            variant=ContractionVariant.RETURN_OFFER,
            message=_RETURN_OFFER_MESSAGE,
        )
    return ContractionInvitation(
        variant=ContractionVariant.SIMPLE_EASE_OFF,
        message=_SIMPLE_EASE_OFF_MESSAGE,
    )
