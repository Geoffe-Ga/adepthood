"""Integration tests wiring the journal resonance endpoint to the Creek Vault read path.

RED: ``run_resonance`` does not yet resolve a reflection source via
``services.creek_vault_reflect.select_reflection_llm`` -- every resonance pass
always uses the cloud LLM regardless of a configured vault, so the
vault-routing assertions here fail until the router is wired.  Two cases
(distress, intimate) already hold today because those paths never touch the
vault client either way; they are kept as regression guards so a later wiring
change cannot accidentally route distress or intimate entries to the vault.
"""

from __future__ import annotations

import json
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultIngestRequest,
    VaultIngestResult,
    VaultTierCeiling,
    VaultWheelBalance,
)
from main import app
from models.marginalia import Marginalia
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
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


def _vault_reflect_json(*notes: dict[str, str]) -> str:
    """Build the strict-JSON reflection payload the vault's reflect() returns."""
    return json.dumps({"notes": list(notes)})


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
        reflect_result: str = "",
        reflect_error: Exception | None = None,
    ) -> None:
        """Store the scripted handshake outcome and reflect behavior."""
        self.ingest_calls: list[VaultIngestRequest] = []
        self.handshake_calls = 0
        self.reflect_calls: list[tuple[str, VaultTierCeiling]] = []
        self._available = available
        self._capabilities = capabilities
        self._reflect_result = reflect_result
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

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> str:
        """Record the call, then raise the scripted error or return the scripted text."""
        self.reflect_calls.append((body, tier_ceiling))
        if self._reflect_error is not None:
            raise self._reflect_error
        return self._reflect_result

    async def wheel(self) -> VaultWheelBalance:
        """Return an empty wheel balance (unused by the reflect path)."""
        return VaultWheelBalance(aspects=())


@pytest.mark.asyncio
async def test_vault_routes_reflection_when_available_and_supports_reflect(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A personal entry with a REFLECT-capable vault persists the vault's own note."""
    fake_vault = ReflectingVaultClient(
        reflect_result=_vault_reflect_json(
            {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _VAULT_NOTE}
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
        reflect_result=_vault_reflect_json(
            {"kind": "theme", "quote": _VERBATIM_QUOTE, "note": _VAULT_NOTE},
            {"kind": "symbol", "quote": _FABRICATED_QUOTE, "note": "should never persist"},
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
    fake_vault = ReflectingVaultClient(reflect_result=_vault_reflect_json())
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
async def test_intimate_entry_never_reaches_the_vault(async_client: AsyncClient) -> None:
    """An intimate entry never touches the vault reflect path either."""
    fake_vault = ReflectingVaultClient(reflect_result=_vault_reflect_json())
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    headers = await _signup(async_client, "vault_read_intimate")
    entry_id = await _create_entry(
        async_client, headers, body="A private confession.", classification="intimate"
    )

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["private"] is True
    assert body["marginalia"] == []
    assert fake_vault.reflect_calls == []
    assert fake_vault.handshake_calls == 0


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
