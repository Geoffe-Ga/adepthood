"""A revoked entitlement restricts AI features, and nothing else (#1938, B21 E1).

The owner's decision (2026-10-07): "revocation restricts AI features only
(journal/export/deletion open)." Course reading, habits and practice stay open
too -- the decision names AI features only. Those free-core routes are pinned,
for the revoked state as well, by ``tests/test_free_core_access_invariants.py``.

What *is* restricted is narrow, and this suite pins its edges:

* **Only revocation restricts.** A member whose ``course_access`` entitlement
  has been revoked (a revoked row, and no live one) may not start a new AI call
  that BotMason credits would pay for. An account with no entitlement row at
  all -- a legacy account from before the license gate, or one the operator
  has never comped -- is not revoked and is not blocked. A revoke followed by a
  re-grant is live again. An operator comp is a live row; an operator's manual
  revocation of it is a revocation like any other.
* **Only money returned, or the operator, restricts -- for now.** A refund or a
  dispute restricts; so does an operator's revocation. A cancelled or ended
  membership does *not*: when AI should stop for a member who cancels (at the
  click, or at period end) is the owner's pending decision "cancel-timing"
  (#1938), and until it is made the user-protective default is that it does not
  stop. A row revoked before the reason was recorded on it is read the same
  protective way.
* **Only operator-funded calls.** A writer's own key pays its own provider, so
  a revoked member who brings one is admitted exactly as before. The client-
  direct path (ADR 0009, page reading on the device) never reaches this server
  and is out of reach of any server-side rule.
* **One error.** ``403 ai_access_revoked``, before the minute bucket, the slot,
  the wallet or any dial: a refusal charges nothing, writes no audit or usage
  row and dials nobody. The page it was asked of stays saved.
* **One chokepoint, plus its admission.** The payer gate
  (:func:`services.generation_access.require_ai_payer`) answers the refusal at
  every AI route's admission; :func:`services.wallet.preflight_deduction`, the
  one function that charges, refuses on its own as well, so a future route that
  reaches the wallet without the gate still cannot spend for a revoked member.
* **Care is never revoked.** A distressed writer refused for revocation still
  receives the local care surface (NORTH-STAR section 10), as one refused for
  payment does.
"""

from __future__ import annotations

from datetime import UTC, datetime
from http import HTTPStatus
from typing import Final

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, delete, select

from domain.entitlements import (
    AI_ACCESS_REVOKED,
    PRODUCT_IDS_ENV_VAR,
    REASON_CANCELLATION,
    REASON_REFUND,
    ai_access_revoked,
    grant_course_access,
    grant_manual_course_access,
    has_course_access,
    revoke_course_access,
    revoke_entitlement_by_id,
)
from models.entitlement import Entitlement
from models.generation_slot import GenerationSlot
from models.llm_usage_log import LLMUsageLog
from models.user import User
from models.wallet_audit import WalletAudit
from services.generation_access import payer_refusal, require_ai_payer
from services.wallet import preflight_deduction
from tests.incident.test_privacy_suspension import (
    _DISTRESS_BODY,
    _MINUTE_BUCKET_ROUTES,
    _call_route,
    arm_anthropic,
    count_rows,
    record_admission,
    record_minute_bucket,
    seed_entry,
    signup,
    wallet,
)
from tests.provider_transport import ANTHROPIC_KEY

_AI_ROUTES: Final = ("resonance", "essay", "detect", "transcribe")
# Purchased credits on top of the default monthly allowance, so a refusal can
# only be about revocation and never about an empty wallet.
_FUNDED_BALANCE: Final = 5
_ADMIN_REASON: Final = "comped for the beta"
_REVOKED_BODY: Final = {"detail": AI_ACCESS_REVOKED}
_BYOK_HEADER: Final = "X-LLM-API-Key"
_MONTHLY_CAP_ENV: Final = "BOTMASON_MONTHLY_CAP"
_WEBHOOK_PATH: Final = "/webhooks/gumroad/ping"
_WEBHOOK_SECRET_ENV: Final = "GUMROAD_WEBHOOK_SECRET"  # pragma: allowlist secret
_WEBHOOK_SECRET: Final = "revocation-suite-shared-secret"  # pragma: allowlist secret
_APTITUDE_PRODUCT: Final = "prod_course_revocation"
_SALE_ID: Final = "S-revocation-1"


async def _fund(session: AsyncSession, user_id: int) -> None:
    """Give the account purchased credits on top of its monthly allowance."""
    user = await session.get(User, user_id)
    assert user is not None
    user.offering_balance = _FUNDED_BALANCE
    session.add(user)
    await session.commit()


async def _drop_entitlements(session: AsyncSession, user_id: int) -> None:
    """Make the account a legacy one: no entitlement row of any kind."""
    await session.execute(delete(Entitlement).where(col(Entitlement.user_id) == user_id))
    await session.commit()


async def _legacy_user(session: AsyncSession, name: str) -> int:
    """An account inserted directly, as before the license gate existed: no entitlement."""
    user = User(email=f"{name}@example.com", password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


# --- the predicate: only a revocation restricts ------------------------------


@pytest.mark.asyncio
async def test_an_account_with_no_entitlement_row_is_not_revoked(
    db_session: AsyncSession,
) -> None:
    """A legacy account never held an entitlement, so it has none to lose."""
    user_id = await _legacy_user(db_session, "legacy_predicate")

    assert not await has_course_access(db_session, user_id)
    assert not await ai_access_revoked(db_session, user_id)


@pytest.mark.asyncio
async def test_a_live_entitlement_is_not_revoked(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A signed-up member holds a live row and is not restricted."""
    _, user_id, _ = await signup(async_client, "live_predicate")

    assert await has_course_access(db_session, user_id)
    assert not await ai_access_revoked(db_session, user_id)


@pytest.mark.asyncio
async def test_a_refunded_entitlement_is_revoked(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A refund (or a dispute, which shares it) leaves a revoked row and no live one."""
    _, user_id, _ = await signup(async_client, "revoked_predicate_refund")

    await revoke_course_access(db_session, user_id, REASON_REFUND)

    assert await ai_access_revoked(db_session, user_id)


@pytest.mark.asyncio
async def test_a_cancelled_membership_does_not_restrict_ai_pending_cancel_timing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A cancellation is not yet a restriction: owner decision "cancel-timing" (#1938) is pending.

    ``cancellation`` and ``subscription_ended`` share one handler and one
    reason code. Until the owner decides whether AI stops at the click or at
    period end, the user-protective default is that it does not stop at all.
    """
    _, user_id, _ = await signup(async_client, "revoked_predicate_cancellation")

    await revoke_course_access(db_session, user_id, REASON_CANCELLATION)

    assert not await has_course_access(db_session, user_id)
    assert not await ai_access_revoked(db_session, user_id)


@pytest.mark.asyncio
async def test_a_revocation_with_no_recorded_reason_does_not_restrict(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A row revoked before reasons were recorded cannot be told from a cancellation.

    So it is read the user-protective way: not a restriction.
    """
    _, user_id, _ = await signup(async_client, "revoked_predicate_unrecorded")
    row = (
        await db_session.execute(select(Entitlement).where(col(Entitlement.user_id) == user_id))
    ).scalar_one()
    row.revoked_at = datetime.now(UTC)
    db_session.add(row)
    await db_session.commit()

    assert not await ai_access_revoked(db_session, user_id)


@pytest.mark.asyncio
async def test_an_operator_revocation_from_before_reason_codes_still_restricts(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An admin revocation always recorded who revoked it, so an older one is still recognised."""
    _, user_id, _ = await signup(async_client, "revoked_predicate_legacy_admin")
    row = (
        await db_session.execute(select(Entitlement).where(col(Entitlement.user_id) == user_id))
    ).scalar_one()
    row.revoked_at = datetime.now(UTC)
    row.entitlement_metadata = {"revocation_reason": _ADMIN_REASON, "revoked_by_admin_id": None}
    db_session.add(row)
    await db_session.commit()

    assert await ai_access_revoked(db_session, user_id)


@pytest.mark.asyncio
async def test_a_regrant_after_revocation_restores_access(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The live row wins: revoked history alone does not restrict a re-granted member."""
    _, user_id, _ = await signup(async_client, "regrant_predicate")
    await revoke_course_access(db_session, user_id, REASON_REFUND)
    user = await db_session.get(User, user_id)
    assert user is not None

    await grant_course_access(db_session, user)

    assert not await ai_access_revoked(db_session, user_id)


@pytest.mark.asyncio
async def test_an_operator_comp_is_live_and_its_manual_revocation_restricts(
    db_session: AsyncSession,
) -> None:
    """An admin comp is a live row; revoking that row by id is a revocation."""
    user_id = await _legacy_user(db_session, "comped_predicate")
    user = await db_session.get(User, user_id)
    assert user is not None

    comp = await grant_manual_course_access(
        db_session, user, reason=_ADMIN_REASON, actor_admin_id=None
    )
    assert not await ai_access_revoked(db_session, user_id)
    assert comp.id is not None

    await revoke_entitlement_by_id(
        db_session, user_id, comp.id, reason=_ADMIN_REASON, actor_admin_id=None
    )
    assert await ai_access_revoked(db_session, user_id)


# --- the routes: 403 ai_access_revoked, before anything is spent --------------


@pytest.mark.asyncio
@pytest.mark.parametrize("route", _AI_ROUTES)
async def test_a_revoked_member_is_refused_every_operator_funded_ai_route(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    """403 ``ai_access_revoked`` with a funded wallet: no charge, slot, minute, usage or dial."""
    stub = arm_anthropic(monkeypatch)
    minute = record_minute_bucket(monkeypatch)
    admitted = record_admission(monkeypatch)
    headers, user_id, _ = await signup(async_client, f"revoked_{route}")
    await _fund(db_session, user_id)
    await revoke_course_access(db_session, user_id, REASON_REFUND)
    before_wallet = await wallet(db_session, user_id)
    before_audit = await count_rows(db_session, WalletAudit)

    resp = await _call_route(route, async_client, db_session, headers, user_id)

    assert resp.status_code == HTTPStatus.FORBIDDEN, resp.text
    assert resp.json() == _REVOKED_BODY
    assert await wallet(db_session, user_id) == before_wallet
    assert await count_rows(db_session, WalletAudit) == before_audit
    assert await count_rows(db_session, GenerationSlot) == 0
    assert await count_rows(db_session, LLMUsageLog) == 0
    assert stub.request_count == 0
    assert admitted == []
    if route in _MINUTE_BUCKET_ROUTES:
        assert minute == []


@pytest.mark.asyncio
@pytest.mark.parametrize("entitlement", ["live", "none"])
@pytest.mark.parametrize("route", _AI_ROUTES)
async def test_live_and_legacy_members_keep_todays_ai_access(
    async_client: AsyncClient,
    db_session: AsyncSession,
    route: str,
    entitlement: str,
) -> None:
    """Control: a live member and one with no entitlement row at all are both admitted."""
    headers, user_id, _ = await signup(async_client, f"admitted_{entitlement}_{route}")
    if entitlement == "none":
        await _drop_entitlements(db_session, user_id)
        assert not await has_course_access(db_session, user_id)

    resp = await _call_route(route, async_client, db_session, headers, user_id)

    assert resp.status_code == HTTPStatus.OK, resp.text


@pytest.mark.asyncio
@pytest.mark.parametrize("route", _AI_ROUTES)
async def test_a_cancelled_member_keeps_ai_access_pending_cancel_timing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    route: str,
) -> None:
    """A cancelled membership is admitted on every AI route until "cancel-timing" is decided."""
    headers, user_id, _ = await signup(async_client, f"cancelled_{route}")
    await revoke_course_access(db_session, user_id, REASON_CANCELLATION)

    resp = await _call_route(route, async_client, db_session, headers, user_id)

    assert resp.status_code == HTTPStatus.OK, resp.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("resource", "restricted"),
    [("refund", True), ("dispute", True), ("cancellation", False), ("subscription_ended", False)],
)
async def test_each_gumroad_reversal_ping_restricts_ai_or_not(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    resource: str,
    *,
    restricted: bool,
) -> None:
    """Through the real webhook: money returned restricts AI; a lapse does not (yet)."""
    monkeypatch.setenv(_WEBHOOK_SECRET_ENV, _WEBHOOK_SECRET)
    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, _APTITUDE_PRODUCT)
    user_id = await _legacy_user(db_session, "webhook_member")
    sale = {
        "sale_id": _SALE_ID,
        "product_id": _APTITUDE_PRODUCT,
        "email": "webhook_member@example.com",
        "resource_name": "sale",
        "is_recurring_charge": "false",
        "refunded": "false",
    }
    granted = await async_client.post(_WEBHOOK_PATH, params={"secret": _WEBHOOK_SECRET}, data=sale)
    assert granted.status_code == HTTPStatus.OK, granted.text
    assert await has_course_access(db_session, user_id)

    reversed_ = await async_client.post(
        _WEBHOOK_PATH,
        params={"secret": _WEBHOOK_SECRET},
        data={**sale, "resource_name": resource},
    )

    assert reversed_.status_code == HTTPStatus.OK, reversed_.text
    db_session.expire_all()
    assert not await has_course_access(db_session, user_id)
    assert await ai_access_revoked(db_session, user_id) is restricted


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["resonance", "essay"])
async def test_a_revoked_unfunded_member_with_their_own_key_is_answered(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    """A valid personal key pays its own provider: 200, and the wallet is never touched."""
    stub = arm_anthropic(monkeypatch)
    monkeypatch.setenv(_MONTHLY_CAP_ENV, "0")
    headers, user_id, _ = await signup(async_client, f"byok_revoked_{route}")
    await revoke_course_access(db_session, user_id, REASON_REFUND)
    assert await ai_access_revoked(db_session, user_id)
    before_wallet = await wallet(db_session, user_id)
    assert before_wallet[1] == 0
    before_audit = await count_rows(db_session, WalletAudit)

    resp = await _call_route(
        route, async_client, db_session, {**headers, _BYOK_HEADER: ANTHROPIC_KEY}, user_id
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert stub.request_count > 0
    assert await wallet(db_session, user_id) == before_wallet
    assert await count_rows(db_session, WalletAudit) == before_audit


@pytest.mark.asyncio
async def test_the_refused_page_stays_saved(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A revoked member's resonance refusal leaves the entry exactly as written."""
    headers, user_id, _ = await signup(async_client, "revoked_page_kept")
    written = await async_client.post(
        "/journal/", json={"message": "Still mine to keep."}, headers=headers
    )
    assert written.status_code == HTTPStatus.CREATED, written.text
    entry_id = written.json()["id"]
    await revoke_course_access(db_session, user_id, REASON_REFUND)

    refused = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    kept = await async_client.get(f"/journal/{entry_id}", headers=headers)

    assert refused.status_code == HTTPStatus.FORBIDDEN, refused.text
    assert refused.json() == _REVOKED_BODY
    assert kept.status_code == HTTPStatus.OK, kept.text
    assert kept.json()["message"] == "Still mine to keep."


@pytest.mark.asyncio
async def test_a_distressed_revoked_member_still_receives_care(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Care never depends on the entitlement: a flagged entry gets the care surface, free."""
    stub = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "revoked_care")
    await revoke_course_access(db_session, user_id, REASON_REFUND)
    entry_id = await seed_entry(db_session, user_id, body=_DISTRESS_BODY)
    before_audit = await count_rows(db_session, WalletAudit)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["care"] is not None
    assert body["care"]["resources"]
    assert body["marginalia"] == []
    assert await count_rows(db_session, WalletAudit) == before_audit
    assert stub.request_count == 0


# --- the seams themselves ----------------------------------------------------


@pytest.mark.asyncio
async def test_the_payer_gate_refuses_a_revoked_member_without_a_key(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The admission answers 403, and ``payer_refusal`` hands it back so care can ride."""
    _, user_id, _ = await signup(async_client, "gate_revoked")
    await _fund(db_session, user_id)
    await revoke_course_access(db_session, user_id, REASON_REFUND)

    with pytest.raises(HTTPException) as raised:
        await require_ai_payer(db_session, user_id, None)
    handed_back = await payer_refusal(db_session, user_id, None)

    assert raised.value.status_code == HTTPStatus.FORBIDDEN
    assert raised.value.detail == AI_ACCESS_REVOKED
    assert handed_back is not None
    assert handed_back.status_code == HTTPStatus.FORBIDDEN
    assert handed_back.detail == AI_ACCESS_REVOKED


@pytest.mark.asyncio
async def test_a_revoked_member_with_their_own_key_is_admitted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A writer's own key pays its own provider: nothing operator-funded is started."""
    _, user_id, _ = await signup(async_client, "gate_byok")
    await revoke_course_access(db_session, user_id, REASON_REFUND)

    await require_ai_payer(db_session, user_id, ANTHROPIC_KEY)

    assert await payer_refusal(db_session, user_id, ANTHROPIC_KEY) is None


@pytest.mark.asyncio
async def test_the_charging_chokepoint_refuses_a_revoked_member_on_its_own(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``preflight_deduction`` refuses even when no admission gate ran first."""
    _, user_id, _ = await signup(async_client, "chokepoint_revoked")
    await _fund(db_session, user_id)
    await revoke_course_access(db_session, user_id, REASON_REFUND)
    before_wallet = await wallet(db_session, user_id)
    before_audit = await count_rows(db_session, WalletAudit)

    with pytest.raises(HTTPException) as raised:
        await preflight_deduction(db_session, user_id)
    await db_session.rollback()

    assert raised.value.status_code == HTTPStatus.FORBIDDEN
    assert raised.value.detail == AI_ACCESS_REVOKED
    assert await wallet(db_session, user_id) == before_wallet
    assert await count_rows(db_session, WalletAudit) == before_audit


@pytest.mark.asyncio
async def test_the_charging_chokepoint_still_charges_a_legacy_member(
    db_session: AsyncSession,
) -> None:
    """Control: no entitlement row is not a revocation, so the deduction goes through."""
    user_id = await _legacy_user(db_session, "chokepoint_legacy")

    spent = await preflight_deduction(db_session, user_id)

    assert spent is not None
