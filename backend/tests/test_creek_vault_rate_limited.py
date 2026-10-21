"""One per-account cap, one story — on the reflection route and on the letter route.

The consumer half of Creek-Vault#1903 step 6. Creek's admission cap is not a
per-route counter and never was: both model-backed routes resolve the one
``generation`` stage through the same provider chokepoint, so a writer held at
the cap is held at it on both. Creek now *reports* it the same way on both
(contract 0.20, ``429 rate_limited``), and this suite is adepthood's side of
that promise — a 429 from either route is a **wait**, not an outage, and it is
the same exception type carrying the same meaning.

Why the classification keys on the **status** rather than on the vault's
``code``: adepthood's vendored bundle is contract 0.18, whose ``ErrorCode``
enum has no ``rate_limited`` member, so :func:`_coerce_error_code` drops the
string and there is no code to read. The status is unambiguous — ``429`` is
Creek's status for exactly one code, and ``ERROR_STATUS`` gives no other code
that status — and it also classifies a 429 from an intermediary that never
reached the vault's error vocabulary at all. This does **not** overturn the
code-first rule those classifiers document: that rule exists so a *coded*
answer is never misattributed by its status class, and ``429`` carries no
competing code to be misattributed from. When the vendored bundle advances and
``rate_limited`` joins ``VaultErrorCode``, the coded branch will agree with
this one rather than replace it, because both run through
:func:`~services.creek_vault_client._availability_failure`.
"""

from __future__ import annotations

import json
from http import HTTPStatus
from pathlib import Path

import httpx
import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekVaultContractError,
    CreekVaultRateLimitedError,
    CreekVaultUnavailableError,
    VaultLetterRequest,
    VaultTierCeiling,
)
from services.creek_vault_client import HttpCreekVaultClient

_FIXTURES = Path(__file__).parent / "fixtures" / "creek_v1" / "examples"
_VAULT_URL = "https://vault.example.test"
_API_KEY = "rate-limit-test-key"  # pragma: allowlist secret
_EXTERNAL_ID = "adepthood-voicedraft-4ab787c21ef0"
_CONTENT = "SENTINEL_CAP_ENTRY the long way home by the river."
_NOTE = "SENTINEL_CAP_NOTE waiting is a practice."
_ANCHOR = "the long way home"

_REFLECTIONS_PATH = "/v1/reflections"
_LETTERS_PATH = f"/v1/letters/{_EXTERNAL_ID}"
_CAPABILITIES_PATH = "/v1/capabilities"

#: The refusal Creek serves at its admission cap. Spelled here rather than read
#: from the vendored bundle because the bundle is contract 0.18 and publishes no
#: such cell: this is the shape contract 0.20 answers with, and pinning it by
#: hand is what lets this suite be written before the bundle is re-vendored.
_CAPPED_BODY = {
    "code": "rate_limited",
    "message": "this vault is over its model-call allowance",
    "request_id": "req-example-rate-limited",
}

#: Creek's own capability names for the two model-backed routes, plus the
#: Voice Draft store a letter is written into. Spelled as Creek spells them
#: on the handshake, not as adepthood names them internally.
_CAPABILITIES = ("reflections", "letters", "voice-drafts")


def _handshake() -> dict[str, object]:
    """Return a handshake advertising both model-backed capabilities."""
    minor = ".".join(CONTRACT_VERSION.split(".")[:2])
    return {
        "vault": {"available": True},
        "capabilities": list(_CAPABILITIES),
        "contract_version": CONTRACT_VERSION,
        "contract_minor": minor,
        "supported_contract_minors": [minor],
        "ontology_version": "aptitude-wavelength/2026-05-23",
        "attestation": None,
    }


class _CappedVault:
    """Answer the handshake, then refuse every capability call with one status.

    One route table rather than two fixtures, so "both routes answer the same
    way" is driven by one scripted vault instead of by two that could drift
    apart exactly as the two call sites under test once did.
    """

    def __init__(self, status: int = HTTPStatus.TOO_MANY_REQUESTS, body: object = None) -> None:
        """Script the refusal every non-handshake call receives."""
        self.status = status
        self.body = _CAPPED_BODY if body is None else body
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Serve the handshake, or the scripted refusal, recording the request."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=_handshake())
        return httpx.Response(self.status, json=self.body)


async def _client(vault: _CappedVault) -> HttpCreekVaultClient:
    """Return a handshaken client whose transport is *vault*."""
    client = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(vault)),
    )
    await client.handshake()
    return client


def _letter_request() -> VaultLetterRequest:
    """Return one letter request over the writer's own entry and note."""
    return VaultLetterRequest(
        external_id=_EXTERNAL_ID,
        content=_CONTENT,
        note=_NOTE,
        anchor_text=_ANCHOR,
        kind="symbol",
        tier=VaultTierCeiling.PERSONAL,
    )


@pytest.mark.asyncio
async def test_a_capped_reflection_is_a_wait() -> None:
    """The route that has served the cap since Creek 0.19."""
    client = await _client(_CappedVault())

    with pytest.raises(CreekVaultRateLimitedError):
        await client.reflect(_CONTENT, VaultTierCeiling.PERSONAL)


@pytest.mark.asyncio
async def test_a_capped_letter_is_a_wait_rather_than_an_outage() -> None:
    """The route Creek 0.20 added, and the asymmetry this closes.

    A letter and a reflection spend the *same* budget, so a writer told "the
    vault is unavailable" on one and "wait a minute" on the other is being
    told two things about one limit.
    """
    client = await _client(_CappedVault())

    with pytest.raises(CreekVaultRateLimitedError):
        await client.write_letter(_letter_request())


@pytest.mark.asyncio
async def test_both_routes_raise_one_type_for_one_cap() -> None:
    """Compared rather than transcribed: the two answers are the same answer.

    The brief's warning is the reason this is a comparison — these two call
    sites have diverged before (the reflection route's whole-request deadline
    was reachable while the letter's was not), and a pair of per-route
    assertions is exactly what lets the next divergence pass.
    """
    vault = _CappedVault()
    client = await _client(vault)

    with pytest.raises(CreekVaultRateLimitedError) as reflecting:
        await client.reflect(_CONTENT, VaultTierCeiling.PERSONAL)
    with pytest.raises(CreekVaultRateLimitedError) as writing:
        await client.write_letter(_letter_request())

    assert type(writing.value) is type(reflecting.value)
    assert writing.value.code == reflecting.value.code


@pytest.mark.asyncio
async def test_a_cap_still_degrades_as_every_caller_already_degrades() -> None:
    """The new type is a *subclass*, so no existing ``except`` changes behaviour.

    The whole point of narrowing inside the availability hierarchy rather than
    beside it: a cap is still a reason the call did not land, so every caller
    that degrades on an absent vault keeps degrading, and only a caller that
    wants to show a wait has to know the difference. It is likewise never a
    contract error — a cap says nothing about the request adepthood sent.
    """
    client = await _client(_CappedVault())

    with pytest.raises(CreekVaultUnavailableError) as capped:
        await client.write_letter(_letter_request())

    assert not isinstance(capped.value, CreekVaultContractError)


@pytest.mark.asyncio
async def test_an_uncoded_429_is_still_a_wait() -> None:
    """A gateway shedding load never reaches the vault's error vocabulary.

    So the classification cannot depend on a body: an intermediary answering
    ``429`` with prose, or with nothing, is the same "come back later" as the
    vault's own cap, and reading it as an outage would send an operator
    hunting an outage that is not there.
    """
    client = await _client(_CappedVault(body={"detail": "slow down"}))

    with pytest.raises(CreekVaultRateLimitedError):
        await client.write_letter(_letter_request())


@pytest.mark.asyncio
async def test_a_503_is_still_the_plain_outage_it_was() -> None:
    """The narrowing is to ``429`` alone; the vault's own outage is unchanged.

    Without this the suite would pass against a classifier that called every
    availability failure a cap, which would tell a writer to wait out an
    outage that waiting cannot clear.
    """
    body = json.loads((_FIXTURES / "letters" / "unavailable-service.json").read_bytes())
    client = await _client(_CappedVault(status=HTTPStatus.SERVICE_UNAVAILABLE, body=body))

    with pytest.raises(CreekVaultUnavailableError) as outage:
        await client.write_letter(_letter_request())

    assert not isinstance(outage.value, CreekVaultRateLimitedError)
