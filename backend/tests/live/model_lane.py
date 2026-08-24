"""Environment resolution and catalogue reconciliation for the live model lane.

The suite mocks every LLM provider, which is the right default -- but it means
the model allowlist in ``services.botmason`` is never checked against reality.
A date-pinned Anthropic build is retired on a published schedule and then
answers ``404``; nothing in a mocked suite can notice. The first report was a
user pressing a button and getting ``502 llm_provider_error``.

This module supplies the three pure pieces that make a live check trustworthy,
so each is testable without a network or a key (see
``tests/test_live_model_lane_guard.py``):

* :func:`resolve_live_api_key` -- the opt-in/require truth table.
* :func:`classify_catalogue_response` -- the transport-vs-verdict cut.
* :func:`retired_models` -- the set difference that *is* the verdict.

The cut in :func:`classify_catalogue_response` is the load-bearing one. A live
check that fails on any non-200 becomes a weekly false alarm and gets ignored,
and an ignored check is the same as no check. So a rate limit, a provider
outage, or a dropped connection yields ``UNREACHABLE`` and the caller skips: no
verdict was available, and none is claimed. Only a catalogue that was actually
read can retire a model.

The converse hole is just as real: a check that skips forever is silently dead,
which has already happened in this repo to a scheduled LLM job that failed
every run on a connection error with nobody watching. So the two causes that
would make this lane *permanently* blind -- a missing/expired credential and a
catalogue endpoint that no longer exists -- classify as ``MISCONFIGURED`` and
are raised rather than skipped, exactly as the Postgres integration lane raises
when it is declared required and finds no database.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from enum import Enum

#: Set truthy to arm the lane. Presence of a key is deliberately NOT enough: a
#: developer who exports ``ANTHROPIC_API_KEY`` for other work must not have
#: their ordinary ``pytest`` run start making paid network calls.
OPT_IN_ENV = "LIVE_MODEL_CHECK"

#: Credential the armed lane reads the catalogue with.
KEY_ENV = "ANTHROPIC_API_KEY"

#: Grepped by the scheduled workflow to tell "an allowlisted model was retired"
#: apart from "the lane could not reach a verdict". Both make the job red; only
#: the first is a statement about this repo's code, and only the first should
#: file an issue. Asserted into the lane's failure messages.
RETIREMENT_SENTINEL = "ALLOWLISTED_MODEL_RETIRED"

#: Anthropic's model catalogue. Lists both floating aliases and date-pinned
#: builds, which is what makes one cheap GET a complete answer for an allowlist
#: that deliberately mixes the two forms.
CATALOGUE_URL = "https://api.anthropic.com/v1/models"

#: Pinned request version for the Anthropic REST API.
ANTHROPIC_VERSION = "2023-06-01"

#: HTTP status that carries a catalogue.
_OK = 200

#: Rate limiting -- transport back-pressure, never a statement about a model.
_TOO_MANY_REQUESTS = 429

#: Server errors start here; everything at or above is the provider's problem.
_SERVER_ERROR_FLOOR = 500

# Spellings that read as "off". Anything else -- "1", "true", "TRUE", "yes" --
# arms the lane, so a typo fails loudly rather than silently disarming.
_FALSEY = frozenset({"", "0", "false", "no", "off"})


class LiveModelLaneMisconfiguredError(RuntimeError):
    """The lane was armed but cannot obtain a verdict from the provider.

    Distinct from "the provider was unreachable": this names a fault in the
    lane's own configuration -- no credential, a rejected credential, a
    catalogue endpoint that has moved -- which would otherwise leave a
    scheduled check skipping forever while its job reported success.
    """


class CatalogueOutcome(Enum):
    """What an HTTP response to the catalogue request permits us to conclude."""

    #: The catalogue was read; a model's absence from it is now meaningful.
    USABLE = "usable"
    #: The provider could not be reached. No verdict; the caller skips.
    UNREACHABLE = "unreachable"
    #: The request can never succeed as configured. The caller raises.
    MISCONFIGURED = "misconfigured"


def _is_truthy(value: str) -> bool:
    """Return whether an environment value reads as "on"."""
    return value.strip().casefold() not in _FALSEY


def resolve_live_api_key(env: Mapping[str, str]) -> str | None:
    """Return the key the armed lane should use, or ``None`` to skip.

    Nothing here reads ``os.environ``; the caller passes it in explicitly, so
    the truth table stays testable and a developer's shell cannot decide what
    CI does.

    Args:
        env: The environment to read. Never ``os.environ`` implicitly.

    Returns:
        The API key when the lane is armed and configured, or ``None`` when the
        lane is not armed and the caller should skip.

    Raises:
        LiveModelLaneMisconfiguredError: The lane is armed but no key is set.
            Arming is a deliberate act, so a missing key is a misconfiguration
            rather than a licence to pass without checking anything.
    """
    if not _is_truthy(env.get(OPT_IN_ENV, "")):
        return None
    key = env.get(KEY_ENV, "").strip()
    if not key:
        msg = (
            f"{KEY_ENV} is unset or blank while {OPT_IN_ENV} is truthy. The "
            f"live model lane was armed deliberately, so it fails here rather "
            f"than skipping past a credential that never arrived."
        )
        raise LiveModelLaneMisconfiguredError(msg)
    return key


def classify_catalogue_response(status_code: int) -> CatalogueOutcome:
    """Classify a catalogue response as verdict, back-pressure, or fault.

    Args:
        status_code: The HTTP status the catalogue request came back with.

    Returns:
        :attr:`CatalogueOutcome.USABLE` for ``200``;
        :attr:`CatalogueOutcome.UNREACHABLE` for ``429`` and ``5xx``, which are
        transport conditions that say nothing about any model;
        :attr:`CatalogueOutcome.MISCONFIGURED` for every other status --
        notably ``401``/``403`` (the credential is missing or expired) and
        ``404`` (the catalogue endpoint itself has moved, leaving this check
        blind).
    """
    if status_code == _OK:
        return CatalogueOutcome.USABLE
    if status_code == _TOO_MANY_REQUESTS or status_code >= _SERVER_ERROR_FLOOR:
        return CatalogueOutcome.UNREACHABLE
    return CatalogueOutcome.MISCONFIGURED


def retired_models(allowlisted: Iterable[str], catalogue: Iterable[str]) -> list[str]:
    """Return allowlisted ids the provider no longer publishes.

    Args:
        allowlisted: Model ids this application is willing to send requests to.
        catalogue: Model ids the provider currently offers.

    Returns:
        The sorted ids present in ``allowlisted`` and absent from ``catalogue``.
        Empty means every id the app can select still exists.
    """
    return sorted(set(allowlisted) - set(catalogue))
