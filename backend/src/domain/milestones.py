"""Milestone evaluation domain functions.

BUG-GOAL-010: this module used to ship a silent stub --
``achieved_milestones`` returned every threshold ``<= value`` regardless
of whether the threshold had already been crossed before, which would
cause clients to re-celebrate every milestone on every check-in.  The
router actually uses :func:`services.streaks.check_milestones` (which
takes ``old_value`` and only returns *newly* crossed thresholds), but
the stub was still importable -- a future caller wiring up the domain
helper would have shipped the regression.

The pure-domain helper is now the real implementation: it takes
``old_value`` and ``new_value`` and returns sorted, dedupe'd
"newly crossed" thresholds.  It is the same shape the service layer
needs, so the two implementations cannot drift in opposite directions.
"""

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
    sorted ascending so the caller can rely on a stable order even when
    ``thresholds`` is an unordered iterable.  ``old_value`` defaults to
    ``0`` so callers checking against a fresh state keep the legacy
    "every threshold up to ``new_value``" behaviour without surfacing
    the duplicate-celebration bug.
    """
    reached = sorted({t for t in thresholds if old_value < t <= new_value})
    return reached, "milestones_achieved"
