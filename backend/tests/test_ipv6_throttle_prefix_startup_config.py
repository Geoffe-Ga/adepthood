"""Tests for the startup IPv6 throttle-prefix configuration check.

Contract: ``IPV6_THROTTLE_PREFIX_LEN`` is read per request, and any value that
is not an integer in ``[1, 128]`` silently degrades to the default -- an
operator who typed ``4 8`` for ``48`` gets the behaviour they did not ask for
and no signal that they typed it.  Boot therefore announces an unusable value
once, with a single ``ipv6_throttle_prefix_unusable`` warning naming the
variable, the offending value, and the default that replaced it.

Three boundaries the announcement must respect.  It is not gated on ``ENV``: a
staging box tuned by hand is exactly where the typo is made, and unlike an
unconfigured proxy allowlist a bad prefix length is wrong everywhere, not just
in production.  Unset and blank stay silent, because ``.env.example`` ships the
variable blank and an unset value is the deliberate "use the default" answer.
And nothing about the runtime changes: the per-request path still degrades to
the default and still says nothing, so a hot loop cannot turn a typo into a log
flood.

No path raises -- a typo must not stop a boot -- and every call below that
reaches its assertions is that proof.
"""

from __future__ import annotations

import logging

import pytest

from client_ip import (
    DEFAULT_IPV6_THROTTLE_PREFIX_LEN,
    IPV6_THROTTLE_PREFIX_ENV_VAR,
    MAX_IPV6_THROTTLE_PREFIX_LEN,
    _throttle_prefix_length,
    unusable_throttle_prefix_config,
)
from main import validate_ipv6_throttle_prefix_config

ENV_VAR = "ENV"
UNUSABLE_MARKER = "ipv6_throttle_prefix_unusable"
MAIN_LOGGER = "main"
EXPECTED_WARNING_COUNT = 1

# The advice has to point the right way round.  The value is a prefix length, so
# an operator who wants one bucket to cover a wider delegation has to make the
# number smaller, and the maximum is the opt-out that restores exact keying --
# telling them to raise it would be precisely backwards, and pinning the wording
# is the only thing that stops a later edit flipping it.
WIDENING_DIRECTION = "smaller number covers a larger delegation"
EXACT_KEYING_ADVICE = f"{MAX_IPV6_THROTTLE_PREFIX_LEN} restores exact per-address keying"

# The issue's own example: a space where the operator meant nothing at all.
TYPO_VALUE = "4 8"

# One usable value, as text and as the integer the runtime must return for it.
USABLE_VALUE = "48"
USABLE_PREFIX_LEN = 48

# Not a prefix at all: out of range at either end, or not an integer.
UNUSABLE_VALUES = ["0", "129", "-1", "64.5", "abc"]

# Both ends of the range, an ordinary tuning, and a padded value -- ``int()``
# accepts surrounding whitespace, so " 48 " is configuration, not a typo.
USABLE_VALUES = ["1", "48", "64", "128", " 48 "]

# Unset and blank both mean "I did not configure this".
ABSENT_VALUES = [None, "", "   "]

ENV_VALUES = [None, "development", "staging", "production"]


def _unusable_warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return the captured records carrying the unusable-config marker."""
    return [record for record in caplog.records if UNUSABLE_MARKER in record.getMessage()]


def _set_prefix_env(monkeypatch: pytest.MonkeyPatch, value: str | None) -> None:
    """Set the prefix-length variable, treating None as unset."""
    if value is None:
        monkeypatch.delenv(IPV6_THROTTLE_PREFIX_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, value)


def test_typo_warns_once_naming_variable_value_and_default(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The warning has to be actionable: which variable, what was read, what was used."""
    monkeypatch.delenv(ENV_VAR, raising=False)
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, TYPO_VALUE)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_ipv6_throttle_prefix_config()

    warnings = _unusable_warnings(caplog)
    assert len(warnings) == EXPECTED_WARNING_COUNT
    assert warnings[0].levelno == logging.WARNING
    message = warnings[0].getMessage()
    assert IPV6_THROTTLE_PREFIX_ENV_VAR in message
    assert TYPO_VALUE in message
    assert str(DEFAULT_IPV6_THROTTLE_PREFIX_LEN) in message


def test_warning_points_the_operator_the_right_way(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Advice that pointed the wrong way would be worse than no advice at all."""
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, TYPO_VALUE)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_ipv6_throttle_prefix_config()

    message = _unusable_warnings(caplog)[0].getMessage()
    assert WIDENING_DIRECTION in message
    assert EXACT_KEYING_ADVICE in message


@pytest.mark.parametrize("value", UNUSABLE_VALUES)
def test_values_that_are_not_prefixes_warn_once(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    value: str,
) -> None:
    """Every value the runtime would silently discard is announced exactly once."""
    monkeypatch.delenv(ENV_VAR, raising=False)
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, value)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_ipv6_throttle_prefix_config()

    assert len(_unusable_warnings(caplog)) == EXPECTED_WARNING_COUNT


@pytest.mark.parametrize("value", USABLE_VALUES)
def test_usable_values_stay_silent(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    value: str,
) -> None:
    """A value the runtime honours has nothing to announce, padding included."""
    monkeypatch.delenv(ENV_VAR, raising=False)
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, value)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_ipv6_throttle_prefix_config()

    assert _unusable_warnings(caplog) == []


@pytest.mark.parametrize("value", ABSENT_VALUES)
def test_unset_and_blank_stay_silent(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    value: str | None,
) -> None:
    """Not configuring the variable is the normal case and must not warn anybody."""
    monkeypatch.delenv(ENV_VAR, raising=False)
    _set_prefix_env(monkeypatch, value)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_ipv6_throttle_prefix_config()

    assert _unusable_warnings(caplog) == []


@pytest.mark.parametrize("env_value", ENV_VALUES)
def test_warning_is_not_gated_on_env(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    env_value: str | None,
) -> None:
    """A bad prefix length is wrong in every environment, not just production."""
    if env_value is None:
        monkeypatch.delenv(ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(ENV_VAR, env_value)
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, TYPO_VALUE)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_ipv6_throttle_prefix_config()

    assert len(_unusable_warnings(caplog)) == EXPECTED_WARNING_COUNT


def test_check_reads_the_environment_afresh_each_call(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The check keeps no state: it announces, returns, and judges the next read anew."""
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, TYPO_VALUE)

    validate_ipv6_throttle_prefix_config()

    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, USABLE_VALUE)

    validate_ipv6_throttle_prefix_config()

    assert len(_unusable_warnings(caplog)) == EXPECTED_WARNING_COUNT


def test_per_request_path_falls_back_silently(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The runtime keeps degrading quietly: one boot warning, not one per request."""
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, TYPO_VALUE)
    caplog.set_level(logging.DEBUG)

    assert _throttle_prefix_length() == DEFAULT_IPV6_THROTTLE_PREFIX_LEN
    assert caplog.records == []


def test_per_request_path_still_honours_a_usable_value(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Adding the boot check changes no runtime answer and emits no runtime record."""
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, USABLE_VALUE)
    caplog.set_level(logging.DEBUG)

    assert _throttle_prefix_length() == USABLE_PREFIX_LEN
    assert caplog.records == []


@pytest.mark.parametrize("value", UNUSABLE_VALUES)
def test_unusable_config_reports_the_raw_value(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    """The raw text is what the operator has to recognise, so it is what comes back."""
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, value)

    assert unusable_throttle_prefix_config() == value


def test_unusable_config_reports_the_typo_verbatim(monkeypatch: pytest.MonkeyPatch) -> None:
    """The typo survives the round trip intact, spaces and all."""
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, TYPO_VALUE)

    assert unusable_throttle_prefix_config() == TYPO_VALUE


@pytest.mark.parametrize("value", [*USABLE_VALUES, *ABSENT_VALUES])
def test_usable_and_absent_config_reports_nothing(
    monkeypatch: pytest.MonkeyPatch,
    value: str | None,
) -> None:
    """Nothing to report covers both a value we honour and a value never given."""
    _set_prefix_env(monkeypatch, value)

    assert unusable_throttle_prefix_config() is None
