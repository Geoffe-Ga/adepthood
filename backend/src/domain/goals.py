"""Goal progress domain functions."""

from __future__ import annotations


def compute_progress(
    current: float, target: float, *, is_additive: bool = True
) -> tuple[float, str]:
    """Compute progress toward ``target``.

    ``is_additive`` mirrors the ``Goal.is_additive`` model field.

    **Additive** (e.g. "drink 8 cups of water"):
        progress = current / target, clamped to [0, 1].

    **Subtractive** (e.g. "limit caffeine to 200 mg"):
        100 % when ``current <= 0`` (nothing consumed — full success),
        0 % when ``current >= target`` (limit reached or exceeded),
        proportional between.  Formally: ``1 - current / target``.

    Returns ``(progress, reason_code)`` where progress is in [0, 1].
    """
    if target <= 0:
        raise ValueError("target must be positive")

    if is_additive:
        progress = max(0.0, min(current / target, 1.0))
        return progress, "additive_progress"

    # Subtractive: success is staying *under* the target.
    # 1.0 when current <= 0, 0.0 when current >= target.
    progress = max(0.0, min(1.0 - current / target, 1.0))
    return progress, "subtractive_progress"
