"""Tests for the startup allowed-hosts configuration check.

Contract: two findings with opposite remedies, because they fail in opposite
directions.  A *malformed* entry is refused on every environment -- entries that
name no host are dropped at request time, so a typo would leave the variable
reading as set while the control settles nothing, and boot is the only place
that disagreement can be caught.  An *absent* value only warns and must never
raise: unset is the status quo, so refusing over it would take down every
deploy that predates the variable to fix a weakness those deploys already had.
Production announces the absence; every other environment is silent.
"""

from __future__ import annotations

import logging

import pytest

from main import validate_allowed_hosts_config
from request_host import ALLOWED_HOSTS_ENV_VAR

ENV_VAR = "ENV"
UNCONFIGURED_MARKER = "allowed_hosts_unconfigured"
MAIN_LOGGER = "main"
# Deliberately not the ``api.example.com`` the refusal message uses as its own
# worked example, so "this entry was quoted back" cannot be confused with
# "the message happens to contain that string".
SENTINEL_HOST = "api.aptitude.guru"

# Values an operator might plausibly type that name no authority: a bare
# wildcard, a wildcard pattern, a URL, a path, userinfo, an interior space, and
# a bracketed IPv6 literal.  Each is refused rather than silently dropped.
UNUSABLE_ENTRIES = [
    "*",
    "*.example.com",
    "https://api.example.com",
    "api.example.com/v1",
    "user@api.example.com",
    "api example.com",
    "[::1]",
    "[::1]:8000",
    "api.example.com:notaport",
    "-api.example.com",
]


def _unconfigured_warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return the captured records carrying the unconfigured marker."""
    return [record for record in caplog.records if UNCONFIGURED_MARKER in record.getMessage()]


def test_production_without_an_allowlist_warns_once(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Production with no allowlist boots, naming the variable that would fix it."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.delenv(ALLOWED_HOSTS_ENV_VAR, raising=False)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_allowed_hosts_config()

    warnings = _unconfigured_warnings(caplog)
    assert len(warnings) == 1
    assert warnings[0].levelno == logging.WARNING
    assert ALLOWED_HOSTS_ENV_VAR in warnings[0].getMessage()


def test_production_with_an_allowlist_is_silent(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A configured production boot has nothing to announce."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(ALLOWED_HOSTS_ENV_VAR, SENTINEL_HOST)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_allowed_hosts_config()

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
    monkeypatch.delenv(ALLOWED_HOSTS_ENV_VAR, raising=False)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_allowed_hosts_config()

    assert _unconfigured_warnings(caplog) == []


def test_a_blank_allowlist_counts_as_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A blank value names nobody, exactly like an unset one, and warns the same."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(ALLOWED_HOSTS_ENV_VAR, "   ")
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_allowed_hosts_config()

    assert len(_unconfigured_warnings(caplog)) == 1


@pytest.mark.parametrize("entry", UNUSABLE_ENTRIES)
def test_an_entry_naming_no_host_refuses_the_boot(
    monkeypatch: pytest.MonkeyPatch,
    entry: str,
) -> None:
    """A value the runtime would discard is refused, quoted back as it was typed."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(ALLOWED_HOSTS_ENV_VAR, entry)

    with pytest.raises(RuntimeError) as raised:
        validate_allowed_hosts_config()

    message = str(raised.value)
    assert ALLOWED_HOSTS_ENV_VAR in message
    assert repr(entry) in message


@pytest.mark.parametrize("env_value", ["development", "staging", "production"])
def test_a_malformed_entry_is_refused_on_every_environment(
    monkeypatch: pytest.MonkeyPatch,
    env_value: str,
) -> None:
    """Unlike an absent value, a typo is wrong wherever it was typed.

    Staging is hand-tuned and is exactly where one gets typed, and a value that
    names no host disarms the control identically in all three.
    """
    monkeypatch.setenv(ENV_VAR, env_value)
    monkeypatch.setenv(ALLOWED_HOSTS_ENV_VAR, "*.example.com")

    with pytest.raises(RuntimeError, match=ALLOWED_HOSTS_ENV_VAR):
        validate_allowed_hosts_config()


def test_a_usable_entry_beside_a_malformed_one_does_not_excuse_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every unusable entry is reported, not just the case where all of them are."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(ALLOWED_HOSTS_ENV_VAR, f"{SENTINEL_HOST},*.example.com,http://x.example")

    with pytest.raises(RuntimeError) as raised:
        validate_allowed_hosts_config()

    message = str(raised.value)
    assert repr("*.example.com") in message
    assert repr("http://x.example") in message
    assert repr(SENTINEL_HOST) not in message


def test_padding_and_doubled_separators_are_not_typos(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A trailing separator or a stray space is ordinary list padding, not a refusal."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(ALLOWED_HOSTS_ENV_VAR, f" {SENTINEL_HOST} ,, aptitude.guru,")
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_allowed_hosts_config()

    assert _unconfigured_warnings(caplog) == []


def test_a_localhost_port_entry_is_a_usable_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The shape a local or staging deploy actually uses must not be refused."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(ALLOWED_HOSTS_ENV_VAR, "localhost:8000,127.0.0.1:8000")

    validate_allowed_hosts_config()
