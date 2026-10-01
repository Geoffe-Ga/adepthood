"""One closed interpretation of the managed-vault activation switch."""

from __future__ import annotations

import os
import sys
from typing import Final

MANAGED_VAULT_ENABLED_ENV_VAR: Final[str] = "CREEK_MANAGED_VAULT_ACTIVATION_ENABLED"
PROVISIONING_AUTH_FILE_ENV_VAR: Final[str] = "CREEK_PROVISIONING_AUTH_FILE"
HANDOFF_AUTH_FILE_ENV_VAR: Final[str] = "CREEK_PROVISIONING_HANDOFF_AUTH_FILE"
_MANAGED_BEARER_PATH_ENV_VARS: Final[tuple[str, str]] = (
    PROVISIONING_AUTH_FILE_ENV_VAR,
    HANDOFF_AUTH_FILE_ENV_VAR,
)

_TRUE_VALUES: Final[frozenset[str]] = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES: Final[frozenset[str]] = frozenset({"", "0", "false", "no", "off"})
_DISABLED_BOOTSTRAP_MODE: Final[str] = "disabled"
_REQUIRED_BOOTSTRAP_MODE: Final[str] = "required"


def parse_managed_vault_activation_enabled() -> bool | None:
    """Parse the activation switch without treating malformed input as disabled."""
    raw = os.getenv(MANAGED_VAULT_ENABLED_ENV_VAR, "").strip().lower()
    if raw in _TRUE_VALUES:
        return True
    if raw in _FALSE_VALUES:
        return False
    return None


def managed_vault_secret_bootstrap_required() -> bool:
    """Require durable secrets for enabled and fail-closed incomplete states."""
    enabled = parse_managed_vault_activation_enabled()
    return enabled is not False or _managed_bearer_path_is_configured()


def _managed_bearer_path_is_configured() -> bool:
    return any(os.getenv(env_var, "") != "" for env_var in _MANAGED_BEARER_PATH_ENV_VARS)


def main() -> None:
    """Print the content-free startup mode consumed by the root entrypoint."""
    mode = (
        _REQUIRED_BOOTSTRAP_MODE
        if managed_vault_secret_bootstrap_required()
        else _DISABLED_BOOTSTRAP_MODE
    )
    sys.stdout.write(mode)


if __name__ == "__main__":
    main()
