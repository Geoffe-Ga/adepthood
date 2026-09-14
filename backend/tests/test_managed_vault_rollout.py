"""Server-authoritative admission policy for bounded managed-vault pilots."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from main import validate_managed_vault_rollout_config
from services.managed_vault_rollout import (
    MANAGED_VAULT_ENABLED_ENV_VAR,
    MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR,
    ManagedVaultRolloutState,
    load_managed_vault_rollout,
)

if TYPE_CHECKING:
    from pathlib import Path


def _complete_provider(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    control = tmp_path / "control"
    handoff = tmp_path / "handoff"
    control.write_text("control-token", encoding="utf-8")
    handoff.write_text("handoff-token", encoding="utf-8")
    monkeypatch.setenv("CREEK_PROVISIONING_URL", "https://creek-control.example.test")
    monkeypatch.setenv("CREEK_PROVISIONING_AUTH_FILE", str(control))
    monkeypatch.setenv("CREEK_PROVISIONING_HANDOFF_AUTH_FILE", str(handoff))


def test_rollout_defaults_disabled_even_when_provider_is_configured(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _complete_provider(monkeypatch, tmp_path)
    monkeypatch.delenv(MANAGED_VAULT_ENABLED_ENV_VAR, raising=False)
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, "1")

    rollout = load_managed_vault_rollout()

    assert rollout.state is ManagedVaultRolloutState.DISABLED
    assert rollout.allows_new_activation(1) is False


@pytest.mark.parametrize(
    ("enabled", "pilot_ids"),
    [("sometimes", "1"), ("true", ""), ("true", "1,not-an-id"), ("true", "0")],
)
def test_invalid_or_half_configured_rollout_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    enabled: str,
    pilot_ids: str,
) -> None:
    _complete_provider(monkeypatch, tmp_path)
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, enabled)
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, pilot_ids)

    rollout = load_managed_vault_rollout()

    assert rollout.state is ManagedVaultRolloutState.INCOMPLETE
    assert rollout.allows_new_activation(1) is False


def test_fully_configured_rollout_is_bounded_to_account_ids(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _complete_provider(monkeypatch, tmp_path)
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, "7,11,7")

    rollout = load_managed_vault_rollout()

    assert rollout.state is ManagedVaultRolloutState.READY
    assert rollout.eligible_user_ids == frozenset({7, 11})
    assert rollout.allows_new_activation(7) is True
    assert rollout.allows_new_activation(8) is False


def test_allowlist_over_the_pilot_ceiling_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _complete_provider(monkeypatch, tmp_path)
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, ",".join(map(str, range(1, 102))))

    rollout = load_managed_vault_rollout()

    assert rollout.state is ManagedVaultRolloutState.INCOMPLETE
    assert rollout.allows_new_activation(1) is False


def test_incomplete_startup_record_names_settings_but_never_secret_values(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _complete_provider(monkeypatch, tmp_path)
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.delenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, raising=False)
    redaction_marker = "mounted-value-must-not-be-logged"
    control = tmp_path / "control"
    control.write_text(redaction_marker, encoding="utf-8")

    validate_managed_vault_rollout_config()

    assert "managed_vault_activation_config_state=incomplete" in caplog.text
    assert MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR in caplog.text
    assert redaction_marker not in caplog.text
