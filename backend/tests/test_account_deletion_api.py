"""End-to-end contract for ``DELETE /users/me`` — in-app account deletion.

Apple App Store Review 5.1.1(v) requires an in-app path to account deletion,
and GDPR Art. 17 requires that the path actually erase. These tests pin the
observable half of that contract: the endpoint exists, it demands explicit
confirmation, it erases the caller's own rows and nobody else's, it leaves the
caller's session dead, and it records a content-free receipt.

The *exhaustive* "which tables were reached" half lives in
``test_account_deletion_policy.py``, which drives every user-owned table from
the schema itself rather than from a hand-maintained list.
"""

from __future__ import annotations

import logging
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import Column, Integer, Table, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from models.account_deletion_audit import AccountDeletionAudit
from services.account_deletion import Account, ErasurePolicyGapError, delete_account
from services.creek_vault_client import CREEK_VAULT_URL_ENV_VAR

_PASSWORD = "securepassword123"  # pragma: allowlist secret
_ENTRY_BODY = "The thing I would least like to survive my own deletion."
# The one log line the deletion is allowed to emit, matched exactly so a
# future line that narrates more than a count cannot hide behind it.
_DELETION_LOG_EVENT = "account_deleted"

# Tables and columns are named through the metadata rather than through the
# model classes -- see :func:`_count`.
_USER_TABLE = "user"
_JOURNAL_TABLE = "journalentry"
_ID = "id"
_USER_ID = "user_id"


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int, str]:
    """Create a user; return ``(auth headers, user id, email)``."""
    email = f"{username}@example.com"
    resp = await client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"], email


async def _write_a_journal_entry(client: AsyncClient, headers: dict[str, str]) -> None:
    """Give the account something personal worth erasing."""
    resp = await client.post(
        "/journal/",
        json={"message": _ENTRY_BODY, "classification": "personal"},
        headers=headers,
    )
    assert resp.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}


async def _count(session: AsyncSession, table_name: str, column: str, value: object) -> int:
    """How many rows of ``table_name`` hold ``value`` in ``column``.

    Addresses the table through the ORM metadata rather than through the model
    class. SQLModel declares its fields as the plain Python types they
    round-trip, so ``JournalEntry.user_id == user_id`` is a ``bool`` to a type
    checker; ``table.c["user_id"] == user_id`` is the SQL expression it
    actually is, and the helper needs no cast to say so.
    """
    table = SQLModel.metadata.tables[table_name]
    result = await session.execute(
        select(func.count()).select_from(table).where(table.c[column] == value),
    )
    return int(result.scalar_one())


@pytest.mark.asyncio
async def test_delete_me_erases_the_callers_own_data(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The happy path: confirmed deletion removes the account and its writing."""
    headers, user_id, email = await _signup(async_client, "leaver")
    await _write_a_journal_entry(async_client, headers)
    assert await _count(db_session, _JOURNAL_TABLE, _USER_ID, user_id) == 1

    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": email},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    assert await _count(db_session, _USER_TABLE, _ID, user_id) == 0
    assert await _count(db_session, _JOURNAL_TABLE, _USER_ID, user_id) == 0


@pytest.mark.asyncio
async def test_delete_me_requires_matching_confirmation(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A wrong (or absent) confirmation must not delete anything."""
    headers, user_id, _ = await _signup(async_client, "hesitant")

    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": "someone.else@example.com"},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert await _count(db_session, _USER_TABLE, _ID, user_id) == 1


@pytest.mark.asyncio
async def test_delete_me_rejects_an_anonymous_caller(async_client: AsyncClient) -> None:
    """Deletion is authenticated; there is no unauthenticated erase path."""
    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": "nobody@example.com"},
    )

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_delete_me_cannot_reach_another_users_data(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The route is ``/users/me`` and resolves the subject from the JWT only.

    The bystander keeps every row, which is the quiet side of the guard: a
    deletion that swept the whole table would pass the noisy assertions above.
    """
    victim_headers, victim_id, _ = await _signup(async_client, "bystander")
    await _write_a_journal_entry(async_client, victim_headers)
    attacker_headers, _, attacker_email = await _signup(async_client, "attacker")

    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": attacker_email},
        headers=attacker_headers,
    )

    assert resp.status_code == HTTPStatus.OK
    assert await _count(db_session, _USER_TABLE, _ID, victim_id) == 1
    assert await _count(db_session, _JOURNAL_TABLE, _USER_ID, victim_id) == 1


@pytest.mark.asyncio
async def test_delete_me_kills_the_callers_session(async_client: AsyncClient) -> None:
    """The token that authorised the deletion stops working immediately."""
    headers, _, email = await _signup(async_client, "logged-out")

    deleted = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": email},
        headers=headers,
    )
    assert deleted.status_code == HTTPStatus.OK

    replayed = await async_client.get("/habits/", headers=headers)
    assert replayed.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_delete_me_records_a_content_free_receipt(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Deletion is an auditable event that retains no deleted content."""
    headers, user_id, email = await _signup(async_client, "audited")
    await _write_a_journal_entry(async_client, headers)

    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": email},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK

    rows = (await db_session.execute(select(AccountDeletionAudit))).scalars().all()
    assert len(rows) == 1
    receipt = rows[0]
    assert receipt.user_id == user_id
    assert receipt.rows_erased >= 1
    # Nothing the user wrote — nor anything that identifies them beyond the
    # surrogate id — may survive inside the receipt itself.
    serialised = f"{receipt.row_counts}{receipt.vault_disposition}"
    assert _ENTRY_BODY not in serialised
    assert email not in serialised


@pytest.mark.asyncio
async def test_delete_me_reports_what_survives(async_client: AsyncClient) -> None:
    """The response states plainly what was erased and what deliberately stays."""
    headers, _, email = await _signup(async_client, "informed")

    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": email},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["recoverable"] is False
    assert "habit" in body["erased"]
    assert "journalentry" in body["erased"]
    assert "practice" in body["anonymised"]
    assert body["vault"]["purged"] is False
    assert body["vault"]["guidance"]


@pytest.mark.asyncio
async def test_an_unreachable_vault_does_not_block_deletion(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A configured vault that could never answer still cannot delay an erasure.

    ``CREEK_VAULT_URL`` points at an address nothing will ever accept. If the
    deletion path grew a vault call, this test would hang until the client's
    timeout and then fail — which is the regression it exists to catch.
    """
    monkeypatch.setenv(CREEK_VAULT_URL_ENV_VAR, "https://vault.invalid:9/")
    headers, user_id, email = await _signup(async_client, "vaulted")

    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": email},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    vault = resp.json()["vault"]
    assert vault["configured"] is True
    assert vault["purged"] is False
    assert "creek purge" in vault["guidance"]
    assert await _count(db_session, _USER_TABLE, _ID, user_id) == 0


@pytest.mark.asyncio
async def test_deletion_refuses_when_the_schema_outgrows_the_policy(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A model with no deletion policy stops the sweep instead of being skipped.

    A partial erasure that reports success is the worse failure: the user is
    told their data is gone while some of it is not. The unpoliced table is
    added to the live metadata for the duration of the test, so this exercises
    the same detector the endpoint calls rather than a stubbed one.
    """
    _, user_id, email = await _signup(async_client, "unswept")
    intruder = Table("sanghamembership", SQLModel.metadata, Column("id", Integer, primary_key=True))
    try:
        with pytest.raises(ErasurePolicyGapError, match="sanghamembership"):
            await delete_account(db_session, Account(user_id=user_id, email=email))
    finally:
        SQLModel.metadata.remove(intruder)

    assert await _count(db_session, _USER_TABLE, _ID, user_id) == 1


@pytest.mark.asyncio
async def test_deleted_account_cannot_log_in_again(async_client: AsyncClient) -> None:
    """Deletion is not deactivation: the credentials no longer resolve."""
    headers, _, email = await _signup(async_client, "gone")
    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": email},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK

    again = await async_client.post("/auth/login", json={"email": email, "password": _PASSWORD})
    assert again.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_the_address_can_be_registered_again_afterwards(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Erasure has to be complete enough that the address is free again.

    This is the assertion a soft delete cannot pass and a partial sweep fails
    on the first leftover row: signup enforces uniqueness on the address, and
    the lockout gate reads ``loginattempt`` rows keyed on the address rather
    than on any account. If either survived the deletion, the person who left
    could never come back — which is the quiet way a deletion feature turns
    into a ban.
    """
    headers, first_id, email = await _signup(async_client, "returning")
    await _write_a_journal_entry(async_client, headers)
    deleted = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": email},
        headers=headers,
    )
    assert deleted.status_code == HTTPStatus.OK

    again = await async_client.post(
        "/auth/signup",
        json={"email": email, "password": _PASSWORD},
    )

    assert again.status_code == HTTPStatus.OK
    # The new account is new, not the old one handed back: the writing that
    # belonged to the erased account is not waiting inside it. (Its surrogate
    # id is deliberately not asserted on -- Postgres never reuses one and
    # SQLite always does, and neither fact is about this feature.)
    fresh = {"Authorization": f"Bearer {again.json()['token']}"}
    entries = await async_client.get("/journal/", headers=fresh)
    assert entries.status_code == HTTPStatus.OK
    assert _ENTRY_BODY not in entries.text
    assert await _count(db_session, _JOURNAL_TABLE, _USER_ID, first_id) == 0


@pytest.mark.asyncio
async def test_deletion_logs_counts_and_never_content(
    async_client: AsyncClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing erased may be readable in the log stream afterwards.

    Logs leave the process — an aggregator, a crash reporter, a support
    console — so a deletion that narrates itself in detail hands the content
    to exactly the places the erasure was supposed to empty. The record is
    allowed to prove the sweep ran (an id that now names nobody, and a count);
    it is not allowed to carry the address or a line of the writing.
    """
    headers, user_id, email = await _signup(async_client, "quiet")
    await _write_a_journal_entry(async_client, headers)

    with caplog.at_level(logging.INFO):
        resp = await async_client.request(
            "DELETE",
            "/users/me",
            json={"confirm_email": email},
            headers=headers,
        )

    assert resp.status_code == HTTPStatus.OK
    emitted = "\n".join(record.getMessage() for record in caplog.records)
    assert _ENTRY_BODY not in emitted
    assert email not in emitted
    audit = [record for record in caplog.records if record.getMessage() == _DELETION_LOG_EVENT]
    assert len(audit) == 1
    assert audit[0].__dict__["user_id"] == user_id
    assert audit[0].__dict__["rows_erased"] >= 1
