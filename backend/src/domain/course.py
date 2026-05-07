"""Domain logic for course content drip-feed gating and progress."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


def compute_days_elapsed(stage_started_at: datetime) -> int:
    """Return whole days since the user started the current stage; clamped to >=0.

    BUG-COURSE-005: a future-dated ``stage_started_at`` (clock skew,
    admin backfill bug, partial migration) produces a negative
    ``timedelta`` whose ``.days`` floors to ``-1`` or further; the
    pre-fix ``max(0, .days)`` quietly returned ``0``, opening every
    ``release_day == 0`` item.  Now we structured-log a warning so
    operators can spot the data-integrity smell without re-introducing
    a 500 path on what is still a clamping fallback.
    """
    now = datetime.now(UTC)
    if stage_started_at.tzinfo is None:
        stage_started_at = stage_started_at.replace(tzinfo=UTC)
    delta = now - stage_started_at
    if delta.total_seconds() < 0:
        logger.warning(
            "stage_started_at_in_future",
            extra={"stage_started_at": stage_started_at.isoformat(), "now": now.isoformat()},
        )
        return 0
    return delta.days


def filter_content_for_user(
    items: list[dict[str, Any]],
    *,
    days_elapsed: int,
    read_content_ids: set[int],
) -> list[dict[str, Any]]:
    """Apply drip-feed gating and read status to raw content items.

    Locked items have their ``url`` set to ``None`` to prevent spoilers.
    """
    result: list[dict[str, Any]] = []
    for item in items:
        is_locked = item["release_day"] > days_elapsed
        enriched = {
            **item,
            "is_locked": is_locked,
            "is_read": item.get("id") in read_content_ids,
            "url": None if is_locked else item["url"],
        }
        result.append(enriched)
    return result


def next_unlock_day(*, release_days: list[int], days_elapsed: int) -> int | None:
    """Return the release_day of the next locked item, or None if all unlocked."""
    locked = sorted(d for d in release_days if d > days_elapsed)
    return locked[0] if locked else None
