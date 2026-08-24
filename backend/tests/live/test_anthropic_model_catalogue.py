"""Reconcile the Anthropic allowlist against Anthropic's live model catalogue.

Opt-in. ``pytest`` on its own never runs this: the lane is armed only when
``LIVE_MODEL_CHECK`` is truthy, and CI's ordinary backend jobs do not set it.

    # locally, with a real key
    LIVE_MODEL_CHECK=1 ANTHROPIC_API_KEY=sk-ant-... \
        python -m pytest tests/live -m live -q --no-cov

On a schedule it runs from ``.github/workflows/live-model-check.yml``, which
turns a retirement into a filed issue rather than a red run nobody reads.

One ``GET /v1/models`` answers the whole allowlist: the catalogue lists
floating aliases and date-pinned builds alike, costs no tokens, and generates
nothing, so the check is cheap enough to run weekly and carries no risk of
being mistaken for product traffic.
"""

from __future__ import annotations

import os

import httpx
import pytest

from services.botmason import PROVIDER_REGISTRY
from tests.live.model_lane import (
    ANTHROPIC_VERSION,
    CATALOGUE_URL,
    KEY_ENV,
    OPT_IN_ENV,
    RETIREMENT_SENTINEL,
    CatalogueOutcome,
    LiveModelLaneMisconfiguredError,
    classify_catalogue_response,
    resolve_live_api_key,
    retired_models,
)

pytestmark = pytest.mark.live

_PROVIDER = "anthropic"
_PAGE_SIZE = 100
_TIMEOUT_SECONDS = 20.0
# Connection-level retries only (httpx does not retry a response it received),
# so a single dropped TCP handshake does not read as a provider outage.
_CONNECT_RETRIES = 2
# A hard stop, so a provider that always claims ``has_more`` cannot spin here.
_MAX_PAGES = 20


class _CatalogueUnreachableError(RuntimeError):
    """The provider could not be reached, so no verdict is available."""


def _fetch_catalogue(api_key: str) -> frozenset[str]:
    """Return every model id the provider currently publishes.

    Args:
        api_key: Credential for the catalogue request. Never logged, never
            included in any exception message raised here.

    Returns:
        The published model ids.

    Raises:
        _CatalogueUnreachableError: Rate limited, a server error, or a
            transport failure -- conditions that say nothing about any model.
        LiveModelLaneMisconfiguredError: The request can never succeed as
            configured (rejected credential, or a catalogue endpoint that has
            moved), which would otherwise leave this check silently blind.
    """
    ids: set[str] = set()
    params: dict[str, str | int] = {"limit": _PAGE_SIZE}
    transport = httpx.HTTPTransport(retries=_CONNECT_RETRIES)
    with httpx.Client(transport=transport, timeout=_TIMEOUT_SECONDS) as client:
        for _ in range(_MAX_PAGES):
            try:
                response = client.get(
                    CATALOGUE_URL,
                    params=params,
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": ANTHROPIC_VERSION,
                    },
                )
            except httpx.HTTPError as exc:
                msg = f"transport failure reaching the model catalogue: {type(exc).__name__}"
                raise _CatalogueUnreachableError(msg) from exc
            outcome = classify_catalogue_response(response.status_code)
            if outcome is CatalogueOutcome.UNREACHABLE:
                msg = f"model catalogue answered HTTP {response.status_code}"
                raise _CatalogueUnreachableError(msg)
            if outcome is CatalogueOutcome.MISCONFIGURED:
                msg = (
                    f"model catalogue answered HTTP {response.status_code}: the "
                    f"credential is missing/expired or {CATALOGUE_URL} has moved. "
                    f"Until this is fixed the lane cannot see a retirement at all."
                )
                raise LiveModelLaneMisconfiguredError(msg)
            payload = response.json()
            ids.update(str(entry["id"]) for entry in payload.get("data", []))
            if not payload.get("has_more"):
                return frozenset(ids)
            params["after_id"] = str(payload["last_id"])
    msg = f"model catalogue still reported more pages after {_MAX_PAGES} requests"
    raise _CatalogueUnreachableError(msg)


@pytest.fixture(scope="module")
def catalogue() -> frozenset[str]:
    """Return the live catalogue, or skip when no verdict is obtainable."""
    api_key = resolve_live_api_key(os.environ)
    if api_key is None:
        pytest.skip(f"live model lane is opt-in; set {OPT_IN_ENV}=1 and {KEY_ENV} to run it")
    try:
        return _fetch_catalogue(api_key)
    except _CatalogueUnreachableError as exc:
        pytest.skip(f"no verdict available ({exc}); this is not a model-retirement result")


def test_every_allowlisted_model_is_still_published(catalogue: frozenset[str]) -> None:
    """An allowlisted id the provider no longer publishes is a live 502 waiting to happen.

    ``_get_model`` will happily select any id on the allowlist, so an id that
    has been retired out from under us reaches the provider and comes back
    ``404`` -- surfacing to the user as ``502 llm_provider_error`` on every
    resonance pass, reflection, and transcription.
    """
    retired = retired_models(PROVIDER_REGISTRY[_PROVIDER].allowed_models, catalogue)

    assert retired == [], (
        f"{RETIREMENT_SENTINEL}: {retired} are on the {_PROVIDER} allowlist in "
        f"backend/src/services/botmason.py but are no longer published at "
        f"{CATALOGUE_URL}. Requests selecting one of them fail with HTTP 404."
    )


def test_the_default_model_is_still_published(catalogue: frozenset[str]) -> None:
    """The default is the id an operator gets by following the documented setup.

    Called out separately from the allowlist sweep because it is the one entry
    whose retirement breaks a correct configuration rather than a chosen
    override -- which is precisely how this lane came to exist.
    """
    default_model = PROVIDER_REGISTRY[_PROVIDER].default_model

    assert default_model in catalogue, (
        f"{RETIREMENT_SENTINEL}: the {_PROVIDER} default model {default_model!r} is "
        f"no longer published at {CATALOGUE_URL}, so BOTMASON_PROVIDER={_PROVIDER} "
        f"with no LLM_MODEL override fails on every call."
    )


def test_every_vision_model_is_still_published(catalogue: frozenset[str]) -> None:
    """Vision ids are audited separately, so they are reconciled separately (ADR-3).

    Journal single-page transcription selects from ``vision_models``, which is
    deliberately not aliased to ``allowed_models``; a sweep of one set would
    not have covered the other.
    """
    retired = retired_models(PROVIDER_REGISTRY[_PROVIDER].vision_models, catalogue)

    assert retired == [], (
        f"{RETIREMENT_SENTINEL}: {retired} are in the {_PROVIDER} vision set in "
        f"backend/src/services/botmason.py but are no longer published at "
        f"{CATALOGUE_URL}, so journal transcription would 404."
    )
