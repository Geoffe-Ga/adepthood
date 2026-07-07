"""Domain logic for course content drip-feed gating and progress."""

from __future__ import annotations

import logging
import math
from datetime import UTC, datetime
from typing import Any

from domain.dates import ensure_aware

logger = logging.getLogger(__name__)


def compute_days_elapsed(stage_started_at: datetime) -> int:
    """Return whole days elapsed; clamps a future ``stage_started_at`` to 0 + WARNING."""
    now = datetime.now(UTC)
    # SQLite drops tzinfo on round-trip, so coerce naive values to UTC
    # before subtraction to avoid TypeError under the test fixture.
    stage_started_at = ensure_aware(stage_started_at)
    delta = now - stage_started_at
    if delta.total_seconds() < 0:
        logger.warning(
            "stage_started_at_in_future",
            extra={"stage_started_at": stage_started_at.isoformat(), "now": now.isoformat()},
        )
        return 0
    return delta.days


def unlocked_chapter_count(*, total: int, duration_days: int, day_in_stage: int) -> int:
    """How many of a stage's chapters are open on ``day_in_stage``.

    The proportional drip spreads a stage's ``total`` chapters evenly
    across its ``duration_days``, so by the 1-based ``day_in_stage`` the
    user has earned ``ceil(total * day / duration)`` of them, clamped to
    ``[0, total]``.  ``ceil`` rounds up, so any open day (``day >= 1``) of
    a seeded stage (``total >= 1``) yields at least one chapter — the
    guarantee that keeps an unlocked, non-empty stage from ever rendering
    "No Content Yet".  A stage the user has moved past supplies
    ``day_in_stage >= duration_days`` and unlocks everything.
    """
    if total <= 0 or duration_days <= 0 or day_in_stage <= 0:
        return 0
    if day_in_stage >= duration_days:
        return total
    earned = math.ceil(total * day_in_stage / duration_days)
    return max(0, min(earned, total))


def enrich_content_item(
    item: dict[str, Any], *, is_locked: bool, read_content_ids: set[int]
) -> dict[str, Any]:
    """Attach lock/read status to a raw content item.

    Locked items have their ``url`` set to ``None`` so a client cannot
    fetch — or spoil — a chapter ahead of its drip release.
    """
    return {
        **item,
        "is_locked": is_locked,
        "is_read": item.get("id") in read_content_ids,
        "url": None if is_locked else item["url"],
    }


def filter_content_for_user(
    items: list[dict[str, Any]],
    *,
    unlocked_count: int,
    read_content_ids: set[int],
) -> list[dict[str, Any]]:
    """Apply proportional drip-feed gating and read status to raw items.

    ``items`` must already be in the stage's release order (ascending):
    the first ``unlocked_count`` are open and the rest are locked by
    **ordinal position**, not by ``release_day``.  Gating on position is
    what lets a non-dense ``release_day`` sequence (stage 1 skips day 11)
    still drip exactly ``unlocked_count`` chapters — ``release_day`` is
    only the sort key now, never the gate.
    """
    return [
        enrich_content_item(
            item, is_locked=position >= unlocked_count, read_content_ids=read_content_ids
        )
        for position, item in enumerate(items)
    ]


def next_unlock_day(*, total: int, duration_days: int, day_in_stage: int) -> int | None:
    """The 1-based day-in-stage the next locked chapter opens, or ``None``.

    Inverts :func:`unlocked_chapter_count`: with ``k`` chapters already
    open, the ``(k + 1)``-th opens on the first day ``D`` satisfying
    ``ceil(total * D / duration) >= k + 1`` — i.e.
    ``floor(k * duration / total) + 1``.  Returns ``None`` once every
    chapter is unlocked (including the empty-stage case).
    """
    unlocked = unlocked_chapter_count(
        total=total, duration_days=duration_days, day_in_stage=day_in_stage
    )
    if unlocked >= total:
        return None
    return (unlocked * duration_days) // total + 1
