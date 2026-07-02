"""The Return — a declinable five-week Metta arc, offered as a skillful rest.

The Return is an optional, self-chosen depth offered only once the program's
Blue stage has been passed (highest stage reached >= ``RETURN_MINIMUM_STAGE``).
Following the "Contraction follows Expansion" rhythm, it reframes a natural
easing-off as a warm invitation to turn toward loving-kindness rather than a
failure to keep pushing. Nothing here ranks, shames, or penalizes: eligibility
is derived from advancement the user already earned, and the week the arc sits
in is a gentle pacing hint, never a deadline.

These helpers are pure: they read :class:`StageProgress` and datetimes and
never mutate stage progress or any other state. The router that persists an arc
lives alongside; this module owns only the sequence, the eligibility rule, and
the elapsed-week math.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from models.stage_progress import StageProgress

# The arc is exactly five weeks — one per focus of loving-kindness.
RETURN_WEEK_COUNT = 5
# Blue is stage 4; reaching stage 5 (Orange) means Blue was passed to get there.
RETURN_MINIMUM_STAGE = 5
DAYS_PER_WEEK = 7
# The full arc: five weeks of seven days. Living all of them is completion.
RETURN_TOTAL_DAYS = RETURN_WEEK_COUNT * DAYS_PER_WEEK
# A user mid-way through a second 10-stage cycle has, by definition, already
# passed Blue in the prior cycle, so the arc is offered regardless of where the
# current cycle sits.
_SECOND_CYCLE = 2


class MettaFocus(enum.StrEnum):
    """The object of loving-kindness a Return week turns toward.

    The progression widens the circle of care: from oneself, out through a
    benefactor, a neutral stranger, and a difficult person, to all beings.
    """

    SELF = "self"
    BENEFACTOR = "benefactor"
    STRANGER = "stranger"
    ANTAGONIST = "antagonist"
    ALL_BEINGS = "all_beings"


@dataclass(frozen=True)
class ReturnWeek:
    """One week of the Return arc: its focus and the warm framing that opens it.

    Immutable so the shared :data:`RETURN_SEQUENCE` cannot be mutated by a
    caller. ``title`` and ``framing`` are user-facing copy held to a strictly
    non-shaming standard — a Return is a skillful rest, never a shortfall.
    """

    week_number: int
    focus: MettaFocus
    title: str
    framing: str


RETURN_SEQUENCE: tuple[ReturnWeek, ...] = (
    ReturnWeek(
        week_number=1,
        focus=MettaFocus.SELF,
        title="Turning kindness inward",
        framing=(
            "Contraction follows expansion, and resting here is its own kind of "
            "practice. This week, offer yourself the warmth you so freely offer "
            "others — you are welcome exactly as you are."
        ),
    ),
    ReturnWeek(
        week_number=2,
        focus=MettaFocus.BENEFACTOR,
        title="Someone who has held you",
        framing=(
            "Bring to mind someone whose care once steadied you. Let your "
            "gratitude soften into a wish for their ease. Nothing is owed here — "
            "only a quiet turning toward what has nourished you."
        ),
    ),
    ReturnWeek(
        week_number=3,
        focus=MettaFocus.STRANGER,
        title="A face you barely know",
        framing=(
            "Picture someone at the edge of your days — unremarkable, unknown. "
            "This week, extend the same simple wish for their wellbeing, "
            "widening the circle of care one gentle step at a time."
        ),
    ),
    ReturnWeek(
        week_number=4,
        focus=MettaFocus.ANTAGONIST,
        title="Meeting a hard heart with softness",
        framing=(
            "Hold someone who has been difficult for you, lightly and at your "
            "own pace. There is no obligation to forgive — only an invitation to "
            "wish them free of the suffering that hardens us all."
        ),
    ),
    ReturnWeek(
        week_number=5,
        focus=MettaFocus.ALL_BEINGS,
        title="The circle without an edge",
        framing=(
            "Let the warmth you have been growing spill past every boundary — "
            "toward all beings, everywhere, without exception. However far it "
            "reaches this week is exactly far enough."
        ),
    ),
)


def _highest_stage_reached(progress: StageProgress) -> int:
    """Return the highest stage this user reached by advancement, not by calendar.

    Advancement-granted stages are the current stage plus any historically
    completed stages; the date-derived calendar unlock is deliberately excluded
    so merely waiting can never confer eligibility.
    """
    return max({progress.current_stage, *progress.completed_stages})


def is_return_eligible(progress: StageProgress | None) -> bool:
    """Return True iff the user has passed Blue by advancement (never by calendar).

    A user with no :class:`StageProgress` row has never advanced and is
    ineligible. Otherwise eligibility holds when the highest stage reached by
    advancement is at least :data:`RETURN_MINIMUM_STAGE`, or when the user is in
    a second-or-later cycle (a full prior 10-stage cycle implies Blue was
    passed, even mid-reset). This is a read-only check that never mutates
    progress.
    """
    if progress is None:
        return False
    if progress.cycle_number >= _SECOND_CYCLE:
        return True
    return _highest_stage_reached(progress) >= RETURN_MINIMUM_STAGE


def _normalize(moment: datetime) -> datetime:
    """Strip tzinfo so naive (SQLite) and aware (Postgres) values compare.

    Both dialects store UTC; only the tzinfo flag differs. Subtracting a mixed
    naive/aware pair raises, so every elapsed-time computation funnels through
    this, mirroring the program-calendar normalization.
    """
    return moment.replace(tzinfo=None) if moment.tzinfo else moment


def _elapsed_days(anchor: datetime, now: datetime) -> int:
    """Whole days since the anchor, floored at zero for clock skew."""
    delta = _normalize(now) - _normalize(anchor)
    return max(0, delta.days)


def resumed_start(started_at: datetime, paused_at: datetime, now: datetime) -> datetime:
    """Return ``started_at`` shifted forward by the elapsed pause duration.

    Resuming a paused arc must not lose the frozen week: the time spent paused
    is pushed onto the start so elapsed-since-start once again matches the
    pre-pause elapsed. ``now`` and ``paused_at`` may carry different tzinfo
    flags across SQLite (naive) and Postgres (aware), so both are normalized
    before subtracting to form the pause duration, exactly as the elapsed-day
    math does. The resulting timedelta is then added to the ORIGINAL
    ``started_at`` — adding a timedelta preserves its tzinfo either way — so no
    mixed naive/aware subtraction is ever performed.
    """
    paused_duration = _normalize(now) - _normalize(paused_at)
    return started_at + paused_duration


def active_return_week(started_at: datetime, paused_at: datetime | None, now: datetime) -> int:
    """Return the 1-based Return week an arc sits in, clamped to the arc length.

    Elapsed time is measured from ``started_at`` to the pause instant if the arc
    is paused, otherwise to ``now`` — so a paused arc reports a frozen week that
    ignores further elapsed time. The result is clamped to
    ``[1, RETURN_WEEK_COUNT]`` so it never climbs past the arc. Mixed
    naive/aware datetimes are normalized rather than raising.
    """
    reference = paused_at if paused_at is not None else now
    week = _elapsed_days(started_at, reference) // DAYS_PER_WEEK + 1
    return min(max(week, 1), RETURN_WEEK_COUNT)


def is_return_complete(started_at: datetime, paused_at: datetime | None, now: datetime) -> bool:
    """Return True once the arc's full five weeks have been lived through.

    Completion is a pure time-derived predicate — nothing is written and no stage
    is mutated. Elapsed time is frozen exactly as :func:`active_return_week` does:
    measured to the pause instant when the arc is paused, otherwise to ``now``, so
    a pause before the boundary keeps completion frozen at False. The arc is
    complete once at least :data:`RETURN_TOTAL_DAYS` have elapsed — the fifth week
    has fully closed, a reflective close rather than a reward. Mixed naive/aware
    datetimes are normalized by the shared elapsed-day helper rather than raising.
    """
    reference = paused_at if paused_at is not None else now
    return _elapsed_days(started_at, reference) >= RETURN_TOTAL_DAYS
