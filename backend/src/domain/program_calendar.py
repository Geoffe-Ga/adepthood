"""Date-derived program calendar — the backend mirror of the frontend anchor.

Issue #386: PR #384 made the frontend treat one program-start anchor as
canonical — every screen derives stage/week from
``programStartDate`` + ``STAGE_DURATIONS_DAYS``.  The backend's gating
used different models (prompt-completion counts for weeks, the validated
advancement chain for stages), so the server could 403 a week or stage
the calendar says is open.  These helpers compute the same calendar
server-side; the gating call sites combine them with the existing models
via ``max(...)`` so time can OPEN access but never revoke what
advancement already granted — and never let a client skip past the
calendar.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from domain.constants import STAGE_DURATIONS_DAYS, TOTAL_STAGES
from domain.weekly_prompts import TOTAL_WEEKS

if TYPE_CHECKING:
    from models.stage_progress import StageProgress

_DAYS_PER_WEEK = 7


def _normalize(moment: datetime) -> datetime:
    """Strip tzinfo so naive (SQLite) and aware (Postgres) values compare.

    Both dialects store UTC; only the tzinfo flag differs (issue #412
    class).  Subtracting mixed naive/aware datetimes raises, so every
    calendar computation funnels through this.
    """
    return moment.replace(tzinfo=None) if moment.tzinfo else moment


def _elapsed_days(anchor: datetime, now: datetime) -> int:
    """Whole days since the anchor, floored at zero for clock skew."""
    delta = _normalize(now) - _normalize(anchor)
    return max(0, delta.days)


def calendar_week(anchor: datetime, now: datetime | None = None) -> int:
    """The 1-based program week ``now`` falls in, clamped to the curriculum."""
    moment = now if now is not None else datetime.now(UTC)
    week = _elapsed_days(anchor, moment) // _DAYS_PER_WEEK + 1
    return min(week, TOTAL_WEEKS)


def calendar_stage(anchor: datetime, now: datetime | None = None) -> int:
    """The 1-based stage ``now`` falls in, walking the duration schedule."""
    moment = now if now is not None else datetime.now(UTC)
    remaining = _elapsed_days(anchor, moment)
    for stage_number, duration in enumerate(STAGE_DURATIONS_DAYS, start=1):
        if remaining < duration:
            return stage_number
        remaining -= duration
    return TOTAL_STAGES


def resolve_program_anchor(progress: StageProgress) -> datetime:
    """The user's program-start anchor.

    Prefers the stored ``program_started_at`` (set at progress creation
    and backfilled by migration from the earliest habit start date);
    legacy rows that pre-date the column fall back to the per-stage
    ``stage_started_at`` — conservative (later) for anyone past stage 1,
    which only makes the time gate stricter, never looser.
    """
    return progress.program_started_at or progress.stage_started_at
