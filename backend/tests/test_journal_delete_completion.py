"""A requested DELETE finishes in the background for every classification (#3098).

Before the durable pending-delete marker, the sweep only knew to withdraw
Intimate entries and never stamped ``deleted_at``: a Personal page whose DELETE
met a transient vault failure stayed live until the writer happened to retry.
These tests pin that the sweep now finishes the withdrawal *and* the deletion,
that it never withdraws a live non-Intimate page nobody asked to delete, and
that what it logs stays content-free.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
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
from services import creek_vault_voice_drafts as drafts
from services import creek_vault_withdraw as withdraw_module
from services import journal_withdrawal_obligation as obligation_module
from services.creek_vault_voice_drafts import (
    JournalRetrySchedule,
    resume_voice_draft_retractions,
)
from services.journal_withdrawal_obligation import (
    OBLIGATION_LOG_EXTRAS,
    OBLIGATION_TRANSITION_EVENT,
)
from services.user_vault_config import store_vault_config
from tests.test_voice_draft_retraction_recovery import _DraftVault as DraftVault

_PASSWORD = "secret12345"  # pragma: allowlist secret
_VAULT_A = "https://vault-a.example.com"
_KEY_A = "key-a-0123456789"  # pragma: allowlist secret
_BODY = "SENTINEL_DELETE_BODY the heron waited"
_T0 = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)
_PAST_BACKOFF = timedelta(hours=2)

_STANDARD_RECORD_KEYS = frozenset(
    logging.LogRecord("n", logging.INFO, "p", 1, "m", None, None).__dict__
) | {"message", "asctime", "taskName", "trace_id"}


def _factory(session: AsyncSession) -> async_sessionmaker[AsyncSession]:
    assert session.bind is not None
    return async_sessionmaker(session.bind, class_=AsyncSession, expire_on_commit=False)


async def _sweep(
    session: AsyncSession,
    vault: CreekVaultPipelineClient,
    moment: datetime,
    *,
    destination: str | None,
) -> None:
    async def _client(_session: AsyncSession, _user_id: int) -> CreekVaultPipelineClient:
        return vault

    async def _destination(_session: AsyncSession, _user_id: int) -> str | None:
        return destination

    await resume_voice_draft_retractions(
        _factory(session),
        _client,
        _destination,
        now=moment,
        journal_retries=JournalRetrySchedule(),
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


async def _mirrored_entry(
    client: AsyncClient,
    session: AsyncSession,
    username: str,
    classification: JournalClassification,
) -> tuple[dict[str, str], int, int, str]:
    """A page of ``classification`` whose copy reached vault A; returns its handles."""
    headers, user_id = await _signup(client, username)
    await store_vault_config(session, user_id, vault_url=_VAULT_A, api_key=_KEY_A)
    destination = await vault_destination_fingerprint(session, user_id)
    assert destination is not None
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=_BODY,
        classification=classification,
        vault_ref="vault-ref-mirrored",
        vault_destination=destination,
    )
    session.add(entry)
    await session.commit()
    assert entry.id is not None
    return headers, user_id, entry.id, destination


async def _failed_delete(client: AsyncClient, headers: dict[str, str], entry_id: int) -> DraftVault:
    """Send a DELETE that meets a transient vault failure, and pin the 503."""
    vault = DraftVault(fail=True)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    response = await client.delete(f"/journal/{entry_id}", headers=headers)
    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE, response.text
    assert response.json() == {"detail": "vault_withdrawal_pending"}
    return vault


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "classification",
    [
        JournalClassification.PUBLIC,
        JournalClassification.PERSONAL,
        JournalClassification.INTIMATE,
    ],
)
async def test_sweep_finishes_a_delete_of_any_classification(
    async_client: AsyncClient,
    db_session: AsyncSession,
    classification: JournalClassification,
) -> None:
    """A DELETE that met a transient failure is withdrawn and stamped by the sweep alone."""
    headers, _user_id, entry_id, destination = await _mirrored_entry(
        async_client, db_session, f"delete_sweep_{classification.value}", classification
    )
    await _failed_delete(async_client, headers, entry_id)

    held = await _entry(db_session, entry_id)
    assert held.deleted_at is None, "the page stays live until the vault confirms"
    pending = await _obligation(db_session, entry_id)
    assert pending is not None
    assert pending.state == JournalWithdrawalState.PENDING_DELETE
    assert pending.destination == destination

    healthy = DraftVault()
    await _sweep(db_session, healthy, _T0, destination=destination)

    assert healthy.withdrawals == [entry_id]
    finished = await _entry(db_session, entry_id)
    assert finished.deleted_at is not None
    assert finished.vault_ref is None
    assert finished.vault_destination is None
    settled = await _obligation(db_session, entry_id)
    assert settled is not None
    assert settled.state == JournalWithdrawalState.CONFIRMED
    assert settled.confirmed_at is not None
    gone = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert gone.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_sweep_keeps_retrying_a_pending_delete_until_confirmed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault still failing leaves the page live and the marker pending; never stalled forever."""
    headers, _user_id, entry_id, destination = await _mirrored_entry(
        async_client, db_session, "delete_sweep_still_down", JournalClassification.PERSONAL
    )
    await _failed_delete(async_client, headers, entry_id)
    down = DraftVault(fail=True)

    await _sweep(db_session, down, _T0, destination=destination)

    assert down.withdrawals == [entry_id]
    assert (await _entry(db_session, entry_id)).deleted_at is None
    still = await _obligation(db_session, entry_id)
    assert still is not None
    assert still.state == JournalWithdrawalState.PENDING_DELETE

    healthy = DraftVault()
    await _sweep(db_session, healthy, _T0 + _PAST_BACKOFF, destination=destination)

    assert healthy.withdrawals == [entry_id]
    assert (await _entry(db_session, entry_id)).deleted_at is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "classification", [JournalClassification.PUBLIC, JournalClassification.PERSONAL]
)
async def test_sweep_never_withdraws_a_live_page_nobody_asked_to_delete(
    async_client: AsyncClient,
    db_session: AsyncSession,
    classification: JournalClassification,
) -> None:
    """A non-Intimate page holding its vault marker, with no DELETE requested, is left alone."""
    _headers, _user_id, entry_id, destination = await _mirrored_entry(
        async_client, db_session, f"delete_sweep_unasked_{classification.value}", classification
    )
    vault = DraftVault()

    await _sweep(db_session, vault, _T0, destination=destination)

    assert vault.withdrawals == []
    untouched = await _entry(db_session, entry_id)
    assert untouched.deleted_at is None
    assert untouched.vault_ref == "vault-ref-mirrored"
    assert await _obligation(db_session, entry_id) is None


@pytest.mark.asyncio
async def test_intimate_reclassification_sweep_still_withdraws_without_deleting(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Intimate keeps today's behaviour: the copy is withdrawn, the page is not deleted."""
    _headers, _user_id, entry_id, destination = await _mirrored_entry(
        async_client, db_session, "delete_sweep_intimate_kept", JournalClassification.INTIMATE
    )
    vault = DraftVault()

    await _sweep(db_session, vault, _T0, destination=destination)

    assert vault.withdrawals == [entry_id]
    kept = await _entry(db_session, entry_id)
    assert kept.deleted_at is None
    assert kept.vault_ref is None
    assert await _obligation(db_session, entry_id) is None


@pytest.mark.asyncio
async def test_a_confirmed_retry_settles_the_pending_delete_marker(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The writer's own retry, once confirmed, leaves no open obligation for the sweep."""
    headers, _user_id, entry_id, destination = await _mirrored_entry(
        async_client, db_session, "delete_retry_settles", JournalClassification.PERSONAL
    )
    await _failed_delete(async_client, headers, entry_id)
    healthy = DraftVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: healthy

    retried = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert retried.status_code == HTTPStatus.NO_CONTENT
    settled = await _obligation(db_session, entry_id)
    assert settled is not None
    assert settled.state == JournalWithdrawalState.CONFIRMED
    later = DraftVault()
    await _sweep(db_session, later, _T0, destination=destination)
    assert later.withdrawals == []


@pytest.mark.asyncio
async def test_pending_delete_telemetry_is_content_free(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Every obligation record names only allowlisted keys and carries no prose, URL or key."""
    headers, _user_id, entry_id, destination = await _mirrored_entry(
        async_client, db_session, "delete_sweep_telemetry", JournalClassification.PERSONAL
    )
    watched = {obligation_module.__name__, drafts.__name__, withdraw_module.__name__}
    caplog.set_level(logging.DEBUG)

    await _failed_delete(async_client, headers, entry_id)
    await _sweep(db_session, DraftVault(), _T0, destination=destination)

    records = [record for record in caplog.records if record.name in watched]
    transitions = [
        r
        for r in records
        if r.name == obligation_module.__name__ and r.getMessage() == OBLIGATION_TRANSITION_EVENT
    ]
    assert {(r.__dict__["from_state"], r.__dict__["to_state"]) for r in transitions} >= {
        ("none", "pending_delete"),
        ("pending_delete", "confirmed"),
    }
    forbidden = (_BODY, "SENTINEL", "https://", "vault-a", _KEY_A, "vault-ref-mirrored")
    for record in transitions:
        extras = set(record.__dict__) - _STANDARD_RECORD_KEYS
        assert extras <= OBLIGATION_LOG_EXTRAS, (record.getMessage(), extras)
    for record in records:
        extras = set(record.__dict__) - _STANDARD_RECORD_KEYS
        rendered = f"{record.getMessage()} {[record.__dict__[key] for key in extras]}"
        assert not any(marker in rendered for marker in forbidden), rendered
