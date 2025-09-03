"""Goal progress domain functions."""

from __future__ import annotations


def compute_progress(current: float, target: float, mode: str = "additive") -> tuple[float, str]:
    """Compute progress toward ``target``.

    ``mode`` can be ``additive`` or ``subtractive``.
    Returns a tuple of ``progress`` (0-1) and ``reason_code``.
    """

    if target <= 0:
        raise ValueError("target must be positive")
    if mode not in {"additive", "subtractive"}:
        raise ValueError("mode must be 'additive' or 'subtractive'")

    if mode == "additive":
        progress = max(0.0, min(current / target, 1.0))
        return progress, "additive_progress"

    # subtractive
    remaining = max(target - current, 0)
    progress = max(0.0, min(remaining / target, 1.0))
    return progress, "subtractive_progress"
