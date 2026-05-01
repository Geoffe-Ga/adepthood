"""Milestone evaluation domain functions."""

from __future__ import annotations

from collections.abc import Iterable

__all__ = ["achieved_milestones"]


def achieved_milestones(
    new_value: int,
    thresholds: Iterable[int],
    old_value: int = 0,
) -> tuple[list[int], str]:
    """Return thresholds where ``old_value < t <= new_value``, sorted ascending."""
    reached = sorted({t for t in thresholds if old_value < t <= new_value})
    return reached, "milestones_achieved"
