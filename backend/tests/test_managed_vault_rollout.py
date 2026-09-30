"""Server-authoritative admission policy for bounded managed-vault pilots."""

from __future__ import annotations

from pathlib import Path

import pytest

from main import validate_managed_vault_rollout_config
from services import creek_provisioning_client as provisioning_client
from services.managed_vault_rollout import (
    MANAGED_VAULT_ALERT_EMAIL_ENV_VAR,
    MANAGED_VAULT_ENABLED_ENV_VAR,
    MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR,
    ManagedVaultRolloutState,
    load_managed_vault_rollout,
)


def _complete_provider(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    control = tmp_path / "control"
    handoff = tmp_path / "handoff"
    control.write_text("control-token", encoding="utf-8")
    handoff.write_text("handoff-token", encoding="utf-8")
    control.chmod(0o400)
    handoff.chmod(0o400)
    monkeypatch.setattr(provisioning_client, "PROVISIONING_AUTH_FILE_PATH", control)
    monkeypatch.setattr(provisioning_client, "HANDOFF_AUTH_FILE_PATH", handoff)
    monkeypatch.setenv("CREEK_PROVISIONING_URL", "https://creek-control.example.test")
    monkeypatch.setenv("CREEK_PROVISIONING_AUTH_FILE", str(control))
    monkeypatch.setenv("CREEK_PROVISIONING_HANDOFF_AUTH_FILE", str(handoff))
    monkeypatch.setenv(MANAGED_VAULT_ALERT_EMAIL_ENV_VAR, "operator@example.com")


def test_production_bearers_are_distinct_fixed_children_of_the_verified_mount() -> None:
    assert (
        Path("/run/adepthood-secrets/creek-control-bearer")
        == provisioning_client.PROVISIONING_AUTH_FILE_PATH
    )
    assert (
        Path("/run/adepthood-secrets/creek-handoff-bearer")
        == provisioning_client.HANDOFF_AUTH_FILE_PATH
    )
    assert (
        provisioning_client.PROVISIONING_AUTH_FILE_PATH
        != provisioning_client.HANDOFF_AUTH_FILE_PATH
    )


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


def test_permissive_handoff_file_keeps_the_rollout_incomplete(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Readiness and request-time authentication share the strict file boundary."""
    _complete_provider(monkeypatch, tmp_path)
    (tmp_path / "handoff").chmod(0o440)
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, "1")

    rollout = load_managed_vault_rollout()

    assert rollout.state is ManagedVaultRolloutState.INCOMPLETE
    assert rollout.defects == ("CREEK_PROVISIONING_HANDOFF_AUTH_FILE",)


def test_same_file_cannot_satisfy_control_and_handoff_custody(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _complete_provider(monkeypatch, tmp_path)
    monkeypatch.setenv(
        "CREEK_PROVISIONING_HANDOFF_AUTH_FILE",
        str(provisioning_client.PROVISIONING_AUTH_FILE_PATH),
    )
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, "1")

    rollout = load_managed_vault_rollout()

    assert rollout.state is ManagedVaultRolloutState.INCOMPLETE
    assert rollout.defects == ("CREEK_PROVISIONING_HANDOFF_AUTH_FILE",)


def test_duplicate_bearer_values_cannot_satisfy_separate_custody(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _complete_provider(monkeypatch, tmp_path)
    (tmp_path / "handoff").chmod(0o600)
    (tmp_path / "handoff").write_text("control-token", encoding="utf-8")
    (tmp_path / "handoff").chmod(0o400)
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, "1")

    rollout = load_managed_vault_rollout()

    assert rollout.state is ManagedVaultRolloutState.INCOMPLETE
    assert rollout.defects == ("CREEK_PROVISIONING_HANDOFF_AUTH_FILE",)


def test_hardlinked_bearers_cannot_satisfy_separate_custody(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    control = tmp_path / "control"
    control.write_text("control-token", encoding="utf-8")
    control.chmod(0o400)
    handoff = tmp_path / "handoff"
    handoff.hardlink_to(control)
    monkeypatch.setattr(provisioning_client, "PROVISIONING_AUTH_FILE_PATH", control)
    monkeypatch.setattr(provisioning_client, "HANDOFF_AUTH_FILE_PATH", handoff)
    monkeypatch.setenv("CREEK_PROVISIONING_URL", "https://creek-control.example.test")
    monkeypatch.setenv("CREEK_PROVISIONING_AUTH_FILE", str(control))
    monkeypatch.setenv("CREEK_PROVISIONING_HANDOFF_AUTH_FILE", str(handoff))
    monkeypatch.setenv(MANAGED_VAULT_ALERT_EMAIL_ENV_VAR, "operator@example.com")
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, "1")

    rollout = load_managed_vault_rollout()

    assert rollout.state is ManagedVaultRolloutState.INCOMPLETE
    assert rollout.defects == (
        "CREEK_PROVISIONING_AUTH_FILE",
        "CREEK_PROVISIONING_HANDOFF_AUTH_FILE",
    )


@pytest.mark.parametrize(
    ("env_var", "expected_defect"),
    [
        ("CREEK_PROVISIONING_AUTH_FILE", "CREEK_PROVISIONING_AUTH_FILE"),
        (
            "CREEK_PROVISIONING_HANDOFF_AUTH_FILE",
            "CREEK_PROVISIONING_HANDOFF_AUTH_FILE",
        ),
    ],
)
def test_outside_mount_bearer_cannot_make_rollout_ready(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    env_var: str,
    expected_defect: str,
) -> None:
    _complete_provider(monkeypatch, tmp_path)
    outside = tmp_path / "outside-mount-token"
    outside.write_text("outside-token", encoding="utf-8")
    outside.chmod(0o400)
    monkeypatch.setenv(env_var, str(outside))
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, "1")

    rollout = load_managed_vault_rollout()

    assert rollout.state is ManagedVaultRolloutState.INCOMPLETE
    assert rollout.defects == (expected_defect,)


@pytest.mark.parametrize("destination", [None, "not-an-email", " operator@example.com"])
def test_invalid_fleet_alert_destination_keeps_the_rollout_incomplete(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    destination: str | None,
) -> None:
    """Activation cannot start when fleet failures have nowhere to arrive."""
    _complete_provider(monkeypatch, tmp_path)
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, "1")
    if destination is None:
        monkeypatch.delenv(MANAGED_VAULT_ALERT_EMAIL_ENV_VAR)
    else:
        monkeypatch.setenv(MANAGED_VAULT_ALERT_EMAIL_ENV_VAR, destination)

    rollout = load_managed_vault_rollout()

    assert rollout.state is ManagedVaultRolloutState.INCOMPLETE
    assert rollout.defects == (MANAGED_VAULT_ALERT_EMAIL_ENV_VAR,)


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
    control.chmod(0o600)
    control.write_text(redaction_marker, encoding="utf-8")
    control.chmod(0o400)

    validate_managed_vault_rollout_config()

    assert "managed_vault_activation_config_state=incomplete" in caplog.text
    assert MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR in caplog.text
    assert redaction_marker not in caplog.text
