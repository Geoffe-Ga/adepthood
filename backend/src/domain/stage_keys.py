"""Stable string keys for the ten APTITUDE Stages (#2665).

A Stage's ``stage_number`` is its position in the program; its *key* is the
colour slug the course itself names it by (``beige`` .. ``clearlight``, the
prefixes of upstream's ``stage_intros`` ids). The stage-correspondence
artifact identifies stages by these keys, and ``CourseStage.stage_key`` stores
them so the seeder can reconcile a row by identity rather than by position.

The tuple is pinned against the generator's ``STAGE_IDS`` and the artifact
schema's positional ``const`` ids by test, so the three cannot drift apart.
"""

from __future__ import annotations

from typing import Final

from domain.constants import TOTAL_STAGES

#: The Stage keys, in program order: ``STAGE_KEYS[n - 1]`` is Stage ``n``'s key.
STAGE_KEYS: Final[tuple[str, ...]] = (
    "beige",
    "purple",
    "red",
    "blue",
    "orange",
    "green",
    "yellow",
    "teal",
    "ultraviolet",
    "clearlight",
)

#: Prefix of the placeholder key a row outside the ten Stages is given, so a
#: legacy out-of-range ``stage_number`` still gets a unique, non-null key.
LEGACY_STAGE_KEY_PREFIX: Final[str] = "stage-"

#: Longest key the ``coursestage.stage_key`` column must hold. Comfortably
#: above ``len("ultraviolet")`` and any ``stage-<n>`` placeholder.
STAGE_KEY_MAX_LENGTH: Final[int] = 32


class UnknownStageError(LookupError):
    """A stage number or key that names none of the ten APTITUDE Stages."""


def stage_key_for(stage_number: int) -> str:
    """Return the colour-slug key of Stage ``stage_number`` (1-based)."""
    if not 1 <= stage_number <= TOTAL_STAGES:
        msg = f"stage_number {stage_number} is outside 1..{TOTAL_STAGES}"
        raise UnknownStageError(msg)
    return STAGE_KEYS[stage_number - 1]


def legacy_stage_key(stage_number: int) -> str:
    """Return the key for ``stage_number``, or a ``stage-<n>`` placeholder.

    In range, this is :func:`stage_key_for`; outside it, a row that predates
    the key (or a hand-built test row) still gets a unique placeholder, which
    the seeder then reports as an orphan instead of failing on.
    """
    try:
        return stage_key_for(stage_number)
    except UnknownStageError:
        return f"{LEGACY_STAGE_KEY_PREFIX}{stage_number}"
