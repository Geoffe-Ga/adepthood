"""Membership events on POST /webhooks/gumroad/ping (#3259, cancel-timing).

The owner's decision (2026-10-14): "Change nothing at the cancel click;
restrict AI when the period ends; give access back on a restart."

* ``cancellation`` changes no access. It is stamped on the sale for the audit
  and never spends the sale's one-time refund/dispute claim.
* ``subscription_ended`` revokes the course access of the account the sale's
  licence binding names (ADR 0008 Decision 4), with a reason that restricts
  operator-funded AI exactly as a refund does. The sale stays unrefunded.
* ``subscription_restarted`` re-grants the access that sale's ending took,
  and nothing else: not one revoked by a refund, a dispute or an operator.
* A refund or dispute after a cancellation or an ending still applies fully.
* Replays move nothing, and out-of-order pings resolve by the events' own
  times (``ended_at`` / ``restarted_at``), latest wins.

A membership ping naming a token-pack sale (or any product on neither
allowlist) is wholly inert and logs ``cancellation_not_applicable``.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.entitlements import (
    PRODUCT_IDS_ENV_VAR,
    TOKEN_PACK_PRODUCT_IDS_ENV_VAR,
    TOKEN_PACK_SIZES_ENV_VAR,
    ai_access_revoked,
    has_course_access,
    revoke_entitlement_by_id,
)
from models.entitlement import Entitlement
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from models.license_binding import LicenseBinding
from models.user import User
from models.wallet_audit import REASON_GUMROAD_REFUND, WalletAudit
from schemas.gumroad import GumroadLicenseResult, GumroadPurchase

WEBHOOK_PATH = "/webhooks/gumroad/ping"
WEBHOOK_SECRET = "gumroad-cancellation-shared-secret-test-only"  # pragma: allowlist secret
WRONG_WEBHOOK_SECRET = "not-the-shared-secret"  # pragma: allowlist secret
WEBHOOK_SECRET_ENV_VAR = "GUMROAD_WEBHOOK_SECRET"  # pragma: allowlist secret

APTITUDE_PRODUCT_ID = "prod_course_abc"
SECOND_APTITUDE_PRODUCT_ID = "prod_course_xyz"
TOKEN_PACK_PRODUCT_ID = "prod_pack_small"
TOKEN_PACK_SIZE = 100

BUYER_EMAIL = "buyer@example.com"
RECIPIENT_EMAIL = "gift-recipient@example.com"
SIGNUP_PATH = "/auth/signup"
SIGNUP_PASSWORD = "securepassword123"  # pragma: allowlist secret
LICENSE_KEY = "CANCEL-SUITE-LICENSE-KEY"  # pragma: allowlist secret
LICENSE_USES = 1
VERIFY_SEAM = "domain.entitlements.verify_license"

SALE_ID = "S-100"
SECOND_SALE_ID = "S-101"
PACK_SALE_ID = "S-200"
UNKNOWN_SALE_ID = "S-999"

CANCELLATION_RESOURCE = "cancellation"
SUBSCRIPTION_ENDED_RESOURCE = "subscription_ended"
SUBSCRIPTION_RESTARTED_RESOURCE = "subscription_restarted"
REFUND_RESOURCE = "refund"
DISPUTE_RESOURCE = "dispute"

# Gumroad's own event times, in the order they happened.
FIRST_EVENT_AT = "2026-10-01T00:00:00Z"
SECOND_EVENT_AT = "2026-11-01T00:00:00Z"
THIRD_EVENT_AT = "2026-12-01T00:00:00Z"
# FIRST_EVENT_AT with no offset, as a ping might send it: read as UTC.
NAIVE_FIRST_EVENT_AT = "2026-10-01T00:00:00"
ADMIN_REASON = "operator revoked after a support ticket"

UNKNOWN_SALE_MARKER = "unknown_sale"
NOT_APPLICABLE_MARKER = "cancellation_not_applicable"
PREVIOUSLY_REVERSED_MARKER = "sale_previously_reversed"
SALE_NOT_BOUND_MARKER = "sale_not_bound"
RESTART_AFTER_REVERSAL_MARKER = "subscription_restart_after_reversal"
NOTHING_TO_RESTORE_MARKER = "subscription_restart_nothing_to_restore"
UNPARSED_TIME_MARKER = "subscription_event_time_unparsed"

EXPECTED_SALES_AFTER_ORPHAN_CANCELLATION = 2
# The row the ending revoked plus the fresh one the restart granted.
ROWS_AFTER_ONE_RESTART = 2


@pytest.fixture(autouse=True)
def gumroad_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure the shared secret and both product allowlists for every test."""
    monkeypatch.setenv(WEBHOOK_SECRET_ENV_VAR, WEBHOOK_SECRET)
    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, f"{APTITUDE_PRODUCT_ID},{SECOND_APTITUDE_PRODUCT_ID}")
    monkeypatch.setenv(TOKEN_PACK_PRODUCT_IDS_ENV_VAR, TOKEN_PACK_PRODUCT_ID)
    monkeypatch.setenv(TOKEN_PACK_SIZES_ENV_VAR, f"{TOKEN_PACK_PRODUCT_ID}:{TOKEN_PACK_SIZE}")


def _sale_payload(**overrides: str) -> dict[str, str]:
    """Build a form-encoded APTITUDE sale ping, with optional overrides."""
    payload = {
        "sale_id": SALE_ID,
        "product_id": APTITUDE_PRODUCT_ID,
        "email": BUYER_EMAIL,
        "resource_name": SALE_RESOURCE_NAME,
        "is_recurring_charge": "false",
        "refunded": "false",
    }
    payload.update(overrides)
    return payload


def _pack_payload(**overrides: str) -> dict[str, str]:
    """Build a token-pack sale ping, with optional overrides."""
    defaults = {"sale_id": PACK_SALE_ID, "product_id": TOKEN_PACK_PRODUCT_ID}
    return _sale_payload(**{**defaults, **overrides})


def _cancellation_payload(**overrides: str) -> dict[str, str]:
    """Build a cancellation ping for the default APTITUDE sale."""
    return _sale_payload(**{"resource_name": CANCELLATION_RESOURCE, **overrides})


def _ended_payload(ended_at: str = FIRST_EVENT_AT) -> dict[str, str]:
    """Build a ``subscription_ended`` ping carrying Gumroad's own event time."""
    return _sale_payload(resource_name=SUBSCRIPTION_ENDED_RESOURCE, ended_at=ended_at)


def _restarted_payload(restarted_at: str = SECOND_EVENT_AT) -> dict[str, str]:
    """Build a ``subscription_restarted`` ping carrying Gumroad's own event time."""
    return _sale_payload(resource_name=SUBSCRIPTION_RESTARTED_RESOURCE, restarted_at=restarted_at)


async def _ping(
    client: AsyncClient,
    payload: dict[str, str],
    secret: str = WEBHOOK_SECRET,
) -> Response:
    """POST one form-encoded ping with the given shared secret."""
    return await client.post(WEBHOOK_PATH, params={"secret": secret}, data=payload)


def _log_carries_marker(caplog: pytest.LogCaptureFixture, marker: str) -> bool:
    """Return True when ``marker`` appears in captured text or as a reason_code."""
    if marker in caplog.text:
        return True
    return any(getattr(record, "reason_code", None) == marker for record in caplog.records)


async def _persist_user(db_session: AsyncSession, email: str = BUYER_EMAIL) -> int:
    """Create and commit a user; return their non-null id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    if user.id is None:
        msg = "user id missing after commit"
        raise RuntimeError(msg)
    return user.id


async def _offering_balance(db_session: AsyncSession, user_id: int) -> int:
    """Return the user's persisted offering balance, read fresh."""
    result = await db_session.execute(
        select(User).where(col(User.id) == user_id).execution_options(populate_existing=True)
    )
    return int(result.scalars().one().offering_balance)


async def _reload_sale(db_session: AsyncSession, sale_id: str) -> GumroadSale:
    """Re-read one sale row from the database, bypassing the identity map."""
    result = await db_session.execute(
        select(GumroadSale)
        .where(col(GumroadSale.gumroad_sale_id) == sale_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


async def _entitlements(db_session: AsyncSession) -> list[Entitlement]:
    """Return every entitlement row, read fresh and ordered by insertion."""
    result = await db_session.execute(
        select(Entitlement).order_by(col(Entitlement.id)).execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _sole_entitlement(db_session: AsyncSession) -> Entitlement:
    """Return the single entitlement row, failing loudly if there is not exactly one."""
    entitlements = await _entitlements(db_session)
    assert len(entitlements) == 1
    return entitlements[0]


async def _refund_audits(db_session: AsyncSession) -> list[WalletAudit]:
    """Return only the ``gumroad_refund`` audit rows, oldest first."""
    result = await db_session.execute(
        select(WalletAudit)
        .where(col(WalletAudit.reason) == REASON_GUMROAD_REFUND)
        .order_by(col(WalletAudit.id))
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _active_entitlements(db_session: AsyncSession) -> list[Entitlement]:
    """Return only the entitlement rows that are still live (``revoked_at`` unset)."""
    return [row for row in await _entitlements(db_session) if row.revoked_at is None]


async def _count_sales(db_session: AsyncSession) -> int:
    """Return the number of GumroadSale rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(GumroadSale))
    return int(result.scalar_one())


async def _bindings(db_session: AsyncSession) -> list[tuple[int, str]]:
    """Return every ``(user_id, sale_id)`` binding, read fresh and ordered by insertion."""
    result = await db_session.execute(
        select(LicenseBinding)
        .order_by(col(LicenseBinding.id))
        .execution_options(populate_existing=True)
    )
    return [(row.user_id, row.gumroad_sale_id) for row in result.scalars().all()]


def _verify_stub_for(sale_id: str) -> object:
    """Build a verify_license stand-in reporting ``LICENSE_KEY`` as ``sale_id``."""

    async def _verify(
        product_id: str,
        license_key: str,
        **_kwargs: object,
    ) -> GumroadLicenseResult | None:
        if license_key != LICENSE_KEY or product_id != APTITUDE_PRODUCT_ID:
            return None
        return GumroadLicenseResult(
            success=True,
            uses=LICENSE_USES,
            purchase=GumroadPurchase(
                email=BUYER_EMAIL,
                product_id=APTITUDE_PRODUCT_ID,
                sale_id=sale_id,
                refunded=False,
                chargebacked=False,
            ),
        )

    return _verify


async def _live_member(client: AsyncClient, db_session: AsyncSession) -> int:
    """A buyer whose APTITUDE sale ping granted (and bound) their access."""
    user_id = await _persist_user(db_session)
    await _ping(client, _sale_payload())
    assert await has_course_access(db_session, user_id)
    return user_id


async def _assert_ai_restricted(db_session: AsyncSession, user_id: int) -> None:
    """The member has no live access and is refused operator-funded AI."""
    db_session.expire_all()
    assert await has_course_access(db_session, user_id) is False
    assert await ai_access_revoked(db_session, user_id) is True


async def _assert_live(db_session: AsyncSession, user_id: int) -> None:
    """The member holds live access and keeps operator-funded AI."""
    db_session.expire_all()
    assert await has_course_access(db_session, user_id) is True
    assert await ai_access_revoked(db_session, user_id) is False


# --- AC1: the cancel click changes no access --------------------------------


@pytest.mark.asyncio
async def test_cancellation_changes_no_access_and_is_recorded_for_audit(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The member keeps the course and AI; the sale records the click and nothing else."""
    user_id = await _live_member(async_client, db_session)

    response = await _ping(async_client, _cancellation_payload(cancelled_at=FIRST_EVENT_AT))

    assert response.status_code == HTTPStatus.OK
    await _assert_live(db_session, user_id)
    assert (await _sole_entitlement(db_session)).revoked_at is None
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.subscription_cancelled_at is not None
    assert sale.revocation_processed_at is None
    assert sale.refunded is False
    assert await _bindings(db_session) == [(user_id, SALE_ID)]


@pytest.mark.asyncio
async def test_a_replayed_cancellation_keeps_the_first_audit_stamp(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A redelivery, even one carrying a later time, records nothing new."""
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _cancellation_payload(cancelled_at=FIRST_EVENT_AT))
    stamped = (await _reload_sale(db_session, SALE_ID)).subscription_cancelled_at

    second = await _ping(async_client, _cancellation_payload(cancelled_at=SECOND_EVENT_AT))

    assert second.status_code == HTTPStatus.OK
    assert stamped is not None
    assert (await _reload_sale(db_session, SALE_ID)).subscription_cancelled_at == stamped
    await _assert_live(db_session, user_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("money_event", [REFUND_RESOURCE, DISPUTE_RESOURCE])
async def test_a_refund_after_a_cancellation_applies_in_full(
    async_client: AsyncClient,
    db_session: AsyncSession,
    money_event: str,
) -> None:
    """AC4: the cancellation spent no claim, so the money event still revokes and flags."""
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _cancellation_payload())

    response = await _ping(async_client, _sale_payload(resource_name=money_event))

    assert response.status_code == HTTPStatus.OK
    await _assert_ai_restricted(db_session, user_id)
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None


# --- AC2: the period ending restricts AI ------------------------------------


@pytest.mark.asyncio
async def test_subscription_ended_revokes_access_and_restricts_ai_without_a_refund(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The ending restricts AI like a refund, but the money was kept and the claim is unspent."""
    user_id = await _live_member(async_client, db_session)

    response = await _ping(async_client, _ended_payload())

    assert response.status_code == HTTPStatus.OK
    await _assert_ai_restricted(db_session, user_id)
    assert (await _sole_entitlement(db_session)).revoked_at is not None
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.refunded is False
    assert sale.revocation_processed_at is None
    assert sale.subscription_ended_at is not None
    assert await _refund_audits(db_session) == []
    assert await _bindings(db_session) == [(user_id, SALE_ID)]


@pytest.mark.asyncio
async def test_a_replayed_ending_revokes_exactly_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """AC5: the same ``subscription_ended`` twice keeps one revoked row, unchanged."""
    await _live_member(async_client, db_session)
    first = await _ping(async_client, _ended_payload())
    revoked_at = (await _sole_entitlement(db_session)).revoked_at

    second = await _ping(async_client, _ended_payload())

    assert [first.status_code, second.status_code] == [HTTPStatus.OK, HTTPStatus.OK]
    assert revoked_at is not None
    assert (await _sole_entitlement(db_session)).revoked_at == revoked_at


@pytest.mark.asyncio
@pytest.mark.real_license_gate
async def test_the_ending_revokes_the_account_bound_to_the_sale_even_when_its_email_differs(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ending follows the binding, not the buyer's address (ADR 0008 Decision 4)."""
    buyer_id = await _persist_user(db_session)
    monkeypatch.setattr(VERIFY_SEAM, _verify_stub_for(SALE_ID))
    signup = await async_client.post(
        SIGNUP_PATH,
        json={"email": RECIPIENT_EMAIL, "password": SIGNUP_PASSWORD, "license_key": LICENSE_KEY},
    )
    assert signup.status_code == HTTPStatus.OK
    recipient_id = int(signup.json()["user_id"])
    await _ping(async_client, _sale_payload())

    response = await _ping(async_client, _ended_payload())

    assert response.status_code == HTTPStatus.OK
    entitlement = await _sole_entitlement(db_session)
    assert entitlement.user_id == recipient_id
    assert entitlement.revoked_at is not None
    assert await has_course_access(db_session, buyer_id) is False
    assert await _bindings(db_session) == [(recipient_id, SALE_ID)]


@pytest.mark.asyncio
async def test_a_replayed_sale_ping_does_not_reinstate_an_ended_membership(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A redelivered original sale ping must never undo an ending.

    The ending spends no reversal claim, so the sale's membership stamps are
    what the sale-dispatch guard has to read; otherwise the redelivery would
    find no active grant and mint a fresh one.
    """
    caplog.set_level(logging.DEBUG)
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _ended_payload())

    response = await _ping(async_client, _sale_payload())

    assert response.status_code == HTTPStatus.OK
    assert await _active_entitlements(db_session) == []
    assert len(await _entitlements(db_session)) == 1
    assert await has_course_access(db_session, user_id) is False
    assert _log_carries_marker(caplog, PREVIOUSLY_REVERSED_MARKER)


@pytest.mark.asyncio
@pytest.mark.parametrize("money_event", [REFUND_RESOURCE, DISPUTE_RESOURCE])
async def test_a_refund_after_an_ending_still_flags_the_sale_and_keeps_ai_restricted(
    async_client: AsyncClient,
    db_session: AsyncSession,
    money_event: str,
) -> None:
    """AC4: an ending does not disarm the refund; the sale is flagged and AI stays off."""
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _ended_payload())

    response = await _ping(async_client, _sale_payload(resource_name=money_event))

    assert response.status_code == HTTPStatus.OK
    await _assert_ai_restricted(db_session, user_id)
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None


# --- AC3: a restart gives back what the ending took --------------------------


@pytest.mark.asyncio
async def test_a_restart_after_an_ending_regrants_and_lifts_the_ai_restriction(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The ended member is live again, on a fresh row linked to the same sale."""
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _ended_payload(FIRST_EVENT_AT))

    response = await _ping(async_client, _restarted_payload(SECOND_EVENT_AT))

    assert response.status_code == HTTPStatus.OK
    await _assert_live(db_session, user_id)
    active = await _active_entitlements(db_session)
    assert len(active) == 1
    assert active[0].user_id == user_id
    assert active[0].source_sale_id == (await _reload_sale(db_session, SALE_ID)).id


@pytest.mark.asyncio
async def test_a_replayed_restart_regrants_exactly_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """AC5: the same restart twice leaves one live row beside the one the ending revoked."""
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _ended_payload(FIRST_EVENT_AT))
    await _ping(async_client, _restarted_payload(SECOND_EVENT_AT))

    second = await _ping(async_client, _restarted_payload(SECOND_EVENT_AT))

    assert second.status_code == HTTPStatus.OK
    assert len(await _active_entitlements(db_session)) == 1
    assert len(await _entitlements(db_session)) == ROWS_AFTER_ONE_RESTART
    await _assert_live(db_session, user_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("money_event", [REFUND_RESOURCE, DISPUTE_RESOURCE])
async def test_a_restart_never_regrants_access_the_money_took_back(
    async_client: AsyncClient,
    db_session: AsyncSession,
    money_event: str,
) -> None:
    """A refunded or disputed sale stays revoked."""
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _sale_payload(resource_name=money_event))

    response = await _ping(async_client, _restarted_payload())

    assert response.status_code == HTTPStatus.OK
    await _assert_ai_restricted(db_session, user_id)
    assert await _active_entitlements(db_session) == []


@pytest.mark.asyncio
async def test_a_restart_after_an_ending_and_a_refund_does_not_regrant(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Ended, then refunded: the restart finds the money gone and gives nothing back."""
    caplog.set_level(logging.DEBUG)
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _ended_payload(FIRST_EVENT_AT))
    await _ping(async_client, _sale_payload(resource_name=REFUND_RESOURCE))

    response = await _ping(async_client, _restarted_payload(SECOND_EVENT_AT))

    assert response.status_code == HTTPStatus.OK
    await _assert_ai_restricted(db_session, user_id)
    assert _log_carries_marker(caplog, RESTART_AFTER_REVERSAL_MARKER)


@pytest.mark.asyncio
async def test_a_restart_never_regrants_an_operator_revocation(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Ended, restarted, then revoked by an operator: a later restart leaves that alone."""
    caplog.set_level(logging.DEBUG)
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _ended_payload(FIRST_EVENT_AT))
    await _ping(async_client, _restarted_payload(SECOND_EVENT_AT))
    live = (await _active_entitlements(db_session))[0]
    assert live.id is not None
    await revoke_entitlement_by_id(
        db_session, user_id, live.id, reason=ADMIN_REASON, actor_admin_id=None
    )

    response = await _ping(async_client, _restarted_payload(THIRD_EVENT_AT))

    assert response.status_code == HTTPStatus.OK
    await _assert_ai_restricted(db_session, user_id)
    assert _log_carries_marker(caplog, NOTHING_TO_RESTORE_MARKER)


@pytest.mark.asyncio
async def test_a_restart_with_no_ending_changes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A live member's restart has nothing to restore: still one live row."""
    user_id = await _live_member(async_client, db_session)

    response = await _ping(async_client, _restarted_payload())

    assert response.status_code == HTTPStatus.OK
    assert len(await _entitlements(db_session)) == 1
    await _assert_live(db_session, user_id)


@pytest.mark.asyncio
async def test_a_restart_of_an_unbound_sale_grants_nobody(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A sale no account holds has no access to give back, nor any to end."""
    caplog.set_level(logging.DEBUG)
    await _ping(async_client, _sale_payload())
    await _ping(async_client, _ended_payload(FIRST_EVENT_AT))

    response = await _ping(async_client, _restarted_payload(SECOND_EVENT_AT))

    assert response.status_code == HTTPStatus.OK
    assert await _entitlements(db_session) == []
    assert _log_carries_marker(caplog, SALE_NOT_BOUND_MARKER)


# --- AC5/AC6: out-of-order delivery resolves by the latest event -------------


@pytest.mark.asyncio
async def test_ended_then_restarted_then_ended_leaves_the_membership_ended(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """AC6: each step takes effect, and the final ending restricts AI again."""
    user_id = await _live_member(async_client, db_session)

    await _ping(async_client, _ended_payload(FIRST_EVENT_AT))
    await _assert_ai_restricted(db_session, user_id)
    await _ping(async_client, _restarted_payload(SECOND_EVENT_AT))
    await _assert_live(db_session, user_id)
    await _ping(async_client, _ended_payload(THIRD_EVENT_AT))

    await _assert_ai_restricted(db_session, user_id)
    assert len(await _entitlements(db_session)) == ROWS_AFTER_ONE_RESTART
    assert await _active_entitlements(db_session) == []


@pytest.mark.asyncio
async def test_a_stale_ending_delivered_after_a_newer_restart_is_outranked(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Restarted at T2 arrives first; the ending from T1 arrives late and moves nothing."""
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _restarted_payload(SECOND_EVENT_AT))

    response = await _ping(async_client, _ended_payload(FIRST_EVENT_AT))

    assert response.status_code == HTTPStatus.OK
    await _assert_live(db_session, user_id)
    assert len(await _entitlements(db_session)) == 1


@pytest.mark.asyncio
async def test_a_restart_then_a_later_ending_means_ended(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Restarted at T1, then ended at T2: the ending is latest and wins."""
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _restarted_payload(FIRST_EVENT_AT))

    await _ping(async_client, _ended_payload(SECOND_EVENT_AT))

    await _assert_ai_restricted(db_session, user_id)


@pytest.mark.asyncio
async def test_a_stale_restart_delivered_after_a_newer_ending_is_outranked(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Ended at T2 lands first; a restart from T1 arrives late and restores nothing.

    The late restart's time carries no offset, so it is also the case that
    proves an offset-less time is read as UTC rather than rejected.
    """
    user_id = await _live_member(async_client, db_session)
    await _ping(async_client, _ended_payload(SECOND_EVENT_AT))

    response = await _ping(async_client, _restarted_payload(NAIVE_FIRST_EVENT_AT))

    assert response.status_code == HTTPStatus.OK
    await _assert_ai_restricted(db_session, user_id)
    assert (await _reload_sale(db_session, SALE_ID)).subscription_restarted_at is not None


@pytest.mark.asyncio
async def test_an_ending_with_an_unreadable_event_time_falls_back_to_receipt(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A ping whose time cannot be read is still applied, at the moment it arrived."""
    caplog.set_level(logging.DEBUG)
    user_id = await _live_member(async_client, db_session)

    response = await _ping(async_client, _ended_payload("not-a-timestamp"))

    assert response.status_code == HTTPStatus.OK
    await _assert_ai_restricted(db_session, user_id)
    assert _log_carries_marker(caplog, UNPARSED_TIME_MARKER)


@pytest.mark.asyncio
async def test_an_ending_with_no_event_time_falls_back_to_receipt(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A ping that carries no ``ended_at`` at all is applied at the moment it arrived."""
    user_id = await _live_member(async_client, db_session)

    response = await _ping(async_client, _sale_payload(resource_name=SUBSCRIPTION_ENDED_RESOURCE))

    assert response.status_code == HTTPStatus.OK
    await _assert_ai_restricted(db_session, user_id)


# --- the lookup and product-class contract ----------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "resource_name",
    [CANCELLATION_RESOURCE, SUBSCRIPTION_ENDED_RESOURCE, SUBSCRIPTION_RESTARTED_RESOURCE],
)
async def test_a_membership_event_for_an_unknown_sale_changes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    resource_name: str,
) -> None:
    """A ping naming a sale_id we never stored is logged and moves nothing.

    Sent twice, because the first persists the orphan ping under that id and
    a lookup forgetting ``resource_name == "sale"`` would then find it.
    """
    caplog.set_level(logging.DEBUG)
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    orphan = _sale_payload(sale_id=UNKNOWN_SALE_ID, resource_name=resource_name)

    first = await _ping(async_client, orphan)
    second = await _ping(async_client, orphan)

    assert [first.status_code, second.status_code] == [HTTPStatus.OK, HTTPStatus.OK]
    assert (await _sole_entitlement(db_session)).revoked_at is None
    assert await _count_sales(db_session) == EXPECTED_SALES_AFTER_ORPHAN_CANCELLATION
    stored = await _reload_sale(db_session, UNKNOWN_SALE_ID)
    assert stored.resource_name == resource_name
    assert stored.subscription_cancelled_at is None
    assert stored.subscription_ended_at is None
    assert stored.subscription_restarted_at is None
    assert _log_carries_marker(caplog, UNKNOWN_SALE_MARKER)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "resource_name",
    [CANCELLATION_RESOURCE, SUBSCRIPTION_ENDED_RESOURCE, SUBSCRIPTION_RESTARTED_RESOURCE],
)
async def test_a_membership_event_for_a_token_pack_is_inert(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    resource_name: str,
) -> None:
    """A one-time pack is no membership: credits stay, no stamp, no claim."""
    caplog.set_level(logging.DEBUG)
    user_id = await _persist_user(db_session)
    await _ping(async_client, _pack_payload())

    response = await _ping(async_client, _pack_payload(resource_name=resource_name))

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == TOKEN_PACK_SIZE
    sale = await _reload_sale(db_session, PACK_SALE_ID)
    assert sale.revocation_processed_at is None
    assert sale.subscription_cancelled_at is None
    assert sale.subscription_ended_at is None
    assert sale.subscription_restarted_at is None
    assert _log_carries_marker(caplog, NOT_APPLICABLE_MARKER)


@pytest.mark.asyncio
async def test_refund_after_an_inert_pack_cancellation_still_claws_back(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A stray cancellation cannot shield a pack from a genuine later refund."""
    user_id = await _persist_user(db_session)
    await _ping(async_client, _pack_payload())
    await _ping(async_client, _pack_payload(resource_name=CANCELLATION_RESOURCE))

    response = await _ping(async_client, _pack_payload(resource_name=REFUND_RESOURCE))

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == 0
    audits = await _refund_audits(db_session)
    assert len(audits) == 1
    assert audits[0].user_id == user_id
    assert audits[0].delta == Decimal(-TOKEN_PACK_SIZE)
    sale = await _reload_sale(db_session, PACK_SALE_ID)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None


@pytest.mark.asyncio
async def test_forged_membership_event_is_rejected_and_changes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An unauthenticated ending is a 401 that leaves access alive."""
    user_id = await _live_member(async_client, db_session)

    response = await _ping(async_client, _ended_payload(), secret=WRONG_WEBHOOK_SECRET)

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    await _assert_live(db_session, user_id)
    assert (await _reload_sale(db_session, SALE_ID)).subscription_ended_at is None
