"""A withdrawal counts only when the vault that received the copy confirms it (#3060).

Reconnecting replaces the stored vault URL in place, and a fresh vault answers
"unknown id, withdrawn" for an id it never saw. Before destination binding that
answer cleared ``vault_ref`` while the old vault still held the plaintext copy.
These tests pin the binding for the journal copy and for mirrored essays.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client, vault_destination_fingerprint
from domain.creek_vault import (
    CreekCapability,
    CreekVaultUnavailableError,
    VaultIngestRequest,
    VaultIngestResult,
    VaultTierCeiling,
    VaultVoiceDraftDeleteResult,
)
from main import app
from models.journal_entry import VAULT_DESTINATION_WIDTH, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from services.creek_vault_voice_drafts import record_mirror_intent
from services.user_vault_config import clear_vault_config, store_vault_config
from tests.test_journal_vault_write import SequencedVaultClient

_PASSWORD = "secret12345"  # pragma: allowlist secret
_VAULT_A = "https://vault-a.example.com"
_VAULT_B = "https://vault-b.example.com"
_KEY_A = "key-a-0123456789"  # pragma: allowlist secret
_KEY_B = "key-b-0123456789"  # pragma: allowlist secret
_PENDING_DETAIL = {"detail": "vault_withdrawal_pending"}


class _DraftAwareVault(SequencedVaultClient):
    """A journal vault that also advertises Voice Drafts and records DELETEs."""

    def __init__(self) -> None:
        super().__init__(
            capabilities=frozenset(
                {
                    CreekCapability.JOURNAL,
                    CreekCapability.JOURNAL_WITHDRAW,
                    CreekCapability.VOICE_DRAFTS,
                }
            )
        )
        self.draft_deletes: list[str] = []

    async def delete_voice_draft(
        self, external_id: str, _tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        """Answer every DELETE "deleted", as a fresh vault does for an id it never saw."""
        self.draft_deletes.append(external_id)
        return VaultVoiceDraftDeleteResult(deleted=True)


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    response = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _PASSWORD},
    )
    assert response.status_code == HTTPStatus.OK
    payload = response.json()
    return {"Authorization": f"Bearer {payload['token']}"}, int(payload["user_id"])


async def _entry(session: AsyncSession, entry_id: int) -> JournalEntry:
    result = await session.execute(
        select(JournalEntry)
        .where(col(JournalEntry.id) == entry_id)
        .execution_options(populate_existing=True)
    )
    entry = result.scalar_one()
    await session.commit()
    return entry


async def _create_public_entry(client: AsyncClient, headers: dict[str, str]) -> int:
    created = await client.post(
        "/journal/",
        json={"message": "A shareable reflection.", "classification": "public"},
        headers=headers,
    )
    assert created.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}, created.text
    return int(created.json()["id"])


async def _patch_intimate(
    client: AsyncClient, entry_id: int, headers: dict[str, str]
) -> tuple[int, object]:
    response = await client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )
    return response.status_code, response.json()


@pytest.mark.asyncio
async def test_fingerprint_is_opaque_normalized_and_key_free(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Same vault spelled differently, or a rotated key, is the same destination."""
    _headers, user_id = await _signup(async_client, "dest_fingerprint")
    assert await vault_destination_fingerprint(db_session, user_id) is None

    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    first = await vault_destination_fingerprint(db_session, user_id)
    await store_vault_config(
        db_session, user_id, vault_url="HTTPS://Vault-A.example.com/", api_key=_KEY_B
    )
    respelled = await vault_destination_fingerprint(db_session, user_id)
    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_A)
    other = await vault_destination_fingerprint(db_session, user_id)

    assert first is not None
    assert first == respelled
    assert other not in {None, first}
    assert len(first) == len(other or "") == VAULT_DESTINATION_WIDTH
    assert "vault-a" not in first
    assert _KEY_A not in first


@pytest.mark.asyncio
async def test_reconnected_vault_never_confirms_old_journal_copy(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Vault B's "withdrawn" is never trusted for a copy vault A holds."""
    headers, user_id = await _signup(async_client, "dest_journal_swap")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_public_entry(async_client, headers)
    ingested = await _entry(db_session, entry_id)
    destination_a = await vault_destination_fingerprint(db_session, user_id)
    assert ingested.vault_ref == "vault-ref-1"
    assert ingested.vault_destination == destination_a

    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    status, body = await _patch_intimate(async_client, entry_id, headers)

    assert (status, body) == (HTTPStatus.SERVICE_UNAVAILABLE, _PENDING_DETAIL)
    assert vault.withdraw_calls == [], "a different vault must never be asked to confirm"
    pending = await _entry(db_session, entry_id)
    assert pending.classification == "intimate"
    assert pending.vault_ref == "vault-ref-1"
    assert pending.vault_destination == destination_a

    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    status, _body = await _patch_intimate(async_client, entry_id, headers)

    assert status == HTTPStatus.OK
    assert vault.withdraw_calls == [entry_id]
    withdrawn = await _entry(db_session, entry_id)
    assert withdrawn.vault_ref is None
    assert withdrawn.vault_destination is None


@pytest.mark.asyncio
async def test_disconnected_vault_keeps_the_copy_pending(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Removing the connection is not proof the old vault let go (escalation 5)."""
    headers, user_id = await _signup(async_client, "dest_journal_disconnect")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_public_entry(async_client, headers)

    await clear_vault_config(db_session, user_id)
    status, body = await _patch_intimate(async_client, entry_id, headers)

    assert (status, body) == (HTTPStatus.SERVICE_UNAVAILABLE, _PENDING_DETAIL)
    assert vault.withdraw_calls == []
    assert (await _entry(db_session, entry_id)).vault_ref == "vault-ref-1"


@pytest.mark.asyncio
async def test_edit_after_reconnect_never_overwrites_the_owed_marker(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A body edit under vault B is not sent there while vault A's copy is still owed."""
    headers, user_id = await _signup(async_client, "dest_edit_after_swap")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_public_entry(async_client, headers)
    destination_a = await vault_destination_fingerprint(db_session, user_id)

    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    edited = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "A revised reflection."}, headers=headers
    )

    assert edited.status_code == HTTPStatus.OK
    assert len(vault.ingest_calls) == 1, "the edit must not create an untracked copy in vault B"
    row = await _entry(db_session, entry_id)
    assert row.vault_destination == destination_a
    assert row.vault_ref == "vault-ref-1"


class _AckLostVault(SequencedVaultClient):
    """Observe the committed destination at ingest time, then lose the acknowledgement."""

    def __init__(self, session: AsyncSession) -> None:
        super().__init__()
        self.session = session
        self.destination_at_ingest: list[str | None] = []

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        assert not self.session.in_transaction(), "ingest held a pooled DB connection"
        row = await _entry(self.session, request.entry_id)
        self.destination_at_ingest.append(row.vault_destination)
        self.ingest_calls.append(request)
        raise CreekVaultUnavailableError("synthetic lost acknowledgement")


@pytest.mark.asyncio
async def test_ingest_ack_lost_still_leaves_a_withdrawal_marker(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The destination is committed before the dial, so a lost ack is still withdrawn."""
    headers, user_id = await _signup(async_client, "dest_ack_lost")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    destination_a = await vault_destination_fingerprint(db_session, user_id)
    vault = _AckLostVault(db_session)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_public_entry(async_client, headers)

    assert vault.destination_at_ingest == [destination_a]
    lost = await _entry(db_session, entry_id)
    assert lost.vault_ref is None
    assert lost.vault_destination == destination_a

    status, _body = await _patch_intimate(async_client, entry_id, headers)

    assert status == HTTPStatus.OK
    assert vault.withdraw_calls == [entry_id]
    reconciled = await _entry(db_session, entry_id)
    assert reconciled.vault_destination is None


@pytest.mark.asyncio
async def test_reconnected_vault_never_confirms_old_essay(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An essay mirrored to vault A stays owed when vault B answers "deleted"."""
    headers, user_id = await _signup(async_client, "dest_essay_swap")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    destination_a = await vault_destination_fingerprint(db_session, user_id)
    entry = JournalEntry(sender="user", user_id=user_id, message="A beginning.")
    db_session.add(entry)
    await db_session.flush()
    assert entry.id is not None
    entry_id = entry.id
    note = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=1,
        anchor_text="A",
        note="A note.",
    )
    db_session.add(note)
    await db_session.commit()
    assert note.id is not None
    note_id = note.id
    assert await record_mirror_intent(
        db_session,
        user_id=user_id,
        entry_id=entry_id,
        marginalia_id=note_id,
        destination=destination_a,
    )
    vault = _DraftAwareVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault

    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    status, body = await _patch_intimate(async_client, entry_id, headers)

    assert (status, body) == (HTTPStatus.SERVICE_UNAVAILABLE, _PENDING_DETAIL)
    assert vault.draft_deletes == []
    result = await db_session.execute(
        select(VoiceDraftRetraction).where(col(VoiceDraftRetraction.marginalia_id) == note_id)
    )
    obligation = result.scalar_one()
    await db_session.refresh(obligation)
    assert obligation.state == VoiceDraftRetractionState.PENDING
    assert obligation.safe_failure_code == "destination_changed"
    assert obligation.destination == destination_a
