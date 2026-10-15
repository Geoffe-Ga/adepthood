"""Every store the nightly retention sweep applies a ratified period to (#3266).

Each test seeds rows on both sides of the store's cutoff, plus every state the
registry says is never eligible, and asserts that exactly the eligible rows go.
The sweep is driven with a fixed ``now`` so the cutoff is exact: a row one
minute past it goes, a row one minute inside it stays.

The day counts are read from the registry's constants, never restated, and the
last tests pin that every bounded rule in the registry names this sweep and
that the sweep covers exactly those rules.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from itertools import count

import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from domain.retention import (
    ANONYMISED_SALE_RETENTION_DAYS,
    CONFIRMED_OBLIGATION_RETENTION_DAYS,
    DEAD_SHARE_LINK_RETENTION_DAYS,
    ENERGY_PLAN_SWEEP_DAYS,
    ERASURE_RECEIPT_RETENTION_DAYS,
    FEEDBACK_SWEEP_DAYS,
    LOGIN_ATTEMPT_RETENTION_DAYS,
    NIGHTLY_RETENTION_SWEEP,
    RESTORE_MARKER_RETENTION_DAYS,
    REVOKED_TOKEN_GRACE_DAYS,
    SOFT_DELETED_ENTRY_RETENTION_DAYS,
    TEARDOWN_RECEIPT_RETENTION_DAYS,
    USAGE_LOG_RETENTION_DAYS,
    RetentionKind,
    RetentionRule,
    nightly_rules,
    retention_report,
)
from domain.retention import (
    RETENTION as REGISTRY,
)
from models.account_deletion_audit import AccountDeletionAudit
from models.energy_plan import EnergyPlan
from models.entitlement import Entitlement
from models.feedback import FeedbackReport
from models.gumroad_sale import GumroadSale
from models.journal_entry import JournalEntry
from models.journal_withdrawal_obligation import (
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)
from models.license_binding import LicenseBinding
from models.llm_usage_log import LLMUsageLog
from models.login_attempt import LoginAttempt
from models.practice_share_link import PracticeShareLink
from models.restore_marker import RestoreMarker, RestoreState
from models.revoked_token import RevokedToken
from models.vault_activation import VaultActivationState, VaultTeardownReceipt
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from services.restore_suppression import RESTORE_ID_ENV_VAR
from services.retention_sweep import (
    SOFT_DELETED_ENTRIES,
    SWEEPS,
    SweepCounts,
    sweep_for,
)

#: The instant every test sweeps at, so each cutoff is exact.
_NOW = datetime(2026, 10, 14, 3, 17, tzinfo=UTC)
#: How far either side of a cutoff a boundary row sits.
_MARGIN = timedelta(minutes=1)
#: The account every row hangs off (SQLite does not enforce the foreign key).
_USER = 1
#: A day count far past every period, for rows whose own clock never starts.
_ANCIENT_DAYS = 1000
#: A use cap a used-up share link has reached.
_USED_UP = 1
_ANCIENT = _NOW - timedelta(days=_ANCIENT_DAYS)
_RESTORE_NAMED = "restore-named-by-the-gate"

_serial = count(1)


def _past(days: int) -> datetime:
    """An instant one margin past the cutoff of a ``days`` period: eligible."""
    return _NOW - timedelta(days=days) - _MARGIN


def _inside(days: int) -> datetime:
    """An instant one margin inside the cutoff of a ``days`` period: kept."""
    return _NOW - timedelta(days=days) + _MARGIN


def _ago(days: int) -> datetime:
    """``days`` before the real clock, for the sweeps that read it themselves."""
    return datetime.now(UTC) - timedelta(days=days)


async def _seed(session: AsyncSession, **rows: SQLModel) -> dict[str, object]:
    """Insert ``rows`` and return each one's primary key by label."""
    for row in rows.values():
        session.add(row)
    await session.commit()
    ids: dict[str, object] = {}
    for label, row in rows.items():
        state = sa.inspect(row)
        assert state is not None, label
        identity = state.identity
        assert identity is not None, label
        (key,) = identity
        ids[label] = key
    return ids


async def _remaining(session: AsyncSession, table_name: str) -> set[object]:
    """Every primary key still present in ``table_name``."""
    table = SQLModel.metadata.tables[table_name]
    (pk,) = table.primary_key.columns
    return set((await session.execute(sa.select(pk))).scalars())


async def _sweep(session: AsyncSession, store: str, *, dry_run: bool = False) -> SweepCounts:
    return await sweep_for(store).run(session, _NOW, dry_run=dry_run)


def _left(ids: dict[str, object], *labels: str) -> set[object]:
    return {ids[label] for label in labels}


# --------------------------------------------------------------------------
# The ten stores no sweep served before
# --------------------------------------------------------------------------


def _obligation(state: str, *, confirmed_at: datetime | None) -> JournalWithdrawalObligation:
    return JournalWithdrawalObligation(
        user_id=_USER,
        journal_entry_id=next(_serial),
        state=state,
        confirmed_at=confirmed_at,
        created_at=_ANCIENT,
        updated_at=_ANCIENT,
    )


@pytest.mark.asyncio
async def test_confirmed_withdrawal_obligations_go_and_open_ones_never_do(
    db_session: AsyncSession,
) -> None:
    """Confirmed rows go 30 days after confirmation; open states are never eligible."""
    days = CONFIRMED_OBLIGATION_RETENTION_DAYS
    confirmed = JournalWithdrawalState.CONFIRMED.value
    ids = await _seed(
        db_session,
        expired=_obligation(confirmed, confirmed_at=_past(days)),
        recent=_obligation(confirmed, confirmed_at=_inside(days)),
        pending=_obligation(JournalWithdrawalState.PENDING_DELETE.value, confirmed_at=None),
        unconfirmed=_obligation(JournalWithdrawalState.UNCONFIRMED.value, confirmed_at=None),
    )

    counts = await _sweep(db_session, "journalwithdrawalobligation")

    assert counts == SweepCounts(eligible=1, deleted=1, blocked=2)
    assert await _remaining(db_session, "journalwithdrawalobligation") == _left(
        ids, "recent", "pending", "unconfirmed"
    )


def _retraction(state: str, *, confirmed_at: datetime | None) -> VoiceDraftRetraction:
    return VoiceDraftRetraction(
        user_id=_USER,
        journal_entry_id=1,
        marginalia_id=next(_serial),
        state=state,
        confirmed_at=confirmed_at,
        created_at=_ANCIENT,
        updated_at=_ANCIENT,
    )


@pytest.mark.asyncio
async def test_confirmed_draft_retractions_go_and_unsettled_ones_never_do(
    db_session: AsyncSession,
) -> None:
    """Confirmed retractions go 30 days after confirmation; mirror_intent and pending stay."""
    days = CONFIRMED_OBLIGATION_RETENTION_DAYS
    confirmed = VoiceDraftRetractionState.CONFIRMED.value
    ids = await _seed(
        db_session,
        expired=_retraction(confirmed, confirmed_at=_past(days)),
        recent=_retraction(confirmed, confirmed_at=_inside(days)),
        intent=_retraction(VoiceDraftRetractionState.MIRROR_INTENT.value, confirmed_at=None),
        pending=_retraction(VoiceDraftRetractionState.PENDING.value, confirmed_at=None),
    )

    counts = await _sweep(db_session, "voicedraftretraction")

    assert counts == SweepCounts(eligible=1, deleted=1, blocked=2)
    assert await _remaining(db_session, "voicedraftretraction") == _left(
        ids, "recent", "intent", "pending"
    )


def _receipt(deleted_at: datetime) -> AccountDeletionAudit:
    return AccountDeletionAudit(
        user_id=next(_serial), deleted_at=deleted_at, vault_disposition="none"
    )


@pytest.mark.asyncio
async def test_erasure_receipts_go_a_year_after_the_erasure(db_session: AsyncSession) -> None:
    """An erasure receipt is kept 365 days from its creation, then removed."""
    days = ERASURE_RECEIPT_RETENTION_DAYS
    ids = await _seed(db_session, expired=_receipt(_past(days)), recent=_receipt(_inside(days)))

    counts = await _sweep(db_session, "accountdeletionaudit")

    assert counts == SweepCounts(eligible=1, deleted=1, blocked=0)
    assert await _remaining(db_session, "accountdeletionaudit") == _left(ids, "recent")


def _sale(anonymised_at: datetime | None) -> GumroadSale:
    serial = next(_serial)
    return GumroadSale(
        gumroad_sale_id=f"sale-{serial}",
        product_id="prod",
        email="" if anonymised_at else "buyer@example.com",
        resource_name="sale",
        raw_payload={},
        created_at=_ANCIENT,
        anonymised_at=anonymised_at,
    )


@pytest.mark.asyncio
async def test_anonymised_sales_go_180_days_after_anonymisation(db_session: AsyncSession) -> None:
    """Only a sale whose clock started goes; one still claimed is held and counted."""
    days = ANONYMISED_SALE_RETENTION_DAYS
    granted = _sale(_past(days))
    bound = _sale(_past(days))
    ids = await _seed(
        db_session,
        expired=_sale(_past(days)),
        recent=_sale(_inside(days)),
        never_linked=_sale(None),
        granted=granted,
        bound=bound,
    )
    await _seed(
        db_session,
        grant=Entitlement(user_id=_USER, source_sale_id=ids["granted"]),
        binding=LicenseBinding(
            user_id=_USER, gumroad_sale_id=bound.gumroad_sale_id, product_id="prod"
        ),
    )

    counts = await _sweep(db_session, "gumroadsale")

    assert counts == SweepCounts(eligible=1, deleted=1, blocked=2)
    assert await _remaining(db_session, "gumroadsale") == _left(
        ids, "recent", "never_linked", "granted", "bound"
    )


@pytest.mark.asyncio
async def test_login_attempts_go_30_days_after_the_attempt(db_session: AsyncSession) -> None:
    """Attempts go after 30 days, including ones against an address with no account."""
    days = LOGIN_ATTEMPT_RETENTION_DAYS
    ids = await _seed(
        db_session,
        expired=LoginAttempt(email="nobody@example.com", created_at=_past(days)),
        recent=LoginAttempt(email="nobody@example.com", created_at=_inside(days)),
    )

    counts = await _sweep(db_session, "loginattempt")

    assert counts == SweepCounts(eligible=1, deleted=1, blocked=0)
    assert await _remaining(db_session, "loginattempt") == _left(ids, "recent")


def _usage(timestamp: datetime) -> LLMUsageLog:
    return LLMUsageLog(user_id=_USER, timestamp=timestamp, provider="stub", model="stub")


@pytest.mark.asyncio
async def test_usage_logs_go_90_days_after_the_call(db_session: AsyncSession) -> None:
    """Metering rows go 90 days after the metered call."""
    days = USAGE_LOG_RETENTION_DAYS
    ids = await _seed(db_session, expired=_usage(_past(days)), recent=_usage(_inside(days)))

    counts = await _sweep(db_session, "llmusagelog")

    assert counts == SweepCounts(eligible=1, deleted=1, blocked=0)
    assert await _remaining(db_session, "llmusagelog") == _left(ids, "recent")


@pytest.mark.asyncio
async def test_revoked_tokens_go_a_day_after_their_own_expiry(db_session: AsyncSession) -> None:
    """A deny-list row goes one day after the token itself expired."""
    days = REVOKED_TOKEN_GRACE_DAYS
    ids = await _seed(
        db_session,
        expired=RevokedToken(jti="expired", expires_at=_past(days)),
        recent=RevokedToken(jti="recent", expires_at=_inside(days)),
        live=RevokedToken(jti="live", expires_at=_NOW + timedelta(days=days)),
    )

    counts = await _sweep(db_session, "revokedtoken")

    assert counts == SweepCounts(eligible=1, deleted=1, blocked=0)
    assert await _remaining(db_session, "revokedtoken") == _left(ids, "recent", "live")


def _link(
    *,
    expires_at: datetime | None = None,
    revoked_at: datetime | None = None,
    used_up: bool = False,
) -> PracticeShareLink:
    return PracticeShareLink(
        token=f"token-{next(_serial)}",
        practice_id=1,
        created_at=_ANCIENT,
        expires_at=expires_at,
        revoked_at=revoked_at,
        max_uses=_USED_UP if used_up else None,
        use_count=_USED_UP if used_up else 0,
    )


@pytest.mark.asyncio
async def test_dead_share_links_go_30_days_after_they_stop_working(
    db_session: AsyncSession,
) -> None:
    """Revoked and expired links go 30 days on; live ones stay; used up with no date is held."""
    days = DEAD_SHARE_LINK_RETENTION_DAYS
    ids = await _seed(
        db_session,
        revoked=_link(revoked_at=_past(days)),
        revoked_recently=_link(revoked_at=_inside(days)),
        expired=_link(expires_at=_past(days)),
        expired_recently=_link(expires_at=_inside(days)),
        live=_link(),
        live_with_expiry=_link(expires_at=_NOW + timedelta(days=days)),
        used_up=_link(used_up=True),
        used_up_then_expired=_link(used_up=True, expires_at=_past(days)),
    )

    counts = await _sweep(db_session, "practicesharelink")

    assert counts == SweepCounts(eligible=3, deleted=3, blocked=1)
    assert await _remaining(db_session, "practicesharelink") == _left(
        ids, "revoked_recently", "expired_recently", "live", "live_with_expiry", "used_up"
    )


def _teardown(state: str, *, confirmed_at: datetime | None) -> VaultTeardownReceipt:
    return VaultTeardownReceipt(
        creek_job_id=f"job-{next(_serial)}",
        state=state,
        confirmed_at=confirmed_at,
        requested_at=_ANCIENT,
        updated_at=_ANCIENT,
    )


@pytest.mark.asyncio
async def test_confirmed_teardown_receipts_go_and_unconfirmed_ones_never_do(
    db_session: AsyncSession,
) -> None:
    """A confirmed receipt goes 90 days on; deleting and failed receipts are held."""
    days = TEARDOWN_RECEIPT_RETENTION_DAYS
    deleted = VaultActivationState.DELETED.value
    ids = await _seed(
        db_session,
        expired=_teardown(deleted, confirmed_at=_past(days)),
        recent=_teardown(deleted, confirmed_at=_inside(days)),
        deleting=_teardown(VaultActivationState.DELETING.value, confirmed_at=None),
        failed=_teardown(VaultActivationState.FAILED.value, confirmed_at=None),
    )

    counts = await _sweep(db_session, "vaultteardownreceipt")

    assert counts == SweepCounts(eligible=1, deleted=1, blocked=2)
    assert await _remaining(db_session, "vaultteardownreceipt") == _left(
        ids, "recent", "deleting", "failed"
    )


def _marker(restore_id: str, state: str, *, completed_at: datetime | None) -> RestoreMarker:
    return RestoreMarker(
        restore_id=restore_id, state=state, started_at=_ANCIENT, completed_at=completed_at
    )


@pytest.mark.asyncio
async def test_completed_restore_markers_go_unless_in_progress_or_named(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A complete marker goes a year on; in_progress and the one RESTORE_ID names stay."""
    monkeypatch.setenv(RESTORE_ID_ENV_VAR, _RESTORE_NAMED)
    days = RESTORE_MARKER_RETENTION_DAYS
    complete = RestoreState.COMPLETE.value
    ids = await _seed(
        db_session,
        expired=_marker("old", complete, completed_at=_past(days)),
        recent=_marker("recent", complete, completed_at=_inside(days)),
        running=_marker("running", RestoreState.IN_PROGRESS.value, completed_at=None),
        named=_marker(_RESTORE_NAMED, complete, completed_at=_past(days)),
    )

    counts = await _sweep(db_session, "restoremarker")

    assert counts == SweepCounts(eligible=1, deleted=1, blocked=2)
    assert await _remaining(db_session, "restoremarker") == _left(ids, "recent", "running", "named")


@pytest.mark.asyncio
async def test_without_restore_id_a_completed_marker_is_not_held(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no RESTORE_ID set, nothing is named, so only the state exemption holds."""
    monkeypatch.delenv(RESTORE_ID_ENV_VAR, raising=False)
    days = RESTORE_MARKER_RETENTION_DAYS
    await _seed(
        db_session,
        expired=_marker(_RESTORE_NAMED, RestoreState.COMPLETE.value, completed_at=_past(days)),
    )

    counts = await _sweep(db_session, "restoremarker")

    assert counts == SweepCounts(eligible=1, deleted=1, blocked=0)
    assert await _remaining(db_session, "restoremarker") == set()


# --------------------------------------------------------------------------
# The three sweeps that already existed, now called as services
# --------------------------------------------------------------------------


def _plan(created_at: datetime) -> EnergyPlan:
    return EnergyPlan(user_id=_USER, plan_json="{}", reason_code="ok", created_at=created_at)


@pytest.mark.asyncio
async def test_energy_plans_go_through_the_existing_service(db_session: AsyncSession) -> None:
    """The sweep calls the energy cleanup service on the ratified week."""
    days = ENERGY_PLAN_SWEEP_DAYS
    ids = await _seed(db_session, expired=_plan(_ago(days + 1)), recent=_plan(_ago(days - 1)))

    dry = await sweep_for("energyplan").run(db_session, datetime.now(UTC), dry_run=True)
    counts = await sweep_for("energyplan").run(db_session, datetime.now(UTC), dry_run=False)

    assert dry == SweepCounts(eligible=1, deleted=0, blocked=0)
    assert counts == SweepCounts(eligible=1, deleted=1, blocked=0)
    assert await _remaining(db_session, "energyplan") == _left(ids, "recent")


def _report(created_at: datetime) -> FeedbackReport:
    return FeedbackReport(
        user_id=_USER,
        public_id=f"report-{next(_serial)}",
        category="broken",
        impact="blocked",
        platform="ios",
        viewport_class="compact",
        summary="Something went wrong.",
        screen="journal.shelf",
        app_build="1.4.2",
        created_at=created_at,
    )


@pytest.mark.asyncio
async def test_feedback_reports_go_through_the_existing_service(db_session: AsyncSession) -> None:
    """The sweep calls the feedback cleanup service on the published window."""
    days = FEEDBACK_SWEEP_DAYS
    ids = await _seed(db_session, expired=_report(_ago(days + 1)), recent=_report(_ago(days - 1)))

    dry = await sweep_for("feedbackreport").run(db_session, datetime.now(UTC), dry_run=True)
    counts = await sweep_for("feedbackreport").run(db_session, datetime.now(UTC), dry_run=False)

    assert dry == SweepCounts(eligible=1, deleted=0, blocked=0)
    assert counts == SweepCounts(eligible=1, deleted=1, blocked=0)
    assert await _remaining(db_session, "feedbackreport") == _left(ids, "recent")


def _entry(deleted_at: datetime | None) -> JournalEntry:
    return JournalEntry(message="page", sender="user", user_id=_USER, deleted_at=deleted_at)


@pytest.mark.asyncio
async def test_soft_deleted_entries_go_through_the_existing_purge(
    db_session: AsyncSession,
) -> None:
    """The sweep calls the journal purge on the ratified window; live pages are untouched."""
    days = SOFT_DELETED_ENTRY_RETENTION_DAYS
    owed = _entry(_ago(days + 1))
    ids = await _seed(
        db_session,
        expired=_entry(_ago(days + 1)),
        recent=_entry(_ago(days - 1)),
        live=_entry(None),
        owed=owed,
    )
    assert owed.id is not None
    await _seed(
        db_session,
        retraction=VoiceDraftRetraction(
            user_id=_USER,
            journal_entry_id=owed.id,
            marginalia_id=next(_serial),
            state=VoiceDraftRetractionState.PENDING.value,
        ),
    )

    dry = await sweep_for(SOFT_DELETED_ENTRIES).run(db_session, datetime.now(UTC), dry_run=True)
    counts = await sweep_for(SOFT_DELETED_ENTRIES).run(db_session, datetime.now(UTC), dry_run=False)

    assert dry == SweepCounts(eligible=1, deleted=0, blocked=1)
    assert counts == SweepCounts(eligible=1, deleted=1, blocked=1)
    assert await _remaining(db_session, "journalentry") == _left(ids, "recent", "live", "owed")


# --------------------------------------------------------------------------
# Dry run, idempotence, and the registry agreeing with the sweep
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_dry_run_counts_and_changes_nothing(db_session: AsyncSession) -> None:
    """--dry-run reports what would go and leaves every row in place."""
    days = LOGIN_ATTEMPT_RETENTION_DAYS
    await _seed(
        db_session,
        expired=LoginAttempt(email="a@example.com", created_at=_past(days)),
        recent=LoginAttempt(email="a@example.com", created_at=_inside(days)),
    )

    counts = await _sweep(db_session, "loginattempt", dry_run=True)

    assert counts == SweepCounts(eligible=1, deleted=0, blocked=0)
    assert len(await _remaining(db_session, "loginattempt")) == len(("expired", "recent"))


@pytest.mark.asyncio
async def test_a_second_run_removes_nothing(db_session: AsyncSession) -> None:
    """Run straight after itself, the sweep finds nothing left to remove."""
    days = USAGE_LOG_RETENTION_DAYS
    await _seed(db_session, expired=_usage(_past(days)), recent=_usage(_inside(days)))

    first = await _sweep(db_session, "llmusagelog")
    second = await _sweep(db_session, "llmusagelog")

    assert first.deleted == 1
    assert second == SweepCounts(eligible=0, deleted=0, blocked=0)


def test_every_store_is_named_once() -> None:
    """One sweep per store, so a store's counts are reported exactly once."""
    stores = [sweep.store for sweep in SWEEPS]
    assert len(stores) == len(set(stores))
    with pytest.raises(KeyError):
        sweep_for("no-such-store")


def test_the_sweep_covers_exactly_the_rules_that_name_it() -> None:
    """Every rule naming the nightly sweep is applied by it, and nothing else is."""
    covered = {table for sweep in SWEEPS for table in sweep.covers}
    assert covered == set(nightly_rules())


def _all_rules() -> list[tuple[str, RetentionRule]]:
    rules: list[tuple[str, RetentionRule]] = []
    for name, rule in REGISTRY.items():
        rules.append((name, rule))
        if rule.soft_deleted is not None:
            rules.append((f"{name} (soft-deleted)", rule.soft_deleted))
    return rules


def test_every_bounded_rule_names_the_nightly_sweep() -> None:
    """No ratified period is left for nobody to apply (#3063 AC18)."""
    bounded = {name for name, rule in _all_rules() if rule.is_bounded()}
    assert bounded, "no bounded rule exists -- this guard is vacuous"
    for name in bounded:
        assert name in nightly_rules(), f"{name}: no sweep applies it"
    fixed = {name for name, rule in _all_rules() if rule.kind is RetentionKind.FIXED_DAYS}
    assert fixed <= bounded


def test_the_report_names_the_sweep_instead_of_flagging_it_missing() -> None:
    """The on-demand report no longer says no sweep applies a ratified period."""
    report = retention_report()
    assert "no sweep applies it yet" not in report
    gumroad = next(line for line in report.splitlines() if line.startswith("gumroadsale"))
    assert NIGHTLY_RETENTION_SWEEP in gumroad
