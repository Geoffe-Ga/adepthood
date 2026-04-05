"""Domain logic for course content drip-feed gating and progress."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def compute_days_elapsed(stage_started_at: datetime) -> int:
    """Return whole days since the user started the current stage."""
    now = datetime.now(UTC)
    # SQLite drops timezone info, so ensure both are tz-aware for subtraction
    if stage_started_at.tzinfo is None:
        stage_started_at = stage_started_at.replace(tzinfo=UTC)
    delta = now - stage_started_at
    return max(0, delta.days)


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
