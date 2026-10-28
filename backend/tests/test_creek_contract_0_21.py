"""What changes when adepthood declares Creek contract 0.21 rather than 0.18.

The pin is a constant sent on every call, and Creek keys three things on it:
whether it serves the caller at all (``supported_contract_minors`` must list the
declared minor exactly), whether a capped model call is reported as ``429
rate_limited`` or downgraded to ``503 temporarily_unavailable`` (0.19 for
reflections, 0.21 for letters), and which fields it adds to a response (0.19's
``inference_source`` and ``inference_pool``, 0.20's ``keyless_inference``).

Every expectation below is a literal rather than a value derived from
:data:`~domain.creek_vault.CONTRACT_VERSION`. A test that reads the pin to decide
what the pin should be passes whatever the pin is, which is exactly the
vacuity this suite exists to avoid.

0.19's handshake field ``inference_pool`` is **parsed and ignored** on purpose:
what *is* part of a pin move is proving it cannot change what adepthood does
with a handshake, which is what the ``ignored`` test pins.

0.19's ``inference_source`` on a reflection or letter is consumed since #3483:
it is the vault's own receipt for the route that answered, and
``request_key:<vendor>`` is the only evidence that the writer's relayed key paid
(``services.inference_provenance``). Here it is pinned only as surfaced on the
parsed answer, and an unreadable value as dropped rather than guessed at.

0.20's ``keyless_inference`` is the exception: since #3501 (the owner's decision
of 2026-10-21) it is consumed, and a pool-less vault's keyless pass is refused
``402 vault_key_required`` before any charge. Here it is pinned only as read
through to the handshake; the refusal itself is ``tests/test_vault_key_required.py``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import replace
from http import HTTPStatus
from pathlib import Path
from typing import Final, cast

import httpx
import pytest

from domain.creek_vault import (
    CreekVaultRateLimitedError,
    HandshakeResult,
    VaultErrorCode,
    VaultLetterRequest,
    VaultTierCeiling,
)
from services.creek_vault_client import HandshakeDegradeReason, HttpCreekVaultClient

_EXAMPLES: Final = Path(__file__).parent / "fixtures" / "creek_v1" / "examples"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "contract-021-test-key"  # pragma: allowlist secret
_CONTENT: Final = "SENTINEL_021_ENTRY the long way home by the river."
_NOTE: Final = "SENTINEL_021_NOTE waiting is a practice."
_ANCHOR: Final = "the long way home"
_EXTERNAL_ID: Final = "adepthood-voicedraft-4ab787c21ef0"

_CAPABILITIES_PATH: Final = "/v1/capabilities"
_REFLECTIONS_PATH: Final = "/v1/reflections"
_LETTERS_PATH: Final = f"/v1/letters/{_EXTERNAL_ID}"
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"

#: The lowest minor at which Creek serves ``rate_limited`` on both model-backed
#: routes. A literal, never read from the pin: the pin has since moved to 0.22
#: (``tests/test_creek_contract_0_22.py``), and what this suite owns is that it
#: never falls back below the letters gate.
_LETTER_GATE_MINOR: Final = (0, 21)

#: The minor Creek ``main``'s published window must still carry for 0.21 callers.
_PUBLISHED_0_21: Final = "0.21"

#: The newest minors a vault still on a pre-0.21 image serves. Creek refuses
#: any minor it does not list exactly, so this vault cannot serve a 0.21 caller
#: and adepthood must say so rather than call it.
_PRE_021_WINDOW: Final = ("0.20", "0.19", "0.18")

#: The field 0.19 added to the handshake, which adepthood ignores. 0.20's
#: ``keyless_inference`` is consumed (#3501), so it is not listed here.
_HANDSHAKE_ADDITIONS: Final = ("inference_pool",)

#: The field 0.19 added to every model-backed answer: the vault's route receipt (#3483).
_PROVENANCE_FIELD: Final = "inference_source"

#: Creek 0.21's answer at the model-call cap on either model-backed route.
_RATE_LIMITED_BODY: Final = {
    "code": "rate_limited",
    "message": "this vault is over its model-call allowance",
    "request_id": "req-example-rate-limited",
}


def _example(capability: str, state: str) -> dict[str, object]:
    """Return one published example cell from the vendored bundle."""
    document = json.loads((_EXAMPLES / capability / state).read_bytes())
    assert isinstance(document, dict)
    return document


def _minor_of(declared: str) -> tuple[int, int]:
    """Return a declared ``major.minor`` as a comparable pair of integers."""
    major, minor = declared.split(".")
    return int(major), int(minor)


def _published_handshake() -> dict[str, object]:
    """Return Creek's own 0.21 ``capabilities/success`` document."""
    return _example("capabilities", "success.json")


def _handshake_serving(window: tuple[str, ...]) -> dict[str, object]:
    """Return the published handshake, narrowed to serve exactly *window*."""
    return _published_handshake() | {
        "contract_minor": window[0],
        "contract_version": f"{window[0]}.0",
        "supported_contract_minors": list(window),
    }


def _without(document: Mapping[str, object], *keys: str) -> dict[str, object]:
    """Return *document* with *keys* removed, as a pre-0.19 vault would send it."""
    return {key: value for key, value in document.items() if key not in keys}


class _ScriptedVault:
    """Serve one handshake, then answer every other call with one scripted reply."""

    def __init__(
        self,
        *,
        handshake: Mapping[str, object] | None = None,
        status: int = HTTPStatus.OK,
        body: Mapping[str, object] | None = None,
    ) -> None:
        """Script the handshake and the reply every capability call receives."""
        self.handshake = _published_handshake() if handshake is None else dict(handshake)
        self.status = status
        self.body = {} if body is None else dict(body)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record *request* and answer it."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=self.handshake)
        return httpx.Response(self.status, json=self.body)

    def calls_to(self, path: str) -> list[httpx.Request]:
        """Return every recorded request to *path*."""
        return [request for request in self.requests if request.url.path == path]


def _client(vault: _ScriptedVault) -> HttpCreekVaultClient:
    """Return a client whose only transport is *vault*."""
    return HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(vault)),
    )


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


# --- negotiation -----------------------------------------------------------


@pytest.mark.asyncio
async def test_a_reflection_declares_at_least_contract_0_21() -> None:
    """The header Creek keys every minor gate on carries 0.21 or later, never 0.18."""
    vault = _ScriptedVault(body=_example("reflections", "success.json"))
    client = _client(vault)
    await client.handshake()

    await client.reflect(_CONTENT, VaultTierCeiling.PERSONAL)

    (sent,) = vault.calls_to(_REFLECTIONS_PATH)
    assert _minor_of(sent.headers[_CONTRACT_HEADER]) >= _LETTER_GATE_MINOR


@pytest.mark.asyncio
async def test_a_letter_declares_at_least_contract_0_21() -> None:
    """The letter route is the one 0.21 itself changed, so it is pinned on its own."""
    vault = _ScriptedVault(body=_example("letters", "success.json"))
    client = _client(vault)
    await client.handshake()

    await client.write_letter(_letter_request())

    (sent,) = vault.calls_to(_LETTERS_PATH)
    assert _minor_of(sent.headers[_CONTRACT_HEADER]) >= _LETTER_GATE_MINOR


@pytest.mark.asyncio
async def test_the_re_imaged_vaults_window_negotiates() -> None:
    """Creek ``main``'s own published handshake, which still serves 0.21, serves us."""
    published = _published_handshake()
    assert _PUBLISHED_0_21 in cast("list[str]", published["supported_contract_minors"])
    client = _client(_ScriptedVault(handshake=published))

    result = await client.handshake()

    assert result.available is True
    assert client.last_degrade_reason is None


@pytest.mark.asyncio
async def test_a_vault_that_stops_at_0_20_is_an_incompatible_version() -> None:
    """The #1888 shape: the pin is ahead of a vault that was not re-imaged.

    Creek refuses any minor it does not list exactly, so calling this vault
    would fail every request. adepthood must name it as version skew -- the
    remedy is a re-image, not a retry -- rather than as an absent vault.
    """
    client = _client(_ScriptedVault(handshake=_handshake_serving(_PRE_021_WINDOW)))

    assert await client.handshake() == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.INCOMPATIBLE_VERSION


# --- the cap reaches us as a wait, on both routes ----------------------------


@pytest.mark.asyncio
async def test_a_capped_reflection_from_a_0_21_vault_is_a_coded_wait() -> None:
    """At 0.21 the cap arrives as ``429 rate_limited``, and the code is read too.

    At 0.18 ``rate_limited`` was not in adepthood's vocabulary, so the code was
    dropped and only the status classified the wait. Now both agree.
    """
    client = _client(_ScriptedVault(status=HTTPStatus.TOO_MANY_REQUESTS, body=_RATE_LIMITED_BODY))
    await client.handshake()

    with pytest.raises(CreekVaultRateLimitedError) as capped:
        await client.reflect(_CONTENT, VaultTierCeiling.PERSONAL)

    assert capped.value.code is VaultErrorCode.RATE_LIMITED


@pytest.mark.asyncio
async def test_a_capped_letter_from_a_0_21_vault_is_a_coded_wait() -> None:
    """The route 0.21 opened to the cap tells the same story as the reflection route."""
    client = _client(_ScriptedVault(status=HTTPStatus.TOO_MANY_REQUESTS, body=_RATE_LIMITED_BODY))
    await client.handshake()

    with pytest.raises(CreekVaultRateLimitedError) as capped:
        await client.write_letter(_letter_request())

    assert capped.value.code is VaultErrorCode.RATE_LIMITED


@pytest.mark.asyncio
async def test_a_rate_limited_code_is_a_wait_whatever_status_carries_it() -> None:
    """Code first: the vault naming its cap outranks the status class it rode on.

    Creek publishes ``rate_limited`` at 429 alone, so this is the defensive
    half -- a proxy rewriting the status must not turn a wait into an outage
    when the vault's own reason survived the trip.
    """
    client = _client(_ScriptedVault(status=HTTPStatus.SERVICE_UNAVAILABLE, body=_RATE_LIMITED_BODY))
    await client.handshake()

    with pytest.raises(CreekVaultRateLimitedError) as capped:
        await client.reflect(_CONTENT, VaultTierCeiling.PERSONAL)

    assert capped.value.code is VaultErrorCode.RATE_LIMITED


# --- the 0.19 / 0.20 additions are parsed and ignored -----------------------


@pytest.mark.asyncio
async def test_the_handshake_additions_are_ignored() -> None:
    """``inference_pool`` changes nothing adepthood decides.

    Compared against the same document with both fields stripped, so the claim
    is "the field had no effect" rather than "the parse did not crash".
    """
    with_fields = _client(_ScriptedVault())
    without_fields = _client(
        _ScriptedVault(handshake=_without(_published_handshake(), *_HANDSHAKE_ADDITIONS))
    )

    assert await with_fields.handshake() == await without_fields.handshake()


@pytest.mark.asyncio
async def test_a_vault_reporting_no_keyless_inference_is_read_through() -> None:
    """``keyless_inference: false`` reaches the handshake, and changes nothing else.

    Acting on it is #3501's refusal before charging. Here the claim is narrower:
    the field is read as the vault sent it, and every other negotiated fact is
    identical to the published document's.
    """
    refusing = await _client(
        _ScriptedVault(handshake=_published_handshake() | {"keyless_inference": False})
    ).handshake()
    baseline = await _client(_ScriptedVault()).handshake()

    assert refusing.refuses_keyless_inference() is True
    assert baseline.refuses_keyless_inference() is False
    assert replace(refusing, keyless_inference=None) == replace(baseline, keyless_inference=None)


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["success.json", "empty.json"])
async def test_a_reflections_inference_source_is_surfaced(state: str) -> None:
    """The published 0.21 reflection carries its route, and nothing else about it moves (#3483)."""
    published = _example("reflections", state)
    assert _PROVENANCE_FIELD in published
    labelled = _client(_ScriptedVault(body=published))
    unlabelled = _client(_ScriptedVault(body=_without(published, _PROVENANCE_FIELD)))
    await labelled.handshake()
    await unlabelled.handshake()

    answered = await labelled.reflect(_CONTENT, VaultTierCeiling.PERSONAL)
    bare = await unlabelled.reflect(_CONTENT, VaultTierCeiling.PERSONAL)

    assert answered.inference_source == published[_PROVENANCE_FIELD]
    assert bare.inference_source is None
    assert replace(answered, inference_source=None) == bare


@pytest.mark.asyncio
async def test_a_letters_inference_source_is_surfaced() -> None:
    """The published 0.21 letter carries its route, and nothing else about it moves (#3483)."""
    published = _example("letters", "success.json")
    assert _PROVENANCE_FIELD in published
    labelled = _client(_ScriptedVault(body=published))
    unlabelled = _client(_ScriptedVault(body=_without(published, _PROVENANCE_FIELD)))
    await labelled.handshake()
    await unlabelled.handshake()

    answered = await labelled.write_letter(_letter_request())
    bare = await unlabelled.write_letter(_letter_request())

    assert answered.inference_source == published[_PROVENANCE_FIELD]
    assert bare.inference_source is None
    assert replace(answered, inference_source=None) == bare


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("raw", "surfaced"),
    [
        ("request_key:anthropic", "request_key:anthropic"),
        ("request_key:openai", "request_key:openai"),
        ("local", "local"),
        ("pool:attested:privatemode", "pool:attested:privatemode"),
        ("request_key:", None),
        ("request_key:Anthropic", None),
        ("REQUEST_KEY:openai", None),
        ("request_key:openai\n", None),
        ("pool:somewhere-else", None),
        (42, None),
        (None, None),
    ],
)
async def test_an_unreadable_inference_source_is_dropped_not_guessed(
    raw: object, surfaced: str | None
) -> None:
    """Only the published vocabulary is surfaced; anything else reads as no receipt at all."""
    published = _example("reflections", "success.json") | {_PROVENANCE_FIELD: raw}
    client = _client(_ScriptedVault(body=published))
    await client.handshake()

    answered = await client.reflect(_CONTENT, VaultTierCeiling.PERSONAL)

    assert answered.inference_source == surfaced
