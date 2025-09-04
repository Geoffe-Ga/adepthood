"""Goal progress domain functions."""

from __future__ import annotations


def compute_progress(
    current: float, target: float, *, is_additive: bool = True
) -> tuple[float, str]:
    """Compute progress toward ``target``.

    ``is_additive`` mirrors the ``Goal.is_additive`` model field. When ``True``
    progress increases toward the target; when ``False`` progress reflects how
    much remains before exceeding the target.
    Returns a tuple of ``progress`` (0-1) and ``reason_code``.
    """

    if target <= 0:
        raise ValueError("target must be positive")

    if is_additive:
        progress = max(0.0, min(current / target, 1.0))
        return progress, "additive_progress"

    remaining = max(target - current, 0)
    progress = max(0.0, min(remaining / target, 1.0))
    return progress, "subtractive_progress"
