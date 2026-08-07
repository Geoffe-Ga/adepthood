"""Integration tests wiring the journal resonance endpoint to the Creek Vault read path.

The vault answers this router with a structured
:class:`~domain.creek_vault.VaultReflection` rather than a string, so the cases
below also pin the two outcomes that were previously indistinguishable from a
blank answer: a care escalation, which must reach the caller as adepthood's own
reviewed care surface rather than as a 502 or as Creek's copy, and an empty
reflection, which is a legitimate answer that simply defers to the cloud.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator, Sequence
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.care import build_care_payload
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultCareEscalationError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultWheelBalance,
)
from main import app
from models.marginalia import Marginalia
from models.user import User
from scripts.creek_contract_drift import BUNDLE_ROOT
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_write import get_creek_vault_client
from services.usage import get_monthly_cap

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

_BODY = "I walked by the river and the willow bent without breaking."
_VERBATIM_QUOTE = "I walked by the river"
_FABRICATED_QUOTE = "the moonlight of Neptune, which never appears here"

_CLOUD_NOTE = "The cloud reads: you return to water."
_VAULT_NOTE = "The vault reads: this is written in your own corpus."

# The acute-distress trigger phrase used in test_resonance_endpoints.py's
# distress test, reused here so the care surface fires the same way.
_DISTRESS_BODY = "I keep thinking I want to kill myself and end my life tonight."

_VAULT_URL = "https://vault.example.test"
_API_KEY = "creek-vault-journal-read-key"  # pragma: allowlist secret
_CAPABILITIES_PATH = "/v1/capabilities"

_DEFAULT_REFLECT_CAPABILITIES = frozenset(
    {CreekCapability.JOURNAL, CreekCapability.CLASSIFY, CreekCapability.REFLECT}
)


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Sign up a fresh user and return an Authorization header for it."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _create_entry(
    client: AsyncClient,
    headers: dict[str, str],
    *,
    body: str = _BODY,
    classification: str = "personal",
) -> int:
    """Create a journal entry and return its id."""
    resp = await client.post(
        "/journal/",
        json={"message": body, "classification": classification},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


def _vault_reflection(*notes: VaultReflectionNote) -> VaultReflection:
    """Build the structured reflection the vault's reflect() answers with.

    Zero notes is deliberately still an ``ok`` answer rather than an empty one:
    what the vault said and what survived projection are separate facts, and the
    consumer -- not this fake -- decides that nothing renderable means deferring.
    """
    return VaultReflection(
        status=VaultReflectionStatus.OK,
        notes=notes,
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.PERSONAL,
    )


def _empty_reflection() -> VaultReflection:
    """Build the reflection a vault with nothing to say answers with."""
    return VaultReflection(
        status=VaultReflectionStatus.EMPTY,
        notes=(),
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.PERSONAL,
    )


def _fake_cloud_llm(monkeypatch: pytest.MonkeyPatch, *notes: dict[str, str]) -> None:
    """Patch the cloud resonance LLM seam to return canned JSON notes."""
    payload = json.dumps({"notes": list(notes)})

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return LLMResponse(
            text=payload,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)


class ReflectingVaultClient:
    """Fake CreekVaultClient: ingests/classifies for entry creation, scripts reflect."""

    def __init__(
        self,
        *,
        available: bool = True,
        capabilities: frozenset[CreekCapability] = _DEFAULT_REFLECT_CAPABILITIES,
        reflect_result: VaultReflection | None = None,
        reflect_error: Exception | None = None,
    ) -> None:
        """Store the scripted handshake outcome and reflect behavior."""
        self.ingest_calls: list[VaultIngestRequest] = []
        self.handshake_calls = 0
        self.reflect_calls: list[tuple[str, VaultTierCeiling]] = []
        self._available = available
        self._capabilities = capabilities
        self._reflect_result = reflect_result if reflect_result is not None else _empty_reflection()
        self._reflect_error = reflect_error

    async def handshake(self) -> HandshakeResult:
        """Record the call and return the scripted availability/capabilities."""
        self.handshake_calls += 1
        return HandshakeResult(
            available=self._available,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Return the scripted availability."""
        return self._available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether ``capability`` is in the scripted capability set."""
        return capability in self._capabilities

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Record the request and return an incrementing vault ref (write path)."""
        self.ingest_calls.append(request)
        return VaultIngestResult(stored=True, vault_ref=f"vault-ref-{len(self.ingest_calls)}")

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Return a fixed classification tag set (write path)."""
        return VaultClassification(tags=("courage",))

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Record the call, then raise the scripted error or return the scripted reflection."""
        self.reflect_calls.append((body, tier_ceiling))
        if self._reflect_error is not None:
            raise self._reflect_error
        return self._reflect_result

    async def wheel(self) -> VaultWheelBalance:
        """Return an empty wheel balance (unused by the reflect path)."""
        return VaultWheelBalance(aspects=())


class _RecordingTransportHandler:
    """A MockTransport handler recording every request that reached the wire."""

    def __init__(self, capabilities: Sequence[str]) -> None:
        """Store the advertised capabilities and start an empty request log."""
        self._capabilities = list(capabilities)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer the capability probe or an empty body."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(
                HTTPStatus.OK,
                json={
                    "available": True,
                    "capabilities": self._capabilities,
                    "contract_version": CONTRACT_VERSION,
                    "ontology_version": "1.0.0",
                    "attestation": None,
                },
            )
        return httpx.Response(HTTPStatus.OK, json={})


@pytest_asyncio.fixture
async def spied_vault() -> AsyncGenerator[tuple[HttpCreekVaultClient, _RecordingTransportHandler]]:
    """Yield a real HTTP vault client paired with the handler spying on its wire."""
    handler = _RecordingTransportHandler(
        [capability.value for capability in _DEFAULT_REFLECT_CAPABILITIES]
    )
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    yield HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http), handler
    await http.aclose()


def _creek_escalation() -> CreekVaultCareEscalationError:
    """Build the content-free escalation the adapter raises on Creek's 200 care handoff."""
    return CreekVaultCareEscalationError()


def _care_texts() -> tuple[str, ...]:
    """Return adepthood's own reviewed care copy: the message plus every resource field."""
    payload = build_care_payload()
    texts = [payload.message]
    for resource in payload.resources:
        texts += [resource.name, resource.contact, resource.what_it_is]
    return tuple(texts)


def _creek_care_texts() -> tuple[str, ...]:
    """Return the care prose that is distinctively Creek's, never adepthood's.

    Read from the vendored bundle rather than invented, so what this asserts is
    absent is exactly the copy a real vault would send. It is Creek's writing, not
    adepthood's, and this app renders only copy it has reviewed itself.

    Adepthood's own reviewed copy is subtracted first. The two sets genuinely
    overlap -- both name the 988 lifeline, because both point at the same real
    crisis line -- and a shared contact string appearing in the response is
    adepthood rendering its own resource, not Creek's prose leaking through.
    Subtracting rather than hardcoding the overlap keeps the assertion honest: a
    string adepthood stops publishing becomes one Creek may not send either.
    """
    published = json.loads((BUNDLE_ROOT / "examples/reflections/care-escalation.json").read_bytes())
    assert isinstance(published, dict)
    signal = published["care_signal"]
    assert isinstance(signal, dict)
    resources = signal["resources"]
    assert isinstance(resources, list)
    texts = [str(signal["message"]), str(published["reason"])]
    for resource in resources:
        assert isinstance(resource, dict)
        texts += [str(resource["name"]), str(resource["contact"])]
    ours = frozenset(_care_texts())
    distinctive = tuple(text for text in texts if text not in ours)
    assert distinctive, "Creek's document must carry prose adepthood does not publish itself"
    return distinctive


async def _read_user(session: AsyncSession, email: str) -> User:
    """Return the persisted user row for ``email``."""
    return (await session.execute(select(User).where(col(User.email) == email))).scalar_one()


@pytest.mark.asyncio
async def test_vault_routes_reflection_when_available_and_supports_reflect(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A personal entry with a REFLECT-capable vault persists the vault's own note."""
    fake_vault = ReflectingVaultClient(
        reflect_result=_vault_reflection(
            VaultReflectionNote(kind="theme", quote=_VERBATIM_QUOTE, note=_VAULT_NOTE)
        )
    )
    _fake_cloud_llm(monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE})
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, "vault_read_routes")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert len(body["marginalia"]) == 1
    assert body["marginalia"][0]["note"] == _VAULT_NOTE
    assert fake_vault.reflect_calls == [(_BODY, VaultTierCeiling.PERSONAL)]
    assert body["remaining_messages"] == get_monthly_cap() - 1


@pytest.mark.asyncio
async def test_vault_notes_are_anchored_against_the_body_not_trusted(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fabricated (non-verbatim) vault quote is dropped; only the real one anchors."""
    fake_vault = ReflectingVaultClient(
        reflect_result=_vault_reflection(
            VaultReflectionNote(kind="theme", quote=_VERBATIM_QUOTE, note=_VAULT_NOTE),
            VaultReflectionNote(
                kind="symbol", quote=_FABRICATED_QUOTE, note="should never persist"
            ),
        )
    )
    _fake_cloud_llm(monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE})
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, "vault_read_anchors")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    rows = (
        (
            await db_session.execute(
                select(Marginalia).where(col(Marginalia.journal_entry_id) == entry_id)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    note = rows[0]
    assert note.note == _VAULT_NOTE
    start = _BODY.find(_VERBATIM_QUOTE)
    assert note.anchor_start == start
    assert note.anchor_end == start + len(_VERBATIM_QUOTE)
    assert note.anchor_text == _VERBATIM_QUOTE


@pytest.mark.asyncio
async def test_distress_entry_never_reaches_the_vault(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A distress-flagged entry surfaces care and cloud reflection, never the vault."""
    fake_vault = ReflectingVaultClient(reflect_result=_vault_reflection())
    _fake_cloud_llm(monkeypatch, {"kind": "theme", "quote": "kill myself", "note": _CLOUD_NOTE})
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, "vault_read_distress")
    entry_id = await _create_entry(async_client, headers, body=_DISTRESS_BODY)
    # Entry creation already exercises the vault write path (a handshake for
    # any non-intimate entry), so the resonance-only delta is measured against
    # this baseline rather than an absolute zero.
    handshakes_after_create = fake_vault.handshake_calls

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["care"] is not None
    assert len(body["marginalia"]) == 1
    assert body["marginalia"][0]["note"] == _CLOUD_NOTE
    assert fake_vault.reflect_calls == []
    assert fake_vault.handshake_calls == handshakes_after_create


@pytest.mark.asyncio
async def test_intimate_entry_never_reaches_the_vault_reflect_path(
    async_client: AsyncClient,
    spied_vault: tuple[HttpCreekVaultClient, _RecordingTransportHandler],
) -> None:
    """An intimate entry issues zero vault requests, asserted at the transport itself.

    Re-pinned on a real client over a recording transport rather than on a fake's
    call counters: the privacy floor's guarantee is that the entry never leaves
    the process, and only the wire can witness that. A method-level spy would
    still pass if a handshake had already gone out.
    """
    client, handler = spied_vault
    app.dependency_overrides[get_creek_vault_client] = lambda: client
    headers = await _signup(async_client, "vault_read_intimate")
    entry_id = await _create_entry(
        async_client, headers, body="A private confession.", classification="intimate"
    )

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["private"] is True
    assert body["marginalia"] == []
    assert handler.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("available", "capabilities"),
    [
        (False, _DEFAULT_REFLECT_CAPABILITIES),
        (True, frozenset({CreekCapability.JOURNAL, CreekCapability.CLASSIFY})),
    ],
    ids=["handshake_unavailable", "reflect_unsupported"],
)
async def test_no_reflect_capability_falls_back_to_cloud(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    available: bool,
    capabilities: frozenset[CreekCapability],
) -> None:
    """No usable vault, or no REFLECT support, keeps today's cloud-only shape."""
    fake_vault = ReflectingVaultClient(available=available, capabilities=capabilities)
    _fake_cloud_llm(monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE})
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, f"vault_read_nocap_{available}_{len(capabilities)}")
    entry_id = await _create_entry(async_client, headers)
    # Entry creation already calls handshake() once via the vault write path;
    # the resonance pass should add exactly one more (its own probe), not zero.
    handshakes_after_create = fake_vault.handshake_calls

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert len(body["marginalia"]) == 1
    assert body["marginalia"][0]["note"] == _CLOUD_NOTE
    assert fake_vault.handshake_calls == handshakes_after_create + 1
    assert fake_vault.reflect_calls == []


@pytest.mark.asyncio
async def test_mid_reflect_vault_failure_degrades_to_cloud(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A vault that advertises REFLECT but raises on the call degrades to the cloud."""
    fake_vault = ReflectingVaultClient(
        reflect_error=CreekVaultUnavailableError("creek vault call failed: creek.reflect")
    )
    _fake_cloud_llm(monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE})
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, "vault_read_degrade")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert len(body["marginalia"]) == 1
    assert body["marginalia"][0]["note"] == _CLOUD_NOTE
    assert len(fake_vault.reflect_calls) == 1
    assert body["remaining_messages"] == get_monthly_cap() - 1
    persisted = (
        await db_session.execute(select(func.count()).select_from(Marginalia))
    ).scalar_one()
    assert persisted == 1


@pytest.mark.asyncio
async def test_empty_vault_reflection_defers_to_the_cloud(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A vault with nothing to say is a legitimate answer that simply defers to the cloud.

    It is not an escalation, not a failure, and not a 502 -- the user gets the
    cloud's reflection and the pass charges exactly once, as it always did.
    """
    fake_vault = ReflectingVaultClient(reflect_result=_empty_reflection())
    _fake_cloud_llm(monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE})
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, "vault_read_empty")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["care"] is None
    assert [note["note"] for note in body["marginalia"]] == [_CLOUD_NOTE]
    assert body["remaining_messages"] == get_monthly_cap() - 1


@pytest.mark.asyncio
async def test_vault_escalation_returns_adepthoods_own_care_surface(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An escalating vault answers 200 with adepthood's reviewed care copy and no reflection.

    Two halves, and the second is the one that needs saying. The user must reach
    a human, so the response is a care surface rather than an error -- and it is
    *adepthood's* care surface, built from ``domain.care``, because Creek's reason,
    message and resource list are Creek's own prose and this app renders only copy
    it has reviewed itself.
    """
    fake_vault = ReflectingVaultClient(reflect_error=_creek_escalation())
    _fake_cloud_llm(monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE})
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, "vault_read_escalate")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    care = body["care"]
    payload = build_care_payload()
    assert care is not None
    assert care["message"] == payload.message
    assert [(item["kind"], item["name"], item["contact"]) for item in care["resources"]] == [
        (resource.kind, resource.name, resource.contact) for resource in payload.resources
    ]
    assert body["marginalia"] == []
    assert _CLOUD_NOTE not in resp.text
    for text in _care_texts():
        assert text in resp.text
    for text in _creek_care_texts():
        assert text not in resp.text


@pytest.mark.asyncio
async def test_vault_escalation_never_charges_the_wallet(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The staged deduction is rolled back, so an escalation costs the writer nothing.

    The pre-flight deduction is staged before the reflection runs, so an
    escalation that returned without rolling back would charge a person in acute
    distress for a reflection they never received.
    """
    fake_vault = ReflectingVaultClient(reflect_error=_creek_escalation())
    _fake_cloud_llm(monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE})
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, "vault_read_escalate_wallet")
    entry_id = await _create_entry(async_client, headers)
    before = await _read_user(db_session, "vault_read_escalate_wallet@example.com")
    used_before = before.monthly_messages_used
    balance_before = before.offering_balance

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    after = await _read_user(db_session, "vault_read_escalate_wallet@example.com")
    assert after.monthly_messages_used == used_before
    assert after.offering_balance == balance_before
    assert body["remaining_messages"] == get_monthly_cap() - used_before
    persisted = (
        await db_session.execute(select(func.count()).select_from(Marginalia))
    ).scalar_one()
    assert persisted == 0


@pytest.mark.asyncio
async def test_vault_escalation_is_not_swallowed_as_a_provider_error(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No intermediate layer intercepts the escalation and reports it as a bad gateway.

    The marginalia wrapper catches only ``LLMProviderError`` and the care wrapper
    only ``HTTPException``, so an escalation that surfaced as a 502 would mean one
    of them had widened -- and a person in acute distress would get an error page
    instead of a way to reach a human.
    """
    fake_vault = ReflectingVaultClient(reflect_error=_creek_escalation())
    _fake_cloud_llm(monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE})
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, "vault_read_escalate_not502")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code != HTTPStatus.BAD_GATEWAY
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["care"] is not None
