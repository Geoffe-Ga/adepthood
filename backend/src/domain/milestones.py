"""Milestone evaluation domain functions."""

from __future__ import annotations

from collections.abc import Iterable

__all__ = ["achieved_milestones"]


def achieved_milestones(
    new_value: int,
    thresholds: Iterable[int],
    old_value: int = 0,
) -> tuple[list[int], str]:
    """Return thresholds *newly crossed* between ``old_value`` and ``new_value``.

    Only thresholds where ``old_value < t <= new_value`` are returned,
    sorted ascending so callers can rely on a stable order even when
    ``thresholds`` is unordered.  ``old_value`` defaults to ``0`` so a
    fresh-state caller keeps the legacy "all thresholds up to
    ``new_value``" behaviour.
    """
    reached = sorted({t for t in thresholds if old_value < t <= new_value})
    return reached, "milestones_achieved"
