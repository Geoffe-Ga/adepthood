"""A deleted account's unconfirmed vault copies leave a detached note, for at most 97 days (#3267).

Owner decision (2026-10-14): "Keep a detached note (opaque vault fingerprint
and entry ID only) until the vault confirms, for at most 97 days." Before it,
account deletion erased the only record that a vault copy was still owed a
withdrawal. These tests pin the note's shape (nothing that reaches the
account), its end on the vault's confirmation, and the 97-day purge.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import SQLModel, col, select

from dependencies.creek_vault import (
    OWNER_ENV_VAR,
    detached_vaults,
    vault_destination_fingerprint,
)
from domain.account_deletion import POLICY, Disposition
from domain.retention import DETACHED_WITHDRAWAL_NOTE_RETENTION_DAYS, RETENTION
from models.journal_withdrawal_note import JournalWithdrawalNote
from models.journal_withdrawal_obligation import (
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)
from services import journal_withdrawal_note as note_module
from services.account_deletion import (
    VAULT_GUIDANCE_DETACHED_NOTES,
    Account,
    AccountVaultDisposition,
    delete_account,
)
from services.creek_vault_client import CREEK_VAULT_URL_ENV_VAR
from services.creek_vault_voice_drafts import JournalRetrySchedule
from services.journal_withdrawal_note import (
    NOTE_LOG_EXTRAS,
    NOTE_SETTLED_EVENT,
    DetachedVault,
    resume_detached_withdrawal_notes,
)
from services.retention_sweep import sweep_for
from tests.helpers.feedback_triage import make_account
from tests.test_voice_draft_retraction_recovery import _DraftVault as DraftVault

_VAULT_FINGERPRINT = "a" * 32
_OTHER_FINGERPRINT = "b" * 32
_ENTRY_ID = 4242
_T0 = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)
_RATIFIED_DAYS = 97
_ONE_DAY = timedelta(days=1)
_DEPLOYMENT_URL = "https://deployment-vault.example.com"
_STANDARD_RECORD_KEYS = frozenset(
    logging.LogRecord("n", logging.INFO, "p", 1, "m", None, None).__dict__
) | {"message", "asctime", "taskName", "trace_id"}


@pytest.fixture(autouse=True)
def _no_deployment_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep each scenario independent of a developer's environment."""
    monkeypatch.delenv(CREEK_VAULT_URL_ENV_VAR, raising=False)
    monkeypatch.delenv(OWNER_ENV_VAR, raising=False)


def _factory(session: AsyncSession) -> async_sessionmaker[AsyncSession]:
    assert session.bind is not None
    return async_sessionmaker(session.bind, class_=AsyncSession, expire_on_commit=False)


async def _owe(
    session: AsyncSession,
    user_id: int,
    entry_id: int,
    state: JournalWithdrawalState,
    destination: str | None = _VAULT_FINGERPRINT,
) -> None:
    session.add(
        JournalWithdrawalObligation(
            user_id=user_id, journal_entry_id=entry_id, state=state.value, destination=destination
        )
    )
    await session.commit()


async def _delete(session: AsyncSession, email: str, user_id: int) -> list[str]:
    receipt = await delete_account(
        session,
        Account(user_id=user_id, email=email),
        vault_disposition=AccountVaultDisposition.manual(),
    )
    return [receipt.vault_guidance]


async def _notes(session: AsyncSession) -> list[JournalWithdrawalNote]:
    result = await session.execute(
        select(JournalWithdrawalNote)
        .order_by(col(JournalWithdrawalNote.journal_entry_id))
        .execution_options(populate_existing=True)
    )
    rows = list(result.scalars().all())
    await session.commit()
    return rows


async def _note_at(session: AsyncSession, entry_id: int, created_at: datetime) -> None:
    session.add(
        JournalWithdrawalNote(
            journal_entry_id=entry_id, destination=_VAULT_FINGERPRINT, created_at=created_at
        )
    )
    await session.commit()


# --------------------------------------------------------------------------
# Detachment at account deletion
# --------------------------------------------------------------------------


def test_the_note_table_names_no_account() -> None:
    """No column of the note is, or points at, the account; deletion retains it."""
    table = SQLModel.metadata.tables["journalwithdrawalnote"]
    assert set(table.c.keys()) == {"id", "journal_entry_id", "destination", "created_at"}
    assert not any(column.foreign_keys for column in table.columns)
    assert POLICY["journalwithdrawalnote"].disposition is Disposition.RETAIN


@pytest.mark.asyncio
async def test_an_unconfirmed_obligation_outlives_the_account_as_a_detached_note(
    db_session: AsyncSession,
) -> None:
    account = await make_account(db_session, "note-unconfirmed@example.com")
    await _owe(db_session, account.user_id, _ENTRY_ID, JournalWithdrawalState.UNCONFIRMED)
    await _owe(db_session, account.user_id, _ENTRY_ID + 1, JournalWithdrawalState.PENDING_DELETE)

    guidance = await _delete(db_session, account.email, account.user_id)

    notes = await _notes(db_session)
    assert [(n.journal_entry_id, n.destination) for n in notes] == [
        (_ENTRY_ID, _VAULT_FINGERPRINT),
        (_ENTRY_ID + 1, _VAULT_FINGERPRINT),
    ]
    remaining = await db_session.execute(
        select(JournalWithdrawalObligation).where(
            col(JournalWithdrawalObligation.user_id) == account.user_id
        )
    )
    assert remaining.scalars().all() == []
    assert VAULT_GUIDANCE_DETACHED_NOTES in guidance[0]


@pytest.mark.asyncio
async def test_an_account_with_only_confirmed_obligations_leaves_no_note(
    db_session: AsyncSession,
) -> None:
    account = await make_account(db_session, "note-confirmed@example.com")
    await _owe(db_session, account.user_id, _ENTRY_ID, JournalWithdrawalState.CONFIRMED)

    guidance = await _delete(db_session, account.email, account.user_id)

    assert await _notes(db_session) == []
    assert VAULT_GUIDANCE_DETACHED_NOTES not in guidance[0]


@pytest.mark.asyncio
async def test_a_reapplied_deletion_keeps_the_note_it_already_has(
    db_session: AsyncSession,
) -> None:
    """A deletion reapplied after a restore does not fork the note or restart its clock."""
    account = await make_account(db_session, "note-reapply@example.com")
    earlier = _T0 - timedelta(days=10)
    await _note_at(db_session, _ENTRY_ID, earlier)
    await _owe(db_session, account.user_id, _ENTRY_ID, JournalWithdrawalState.UNCONFIRMED)

    await _delete(db_session, account.email, account.user_id)

    notes = await _notes(db_session)
    assert len(notes) == 1
    assert notes[0].created_at.replace(tzinfo=UTC) == earlier


# --------------------------------------------------------------------------
# The vault confirms
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_vault_with_that_fingerprint_confirming_deletes_the_note(
    db_session: AsyncSession,
) -> None:
    account = await make_account(db_session, "note-confirm@example.com")
    await _owe(db_session, account.user_id, _ENTRY_ID, JournalWithdrawalState.UNCONFIRMED)
    await _delete(db_session, account.email, account.user_id)
    vault = DraftVault()

    settled = await resume_detached_withdrawal_notes(
        _factory(db_session),
        (DetachedVault(destination=_VAULT_FINGERPRINT, connect=lambda: vault),),
        now=_T0,
        retries=JournalRetrySchedule(),
    )

    assert settled == 1
    assert vault.withdrawals == [_ENTRY_ID]
    assert await _notes(db_session) == []


@pytest.mark.asyncio
async def test_a_vault_that_does_not_confirm_leaves_the_note(db_session: AsyncSession) -> None:
    await _note_at(db_session, _ENTRY_ID, _T0)
    vault = DraftVault(fail=True)

    settled = await resume_detached_withdrawal_notes(
        _factory(db_session),
        (DetachedVault(destination=_VAULT_FINGERPRINT, connect=lambda: vault),),
        now=_T0,
        retries=JournalRetrySchedule(),
    )

    assert settled == 0
    assert vault.withdrawals == [_ENTRY_ID]
    assert len(await _notes(db_session)) == 1


@pytest.mark.asyncio
async def test_a_different_vault_is_never_dialled_for_a_note(db_session: AsyncSession) -> None:
    await _note_at(db_session, _ENTRY_ID, _T0)
    vault = DraftVault()

    settled = await resume_detached_withdrawal_notes(
        _factory(db_session),
        (DetachedVault(destination=_OTHER_FINGERPRINT, connect=lambda: vault),),
        now=_T0,
        retries=JournalRetrySchedule(),
    )

    assert settled == 0
    assert vault.withdrawals == []
    assert len(await _notes(db_session)) == 1


@pytest.mark.asyncio
async def test_the_bound_deployment_vault_still_answers_for_its_erased_owner(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deployment vault's fingerprint for its owner is what reaches that owner's notes."""
    account = await make_account(db_session, "note-deployment@example.com")
    monkeypatch.setenv(CREEK_VAULT_URL_ENV_VAR, _DEPLOYMENT_URL)
    monkeypatch.setenv(OWNER_ENV_VAR, str(account.user_id))
    live_fingerprint = await vault_destination_fingerprint(db_session, account.user_id)
    assert live_fingerprint is not None

    await delete_account(
        db_session,
        Account(user_id=account.user_id, email=account.email),
        vault_disposition=AccountVaultDisposition.manual(),
    )

    assert [vault.destination for vault in detached_vaults()] == [live_fingerprint]


def test_no_vault_is_dialable_without_a_bound_deployment_vault(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert detached_vaults() == ()
    monkeypatch.setenv(CREEK_VAULT_URL_ENV_VAR, _DEPLOYMENT_URL)
    assert detached_vaults() == ()


# --------------------------------------------------------------------------
# The 97-day purge
# --------------------------------------------------------------------------


def test_the_ninety_seven_days_are_the_ratified_constant() -> None:
    assert DETACHED_WITHDRAWAL_NOTE_RETENTION_DAYS == _RATIFIED_DAYS
    rule = RETENTION["journalwithdrawalnote"]
    assert rule.days == _RATIFIED_DAYS
    assert rule.ratified


@pytest.mark.asyncio
async def test_a_98_day_old_note_is_purged_and_a_96_day_old_one_kept(
    db_session: AsyncSession,
) -> None:
    await _note_at(db_session, _ENTRY_ID, _T0 - timedelta(days=_RATIFIED_DAYS + 1))
    await _note_at(db_session, _ENTRY_ID + 1, _T0 - timedelta(days=_RATIFIED_DAYS - 1))

    counts = await sweep_for("journalwithdrawalnote").run(db_session, _T0, dry_run=False)

    assert counts.deleted == 1
    assert [note.journal_entry_id for note in await _notes(db_session)] == [_ENTRY_ID + 1]


@pytest.mark.asyncio
async def test_the_purge_keeps_a_note_on_its_97th_day(db_session: AsyncSession) -> None:
    await _note_at(db_session, _ENTRY_ID, _T0 - timedelta(days=_RATIFIED_DAYS))
    await _note_at(db_session, _ENTRY_ID + 1, _T0 - timedelta(days=_RATIFIED_DAYS) - _ONE_DAY)

    counts = await sweep_for("journalwithdrawalnote").run(db_session, _T0, dry_run=False)
    assert counts.deleted == 1
    assert [note.journal_entry_id for note in await _notes(db_session)] == [_ENTRY_ID]


# --------------------------------------------------------------------------
# Telemetry
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_note_telemetry_carries_only_the_allowed_extras(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """No record from the note module carries an extra beyond ``NOTE_LOG_EXTRAS`` (#3336).

    Driven through a failed resume, a confirmed resume and the purge. No record
    renders the vault fingerprint either.
    """
    await _note_at(db_session, _ENTRY_ID, _T0)
    await _note_at(db_session, _ENTRY_ID + 1, _T0)
    failing, confirming = DraftVault(fail=True), DraftVault()
    caplog.set_level(logging.DEBUG, logger=note_module.__name__)

    failed = await resume_detached_withdrawal_notes(
        _factory(db_session),
        (DetachedVault(destination=_VAULT_FINGERPRINT, connect=lambda: failing),),
        now=_T0,
        retries=JournalRetrySchedule(),
    )
    confirmed = await resume_detached_withdrawal_notes(
        _factory(db_session),
        (DetachedVault(destination=_VAULT_FINGERPRINT, connect=lambda: confirming),),
        now=_T0,
        retries=JournalRetrySchedule(),
    )
    await _note_at(db_session, _ENTRY_ID + 2, _T0 - timedelta(days=_RATIFIED_DAYS + 1))
    purged = await sweep_for("journalwithdrawalnote").run(db_session, _T0, dry_run=False)

    assert (failed, confirmed, purged.deleted) == (0, 2, 1)
    records = [record for record in caplog.records if record.name == note_module.__name__]
    settled = [record for record in records if record.getMessage() == NOTE_SETTLED_EVENT]
    assert [record.__dict__["entry_id"] for record in settled] == [_ENTRY_ID, _ENTRY_ID + 1]
    for record in records:
        extras = set(record.__dict__) - _STANDARD_RECORD_KEYS
        assert extras <= NOTE_LOG_EXTRAS, (record.getMessage(), extras)
        rendered = f"{record.getMessage()} {[record.__dict__[key] for key in extras]}"
        assert _VAULT_FINGERPRINT not in rendered, rendered
