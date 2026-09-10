"""The provider probe is refused a production boot, not merely discouraged.

:mod:`services.provider_probe` lets one marked prompt leave a stub-configured
server for a real provider, so that the wiring behind the stub — key
resolution, the SDK, the transport, the retry budget, the classification of the
answer — can be exercised on a deployment that would otherwise never run any of
it. The end-to-end lane arms it against a loopback fake.

In front of real users the same seam is a request path chosen by the contents of
a journal entry, which is not something to leave to a runbook. This is therefore
the shape of ``validate_email_config`` rather than of the warn-only checks: a
production boot with the token armed does not go live. Outside production it is
silent, because arming it is exactly what a developer or the lane does on
purpose.

The length floor is asserted on this path too. A refusal keyed on "the variable
is set" would take a deploy down over a value that could not arm anything, and a
refusal keyed on the trimmed token is the only one that agrees with what
:func:`services.provider_probe.armed_probe_token` actually reads.
"""

from __future__ import annotations

import pytest

from main import validate_provider_probe_config
from services.provider_probe import MIN_PROBE_TOKEN_LENGTH, PROVIDER_PROBE_ENV_VAR

ENV_VAR = "ENV"

#: A token that clears the floor, as the lane's random value does.
ARMED = "b7Qm2xL9pT4vRc8ZaHnE6sWd"  # pragma: allowlist secret


def test_production_with_the_probe_armed_refuses_to_boot(monkeypatch: pytest.MonkeyPatch) -> None:
    """A live provider seam selected by user text must not reach real users."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(PROVIDER_PROBE_ENV_VAR, ARMED)

    with pytest.raises(RuntimeError, match=PROVIDER_PROBE_ENV_VAR):
        validate_provider_probe_config()


def test_the_production_refusal_never_echoes_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The value is a secret, unlike the backend name the email refusal quotes.

    Anyone who learns it can make a request leave the stub, so the refusal names
    the variable and says nothing about what is in it.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(PROVIDER_PROBE_ENV_VAR, ARMED)

    with pytest.raises(RuntimeError) as excinfo:
        validate_provider_probe_config()

    assert ARMED not in str(excinfo.value)


def test_production_with_a_token_too_short_to_arm_anything_still_boots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The refusal agrees with the reader: what cannot arm the probe is not armed.

    A check keyed on "the variable is present" would take a production deploy
    down over a leftover empty string, which is a different (and false) claim
    from the one this refusal makes.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(PROVIDER_PROBE_ENV_VAR, "x" * (MIN_PROBE_TOKEN_LENGTH - 1))

    validate_provider_probe_config()


def test_production_without_the_variable_boots_silently(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ordinary production deployment never sees this check at all."""
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.delenv(PROVIDER_PROBE_ENV_VAR, raising=False)

    validate_provider_probe_config()


@pytest.mark.parametrize("env", ["development", "staging", "test"])
def test_arming_the_probe_outside_production_is_silent(
    env: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Arming it is what the lane and a developer do deliberately."""
    monkeypatch.setenv(ENV_VAR, env)
    monkeypatch.setenv(PROVIDER_PROBE_ENV_VAR, ARMED)

    validate_provider_probe_config()
