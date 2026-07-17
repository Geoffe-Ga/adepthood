"""Integration tests wiring the journal router to the Creek Vault write path.

RED: the create/update journal endpoints do not yet call
``services.creek_vault_write.store_and_classify`` and ``JournalEntry`` does not
yet carry ``vault_ref`` / ``vault_tags`` columns, so every test here fails
until both are implemented.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

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
from models.journal_entry import JournalEntry
from services.creek_vault_write import get_creek_vault_client

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Sign up a fresh user and return an Authorization header for it."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _entry_row(db_session: AsyncSession, entry_id: int) -> JournalEntry:
    """Fetch the persisted JournalEntry row by id."""
    result = await db_session.execute(select(JournalEntry).where(col(JournalEntry.id) == entry_id))
    return result.scalar_one()


class SequencedVaultClient:
    """Fake CreekVaultClient: available, ingests successfully, refs increment per call."""

    def __init__(
        self,
        *,
        capabilities: frozenset[CreekCapability] = frozenset(
            {CreekCapability.INGEST, CreekCapability.CLASSIFY}
        ),
        ingest_error: Exception | None = None,
    ) -> None:
        """Store the advertised capabilities and any scripted ingest failure."""
        self.ingest_calls: list[VaultIngestRequest] = []
        self._capabilities = capabilities
        self._ingest_error = ingest_error

    async def handshake(self) -> HandshakeResult:
        """Report available with the configured capability set."""
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Always report available -- this fake never degrades on handshake."""
        return True

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether ``capability`` is in the configured capability set."""
        return capability in self._capabilities

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Record the request, then raise or return an incrementing vault ref."""
        self.ingest_calls.append(request)
        if self._ingest_error is not None:
            raise self._ingest_error
        return VaultIngestResult(stored=True, vault_ref=f"vault-ref-{len(self.ingest_calls)}")

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Return a fixed classification tag set."""
        return VaultClassification(tags=("courage",))

    async def reflect(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> str:
        """Return an empty reflection (unused by the write path)."""
        return ""

    async def wheel(self) -> VaultWheelBalance:
        """Return an empty wheel balance (unused by the write path)."""
        return VaultWheelBalance(aspects=())


@pytest.mark.asyncio
async def test_create_non_intimate_entry_persists_vault_ref_and_tags(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A non-intimate create with an available, classifying vault persists ref + tags."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_create")

    resp = await async_client.post(
        "/journal/",
        json={"message": "A public reflection.", "classification": "public"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.vault_ref == "vault-ref-1"
    assert row.vault_tags == ["courage"]


@pytest.mark.asyncio
async def test_create_intimate_entry_never_touches_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An intimate create leaves vault_ref/vault_tags unset and never calls the vault."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_intimate")

    resp = await async_client.post(
        "/journal/",
        json={"message": "A private confession.", "classification": "intimate"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.vault_ref is None
    assert row.vault_tags is None
    assert fake.ingest_calls == []


@pytest.mark.asyncio
async def test_create_degrades_gracefully_when_ingest_raises(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault ingest failure never blocks the write -- the entry still saves, unrefed."""
    fake = SequencedVaultClient(
        ingest_error=CreekVaultUnavailableError("creek vault call failed: creek.ingest")
    )
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_degrade")

    resp = await async_client.post(
        "/journal/",
        json={"message": "Written while the vault is down.", "classification": "personal"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.vault_ref is None


@pytest.mark.asyncio
async def test_create_with_default_provider_and_no_vault_configured_behaves_as_today(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no dependency override and no CREEK_VAULT_URL, the write path is a no-op."""
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    headers = await _signup(async_client, "vault_unconfigured")

    resp = await async_client.post(
        "/journal/",
        json={"message": "Ordinary entry, no vault configured.", "classification": "personal"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.vault_ref is None


@pytest.mark.asyncio
async def test_patch_message_edit_reingests_and_updates_vault_ref(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Editing the body re-ingests and the persisted vault_ref advances to the new ref."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_patch_body")

    created = await async_client.post(
        "/journal/",
        json={"message": "Original body.", "classification": "public"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    first_row = await _entry_row(db_session, entry_id)
    assert first_row.vault_ref == "vault-ref-1"

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "Revised body."}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK

    second_row = await _entry_row(db_session, entry_id)
    assert len(fake.ingest_calls) == 2
    assert second_row.vault_ref == "vault-ref-2"


@pytest.mark.asyncio
async def test_patch_title_only_does_not_reingest(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A title-only PATCH sends no body to the vault -- no second ingest call."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_patch_title")

    created = await async_client.post(
        "/journal/",
        json={"message": "Untouched body.", "classification": "public"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    assert len(fake.ingest_calls) == 1

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"title": "A new title"}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK
    assert len(fake.ingest_calls) == 1

    row = await _entry_row(db_session, entry_id)
    assert row.vault_ref == "vault-ref-1"


@pytest.mark.asyncio
async def test_patch_to_intimate_clears_prior_vault_ref_and_tags(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-classifying an ingested entry as intimate clears its ref/tags and re-sends nothing."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_to_intimate")

    created = await async_client.post(
        "/journal/",
        json={"message": "A shareable reflection.", "classification": "public"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    first_row = await _entry_row(db_session, entry_id)
    assert first_row.vault_ref == "vault-ref-1"
    assert first_row.vault_tags == ["courage"]

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK

    await db_session.refresh(first_row)
    assert len(fake.ingest_calls) == 1
    assert first_row.vault_ref is None
    assert first_row.vault_tags is None


@pytest.mark.asyncio
async def test_patch_from_intimate_to_personal_ingests(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-classifying an intimate entry as personal ingests it for the first time."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_from_intimate")

    created = await async_client.post(
        "/journal/",
        json={"message": "A private note, later shared.", "classification": "intimate"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    assert fake.ingest_calls == []

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "personal"}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK

    row = await _entry_row(db_session, entry_id)
    assert len(fake.ingest_calls) == 1
    assert row.vault_ref == "vault-ref-1"
