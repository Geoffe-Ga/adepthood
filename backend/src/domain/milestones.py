"""Milestone evaluation domain functions."""

from __future__ import annotations

from collections.abc import Iterable


def achieved_milestones(value: int, thresholds: Iterable[int]) -> tuple[list[int], str]:
    """Return thresholds that have been met by ``value``.

    The result includes a ``reason_code`` for auditability.
    """

    reached: list[int] = [t for t in thresholds if value >= t]
    return reached, "milestones_achieved"
