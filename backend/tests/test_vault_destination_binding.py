"""A withdrawal counts only when the vault that received the copy confirms it (#3060).

Reconnecting replaces the stored vault URL in place, and a fresh vault answers
"unknown id, withdrawn" for an id it never saw. Before destination binding that
answer cleared ``vault_ref`` while the old vault still held the plaintext copy.
These tests pin the binding for the journal copy and for mirrored essays.
"""

from __future__ import annotations

import logging
from datetime import datetime
from http import HTTPStatus
from typing import Annotated

import pytest
from fastapi import Depends
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies import creek_vault as creek_vault_dependency
from dependencies.creek_vault import (
    get_creek_vault_client,
    resolve_creek_vault_client,
    resolved_vault_destination,
    vault_destination_fingerprint,
)
from domain.creek_vault import (
    CreekCapability,
    CreekVaultClient,
    CreekVaultUnavailableError,
    VaultIngestRequest,
    VaultIngestResult,
    VaultSendSuspendedError,
    VaultTierCeiling,
    VaultVoiceDraftDeleteResult,
)
from main import app
from models.journal_entry import VAULT_DESTINATION_WIDTH, JournalEntry
from models.journal_withdrawal_obligation import JournalWithdrawalObligation
from models.marginalia import Marginalia, MarginaliaKind
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from routers import journal as journal_router
from routers.auth import get_current_user
from services import creek_vault_withdraw as withdraw_module
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_voice_drafts import record_mirror_intent
from services.creek_vault_write import VaultWriteOutcome
from services.privacy_suspension import VAULT_SEND_SUSPEND_ENV_VAR, vault_send_suspended
from services.user_vault_config import clear_vault_config, store_vault_config
from tests.incident.test_privacy_suspension import (
    _VaultRecorder,
    handshaken_vault,
    suspend_vault,
)
from tests.test_journal_vault_write import SequencedVaultClient

_PASSWORD = "secret12345"  # pragma: allowlist secret
_VAULT_A = "https://vault-a.example.com"
_VAULT_B = "https://vault-b.example.com"
_KEY_A = "key-a-0123456789"  # pragma: allowlist secret
_KEY_B = "key-b-0123456789"  # pragma: allowlist secret
# A copy owed to a vault other than the connected one answers with where it is
# (#3094): the vault connected before, or the one disconnected.
_PREVIOUS_DETAIL = {"detail": "vault_withdrawal_previous_vault"}
_DISCONNECTED_DETAIL = {"detail": "vault_withdrawal_disconnected_vault"}


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

    assert (status, body) == (HTTPStatus.SERVICE_UNAVAILABLE, _PREVIOUS_DETAIL)
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
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Removing the connection is not proof the old vault let go (escalation 5).

    The request resolves the local fallback, as the app does with no vault
    connected, so the spy sits at the one place every withdrawal dial passes
    through, ``withdraw_journal_from_vault``: nothing may reach it.
    """
    headers, user_id = await _signup(async_client, "dest_journal_disconnect")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_public_entry(async_client, headers)
    dialled = _spy_on_withdrawal_dials(monkeypatch)

    await clear_vault_config(db_session, user_id)
    app.dependency_overrides[get_creek_vault_client] = LocalFallbackCreekVaultClient
    status, body = await _patch_intimate(async_client, entry_id, headers)

    assert (status, body) == (HTTPStatus.SERVICE_UNAVAILABLE, _DISCONNECTED_DETAIL)
    assert dialled == []
    assert (await _entry(db_session, entry_id)).vault_ref == "vault-ref-1"


@pytest.mark.asyncio
async def test_a_dialable_client_with_no_recorded_connection_never_dials_the_old_copy(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A client that could dial, but no stored connection: the copy is still A's, never asked."""
    headers, user_id = await _signup(async_client, "dest_journal_dialable")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_public_entry(async_client, headers)

    await clear_vault_config(db_session, user_id)
    status, body = await _patch_intimate(async_client, entry_id, headers)

    assert (status, body) == (HTTPStatus.SERVICE_UNAVAILABLE, _PREVIOUS_DETAIL)
    assert vault.withdraw_calls == []
    assert (await _entry(db_session, entry_id)).vault_ref == "vault-ref-1"


def _spy_on_withdrawal_dials(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Record every journal withdrawal that reaches the dial, whatever the client."""
    dialled: list[int] = []
    real = withdraw_module.withdraw_journal_from_vault

    async def _recording(client: CreekVaultClient, *, entry_id: int) -> bool:
        dialled.append(entry_id)
        return await real(client, entry_id=entry_id)

    monkeypatch.setattr(withdraw_module, "withdraw_journal_from_vault", _recording)
    return dialled


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

    assert (status, body) == (HTTPStatus.SERVICE_UNAVAILABLE, _PREVIOUS_DETAIL)
    assert vault.draft_deletes == []
    result = await db_session.execute(
        select(VoiceDraftRetraction).where(col(VoiceDraftRetraction.marginalia_id) == note_id)
    )
    obligation = result.scalar_one()
    await db_session.refresh(obligation)
    assert obligation.state == VoiceDraftRetractionState.PENDING
    assert obligation.safe_failure_code == "destination_changed"
    assert obligation.destination == destination_a


async def _create_intimate_entry(client: AsyncClient, headers: dict[str, str]) -> int:
    created = await client.post(
        "/journal/",
        json={"message": "A private confession.", "classification": "intimate"},
        headers=headers,
    )
    assert created.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}, created.text
    return int(created.json()["id"])


@pytest.mark.asyncio
async def test_never_sent_intimate_entry_is_unbound_and_deletes_after_disconnect(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An Intimate page that never left the server owes no vault anything."""
    headers, user_id = await _signup(async_client, "dest_intimate_disconnect")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_intimate_entry(async_client, headers)

    assert vault.ingest_calls == []
    assert (await _entry(db_session, entry_id)).vault_destination is None

    await clear_vault_config(db_session, user_id)
    deleted = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert deleted.status_code == HTTPStatus.NO_CONTENT
    assert vault.withdraw_calls == []


@pytest.mark.asyncio
async def test_never_sent_intimate_entry_deletes_on_a_vault_without_withdraw(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault that cannot withdraw is never asked to, for a page it never received."""
    headers, user_id = await _signup(async_client, "dest_intimate_no_withdraw")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    vault = SequencedVaultClient(capabilities=frozenset({CreekCapability.JOURNAL}))
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_intimate_entry(async_client, headers)

    deleted = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert deleted.status_code == HTTPStatus.NO_CONTENT
    assert vault.withdraw_calls == []


@pytest.mark.asyncio
async def test_never_sent_intimate_entry_edits_while_the_vault_is_offline(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Autosave and Finish on an Intimate page never depend on a vault being reachable."""
    headers, user_id = await _signup(async_client, "dest_intimate_offline_edit")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_intimate_entry(async_client, headers)
    vault.handshake_error = CreekVaultUnavailableError("offline")

    edited = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "A revised confession."}, headers=headers
    )
    finished = await async_client.patch(
        f"/journal/{entry_id}",
        json={"message": "A revised confession.", "status": "finished"},
        headers=headers,
    )

    assert edited.status_code == HTTPStatus.OK
    assert finished.status_code == HTTPStatus.OK
    assert vault.withdraw_calls == []


@pytest.mark.asyncio
async def test_an_entry_the_vault_never_received_is_left_unbound(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A write the handshake turned away dialled no ingest, so it binds no destination."""
    headers, user_id = await _signup(async_client, "dest_unavailable_write")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    # A vault that does not ingest journals: the handshake turns the write away.
    vault = SequencedVaultClient(capabilities=frozenset({CreekCapability.JOURNAL_WITHDRAW}))
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_public_entry(async_client, headers)

    assert vault.ingest_calls == []
    assert (await _entry(db_session, entry_id)).vault_destination is None

    await clear_vault_config(db_session, user_id)
    deleted = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert deleted.status_code == HTTPStatus.NO_CONTENT


@pytest.mark.asyncio
async def test_reconnected_vault_never_confirms_old_copy_on_delete(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """DELETE after a reconnect stays pending, names destination_changed, and dials nobody.

    Escalation 5 (#3060): the old vault still holds the copy and no stored
    credential reaches it. Owner decision (#3094): the 503 names the previous
    vault so the writer can reconnect it first, or take the erase-locally
    path (pinned in ``test_journal_unreachable_vault.py``).
    """
    headers, user_id = await _signup(async_client, "dest_delete_swap")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_public_entry(async_client, headers)
    destination_a = await vault_destination_fingerprint(db_session, user_id)

    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    caplog.set_level(logging.WARNING)
    deleted = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert deleted.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert deleted.json() == _PREVIOUS_DETAIL
    assert vault.withdraw_calls == []
    row = await _entry(db_session, entry_id)
    assert row.deleted_at is None
    assert row.vault_ref == "vault-ref-1"
    assert row.vault_destination == destination_a
    assert any(
        getattr(record, "reason", None) == "destination_changed" for record in caplog.records
    )


@pytest.mark.asyncio
async def test_legacy_unbound_marker_is_withdrawn_from_the_current_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Known pre-migration limit: a NULL-destination ref still trusts whichever vault is connected.

    Rows ingested before destination binding carry no fingerprint, so there is
    nothing to compare. Pinned so that closing this (#3060 finding 13) is a
    deliberate change rather than an accident.
    """
    headers, user_id = await _signup(async_client, "dest_legacy_unbound")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    entry = JournalEntry(
        sender="user", user_id=user_id, message="A legacy page.", vault_ref="legacy-ref"
    )
    db_session.add(entry)
    await db_session.commit()
    assert entry.id is not None
    entry_id = entry.id
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault

    status, _body = await _patch_intimate(async_client, entry_id, headers)

    assert status == HTTPStatus.OK
    assert vault.withdraw_calls == [entry_id]


@pytest.mark.asyncio
async def test_intimate_create_never_stages_a_destination_even_transiently(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No destination is committed before the (skipped) write, so a crash there owes nothing."""
    headers, user_id = await _signup(async_client, "dest_intimate_transient")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    staged: list[str | None] = []
    real_store = journal_router.store_and_classify

    async def _observing_store(
        client: CreekVaultClient,
        *,
        entry_id: int,
        body: str,
        classification: str,
        created_at: datetime,
    ) -> VaultWriteOutcome:
        staged.append((await _entry(db_session, entry_id)).vault_destination)
        return await real_store(
            client,
            entry_id=entry_id,
            body=body,
            classification=classification,
            created_at=created_at,
        )

    monkeypatch.setattr(journal_router, "store_and_classify", _observing_store)
    await _create_intimate_entry(async_client, headers)

    assert staged == [None]


@pytest.mark.parametrize("lost_ack", [False, True], ids=["ingested", "ack_lost"])
@pytest.mark.asyncio
async def test_offline_edit_of_a_sent_entry_keeps_its_withdrawal_marker(
    async_client: AsyncClient, db_session: AsyncSession, *, lost_ack: bool
) -> None:
    """An edit the vault turns away never erases the marker of a copy it already holds."""
    headers, user_id = await _signup(async_client, f"dest_offline_edit_{lost_ack}")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    destination_a = await vault_destination_fingerprint(db_session, user_id)
    first = _AckLostVault(db_session) if lost_ack else SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: first
    entry_id = await _create_public_entry(async_client, headers)
    assert (await _entry(db_session, entry_id)).vault_destination == destination_a

    offline = SequencedVaultClient(capabilities=frozenset({CreekCapability.JOURNAL_WITHDRAW}))
    app.dependency_overrides[get_creek_vault_client] = lambda: offline
    edited = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "An edit while A is away."}, headers=headers
    )

    assert edited.status_code == HTTPStatus.OK
    assert offline.ingest_calls == []
    assert (await _entry(db_session, entry_id)).vault_destination == destination_a

    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    deleted = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert deleted.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert offline.withdraw_calls == []
    assert first.withdraw_calls == []


@pytest.fixture
def dialable_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Judge every stored host dialable without a DNS lookup (no dial ever happens here)."""

    async def _never_undialable(_session: AsyncSession, _vault_url: str) -> bool:
        return False

    monkeypatch.setattr(creek_vault_dependency, "_stored_host_is_undialable", _never_undialable)


@pytest.mark.asyncio
@pytest.mark.usefixtures("dialable_hosts")
async def test_destination_comes_from_the_same_read_as_the_client(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A reconnect after the client was resolved cannot rebind the write to the new vault."""
    headers, user_id = await _signup(async_client, "dest_same_read")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    destination_a = await vault_destination_fingerprint(db_session, user_id)
    vault = SequencedVaultClient()

    async def _resolve_then_reconnect(
        current_user: Annotated[int, Depends(get_current_user)],
        session: Annotated[AsyncSession, Depends(get_session)],
    ) -> CreekVaultClient:
        await resolve_creek_vault_client(session, current_user)
        await store_vault_config(session, current_user, vault_url=_VAULT_B, api_key=_KEY_B)
        return vault

    app.dependency_overrides[get_creek_vault_client] = _resolve_then_reconnect
    entry_id = await _create_public_entry(async_client, headers)

    assert (await _entry(db_session, entry_id)).vault_destination == destination_a


@pytest.mark.asyncio
@pytest.mark.usefixtures("dialable_hosts")
async def test_resolved_destination_is_scoped_to_the_resolved_account(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The captured fingerprint answers only for the account it was read for."""
    _headers_a, first_user = await _signup(async_client, "dest_scope_first")
    _headers_b, second_user = await _signup(async_client, "dest_scope_second")
    await store_vault_config(db_session, first_user, vault_url=_VAULT_A, api_key=_KEY_A)
    await store_vault_config(db_session, second_user, vault_url=_VAULT_B, api_key=_KEY_B)
    first_a = await vault_destination_fingerprint(db_session, first_user)

    await resolve_creek_vault_client(db_session, first_user)
    await store_vault_config(db_session, first_user, vault_url=_VAULT_B, api_key=_KEY_B)

    assert await resolved_vault_destination(db_session, first_user) == first_a
    assert await resolved_vault_destination(
        db_session, second_user
    ) == await vault_destination_fingerprint(db_session, second_user)


async def _obligations(session: AsyncSession, entry_id: int) -> list[JournalWithdrawalObligation]:
    result = await session.execute(
        select(JournalWithdrawalObligation).where(
            col(JournalWithdrawalObligation.journal_entry_id) == entry_id
        )
    )
    rows = list(result.scalars().all())
    await session.commit()
    return rows


@pytest.mark.parametrize(
    ("ingest_error", "sent"),
    [
        pytest.param(VaultSendSuspendedError(), False, id="suspended"),
        pytest.param(CreekVaultUnavailableError("synthetic lost answer"), True, id="degraded"),
    ],
)
@pytest.mark.asyncio
async def test_only_a_send_that_may_have_left_binds_a_withdrawal(
    async_client: AsyncClient,
    db_session: AsyncSession,
    ingest_error: Exception,
    *,
    sent: bool,
) -> None:
    """An operator-suspended send owes nothing; a degraded one still owes its withdrawal (#3107).

    The suspension is refused at the adapter before the wire, so the staged
    destination is dropped and a later deletion -- even with the vault gone --
    completes at once with no obligation. A genuinely degraded send may have
    landed, so it keeps its marker and its deletion stays owed.
    """
    headers, user_id = await _signup(async_client, f"dest_suspended_{sent}")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    destination_a = await vault_destination_fingerprint(db_session, user_id)
    vault = SequencedVaultClient(ingest_error=ingest_error)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_public_entry(async_client, headers)

    assert len(vault.ingest_calls) == 1
    bound = (await _entry(db_session, entry_id)).vault_destination
    assert bound == (destination_a if sent else None)

    await clear_vault_config(db_session, user_id)
    deleted = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert vault.withdraw_calls == []
    if sent:
        assert deleted.status_code == HTTPStatus.SERVICE_UNAVAILABLE
        assert [row.destination for row in await _obligations(db_session, entry_id)] == [
            destination_a
        ]
    else:
        assert deleted.status_code == HTTPStatus.NO_CONTENT
        assert await _obligations(db_session, entry_id) == []


@pytest.mark.asyncio
async def test_a_suspended_send_binds_nothing_until_resumed(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Through the real adapter: no PUT and no binding under the switch; the next real send binds.

    The destination is still staged before the dial (so a lost answer after
    resume stays withdrawable); it is only dropped when the adapter proves
    the suspended dial never left.
    """
    headers, user_id = await _signup(async_client, "dest_suspended_resumed")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    destination_a = await vault_destination_fingerprint(db_session, user_id)
    recorder = _VaultRecorder()
    vault = await handshaken_vault(recorder)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault

    suspend_vault(monkeypatch)
    entry_id = await _create_public_entry(async_client, headers)

    assert "PUT" not in recorder.methods()
    assert (await _entry(db_session, entry_id)).vault_destination is None

    monkeypatch.delenv(VAULT_SEND_SUSPEND_ENV_VAR)
    edited = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "Written after the switch."}, headers=headers
    )

    assert edited.status_code == HTTPStatus.OK
    assert recorder.methods().count("PUT") == 1
    assert (await _entry(db_session, entry_id)).vault_destination == destination_a


class _SwitchAwareVault(SequencedVaultClient):
    """Stores like a real vault, but refuses the ingest the way the adapter does under the switch.

    The adapter's request site checks ``vault_send_suspended()`` before the
    wire; this double does the same, so ``ingest_calls`` holds only sends that
    actually left.
    """

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        if vault_send_suspended():
            raise VaultSendSuspendedError
        return await super().ingest(request)


@pytest.mark.asyncio
async def test_a_suspended_edit_of_a_sent_entry_keeps_owing_its_copy(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A copy that really reached the vault is still owed after a suspended edit (#3107).

    Only the binding *this* write staged may be dropped on SUSPENDED; the
    marker and ref of an earlier, real send survive, and its deletion stays
    owed to the vault that holds it.
    """
    monkeypatch.delenv(VAULT_SEND_SUSPEND_ENV_VAR, raising=False)
    headers, user_id = await _signup(async_client, "dest_suspended_bound")
    await store_vault_config(db_session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    destination_a = await vault_destination_fingerprint(db_session, user_id)
    vault = _SwitchAwareVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    entry_id = await _create_public_entry(async_client, headers)

    sent = await _entry(db_session, entry_id)
    assert len(vault.ingest_calls) == 1
    assert sent.vault_destination == destination_a
    assert sent.vault_ref == "vault-ref-1"

    suspend_vault(monkeypatch)
    edited = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "Edited under the switch."}, headers=headers
    )

    assert edited.status_code == HTTPStatus.OK
    assert len(vault.ingest_calls) == 1, "the suspended edit must not send"
    kept = await _entry(db_session, entry_id)
    assert kept.vault_destination == destination_a
    assert kept.vault_ref == "vault-ref-1"

    await clear_vault_config(db_session, user_id)
    deleted = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert deleted.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert vault.withdraw_calls == []
    assert [row.destination for row in await _obligations(db_session, entry_id)] == [destination_a]
