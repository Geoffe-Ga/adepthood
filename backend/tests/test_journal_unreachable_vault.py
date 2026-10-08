"""A writer whose old vault is out of reach can still finish deleting a page (#3094).

Owner decision (B04 escalation 5): reconnect first, then a local erase with an
UNCONFIRMED obligation and a plain tell. So a DELETE whose copy lives in a vault
other than the one connected now answers a 503 that says *which* vault -- the
one connected before, or the one disconnected -- in content-free terms; the
writer can reconnect it, or take ``POST /journal/{id}/erase-locally``, which
erases the page here, keeps a content-free ``unconfirmed`` obligation bound to
the old vault, and returns a receipt that never calls the copy withdrawn.
Reconnecting that vault later lets the sweep confirm and clear the obligation.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client, vault_destination_fingerprint
from domain.creek_vault import CreekVaultPipelineClient
from main import app
from models.journal_entry import JournalClassification, JournalEntry
from models.journal_withdrawal_obligation import (
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)
from services import journal_withdrawal_obligation as obligation_module
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_voice_drafts import (
    JournalRetrySchedule,
    resume_voice_draft_retractions,
)
from services.journal_withdrawal_obligation import (
    ERASED_UNCONFIRMED_EVENT,
    OBLIGATION_LOG_EXTRAS,
    OBLIGATION_TRANSITION_EVENT,
)
from services.user_vault_config import clear_vault_config, store_vault_config
from tests.test_voice_draft_retraction_recovery import _DraftVault as DraftVault

_PASSWORD = "secret12345"  # pragma: allowlist secret
_VAULT_A = "https://vault-a.example.com"
_VAULT_B = "https://vault-b.example.com"
_KEY_A = "key-a-0123456789"  # pragma: allowlist secret
_KEY_B = "key-b-0123456789"  # pragma: allowlist secret
_BODY = "SENTINEL_UNREACHABLE_BODY the old house by the water"
_TITLE = "SENTINEL_UNREACHABLE_TITLE"
_T0 = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)

_PREVIOUS = {"detail": "vault_withdrawal_previous_vault"}
_DISCONNECTED = {"detail": "vault_withdrawal_disconnected_vault"}

_STANDARD_RECORD_KEYS = frozenset(
    logging.LogRecord("n", logging.INFO, "p", 1, "m", None, None).__dict__
) | {"message", "asctime", "taskName", "trace_id"}


def _factory(session: AsyncSession) -> async_sessionmaker[AsyncSession]:
    assert session.bind is not None
    return async_sessionmaker(session.bind, class_=AsyncSession, expire_on_commit=False)


async def _sweep(
    session: AsyncSession, vault: CreekVaultPipelineClient, *, destination: str | None
) -> None:
    async def _client(_session: AsyncSession, _user_id: int) -> CreekVaultPipelineClient:
        return vault

    async def _destination(_session: AsyncSession, _user_id: int) -> str | None:
        return destination

    await resume_voice_draft_retractions(
        _factory(session), _client, _destination, now=_T0, journal_retries=JournalRetrySchedule()
    )


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


async def _obligation(session: AsyncSession, entry_id: int) -> JournalWithdrawalObligation | None:
    result = await session.execute(
        select(JournalWithdrawalObligation)
        .where(col(JournalWithdrawalObligation.journal_entry_id) == entry_id)
        .execution_options(populate_existing=True)
    )
    row = result.scalars().first()
    await session.commit()
    return row


async def _page_in_vault_a(
    client: AsyncClient, session: AsyncSession, username: str
) -> tuple[dict[str, str], int, int, str]:
    """A Personal page whose copy reached vault A; returns headers, user, entry and A's id."""
    headers, user_id = await _signup(client, username)
    await store_vault_config(session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    destination_a = await vault_destination_fingerprint(session, user_id)
    assert destination_a is not None
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=_BODY,
        title=_TITLE,
        classification=JournalClassification.PERSONAL,
        vault_ref="vault-ref-a",
        vault_destination=destination_a,
    )
    session.add(entry)
    await session.commit()
    assert entry.id is not None
    return headers, user_id, entry.id, destination_a


def _use(vault: DraftVault) -> DraftVault:
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    return vault


# --- 1. Reconnect first: the 503 says which vault holds the copy -------------


@pytest.mark.asyncio
async def test_delete_after_reconnect_names_the_previous_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Vault B is connected; the copy is in A. The 503 says so and dials nobody."""
    headers, user_id, entry_id, _a = await _page_in_vault_a(
        async_client, db_session, "unreach_previous"
    )
    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    vault = _use(DraftVault())

    response = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json() == _PREVIOUS
    assert vault.withdrawals == []
    assert (await _entry(db_session, entry_id)).deleted_at is None


@pytest.mark.asyncio
async def test_delete_after_disconnect_names_the_disconnected_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No vault is connected now; the copy is in the one that was."""
    headers, user_id, entry_id, _a = await _page_in_vault_a(
        async_client, db_session, "unreach_disconnected"
    )
    await clear_vault_config(db_session, user_id)
    app.dependency_overrides[get_creek_vault_client] = LocalFallbackCreekVaultClient

    response = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json() == _DISCONNECTED


@pytest.mark.asyncio
async def test_intimate_patch_after_reconnect_names_the_previous_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The Intimate reclassification says where the copy is, too; the tier still holds."""
    headers, user_id, entry_id, _a = await _page_in_vault_a(
        async_client, db_session, "unreach_patch"
    )
    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    _use(DraftVault())

    response = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json() == _PREVIOUS
    assert (await _entry(db_session, entry_id)).classification == "intimate"


# --- 2. "I can't reach it": erase here, keep an UNCONFIRMED obligation -------


@pytest.mark.asyncio
async def test_erase_locally_removes_the_page_and_keeps_an_unconfirmed_obligation(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The page is gone from read, list and export; the old vault's copy is owed, not withdrawn."""
    headers, user_id, entry_id, destination_a = await _page_in_vault_a(
        async_client, db_session, "unreach_erase"
    )
    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    vault = _use(DraftVault())
    refused = await async_client.delete(f"/journal/{entry_id}", headers=headers)
    assert refused.json() == _PREVIOUS

    erased = await async_client.post(f"/journal/{entry_id}/erase-locally", headers=headers)

    assert erased.status_code == HTTPStatus.OK, erased.text
    assert erased.json() == {
        "entry_id": entry_id,
        "remote_copy": "unconfirmed",
        "copy_location": "previous_vault",
    }
    assert "withdrawn" not in erased.text
    assert vault.withdrawals == [], "vault B is never asked to confirm A's copy"
    read = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert read.status_code == HTTPStatus.NOT_FOUND
    listed = await async_client.get("/journal/", headers=headers)
    assert all(item["id"] != entry_id for item in listed.json()["items"])
    exported = await async_client.get("/users/me/export/journal.md", headers=headers)
    assert exported.status_code == HTTPStatus.OK
    assert _BODY not in exported.text
    assert _TITLE not in exported.text
    owed = await _obligation(db_session, entry_id)
    assert owed is not None
    assert owed.state == JournalWithdrawalState.UNCONFIRMED
    assert owed.destination == destination_a
    assert owed.confirmed_at is None
    assert (await _entry(db_session, entry_id)).deleted_at is not None


@pytest.mark.asyncio
async def test_erase_locally_after_disconnect_names_the_disconnected_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """With no vault connected the receipt points at the one that was."""
    headers, user_id, entry_id, destination_a = await _page_in_vault_a(
        async_client, db_session, "unreach_erase_disconnected"
    )
    await clear_vault_config(db_session, user_id)
    app.dependency_overrides[get_creek_vault_client] = LocalFallbackCreekVaultClient

    erased = await async_client.post(f"/journal/{entry_id}/erase-locally", headers=headers)

    assert erased.status_code == HTTPStatus.OK
    assert erased.json()["remote_copy"] == "unconfirmed"
    assert erased.json()["copy_location"] == "disconnected_vault"
    owed = await _obligation(db_session, entry_id)
    assert owed is not None
    assert owed.destination == destination_a


@pytest.mark.asyncio
async def test_erase_locally_when_the_connected_vault_itself_fails(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Vault A is still connected but cannot confirm: the receipt names the connected vault.

    The obligation stays bound to A, and A's later confirmation clears it.
    """
    headers, _user_id, entry_id, destination_a = await _page_in_vault_a(
        async_client, db_session, "unreach_erase_connected"
    )
    failing = _use(DraftVault(fail=True))

    erased = await async_client.post(f"/journal/{entry_id}/erase-locally", headers=headers)

    assert erased.status_code == HTTPStatus.OK
    assert erased.json() == {
        "entry_id": entry_id,
        "remote_copy": "unconfirmed",
        "copy_location": "connected_vault",
    }
    assert failing.withdrawals == [entry_id], "the connected vault was asked first"
    owed = await _obligation(db_session, entry_id)
    assert owed is not None
    assert owed.state == JournalWithdrawalState.UNCONFIRMED
    assert owed.destination == destination_a

    healthy = DraftVault()
    await _sweep(db_session, healthy, destination=destination_a)

    assert healthy.withdrawals == [entry_id]
    cleared = await _obligation(db_session, entry_id)
    assert cleared is not None
    assert cleared.state == JournalWithdrawalState.CONFIRMED


@pytest.mark.asyncio
async def test_erase_locally_confirms_when_the_vault_can_answer(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Reconnect-first holds inside the erase too: a reachable vault is asked, and confirms."""
    headers, _user_id, entry_id, _a = await _page_in_vault_a(
        async_client, db_session, "unreach_erase_reachable"
    )
    vault = _use(DraftVault())

    erased = await async_client.post(f"/journal/{entry_id}/erase-locally", headers=headers)

    assert erased.status_code == HTTPStatus.OK
    assert erased.json() == {
        "entry_id": entry_id,
        "remote_copy": "confirmed_absent",
        "copy_location": None,
    }
    assert vault.withdrawals == [entry_id]
    row = await _entry(db_session, entry_id)
    assert row.deleted_at is not None
    assert row.vault_ref is None
    owed = await _obligation(db_session, entry_id)
    assert owed is None or owed.state == JournalWithdrawalState.CONFIRMED


@pytest.mark.asyncio
async def test_erase_locally_of_another_accounts_page_is_refused(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Ownership is checked first: nobody can erase, or learn about, somebody else's page.

    Discriminating on purpose: the exact application 404 body (a router miss
    answers ``Not Found``), the ownership audit row, and -- the positive
    control -- the owner reaching the very same URL.
    """
    owner_headers, _owner_id, entry_id, _a = await _page_in_vault_a(
        async_client, db_session, "unreach_owner"
    )
    intruder_headers, intruder_id = await _signup(async_client, "unreach_intruder")
    vault = _use(DraftVault())
    caplog.set_level(logging.WARNING)

    response = await async_client.post(
        f"/journal/{entry_id}/erase-locally", headers=intruder_headers
    )

    assert response.status_code == HTTPStatus.NOT_FOUND
    assert response.json() == {"detail": "journal_entry_not_found"}
    denials = [r for r in caplog.records if r.getMessage() == "resource_access_denied"]
    assert [
        (r.__dict__["resource"], r.__dict__["resource_id"], r.__dict__["user_id"]) for r in denials
    ] == [("journal_entry", entry_id, intruder_id)]
    assert vault.withdrawals == []
    assert (await _entry(db_session, entry_id)).deleted_at is None
    assert await _obligation(db_session, entry_id) is None

    owned = await async_client.post(f"/journal/{entry_id}/erase-locally", headers=owner_headers)

    assert owned.status_code == HTTPStatus.OK
    assert (await _entry(db_session, entry_id)).deleted_at is not None


# --- 3. Reconnect afterwards confirms and clears ------------------------------


@pytest.mark.asyncio
async def test_reconnecting_the_old_vault_confirms_and_clears_the_obligation(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Only vault A's confirmation clears it: B is never dialled, A is."""
    headers, user_id, entry_id, destination_a = await _page_in_vault_a(
        async_client, db_session, "unreach_reconnect"
    )
    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    destination_b = await vault_destination_fingerprint(db_session, user_id)
    _use(DraftVault())
    await async_client.post(f"/journal/{entry_id}/erase-locally", headers=headers)

    vault_b = DraftVault()
    await _sweep(db_session, vault_b, destination=destination_b)

    assert vault_b.withdrawals == []
    still = await _obligation(db_session, entry_id)
    assert still is not None
    assert still.state == JournalWithdrawalState.UNCONFIRMED

    vault_a = DraftVault()
    await _sweep(db_session, vault_a, destination=destination_a)

    assert vault_a.withdrawals == [entry_id]
    cleared = await _obligation(db_session, entry_id)
    assert cleared is not None
    assert cleared.state == JournalWithdrawalState.CONFIRMED
    assert cleared.confirmed_at is not None
    row = await _entry(db_session, entry_id)
    assert row.vault_ref is None
    assert row.vault_destination is None


@pytest.mark.asyncio
async def test_a_copy_with_no_recorded_vault_is_never_confirmed_by_any_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A legacy, unbound copy erased with no vault connected stays unconfirmed for good."""
    headers, user_id = await _signup(async_client, "unreach_unbound")
    entry = JournalEntry(sender="user", user_id=user_id, message=_BODY, vault_ref="legacy-ref")
    db_session.add(entry)
    await db_session.commit()
    assert entry.id is not None
    entry_id = entry.id
    # With no vault connected the app resolves the local fallback, which dials nothing.
    app.dependency_overrides[get_creek_vault_client] = LocalFallbackCreekVaultClient

    erased = await async_client.post(f"/journal/{entry_id}/erase-locally", headers=headers)
    assert erased.json()["remote_copy"] == "unconfirmed"

    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    some_vault = DraftVault()
    await _sweep(
        db_session,
        some_vault,
        destination=await vault_destination_fingerprint(db_session, user_id),
    )

    assert some_vault.withdrawals == []
    owed = await _obligation(db_session, entry_id)
    assert owed is not None
    assert owed.state == JournalWithdrawalState.UNCONFIRMED


@pytest.mark.asyncio
async def test_erase_telemetry_is_content_free(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The erase and its obligation log ids and closed codes only."""
    headers, user_id, entry_id, _a = await _page_in_vault_a(
        async_client, db_session, "unreach_telemetry"
    )
    await store_vault_config(db_session, user_id, vault_url=_VAULT_B, api_key=_KEY_B)
    _use(DraftVault())
    caplog.set_level(logging.DEBUG)

    await async_client.post(f"/journal/{entry_id}/erase-locally", headers=headers)

    ours = [r for r in caplog.records if r.name == obligation_module.__name__]
    transitions = [r for r in ours if r.getMessage() == OBLIGATION_TRANSITION_EVENT]
    assert {(r.__dict__["from_state"], r.__dict__["to_state"]) for r in transitions} == {
        ("none", "unconfirmed")
    }
    erased = [r for r in ours if r.getMessage() == ERASED_UNCONFIRMED_EVENT]
    assert [r.__dict__["reason"] for r in erased] == ["previous_vault"]
    for record in ours:
        assert set(record.__dict__) - _STANDARD_RECORD_KEYS <= OBLIGATION_LOG_EXTRAS
    forbidden = (_BODY, _TITLE, "SENTINEL", "https://", "vault-a", "vault-b", _KEY_A, _KEY_B)
    for record in caplog.records:
        extras = set(record.__dict__) - _STANDARD_RECORD_KEYS
        rendered = f"{record.getMessage()} {[record.__dict__[key] for key in extras]}"
        assert not any(marker in rendered for marker in forbidden), rendered
