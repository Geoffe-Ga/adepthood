"""HTTP contract tests for Creek's ``letters`` capability (contract 0.17, #3203).

Every response body here is a vendored example from
``tests/fixtures/creek_v1/examples/letters/``, re-addressed to this request's
external id where the example's own id differs, so the client is driven with the
shapes Creek actually publishes rather than with ones invented here.
"""

from __future__ import annotations

import json
from http import HTTPStatus
from pathlib import Path

import httpx
import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapabilityUnsupportedError,
    CreekCeilingUnrepresentableError,
    CreekVaultCareEscalationError,
    CreekVaultContractError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    VaultIngestAction,
    VaultLetterRequest,
    VaultTierCeiling,
)
from services.creek_vault_client import (
    _LETTER_CALL,
    _REFLECTION_CALL,
    _VAULT_TIMEOUT_SECONDS,
    _VAULT_TOTAL_DEADLINE_SECONDS,
    CONTRACT_MINOR,
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
)
from services.creek_vault_telemetry import VaultTelemetryOutcome

_EXAMPLES = Path(__file__).parent / "fixtures" / "creek_v1" / "examples" / "letters"
_VAULT_URL = "https://vault.example.test"
_API_KEY = "letter-test-key"  # pragma: allowlist secret
_EXTERNAL_ID = "adepthood-voicedraft-4ab787c21ef0"
_CONTENT = "SENTINEL_LETTER_ENTRY the long way home by the river."
_NOTE = "SENTINEL_LETTER_NOTE waiting is a practice."
_ANCHOR = "the long way home"


def _example(state: str) -> dict[str, object]:
    payload = json.loads((_EXAMPLES / f"{state}.json").read_text())
    assert isinstance(payload, dict)
    return payload


def _handshake_payload(capabilities: list[str]) -> dict[str, object]:
    minor = ".".join(CONTRACT_VERSION.split(".")[:2])
    return {
        "vault": {"available": True},
        "capabilities": capabilities,
        "contract_version": CONTRACT_VERSION,
        "contract_minor": minor,
        "supported_contract_minors": [minor],
        "ontology_version": "aptitude-wavelength/2026-05-23",
        "attestation": None,
    }


class _LetterRoute:
    """Serve a handshake plus one scripted letter answer, recording every request."""

    def __init__(
        self,
        payload: object,
        status: int = HTTPStatus.OK,
        *,
        capabilities: tuple[str, ...] = ("letters", "voice-drafts"),
        error: Exception | None = None,
    ) -> None:
        self.payload = payload
        self.status = status
        self.capabilities = list(capabilities)
        self.error = error
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path.endswith("/v1/capabilities"):
            return httpx.Response(HTTPStatus.OK, json=_handshake_payload(self.capabilities))
        if self.error is not None:
            raise self.error
        return httpx.Response(self.status, json=self.payload)


def _request(tier: VaultTierCeiling = VaultTierCeiling.PERSONAL) -> VaultLetterRequest:
    return VaultLetterRequest(
        external_id=_EXTERNAL_ID,
        content=_CONTENT,
        note=_NOTE,
        anchor_text=_ANCHOR,
        kind="symbol",
        tier=tier,
    )


async def _client(route: _LetterRoute) -> HttpCreekVaultClient:
    client = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(route)),
    )
    await client.handshake()
    return client


@pytest.mark.asyncio
async def test_a_letter_posts_the_published_request_shape_and_reads_the_success_cell() -> None:
    """POST addresses the opaque id, sends the four published fields, and verifies the echo."""
    route = _LetterRoute(_example("success"))
    client = await _client(route)

    letter = await client.write_letter(_request())

    assert letter.letter == _example("success")["letter"]
    assert letter.vault_ref == _example("success")["fragment_id"]
    assert letter.action is VaultIngestAction.CREATED
    sent = route.requests[-1]
    assert sent.method == "POST"
    assert str(sent.url) == f"{_VAULT_URL}/v1/letters/{_EXTERNAL_ID}"
    assert sent.headers["Authorization"] == f"Bearer {_API_KEY}"
    assert sent.headers["X-Creek-Contract-Version"] == CONTRACT_MINOR
    assert sent.headers["X-Creek-Tier-Ceiling"] == "personal"
    assert json.loads(sent.content) == {
        "content": _CONTENT,
        "note": {"kind": "symbol", "anchor_text": _ANCHOR, "note": _NOTE},
        "tier": "personal",
    }


@pytest.mark.asyncio
async def test_the_empty_cell_is_a_letter_the_id_already_held() -> None:
    """``unchanged`` is first-writer-wins returning the stored letter, not a failure."""
    client = await _client(_LetterRoute(_example("empty")))

    letter = await client.write_letter(_request())

    assert letter.action is VaultIngestAction.UNCHANGED
    assert letter.letter == _example("empty")["letter"]


@pytest.mark.asyncio
async def test_the_care_escalation_cell_raises_out_of_the_degrade_hierarchy() -> None:
    """Creek's 200 care handoff is never readable as a letter."""
    client = await _client(_LetterRoute(_example("care-escalation")))

    with pytest.raises(CreekVaultCareEscalationError):
        await client.write_letter(_request())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("state", "status", "error"),
    [
        ("refusal", HTTPStatus.FORBIDDEN, CreekVaultContractError),
        ("malformed-input", HTTPStatus.UNPROCESSABLE_ENTITY, CreekVaultContractError),
        ("incompatible-version", HTTPStatus.CONFLICT, CreekVaultContractError),
        ("unavailable-service", HTTPStatus.SERVICE_UNAVAILABLE, CreekVaultUnavailableError),
    ],
)
async def test_error_cells_raise_their_classified_failure(
    state: str, status: int, error: type[Exception]
) -> None:
    """A coded refusal is a contract error even at 403; the vault's own outage is unavailable."""
    client = await _client(_LetterRoute(_example(state), status))

    with pytest.raises(error):
        await client.write_letter(_request())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field",
    ["external_id", "tier", "tier_ceiling", "attribution", "action", "fragment_id", "letter"],
)
async def test_an_unverifiable_success_is_an_unreadable_answer(field: str) -> None:
    """A 2xx whose identity, tier, authorship or letter does not verify is no letter at all."""
    wrong: dict[str, object] = {
        "external_id": "adepthood-voicedraft-somebody-else",
        "tier": "open",
        "tier_ceiling": "open",
        "attribution": {"author": "user", "author_slug": "owner", "voice_weight": 1.0},
        "action": "updated",
        "fragment_id": "",
        "letter": "   ",
    }
    payload = {**_example("success"), field: wrong[field]}
    client = await _client(_LetterRoute(payload))

    with pytest.raises(CreekVaultPayloadError):
        await client.write_letter(_request())


@pytest.mark.asyncio
async def test_a_body_that_is_not_an_object_is_an_unreadable_answer() -> None:
    """A proxy page served as 200 is not a stored letter."""
    client = await _client(_LetterRoute(["not", "an", "object"]))

    with pytest.raises(CreekVaultPayloadError):
        await client.write_letter(_request())


@pytest.mark.asyncio
async def test_an_unadvertised_letters_capability_refuses_before_the_wire() -> None:
    """A vault that never advertised ``letters`` never sees the entry."""
    route = _LetterRoute(_example("success"), capabilities=("voice-drafts",))
    client = await _client(route)

    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.write_letter(_request())

    assert all(request.url.path.endswith("/v1/capabilities") for request in route.requests)


@pytest.mark.asyncio
async def test_an_intimate_letter_is_unspellable_and_never_sent() -> None:
    """Intimate has no wire spelling: refused while the entry is still a frozen field."""
    route = _LetterRoute(_example("success"))
    client = await _client(route)

    with pytest.raises(CreekCeilingUnrepresentableError):
        await client.write_letter(_request(VaultTierCeiling.INTIMATE))

    assert all(request.url.path.endswith("/v1/capabilities") for request in route.requests)


@pytest.mark.asyncio
async def test_a_transport_failure_is_an_absent_vault() -> None:
    """A connection error surfaces as unavailable, carrying none of the entry."""
    route = _LetterRoute(_example("success"), error=httpx.ConnectError("refused"))
    client = await _client(route)

    with pytest.raises(CreekVaultUnavailableError) as raised:
        await client.write_letter(_request())

    assert "SENTINEL" not in str(raised.value)


@pytest.mark.asyncio
async def test_the_local_fallback_has_no_vault_to_write_a_letter() -> None:
    """No configured vault: the capability is unsupported, never a silent success."""
    client = LocalFallbackCreekVaultClient(VaultTelemetryOutcome.FALLBACK_UNCONFIGURED)

    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.write_letter(_request())


def test_a_letter_request_never_renders_its_prose() -> None:
    """``repr()`` of a request carries the id and tier but none of the writing."""
    rendered = repr(_request())

    assert "SENTINEL" not in rendered
    assert _ANCHOR not in rendered


@pytest.mark.asyncio
async def test_a_letter_runs_under_the_widened_phase_budgets() -> None:
    """A letter's read phase reaches the whole-request deadline, as a reflection's does.

    The divergence this closes (Creek-Vault#1903 step 6), and the home of the
    full rationale the client module now points here for. ``_post_reflection``
    was given :data:`_REFLECTION_CALL` by #3493 so the transport's ``read``
    phase would reach the thirty-second deadline instead of capping the call at
    :data:`_VAULT_TIMEOUT_SECONDS`. The letter call beside it named no deadline
    at all, so it kept the pooled client's per-phase budgets and died ten
    seconds from request to first byte -- the vault's model wake included --
    however generous the ``asyncio.timeout`` around it looked, because a phase
    budget is checked long before a whole-request deadline is. A letter is a
    generation call on the same ``generation`` chokepoint as a reflection, so it
    was the same bug on the same seam, one call site over.

    It is also what makes a vault's admission cap *observable* on this route: a
    ``429`` the transport cut off before it arrived is reported as a timeout,
    which is an outage story told about a wait.

    Four claims, each catching a different way the widening could be undone:
    the ``read`` equality catches the deadline being dropped from the
    departures; the three unchanged phases catch a widening that blunts the
    budgets bounding a genuinely unreachable host; and the capability GET
    catches the widening having been applied to the pooled client, where it
    would move every call rather than this one. That last one asserts
    *inequality* rather than a value: this suite's client is built without
    :data:`_VAULT_HTTP_TIMEOUT`, so the handshake runs on httpx's own default,
    and the claim being made is "the widening did not reach this call" rather
    than any particular number.
    """
    route = _LetterRoute(_example("success"))
    client = await _client(route)

    await client.write_letter(_request())

    post = next(r for r in route.requests if r.url.path.startswith("/v1/letters/"))
    budgets = post.extensions["timeout"]
    assert budgets["read"] == _VAULT_TOTAL_DEADLINE_SECONDS
    assert budgets["connect"] == _VAULT_TIMEOUT_SECONDS
    assert budgets["write"] == _VAULT_TIMEOUT_SECONDS
    assert budgets["pool"] == _VAULT_TIMEOUT_SECONDS

    handshake = next(r for r in route.requests if r.url.path == "/v1/capabilities")
    assert handshake.extensions["timeout"]["read"] != _VAULT_TOTAL_DEADLINE_SECONDS


def test_the_two_model_backed_call_sites_depart_on_the_same_budget() -> None:
    """The reflection and the letter run under one departure shape, not two.

    Asserted on the values rather than on their identity, so a second constant
    spelling the same thing still passes while a *narrowing* of either does
    not. The brief for #1903 step 6 names these two call sites as having
    diverged before; this is the pin that makes the next divergence a failing
    test rather than a debugging cycle.
    """
    assert _LETTER_CALL.deadline == _REFLECTION_CALL.deadline
    assert _LETTER_CALL.forwards_provider_key is _REFLECTION_CALL.forwards_provider_key
    assert _LETTER_CALL.contract_versioned is _REFLECTION_CALL.contract_versioned
