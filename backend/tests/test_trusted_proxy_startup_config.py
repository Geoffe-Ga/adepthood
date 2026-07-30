"""Tests for the startup trusted-proxy configuration check.

Contract: an unconfigured proxy allowlist is a bootable but degraded state, not
a failure. With ``TRUSTED_PROXY_CIDRS`` unset the forwarded header is ignored
everywhere, so every client behind the ingress shares one rate-limit bucket and
one audited address -- an operator has no other signal that this is happening.
Production therefore announces it with a single ``trusted_proxies_unconfigured``
warning; a configured production boot and every non-production boot are silent,
and no path raises.
"""

from __future__ import annotations

import logging

import pytest

from client_ip import TRUSTED_PROXIES_ENV_VAR
from main import validate_trusted_proxy_config

ENV_VAR = "ENV"
UNCONFIGURED_MARKER = "trusted_proxies_unconfigured"
MAIN_LOGGER = "main"
SENTINEL_CIDRS = "192.0.2.0/24"


def _unconfigured_warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return the captured records carrying the unconfigured marker."""
    return [record for record in caplog.records if UNCONFIGURED_MARKER in record.getMessage()]


def test_production_without_trusted_proxies_warns_once(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Production with no allowlist boots, naming the variable that would fix it."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.delenv(TRUSTED_PROXIES_ENV_VAR, raising=False)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_trusted_proxy_config()

    warnings = _unconfigured_warnings(caplog)
    assert len(warnings) == 1
    assert warnings[0].levelno == logging.WARNING
    assert TRUSTED_PROXIES_ENV_VAR in warnings[0].getMessage()


def test_production_with_trusted_proxies_is_silent(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A configured production boot has nothing to announce."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, SENTINEL_CIDRS)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_trusted_proxy_config()

    assert _unconfigured_warnings(caplog) == []


@pytest.mark.parametrize("env_value", ["development", "staging", None])
def test_non_production_envs_stay_silent(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    env_value: str | None,
) -> None:
    """Outside production an unconfigured allowlist is normal: no warning, no raise."""
    if env_value is None:
        monkeypatch.delenv(ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(ENV_VAR, env_value)
    monkeypatch.delenv(TRUSTED_PROXIES_ENV_VAR, raising=False)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_trusted_proxy_config()

    assert _unconfigured_warnings(caplog) == []


def test_blank_trusted_proxies_counts_as_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A blank value trusts nobody, exactly like an unset one, and warns the same."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, "   ")
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_trusted_proxy_config()

    assert len(_unconfigured_warnings(caplog)) == 1
