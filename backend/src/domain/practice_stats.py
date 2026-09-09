"""All-time per-practice totals: how many sits, and how many minutes.

Sibling of :mod:`domain.habit_stats` -- a pure function over ORM rows, no
session, no query -- so the counting rule is cheap to test and lives in exactly
one place.  The router fetches the rows and hands them here, the way
``GET /habits/{habit_id}/stats`` hands its completions to
:func:`domain.habit_stats.compute_habit_stats`.

Which sessions count
--------------------
This aggregator had to settle a question the codebase had so far avoided,
because until now nothing asked for a *total*.  Two readers of the same table
disagreed:

* :func:`domain.practice_insights._bucket_by_week` and
  :func:`domain.practice_insights._rolling_30d_stats` skip every row with
  ``duration_minutes <= 0`` -- "zero-duration aborts don't move the cadence
  needle".
* ``GET /practice-sessions/week-count``
  (:func:`routers.practice_sessions.week_count`) counts rows by timestamp with
  no duration filter at all.

A total cannot honour both.  It follows the insights rule --
``duration_minutes > MIN_COUNTED_DURATION_MINUTES`` -- for three reasons:

1. *It agrees with the numbers a practitioner already sees.*  The weekly bar
   and the 30-day rollup are the only practice figures on screen today, and
   both are built on this filter.  A lifetime total that disagreed with the
   bar would read as one of them being broken.  ``week-count`` is the odd one
   out and is already only the *fallback* path in ``useWeeklyProgress``, taken
   when the insights request fails.
2. *It is the precedent the Habits stats path set.*  ``_additive_stats``
   filters ``completed_units > 0`` for exactly this reason (#781): the stats
   endpoint and the list endpoint must not report different numbers about the
   same rows.
3. *It keeps the two fields describing one population.*  ``total_minutes /
   total_sessions`` is a real average sitting length only if the rows counted
   are the rows summed.  Counting an abort that contributes zero minutes would
   silently drag that mean toward zero.

Semantically the same claim, in the user's words: a sit you cancelled before
it started is not time you put in.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from models.practice_session import PracticeSession

# The exclusive floor a session's duration must clear to be counted.  Strictly
# greater than, never ``>=``: a zero-length row is the abort case, not a sit.
MIN_COUNTED_DURATION_MINUTES = 0.0


@dataclass(frozen=True, slots=True)
class PracticeStats:
    """All-time totals for one practice.

    Mirrors the wire schema in :class:`schemas.practice.PracticeStatsResponse`
    so the router re-shapes with a single ``model_validate``.
    """

    total_sessions: int
    total_minutes: float


def compute_practice_stats(sessions: Iterable[PracticeSession]) -> PracticeStats:
    """Aggregate ``sessions`` into all-time totals for a single practice.

    ``sessions`` may be any iterable of rows the caller has already scoped to
    one user and one practice; this function never re-queries and never filters
    on ownership -- that is the router's job, and keeping it out of here means
    a caller cannot accidentally rely on this to be a security boundary.

    Deliberately not windowed, matching ``GET /habits/{habit_id}/stats``
    (#294): "how much have I put into this" is a lifetime question.
    """
    counted = [s for s in sessions if s.duration_minutes > MIN_COUNTED_DURATION_MINUTES]
    return PracticeStats(
        total_sessions=len(counted),
        total_minutes=float(sum(s.duration_minutes for s in counted)),
    )
