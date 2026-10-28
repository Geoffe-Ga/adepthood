"""Integration tests wiring the journal resonance endpoint to the Creek Vault read path.

The vault answers this router with a structured
:class:`~domain.creek_vault.VaultReflection` rather than a string, so the cases
below also pin the two outcomes that were previously indistinguishable from a
blank answer: a care escalation, which must reach the caller as adepthood's own
reviewed care surface rather than as a 502 or as Creek's copy, and an empty
reflection, which is a legitimate answer that settles as a refunded zero-note
pass.

Every case that connects a vault also binds the caller's boundary to it
(:func:`_bind_to_vault`), because that -- not the vault client's type -- is what
routes a pass to the vault (#3061). Under that boundary nothing here is ever
answered by the app provider: :func:`_fake_cloud_llm` records every call that
reaches it, and the vault cases assert it recorded none.
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

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.care import build_care_payload
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultCareEscalationError,
    CreekVaultUnavailableError,
    VaultPraxisKind,
    VaultPraxisStatus,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultRelatedEddy,
    VaultRelatedPraxis,
    VaultTierCeiling,
)
from domain.resonance import NO_NOTES_MESSAGES, NoNotesReason
from main import app
from models.marginalia import Marginalia
from models.user import User
from models.wallet_audit import REASON_REFUND_FAILED_RESONANCE, REASON_SPEND_MONTHLY, WalletAudit
from scripts.creek_contract_drift import BUNDLE_ROOT
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from services.creek_vault_client import HttpCreekVaultClient
from services.reflection_boundary import REFLECTION_SOURCE_UNAVAILABLE, ReflectionBoundary
from services.usage import get_monthly_cap
from tests.support.reflecting_vault import (
    DEFAULT_REFLECT_CAPABILITIES,
    ReflectingVaultClient,
    empty_reflection,
)

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


def _vault_reflection(
    *notes: VaultReflectionNote,
    related_praxis: tuple[VaultRelatedPraxis, ...] = (),
    related_eddies: tuple[VaultRelatedEddy, ...] = (),
) -> VaultReflection:
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
        related_praxis=related_praxis,
        related_eddies=related_eddies,
    )


# One compiled page of each kind, as a REFLECT-capable vault hands them back.
_VAULT_PRAXIS = VaultRelatedPraxis(
    title="Walking before the willow",
    praxis_type=VaultPraxisKind.PRACTICE,
    status=VaultPraxisStatus.ACTIVE,
    excerpt="The page's own opening lines, as the writer wrote them.",
)
_VAULT_EDDY = VaultRelatedEddy(
    title="Water and bending",
    description="A cluster the writer keeps returning to.",
    fragment_count=9,
    formed="2026-03-04",
)


def _fake_cloud_llm(monkeypatch: pytest.MonkeyPatch, *notes: dict[str, str]) -> list[str]:
    """Patch the app-provider resonance seam to return canned JSON notes; return its call log.

    Every prompt that reaches the app provider is appended to the returned list,
    so a vault-bound case can assert the list stayed empty.
    """
    payload = json.dumps({"notes": list(notes)})
    calls: list[str] = []

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del history, system_prompt, api_key
        calls.append(prompt)
        return LLMResponse(
            text=payload,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)
    return calls


def _bind_to_vault(fake_vault: object) -> None:
    """Serve ``fake_vault`` and bind the caller's AI operations to it (VAULT_BOUND)."""
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND


async def _assert_refunded(session: AsyncSession, email: str) -> None:
    """The committed deduction was compensated: wallet untouched, spend+refund audited."""
    await session.rollback()
    user = await _read_user(session, email)
    assert user.monthly_messages_used == 0
    reasons = (
        (
            await session.execute(
                select(col(WalletAudit.reason))
                .where(col(WalletAudit.user_id) == user.id)
                .order_by(col(WalletAudit.id))
            )
        )
        .scalars()
        .all()
    )
    assert list(reasons) == [REASON_SPEND_MONTHLY, REASON_REFUND_FAILED_RESONANCE]


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
        [capability.value for capability in DEFAULT_REFLECT_CAPABILITIES]
    )
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    yield HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http), handler
    await http.aclose()


def _creek_escalation() -> CreekVaultCareEscalationError:
    """Build the content-free escalation the adapter raises on Creek's 200 care handoff."""
    return CreekVaultCareEscalationError()


def _care_texts() -> tuple[str, ...]:
    """Return adepthood's own reviewed care copy: title, message, every resource field."""
    payload = build_care_payload()
    texts = [payload.title, payload.message]
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
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
    headers = await _signup(async_client, "vault_read_routes")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert len(body["marginalia"]) == 1
    assert body["marginalia"][0]["note"] == _VAULT_NOTE
    assert fake_vault.reflect_calls == [(_BODY, VaultTierCeiling.PERSONAL)]
    assert body["remaining_messages"] == get_monthly_cap() - 1
    assert cloud_calls == []


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
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
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
    assert cloud_calls == []


@pytest.mark.asyncio
async def test_distress_entry_gets_care_alone_and_reaches_no_model(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A vault-bound, distress-flagged entry gets care and no reflection from anyone.

    Not the vault -- on distress adepthood does not ask it -- and no longer the
    app provider in its place either (#3061): the care surface stands alone and
    the committed charge is refunded.
    """
    fake_vault = ReflectingVaultClient(reflect_result=_vault_reflection())
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": "kill myself", "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
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
    assert body["marginalia"] == []
    assert fake_vault.reflect_calls == []
    assert fake_vault.handshake_calls == handshakes_after_create
    assert cloud_calls == []
    await _assert_refunded(db_session, "vault_read_distress@example.com")


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
    _bind_to_vault(client)
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
        (False, DEFAULT_REFLECT_CAPABILITIES),
        (True, frozenset({CreekCapability.JOURNAL, CreekCapability.CLASSIFY})),
    ],
    ids=["handshake_unavailable", "reflect_unsupported"],
)
async def test_no_reflect_capability_fails_closed(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    available: bool,
    capabilities: frozenset[CreekCapability],
) -> None:
    """No usable vault, or no REFLECT support, is a refunded 503 -- never the app provider."""
    fake_vault = ReflectingVaultClient(available=available, capabilities=capabilities)
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
    headers = await _signup(async_client, f"vault_read_nocap_{available}_{len(capabilities)}")
    entry_id = await _create_entry(async_client, headers)
    # Entry creation already calls handshake() once via the vault write path;
    # the resonance pass should add exactly one more (its own probe), not zero.
    handshakes_after_create = fake_vault.handshake_calls

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert resp.json()["detail"] == REFLECTION_SOURCE_UNAVAILABLE
    assert fake_vault.handshake_calls == handshakes_after_create + 1
    assert fake_vault.reflect_calls == []
    assert cloud_calls == []
    await _assert_refunded(
        db_session, f"vault_read_nocap_{available}_{len(capabilities)}@example.com".lower()
    )


@pytest.mark.asyncio
async def test_mid_reflect_vault_failure_fails_closed(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A vault that advertises REFLECT but raises on the call is a refunded 503, not the cloud."""
    fake_vault = ReflectingVaultClient(
        reflect_error=CreekVaultUnavailableError("creek vault call failed: creek.reflect")
    )
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
    headers = await _signup(async_client, "vault_read_degrade")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert resp.json()["detail"] == REFLECTION_SOURCE_UNAVAILABLE
    assert len(fake_vault.reflect_calls) == 1
    assert cloud_calls == []
    persisted = (
        await db_session.execute(select(func.count()).select_from(Marginalia))
    ).scalar_one()
    assert persisted == 0
    await _assert_refunded(db_session, "vault_read_degrade@example.com")


@pytest.mark.asyncio
async def test_empty_vault_reflection_is_refunded_zero_notes(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A vault with nothing to say is a legitimate answer: zero notes, explained, uncharged.

    It is not an escalation, not a failure, and not a 502 -- and it is no longer
    handed to the cloud to answer instead (#3061). The pass settles like any
    pass that kept no notes: the server's own explanation and a refund.
    """
    fake_vault = ReflectingVaultClient(reflect_result=empty_reflection())
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
    headers = await _signup(async_client, "vault_read_empty")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["care"] is None
    assert body["marginalia"] == []
    assert body["no_notes_message"] == NO_NOTES_MESSAGES[NoNotesReason.NOTHING_TO_ADD]
    assert body["remaining_messages"] == get_monthly_cap()
    assert cloud_calls == []


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
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
    headers = await _signup(async_client, "vault_read_escalate")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    care = body["care"]
    payload = build_care_payload()
    assert care is not None
    assert care["title"] == payload.title
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
    assert cloud_calls == []


@pytest.mark.asyncio
async def test_vault_escalation_never_charges_the_wallet(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The committed deduction is refunded, so an escalation costs the writer nothing.

    The pre-flight deduction commits before the reflection runs, so an
    escalation that returned without the compensating credit would charge a
    person in acute distress for a reflection they never received.
    """
    fake_vault = ReflectingVaultClient(reflect_error=_creek_escalation())
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
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
    assert cloud_calls == []


@pytest.mark.asyncio
async def test_vault_escalation_refunds_the_committed_charge(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The escalation's uncharged promise is now kept by compensation, and audited.

    The deduction commits before the vault is dialled, so the escalation path
    cannot roll it back any more — it reverses the committed spend with a
    crediting entry instead, and the audit pair is what proves the promise was
    kept rather than the charge never landing.
    """
    fake_vault = ReflectingVaultClient(reflect_error=_creek_escalation())
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
    headers = await _signup(async_client, "vault_read_escalate_audit")
    entry_id = await _create_entry(async_client, headers)
    before = await _read_user(db_session, "vault_read_escalate_audit@example.com")
    used_before = before.monthly_messages_used
    balance_before = before.offering_balance

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    # Discard anything merely flushed on the shared test session: production's
    # get_session teardown rolls uncommitted work back, so the refund and its
    # audit row below must be durable to satisfy these assertions.
    await db_session.rollback()
    after = await _read_user(db_session, "vault_read_escalate_audit@example.com")
    assert after.monthly_messages_used == used_before
    assert after.offering_balance == balance_before
    audit_rows = (
        (
            await db_session.execute(
                select(WalletAudit)
                .where(col(WalletAudit.user_id) == after.id)
                .order_by(col(WalletAudit.id))
            )
        )
        .scalars()
        .all()
    )
    assert [row.reason for row in audit_rows] == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_FAILED_RESONANCE,
    ]
    assert cloud_calls == []


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
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
    headers = await _signup(async_client, "vault_read_escalate_not502")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code != HTTPStatus.BAD_GATEWAY
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["care"] is not None
    assert cloud_calls == []


@pytest.mark.asyncio
async def test_vault_related_pages_reach_the_resonance_response(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A vault's own praxis and eddies ride the pass that surfaced them, out to the client.

    They are the writer's own compiled pages, so they travel beside the vault's
    note rather than inside it: nothing about the marginalia changes, and the two
    collections arrive as their own published fields.
    """
    fake_vault = ReflectingVaultClient(
        reflect_result=_vault_reflection(
            VaultReflectionNote(kind="theme", quote=_VERBATIM_QUOTE, note=_VAULT_NOTE),
            related_praxis=(_VAULT_PRAXIS,),
            related_eddies=(_VAULT_EDDY,),
        )
    )
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
    headers = await _signup(async_client, "vault_read_related")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert [note["note"] for note in body["marginalia"]] == [_VAULT_NOTE]
    assert body["related_praxis"] == [
        {
            "title": _VAULT_PRAXIS.title,
            "praxis_type": _VAULT_PRAXIS.praxis_type.value,
            "status": _VAULT_PRAXIS.status.value,
            "excerpt": _VAULT_PRAXIS.excerpt,
        }
    ]
    assert body["related_eddies"] == [
        {
            "title": _VAULT_EDDY.title,
            "description": _VAULT_EDDY.description,
            "fragment_count": _VAULT_EDDY.fragment_count,
            "formed": _VAULT_EDDY.formed,
        }
    ]
    assert cloud_calls == []


@pytest.mark.asyncio
async def test_a_cloud_reflection_carries_no_related_pages(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only a vault knows about compiled pages, so a cloud pass publishes empty collections.

    Empty rather than absent: the fields are always present on the response, so a
    client never has to distinguish "this server does not send them" from "this
    pass surfaced none". Pinned to an app-provider-bound caller, the only one
    a cloud reflection is ever produced for.
    """
    fake_vault = ReflectingVaultClient(available=False, capabilities=frozenset())
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.APP_PROVIDER
    headers = await _signup(async_client, "vault_read_no_related")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert [note["note"] for note in body["marginalia"]] == [_CLOUD_NOTE]
    assert body["related_praxis"] == []
    assert body["related_eddies"] == []
    assert len(cloud_calls) == 1


@pytest.mark.asyncio
async def test_an_intimate_entry_publishes_empty_related_collections(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The privacy floor returns before any vault call, so it surfaces no pages either."""
    fake_vault = ReflectingVaultClient(
        reflect_result=_vault_reflection(
            VaultReflectionNote(kind="theme", quote=_VERBATIM_QUOTE, note=_VAULT_NOTE),
            related_praxis=(_VAULT_PRAXIS,),
            related_eddies=(_VAULT_EDDY,),
        )
    )
    cloud_calls = _fake_cloud_llm(
        monkeypatch, {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _CLOUD_NOTE}
    )
    _bind_to_vault(fake_vault)
    headers = await _signup(async_client, "vault_read_intimate_related")
    entry_id = await _create_entry(async_client, headers, classification="intimate")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["private"] is True
    assert body["related_praxis"] == []
    assert body["related_eddies"] == []
    assert fake_vault.reflect_calls == []
    assert cloud_calls == []
