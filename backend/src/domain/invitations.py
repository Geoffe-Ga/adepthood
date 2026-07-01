"""Pure readiness-signal computation — coordinates for resonant invitations.

Given a snapshot of a user's cross-feature engagement (habit streaks, sustained
practice weeks, active-day count in a rolling window), decide which deeper
depths the moment invites the user to *consider*. The output is a list of
plain coordinates — target ring, optional concrete target, and why the moment
qualifies — that a later persistence pass turns into ``InvitationSignal`` rows.

This module encodes NO shaming and NO FOMO: it never counts what the user
*failed* to do, never compares them to anyone, and stays silent by default.
An absent signal is the norm, not a deficiency. The thresholds below are
deliberately conservative so an invitation only appears once a rhythm is
genuinely established — the "you choose your depth" principle honoured before a
single row is written.

Pure by design: no session, no I/O, no clock. The caller gathers the
aggregates (that is where the DB lives) and hands them in; this function is a
deterministic map from a value object to a list of value objects, trivial to
unit-test without fixtures.
"""

from __future__ import annotations

from dataclasses import dataclass

from models.invitation_signal import InvitationKind, InvitationTargetType

# A sustained habit rhythm: three unbroken weeks. Long enough that the streak
# reflects an integrated habit rather than a burst of early enthusiasm, so the
# consistency invitation lands as recognition, never nagging.
SUSTAINED_HABIT_STREAK_DAYS = 21

# A practice held for a full month of weeks. Mirrors the practice-cadence
# "≥4 sessions/week" rule: four such weeks running is depth already reached,
# which the mastery invitation acknowledges.
SUSTAINED_PRACTICE_WEEKS = 4

# Broad cross-feature engagement: active on 25 of the last 30 days. Set high
# and outward-facing so the embodied-community invitation only surfaces for a
# user whose practice is clearly part of daily life — never a nudge to do more.
HIGH_ENGAGEMENT_ACTIVE_DAYS = 25

# Rolling window over which active days are counted. Thirty days is a full
# month of rhythm — wide enough to smooth over a missed day, narrow enough that
# the signal reflects the present season, not a distant past.
ENGAGEMENT_WINDOW_DAYS = 30

# Reference the model enum *values* (not bare string literals) so the candidate
# coordinates can never drift from the persisted vocabulary — the drift-guard
# test asserts exactly this coupling.
_HABIT = InvitationTargetType.HABIT.value
_PRACTICE = InvitationTargetType.PRACTICE.value
_EMBODIED_COMMUNITY = InvitationTargetType.EMBODIED_COMMUNITY.value
_CONSISTENCY = InvitationKind.CONSISTENCY.value
_MASTERY = InvitationKind.MASTERY.value
_READINESS = InvitationKind.READINESS.value


@dataclass(frozen=True)
class InvitationCandidate:
    """One coordinate for a resonant invitation, before it is persisted.

    ``target_id`` is ``None`` for a ring-level (outward) invitation such as
    embodied community, which has no concrete target within the ring.
    """

    target_type: str
    target_id: int | None
    kind: str


@dataclass(frozen=True)
class HabitSignal:
    """A habit's current streak length, gathered from the persistence layer."""

    habit_id: int
    streak_days: int


@dataclass(frozen=True)
class PracticeSignal:
    """A practice's count of consecutive weeks that met the cadence target."""

    practice_id: int
    sustained_weeks: int


@dataclass(frozen=True)
class ReadinessAggregates:
    """A snapshot of one user's cross-feature engagement for candidate math."""

    habits: list[HabitSignal]
    practices: list[PracticeSignal]
    active_days_in_window: int


def _habit_candidates(habits: list[HabitSignal]) -> list[InvitationCandidate]:
    """Emit a consistency candidate for each habit that cleared the streak floor."""
    return [
        InvitationCandidate(target_type=_HABIT, target_id=h.habit_id, kind=_CONSISTENCY)
        for h in habits
        if h.streak_days >= SUSTAINED_HABIT_STREAK_DAYS
    ]


def _practice_candidates(practices: list[PracticeSignal]) -> list[InvitationCandidate]:
    """Emit a mastery candidate for each practice that held the cadence long enough."""
    return [
        InvitationCandidate(target_type=_PRACTICE, target_id=p.practice_id, kind=_MASTERY)
        for p in practices
        if p.sustained_weeks >= SUSTAINED_PRACTICE_WEEKS
    ]


def _community_candidates(active_days_in_window: int) -> list[InvitationCandidate]:
    """Emit the outward, null-target readiness candidate when engagement is high."""
    if active_days_in_window >= HIGH_ENGAGEMENT_ACTIVE_DAYS:
        return [
            InvitationCandidate(target_type=_EMBODIED_COMMUNITY, target_id=None, kind=_READINESS)
        ]
    return []


def compute_invitation_candidates(
    aggregates: ReadinessAggregates,
) -> list[InvitationCandidate]:
    """Map an engagement snapshot to the invitation coordinates it warrants.

    Silent by default: aggregates below every threshold yield ``[]``. Each
    source contributes independently — one candidate per qualifying habit, one
    per qualifying practice, and at most one outward community candidate — so
    the three signals coexist without interfering.
    """
    return [
        *_habit_candidates(aggregates.habits),
        *_practice_candidates(aggregates.practices),
        *_community_candidates(aggregates.active_days_in_window),
    ]
