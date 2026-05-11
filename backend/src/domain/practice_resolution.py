"""Pure helpers that collapse ``(Practice, UserPractice)`` to effective values.

Frontend code reads a single ``effective_name`` / ``effective_config`` per
user-practice; these helpers are the single place that merges the user's
overrides on top of the shared catalog row. Keeping them pure (no DB
access) makes them trivially testable and lets the API endpoints reuse
them without round-tripping through the ORM.
"""

from __future__ import annotations

from models.practice import Practice
from models.user_practice import UserPractice
from schemas.practice_mode_config import ModeConfig, ModeConfigAdapter


def effective_name(practice: Practice, user_practice: UserPractice | None) -> str:
    """Return the user's custom name if set, else the catalog name."""
    if user_practice is not None and user_practice.custom_name:
        return user_practice.custom_name
    return practice.name


def effective_config(practice: Practice, user_practice: UserPractice | None) -> ModeConfig:
    """Return the user's override if set, else the catalog ``mode_config``.

    Validates the resolved payload through :class:`ModeConfigAdapter` so a
    structurally invalid override surfaces as a domain error rather than
    leaking into engine code. Raises ``ValueError("mode_mismatch")`` when
    the override's ``mode`` discriminator doesn't agree with the catalog
    mode — the override may only swap fields *within* a mode.
    """
    payload = (
        user_practice.mode_config_override
        if user_practice is not None and user_practice.mode_config_override is not None
        else practice.mode_config
    )
    cfg = ModeConfigAdapter.validate_python(payload)
    if cfg.mode != practice.mode:
        msg = "mode_mismatch"
        raise ValueError(msg)
    return cfg
