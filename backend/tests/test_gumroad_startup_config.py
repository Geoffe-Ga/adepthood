"""Tests for the startup Gumroad configuration check.

Contract: enforcement is all-or-nothing. A production deploy with neither
Gumroad variable set is a known-degraded but bootable state, announced by one
prominent ``gumroad_unconfigured`` warning; a production deploy with only one
of the pair set is a misconfiguration and still refuses to boot. Outside
production the check is inert. No credential value ever appears in the
failure message.
"""

from __future__ import annotations

import logging

import pytest

from main import validate_gumroad_config

ENV_VAR = "ENV"
API_TOKEN_ENV = "GUMROAD_API_TOKEN"
WEBHOOK_SECRET_ENV = "GUMROAD_WEBHOOK_SECRET"  # pragma: allowlist secret
GUMROAD_ENV_VARS = (API_TOKEN_ENV, WEBHOOK_SECRET_ENV)
UNCONFIGURED_MARKER = "gumroad_unconfigured"

SENTINEL_TOKEN = "sentinel-gumroad-api-token"  # pragma: allowlist secret
SENTINEL_SECRET = "sentinel-gumroad-webhook-secret"  # pragma: allowlist secret

MAIN_LOGGER = "main"


def _unconfigured_warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return the captured records carrying the unconfigured marker."""
    return [record for record in caplog.records if UNCONFIGURED_MARKER in record.getMessage()]


def test_production_without_any_gumroad_config_warns_and_returns(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Production with neither variable set boots, announcing the degraded state once."""
    monkeypatch.setenv(ENV_VAR, "production")
    for name in GUMROAD_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_gumroad_config()

    warnings = _unconfigured_warnings(caplog)
    assert len(warnings) == 1
    assert warnings[0].levelno == logging.WARNING
    message = warnings[0].getMessage()
    assert API_TOKEN_ENV in message
    assert WEBHOOK_SECRET_ENV in message


def test_production_with_only_webhook_secret_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Half-configured production still fails fast, naming the missing token only."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.delenv(API_TOKEN_ENV, raising=False)
    monkeypatch.setenv(WEBHOOK_SECRET_ENV, SENTINEL_SECRET)

    with pytest.raises(RuntimeError, match=API_TOKEN_ENV) as excinfo:
        validate_gumroad_config()

    assert SENTINEL_SECRET not in str(excinfo.value)


def test_production_with_only_api_token_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The mirror half-configured case fails fast, naming the missing secret only."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(API_TOKEN_ENV, SENTINEL_TOKEN)
    monkeypatch.delenv(WEBHOOK_SECRET_ENV, raising=False)

    with pytest.raises(RuntimeError, match=WEBHOOK_SECRET_ENV) as excinfo:
        validate_gumroad_config()

    assert SENTINEL_TOKEN not in str(excinfo.value)


def test_production_fully_configured_is_silent(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A fully configured production boot neither raises nor warns."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(API_TOKEN_ENV, SENTINEL_TOKEN)
    monkeypatch.setenv(WEBHOOK_SECRET_ENV, SENTINEL_SECRET)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_gumroad_config()

    assert _unconfigured_warnings(caplog) == []


@pytest.mark.parametrize("env_value", ["development", "staging", None])
def test_non_production_envs_never_raise_or_warn(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    env_value: str | None,
) -> None:
    """Outside production an unconfigured integration is normal and silent."""
    if env_value is None:
        monkeypatch.delenv(ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(ENV_VAR, env_value)
    for name in GUMROAD_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_gumroad_config()

    assert _unconfigured_warnings(caplog) == []


def test_blank_values_count_as_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Empty-string values behave exactly like unset ones, not like partial config."""
    monkeypatch.setenv(ENV_VAR, "production")
    for name in GUMROAD_ENV_VARS:
        monkeypatch.setenv(name, "")
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_gumroad_config()

    assert len(_unconfigured_warnings(caplog)) == 1


def test_blank_value_alongside_a_set_value_still_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A blank token beside a real secret is partial config, not an unconfigured deploy."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(API_TOKEN_ENV, "")
    monkeypatch.setenv(WEBHOOK_SECRET_ENV, SENTINEL_SECRET)

    with pytest.raises(RuntimeError, match=API_TOKEN_ENV) as excinfo:
        validate_gumroad_config()

    message = str(excinfo.value)
    assert WEBHOOK_SECRET_ENV not in message
    assert SENTINEL_SECRET not in message
