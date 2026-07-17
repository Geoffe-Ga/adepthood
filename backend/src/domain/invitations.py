"""Pure readiness-signal computation — coordinates for resonant invitations.

Given a snapshot of a user's cross-feature engagement (habit streaks, sustained
practice weeks, active-day count in a rolling window) plus any Creek Vault
corpus-theme readings, decide which deeper depths the moment invites the user to
*consider*. The output is a list of plain coordinates — target ring, optional
concrete target, and why the moment qualifies — that a later persistence pass
turns into ``InvitationSignal`` rows.

The behavioral signals (habit / practice / community) are computed purely from
local engagement and stay local. The corpus-theme source is the one outward
input: a Wheel-of-Wholeness reading gathered from a connected vault, which the
caller passes in already validated. This module applies the fullness threshold
and picks the single strongest theme, so at most one course invitation is ever
offered from it.

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

from dataclasses import dataclass, field

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

# A corpus theme this full is a genuinely lived Aspect, not a passing mention —
# high enough that the course invitation reads as recognition of where the
# user's own writing already dwells, never a nudge to "complete" a stage.
CORPUS_THEME_FULLNESS_THRESHOLD = 0.75

# Reference the model enum *values* (not bare string literals) so the candidate
# coordinates can never drift from the persisted vocabulary — the drift-guard
# test asserts exactly this coupling.
_HABIT = InvitationTargetType.HABIT.value
_PRACTICE = InvitationTargetType.PRACTICE.value
_COURSE = InvitationTargetType.COURSE.value
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
class CorpusThemeSignal:
    """One Aspect's fullness in a vault Wheel-of-Wholeness reading of the user's corpus."""

    stage_number: int
    fullness: float


@dataclass(frozen=True)
class ReadinessAggregates:
    """A snapshot of one user's cross-feature engagement for candidate math.

    ``corpus_themes`` defaults to empty and is appended last so every existing
    positional construction (behavioral-only) stays valid and behaves exactly as
    before — the vault source is purely additive.
    """

    habits: list[HabitSignal]
    practices: list[PracticeSignal]
    active_days_in_window: int
    corpus_themes: list[CorpusThemeSignal] = field(default_factory=list)


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


def _corpus_theme_candidates(themes: list[CorpusThemeSignal]) -> list[InvitationCandidate]:
    """Emit at most one course candidate for the strongest above-threshold corpus theme.

    Filters to themes at or above :data:`CORPUS_THEME_FULLNESS_THRESHOLD`; with
    none, stays silent. Otherwise the single strongest wins — highest fullness
    first, lowest ``stage_number`` breaking a tie — so the offer points at the
    one Aspect the user's own corpus most fully embodies.
    """
    eligible = [t for t in themes if t.fullness >= CORPUS_THEME_FULLNESS_THRESHOLD]
    if not eligible:
        return []
    strongest = max(eligible, key=lambda t: (t.fullness, -t.stage_number))
    return [
        InvitationCandidate(target_type=_COURSE, target_id=strongest.stage_number, kind=_READINESS)
    ]


def compute_invitation_candidates(
    aggregates: ReadinessAggregates,
) -> list[InvitationCandidate]:
    """Map an engagement snapshot to the invitation coordinates it warrants.

    Silent by default: aggregates below every threshold yield ``[]``. Each
    source contributes independently — one candidate per qualifying habit, one
    per qualifying practice, at most one outward community candidate, and at most
    one course candidate for the strongest above-threshold corpus theme — so the
    behavioral and corpus-theme signals coexist without interfering.
    """
    return [
        *_habit_candidates(aggregates.habits),
        *_practice_candidates(aggregates.practices),
        *_community_candidates(aggregates.active_days_in_window),
        *_corpus_theme_candidates(aggregates.corpus_themes),
    ]
