"""Server-authoritative admission for the bounded managed-vault pilot."""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Final

from services.creek_provisioning_client import (
    HANDOFF_AUTH_FILE_ENV_VAR,
    PROVISIONING_AUTH_FILE_ENV_VAR,
    PROVISIONING_URL_ENV_VAR,
)
from services.creek_vault_url import classify_vault_url

MANAGED_VAULT_ENABLED_ENV_VAR: Final[str] = "CREEK_MANAGED_VAULT_ACTIVATION_ENABLED"
MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR: Final[str] = "CREEK_MANAGED_VAULT_PILOT_USER_IDS"
MAX_PILOT_ACCOUNTS: Final[int] = 100

_TRUE_VALUES: Final[frozenset[str]] = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES: Final[frozenset[str]] = frozenset({"", "0", "false", "no", "off"})


class ManagedVaultRolloutState(StrEnum):
    """Operator-visible state; callers expose only one unavailable answer."""

    DISABLED = "disabled"
    INCOMPLETE = "incomplete"
    READY = "ready"


@dataclass(frozen=True, slots=True)
class ManagedVaultRollout:
    """One immutable interpretation of the current deployment settings."""

    state: ManagedVaultRolloutState
    eligible_user_ids: frozenset[int] = frozenset()
    defects: tuple[str, ...] = ()

    def allows_new_activation(self, user_id: int) -> bool:
        """Admit only a positive account explicitly present in a ready pilot."""
        return self.state is ManagedVaultRolloutState.READY and user_id in self.eligible_user_ids


def _mounted_secret_is_readable(env_var: str) -> bool:
    path = os.getenv(env_var, "").strip()
    if not path:
        return False
    try:
        return bool(Path(path).read_text(encoding="utf-8").strip())
    except OSError:
        return False


def _parse_enabled() -> bool | None:
    raw = os.getenv(MANAGED_VAULT_ENABLED_ENV_VAR, "").strip().lower()
    if raw in _TRUE_VALUES:
        return True
    if raw in _FALSE_VALUES:
        return False
    return None


def _parse_pilot_ids() -> frozenset[int] | None:
    raw = os.getenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, "").strip()
    if not raw:
        return None
    try:
        values = frozenset(int(item.strip()) for item in raw.split(","))
    except ValueError:
        return None
    return values if _pilot_ids_are_bounded(values) else None


def _pilot_ids_are_bounded(values: frozenset[int]) -> bool:
    """Keep a rollout both account-specific and small enough to be a pilot."""
    if not values or len(values) > MAX_PILOT_ACCOUNTS:
        return False
    return not any(value <= 0 for value in values)


def _provider_defects() -> list[str]:
    defects: list[str] = []
    base_url = os.getenv(PROVISIONING_URL_ENV_VAR, "").strip()
    if not base_url or classify_vault_url(base_url) is not None:
        defects.append(PROVISIONING_URL_ENV_VAR)
    defects.extend(
        env_var
        for env_var in (PROVISIONING_AUTH_FILE_ENV_VAR, HANDOFF_AUTH_FILE_ENV_VAR)
        if not _mounted_secret_is_readable(env_var)
    )
    return defects


def _rollout_defects(
    *,
    enabled: bool | None,
    pilot_ids: frozenset[int] | None,
) -> list[str]:
    defects = _provider_defects()
    if enabled is None:
        defects.append(MANAGED_VAULT_ENABLED_ENV_VAR)
    if pilot_ids is None:
        defects.append(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR)
    return defects


def _incomplete_rollout(defects: list[str]) -> ManagedVaultRollout:
    """Freeze one defective setting list without exposing any setting value."""
    return ManagedVaultRollout(
        ManagedVaultRolloutState.INCOMPLETE,
        defects=tuple(defects),
    )


def _ready_rollout(pilot_ids: frozenset[int] | None) -> ManagedVaultRollout:
    if pilot_ids is None:
        return _incomplete_rollout([MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR])
    return ManagedVaultRollout(
        ManagedVaultRolloutState.READY,
        eligible_user_ids=pilot_ids,
    )


def _disabled_rollout() -> ManagedVaultRollout:
    return ManagedVaultRollout(ManagedVaultRolloutState.DISABLED)


def _enabled_is_explicitly_false(*, enabled: bool | None) -> bool:
    return enabled is False


def _configured_rollout(
    *,
    enabled: bool | None,
    pilot_ids: frozenset[int] | None,
) -> ManagedVaultRollout:
    defects = _rollout_defects(enabled=enabled, pilot_ids=pilot_ids)
    if defects:
        return _incomplete_rollout(defects)
    return _ready_rollout(pilot_ids)


def _parse_rollout() -> ManagedVaultRollout:
    enabled = _parse_enabled()
    if _enabled_is_explicitly_false(enabled=enabled):
        return _disabled_rollout()
    return _configured_rollout(enabled=enabled, pilot_ids=_parse_pilot_ids())


def load_managed_vault_rollout() -> ManagedVaultRollout:
    """Read rollout configuration without retaining or reporting secret values."""
    return _parse_rollout()


def managed_vault_activation_is_available(user_id: int) -> bool:
    """Return the live server-side verdict for one authenticated account."""
    return load_managed_vault_rollout().allows_new_activation(user_id)
