"""Offline safety checks for the opt-in resonance-yield live lane.

These tests run in the ordinary backend suite.  They exercise only pure
configuration resolution: an exported provider key must never be enough to
spend money, while explicitly arming the lane without a usable production
provider/key pair must fail loudly instead of reporting a misleading skip.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import pytest

from services.botmason import LLMCreditExhaustedError, LLMProviderError
from tests.live.resonance_lane import (
    KEY_ENV,
    OPT_IN_ENV,
    PROVIDER_ENV,
    ResonanceLaneMisconfiguredError,
    provider_is_unreachable,
    resolve_live_resonance_api_key,
)

_KEY = "sk-live-test-key"
_FIXTURE = Path(__file__).parent / "live" / "fixtures" / "resonance_yield_entry.md"
_COMPLETED_HABIT_PHRASES = (
    "I did my twenty minutes of meditation before breakfast.",
    "I lifted weights for forty minutes after work.",
    "I wrote three pages in my notebook before turning off the lamp.",
)
_THEME_ANCHORS = (
    "an open hand",
    "the unfinished shelf",
    "the quiet kitchen",
    "the river path",
)


@pytest.mark.parametrize("flag", ["1", "true", "TRUE", "yes"])
def test_armed_lane_returns_the_configured_provider_key(flag: str) -> None:
    """An explicit opt-in plus a matching real provider/key arms the lane."""
    env = {OPT_IN_ENV: flag, PROVIDER_ENV: "openai", KEY_ENV: _KEY}

    assert resolve_live_resonance_api_key(env) == _KEY


@pytest.mark.parametrize(
    "env",
    [
        {},
        {OPT_IN_ENV: ""},
        {OPT_IN_ENV: "0"},
        {OPT_IN_ENV: "false"},
        {OPT_IN_ENV: "off"},
    ],
)
def test_unarmed_lane_returns_none_even_with_a_provider_key(env: Mapping[str, str]) -> None:
    """A key in a developer shell cannot turn an ordinary test run into traffic."""
    configured = {**env, PROVIDER_ENV: "openai", KEY_ENV: _KEY}

    assert resolve_live_resonance_api_key(configured) is None


@pytest.mark.parametrize(
    ("provider", "key"),
    [
        ("openai", ""),
        ("openai", "   "),
        ("stub", _KEY),
        ("not-a-provider", _KEY),
        ("anthropic", _KEY),
        ("OpenAI", _KEY),
        (" openai", _KEY),
        ("openai", f" {_KEY} "),
    ],
)
def test_armed_lane_refuses_missing_or_mismatched_provider_configuration(
    provider: str, key: str
) -> None:
    """An armed but unusable lane fails instead of silently checking nothing."""
    env = {OPT_IN_ENV: "1", PROVIDER_ENV: provider, KEY_ENV: key}

    with pytest.raises(ResonanceLaneMisconfiguredError) as excinfo:
        resolve_live_resonance_api_key(env)

    message = str(excinfo.value)
    assert OPT_IN_ENV in message
    assert KEY_ENV in message
    assert PROVIDER_ENV in message
    if key.strip():
        assert key not in message


def test_resolver_reads_only_the_mapping_it_was_given(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ambient process state cannot arm a resolver called with an empty mapping."""
    monkeypatch.setenv(OPT_IN_ENV, "1")
    monkeypatch.setenv(PROVIDER_ENV, "openai")
    monkeypatch.setenv(KEY_ENV, _KEY)

    assert resolve_live_resonance_api_key({}) is None


class _StatusError(RuntimeError):
    """Minimal provider-like failure carrying a response status."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"provider status {status_code}")
        self.status_code = status_code


def _wrapped_failure(cause: BaseException) -> LLMProviderError:
    """Return the public production error shape while retaining its SDK cause."""
    wrapped = LLMProviderError("provider request failed")
    wrapped.__cause__ = cause
    return wrapped


@pytest.mark.parametrize("status", [408, 409, 429, 500, 529, 599])
def test_transient_provider_statuses_are_unreachable(status: int) -> None:
    """Back-pressure and server errors yield no verdict and may skip the live run."""
    assert provider_is_unreachable(_wrapped_failure(_StatusError(status))) is True


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_permanent_provider_statuses_are_not_skippable(status: int) -> None:
    """Credential and request faults must fail an armed lane loudly."""
    assert provider_is_unreachable(_wrapped_failure(_StatusError(status))) is False


def test_transport_failure_is_unreachable() -> None:
    """A dropped connection carries no model-quality verdict and may skip."""
    assert provider_is_unreachable(_wrapped_failure(ConnectionError("offline"))) is True


def test_exhausted_credit_is_not_misreported_as_transient_rate_limiting() -> None:
    """A spent account is actionable configuration, even if its raw status is 429."""
    exhausted = LLMCreditExhaustedError("credit unavailable", provider="openai")
    exhausted.__cause__ = _StatusError(429)

    assert provider_is_unreachable(exhausted) is False


def test_wrapped_exhausted_credit_remains_a_loud_failure() -> None:
    """A public wrapper cannot hide the actionable billing subtype below it."""
    exhausted = LLMCreditExhaustedError("credit unavailable", provider="openai")
    exhausted.__cause__ = _StatusError(429)

    assert provider_is_unreachable(_wrapped_failure(exhausted)) is False


def test_permanent_status_wins_over_a_retained_transport_context() -> None:
    """A received 401 is a verdict even if the SDK chains an older socket error."""
    rejected = _StatusError(401)
    rejected.__cause__ = ConnectionError("older transport context")

    assert provider_is_unreachable(_wrapped_failure(rejected)) is False


def test_committed_fixture_has_the_promised_size_and_completion_evidence() -> None:
    """The paid measurement stays stable because its invented input is pinned."""
    body = _FIXTURE.read_text(encoding="utf-8")

    assert 900 <= len(body.split()) <= 1100
    assert all(phrase in body for phrase in _COMPLETED_HABIT_PHRASES)


def test_committed_fixture_carries_four_distinct_quotable_themes() -> None:
    """The model has several separated passages worth annotating, not one refrain."""
    body = _FIXTURE.read_text(encoding="utf-8").casefold()

    assert all(anchor in body for anchor in _THEME_ANCHORS)
