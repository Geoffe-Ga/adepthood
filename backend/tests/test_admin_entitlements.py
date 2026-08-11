"""Tests for the admin entitlement override + user summary endpoints.

These three routes are the operator's alternative to a SQL console, so the
properties that matter are as much about the paper trail as the mutation:

- the auth gate (anonymous / non-admin / admin) on every route, so the new
  surface inherits the same per-user boundary as the rest of ``admin.py``;
- a manual grant leaving ``source_sale_id`` NULL and carrying its reason in
  the entitlement's metadata bag -- a comp with no recorded reason is exactly
  the SQL-console situation these endpoints exist to replace;
- revoke addressing one entitlement *by id*, 404ing on a row that does not
  exist, belongs to another user, or is already revoked -- the domain's
  ``revoke_course_access`` is a silent no-op by design, which is right for a
  webhook and wrong for an operator who needs to know their click landed;
- a blank or whitespace-only reason rejected on both mutations, since a
  required field that accepts ``" "`` is not required;
- the summary reporting the caps it advertises (20 wallet rows, 10 sales) and
  matching sales by email rather than user id, because a Gumroad purchase made
  under a different address is precisely what an operator is looking for.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.entitlement import Entitlement, EntitlementKind
from models.gumroad_sale import GumroadSale
from models.user import User
from models.wallet_audit import WalletAudit

# The summary's advertised caps. Asserted rather than assumed: a truncation
# nobody verified is how an operator ends up reading a partial history as a
# complete one.
_WALLET_AUDIT_LIMIT = 20
_GUMROAD_SALE_LIMIT = 10


async def _signup(
    client: AsyncClient, email: str = "user@example.com", password: str = "secret12345"
) -> tuple[int, dict[str, str]]:
    """Create a user and return ``(user_id, auth headers)``."""
    resp = await client.post("/auth/signup", json={"email": email, "password": password})
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return int(body["user_id"]), {"Authorization": f"Bearer {body['token']}"}


async def _promote(db_session: AsyncSession, email: str) -> None:
    """Flip ``is_admin`` for a user by email."""
    await db_session.execute(update(User).where(col(User.email) == email).values(is_admin=True))
    await db_session.commit()


async def _signup_admin(
    client: AsyncClient, db_session: AsyncSession, email: str = "admin@example.com"
) -> tuple[int, dict[str, str]]:
    """Sign up + promote a user; return ``(user_id, auth headers)``."""
    user_id, headers = await _signup(client, email=email)
    await _promote(db_session, email)
    return user_id, headers


async def _make_user(db_session: AsyncSession, email: str) -> int:
    """Insert a User row directly (no rate-limited HTTP signup) and return its id."""
    user = User(email=email, password_hash="x")
    db_session.add(user)
    await db_session.flush()
    assert user.id is not None
    await db_session.commit()
    return user.id


async def _active_entitlements(db_session: AsyncSession, user_id: int) -> list[Entitlement]:
    """Read committed active entitlements for ``user_id``.

    ``expire_all`` first so the assertion reads what the request committed
    rather than a stale identity-map copy.
    """
    db_session.expire_all()
    result = await db_session.execute(
        select(Entitlement).where(
            col(Entitlement.user_id) == user_id,
            col(Entitlement.revoked_at).is_(None),
        )
    )
    return list(result.scalars().all())


# --- auth gate ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_entitlement_grant_requires_admin(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Anonymous and non-admin callers cannot comp course access."""
    target = await _make_user(db_session, "target@example.com")
    payload = {"kind": "course_access", "reason": "beta cohort comp"}

    anon = await async_client.post(f"/admin/users/{target}/entitlements", json=payload)
    assert anon.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}

    _, plain_headers = await _signup(async_client, email="plain@example.com")
    denied = await async_client.post(
        f"/admin/users/{target}/entitlements", json=payload, headers=plain_headers
    )
    assert denied.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}

    assert await _active_entitlements(db_session, target) == []


@pytest.mark.asyncio
async def test_entitlement_revoke_requires_admin(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A non-admin cannot revoke someone's access."""
    target = await _make_user(db_session, "revoke-target@example.com")
    entitlement = Entitlement(user_id=target)
    db_session.add(entitlement)
    await db_session.commit()
    await db_session.refresh(entitlement)

    _, plain_headers = await _signup(async_client, email="plain-revoke@example.com")
    denied = await async_client.request(
        "DELETE",
        f"/admin/users/{target}/entitlements/{entitlement.id}",
        json={"reason": "abuse"},
        headers=plain_headers,
    )
    assert denied.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}
    assert len(await _active_entitlements(db_session, target)) == 1


@pytest.mark.asyncio
async def test_user_summary_requires_admin(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The summary exposes another user's email and history; admin only."""
    target = await _make_user(db_session, "summary-target@example.com")

    anon = await async_client.get(f"/admin/users/{target}/summary")
    assert anon.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}

    _, plain_headers = await _signup(async_client, email="plain-summary@example.com")
    denied = await async_client.get(f"/admin/users/{target}/summary", headers=plain_headers)
    assert denied.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}


# --- grant -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manual_grant_records_reason_and_no_sale_link(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A comp writes an unlinked entitlement carrying its reason.

    ``source_sale_id`` NULL is what distinguishes a manual comp from a paid
    grant in every later report; the reason is the whole point of routing this
    through an endpoint instead of a SQL console.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target = await _make_user(db_session, "comped@example.com")

    resp = await async_client.post(
        f"/admin/users/{target}/entitlements",
        json={"kind": "course_access", "reason": "beta cohort comp"},
        headers=admin_headers,
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text

    rows = await _active_entitlements(db_session, target)
    assert len(rows) == 1
    granted = rows[0]
    assert granted.kind == EntitlementKind.COURSE_ACCESS
    assert granted.source_sale_id is None
    assert granted.entitlement_metadata.get("reason") == "beta cohort comp"


@pytest.mark.asyncio
async def test_manual_grant_is_idempotent(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Granting twice leaves one active row, not a duplicate.

    The partial unique index would reject the second insert with a 500; the
    operator should instead see the grant they asked for.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target = await _make_user(db_session, "twice@example.com")
    payload = {"kind": "course_access", "reason": "support escalation"}

    first = await async_client.post(
        f"/admin/users/{target}/entitlements", json=payload, headers=admin_headers
    )
    second = await async_client.post(
        f"/admin/users/{target}/entitlements", json=payload, headers=admin_headers
    )
    assert first.status_code == HTTPStatus.CREATED, first.text
    assert second.status_code == HTTPStatus.CREATED, second.text
    assert len(await _active_entitlements(db_session, target)) == 1


@pytest.mark.asyncio
async def test_manual_grant_rejects_a_blank_reason(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Whitespace is not a reason.

    A required field that accepts ``"   "`` is not required, and the resulting
    row is indistinguishable from the undocumented SQL write this replaces.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target = await _make_user(db_session, "blank-reason@example.com")

    for reason in ("", "   "):
        resp = await async_client.post(
            f"/admin/users/{target}/entitlements",
            json={"kind": "course_access", "reason": reason},
            headers=admin_headers,
        )
        assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, resp.text

    assert await _active_entitlements(db_session, target) == []


@pytest.mark.asyncio
async def test_manual_grant_404s_for_an_unknown_user(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Comping a nonexistent id is an operator mistake worth reporting."""
    _, admin_headers = await _signup_admin(async_client, db_session)
    resp = await async_client.post(
        "/admin/users/999999/entitlements",
        json={"kind": "course_access", "reason": "typo in the id"},
        headers=admin_headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


# --- revoke ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_revoke_marks_the_row_revoked(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Revoking sets ``revoked_at`` and frees the active slot."""
    _, admin_headers = await _signup_admin(async_client, db_session)
    target = await _make_user(db_session, "revoke-me@example.com")
    entitlement = Entitlement(user_id=target)
    db_session.add(entitlement)
    await db_session.commit()
    await db_session.refresh(entitlement)

    resp = await async_client.request(
        "DELETE",
        f"/admin/users/{target}/entitlements/{entitlement.id}",
        json={"reason": "refund processed manually"},
        headers=admin_headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert await _active_entitlements(db_session, target) == []


@pytest.mark.asyncio
async def test_revoke_writes_its_reason_to_the_row(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The revocation's audit lands on the entitlement, not only in a log line.

    A revoked row outlives application-log retention, and an operator asking
    "why did this person lose access?" months later should be able to read the
    answer off the row rather than reconstruct it from a log search. Logging
    alone is a materially weaker guarantee than the one this surface promises.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target = await _make_user(db_session, "audited-revoke@example.com")
    entitlement = Entitlement(user_id=target)
    db_session.add(entitlement)
    await db_session.commit()
    await db_session.refresh(entitlement)
    entitlement_id = entitlement.id

    resp = await async_client.request(
        "DELETE",
        f"/admin/users/{target}/entitlements/{entitlement_id}",
        json={"reason": "chargeback filed with the bank"},
        headers=admin_headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text

    db_session.expire_all()
    revoked = await db_session.get(Entitlement, entitlement_id)
    assert revoked is not None
    assert revoked.revoked_at is not None
    assert revoked.entitlement_metadata.get("revocation_reason") == (
        "chargeback filed with the bank"
    )
    assert revoked.entitlement_metadata.get("revoked_by_admin_id") is not None


@pytest.mark.asyncio
async def test_revoke_preserves_the_grant_reason(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Revoking records why access ended without erasing why it began.

    Both stories matter to the operator reading the row, so the revocation
    merges into the metadata bag under its own keys rather than replacing it.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target = await _make_user(db_session, "grant-then-revoke@example.com")

    granted = await async_client.post(
        f"/admin/users/{target}/entitlements",
        json={"kind": "course_access", "reason": "beta cohort comp"},
        headers=admin_headers,
    )
    assert granted.status_code == HTTPStatus.CREATED, granted.text
    entitlement_id = granted.json()["id"]

    revoked_resp = await async_client.request(
        "DELETE",
        f"/admin/users/{target}/entitlements/{entitlement_id}",
        json={"reason": "cohort ended"},
        headers=admin_headers,
    )
    assert revoked_resp.status_code == HTTPStatus.OK, revoked_resp.text

    db_session.expire_all()
    row = await db_session.get(Entitlement, entitlement_id)
    assert row is not None
    assert row.entitlement_metadata.get("reason") == "beta cohort comp"
    assert row.entitlement_metadata.get("revocation_reason") == "cohort ended"


@pytest.mark.asyncio
async def test_grant_honours_the_requested_kind(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The ``kind`` field is applied, not accepted and discarded.

    ``EntitlementKind`` has one member today, so this cannot yet produce a
    visibly wrong grant. It pins the wiring anyway: the partial unique index is
    on ``(user_id, kind)``, so the moment a second kind exists, a lookup that
    ignored kind would refresh the wrong row and one kind would silently
    overwrite another.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target = await _make_user(db_session, "kinded@example.com")

    resp = await async_client.post(
        f"/admin/users/{target}/entitlements",
        json={"kind": EntitlementKind.COURSE_ACCESS.value, "reason": "explicit kind"},
        headers=admin_headers,
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    assert resp.json()["kind"] == EntitlementKind.COURSE_ACCESS.value

    rows = await _active_entitlements(db_session, target)
    assert [row.kind for row in rows] == [EntitlementKind.COURSE_ACCESS]


@pytest.mark.asyncio
async def test_grant_rejects_an_unknown_kind(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A kind outside the enum is refused rather than coerced to the default.

    Silently substituting ``course_access`` for whatever was asked is how an
    operator ends up believing they granted something they did not.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target = await _make_user(db_session, "bad-kind@example.com")

    resp = await async_client.post(
        f"/admin/users/{target}/entitlements",
        json={"kind": "botmason_tokens", "reason": "not a real kind yet"},
        headers=admin_headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert await _active_entitlements(db_session, target) == []


@pytest.mark.asyncio
async def test_revoke_404s_when_already_revoked(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A second revoke reports 404 rather than silently succeeding.

    ``domain.entitlements.revoke_course_access`` no-ops when nothing is active
    -- correct for a webhook replay, wrong for an operator, who would read a
    200 as "access removed" without it ever having been.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target = await _make_user(db_session, "double-revoke@example.com")
    entitlement = Entitlement(user_id=target, revoked_at=datetime.now(UTC))
    db_session.add(entitlement)
    await db_session.commit()
    await db_session.refresh(entitlement)

    resp = await async_client.request(
        "DELETE",
        f"/admin/users/{target}/entitlements/{entitlement.id}",
        json={"reason": "again"},
        headers=admin_headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_revoke_404s_for_another_users_entitlement(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The path's ``user_id`` must own the entitlement being revoked.

    Without this the id alone addresses the row, and a mistyped user id
    revokes a stranger's access while reporting success against the intended
    account.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    owner = await _make_user(db_session, "owner@example.com")
    bystander = await _make_user(db_session, "bystander@example.com")
    entitlement = Entitlement(user_id=owner)
    db_session.add(entitlement)
    await db_session.commit()
    await db_session.refresh(entitlement)

    resp = await async_client.request(
        "DELETE",
        f"/admin/users/{bystander}/entitlements/{entitlement.id}",
        json={"reason": "wrong user"},
        headers=admin_headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert len(await _active_entitlements(db_session, owner)) == 1


@pytest.mark.asyncio
async def test_revoke_rejects_a_blank_reason(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Revocation needs a recorded why, same as a grant."""
    _, admin_headers = await _signup_admin(async_client, db_session)
    target = await _make_user(db_session, "revoke-blank@example.com")
    entitlement = Entitlement(user_id=target)
    db_session.add(entitlement)
    await db_session.commit()
    await db_session.refresh(entitlement)

    resp = await async_client.request(
        "DELETE",
        f"/admin/users/{target}/entitlements/{entitlement.id}",
        json={"reason": "  "},
        headers=admin_headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert len(await _active_entitlements(db_session, target)) == 1


# --- summary -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_summary_matches_sales_whose_email_differs_only_by_case(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A sale typed with different capitalisation still belongs to the account.

    ``GumroadSale.email`` is stored exactly as Gumroad reports it, while
    ``User.email`` is normalised at signup — so the two legitimately differ in
    case for the same person. ``routers/gumroad._find_user_by_email`` already
    folds case for this reason; a summary that did not would show
    ``gumroad_sales: []`` for a buyer who *did* pay, which is precisely the
    account most likely to be the subject of the support ticket that sent the
    operator here.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target_email = "jane.doe@example.com"
    target = await _make_user(db_session, target_email)
    db_session.add(
        GumroadSale(
            gumroad_sale_id="mixed-case-sale",
            product_id="prod-1",
            # As Gumroad reports it: the address the buyer typed.
            email="Jane.Doe@Example.com",
            resource_name="sale",
        )
    )
    await db_session.commit()

    resp = await async_client.get(f"/admin/users/{target}/summary", headers=admin_headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    sale_ids = {sale["gumroad_sale_id"] for sale in resp.json()["gumroad_sales"]}
    assert sale_ids == {"mixed-case-sale"}


@pytest.mark.asyncio
async def test_summary_reports_the_users_access_picture(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The summary answers "what does this account actually have?" in one call."""
    _, admin_headers = await _signup_admin(async_client, db_session)
    target_email = "summary@example.com"
    target = await _make_user(db_session, target_email)
    db_session.add(Entitlement(user_id=target, entitlement_metadata={"reason": "comp"}))
    db_session.add(
        GumroadSale(
            gumroad_sale_id="sale-1",
            product_id="prod-1",
            email=target_email,
            resource_name="sale",
        )
    )
    await db_session.commit()

    resp = await async_client.get(f"/admin/users/{target}/summary", headers=admin_headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()

    assert body["email"] == target_email
    assert body["created_at"]
    assert len(body["entitlements"]) == 1
    assert len(body["gumroad_sales"]) == 1
    assert body["gumroad_sales"][0]["gumroad_sale_id"] == "sale-1"
    assert "offering_balance" in body
    assert "monthly_messages_used" in body
    assert body["wallet_audit"] == []


@pytest.mark.asyncio
async def test_summary_caps_and_orders_its_history(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Wallet rows cap at 20 and sales at 10, newest first.

    An operator reading a silently truncated history as a complete one is the
    failure this pins: the caps are only safe if they are the *newest* rows.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target_email = "busy@example.com"
    target = await _make_user(db_session, target_email)

    base = datetime.now(UTC) - timedelta(days=60)
    for index in range(_WALLET_AUDIT_LIMIT + 5):
        db_session.add(
            WalletAudit(
                user_id=target,
                bucket="offering",
                reason=f"entry-{index}",
                delta=Decimal(1),
                balance_before=Decimal(index),
                balance_after=Decimal(index + 1),
                created_at=base + timedelta(minutes=index),
            )
        )
    for index in range(_GUMROAD_SALE_LIMIT + 3):
        db_session.add(
            GumroadSale(
                gumroad_sale_id=f"sale-{index}",
                product_id="prod-1",
                email=target_email,
                resource_name="sale",
                created_at=base + timedelta(minutes=index),
            )
        )
    await db_session.commit()

    resp = await async_client.get(f"/admin/users/{target}/summary", headers=admin_headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()

    assert len(body["wallet_audit"]) == _WALLET_AUDIT_LIMIT
    assert len(body["gumroad_sales"]) == _GUMROAD_SALE_LIMIT
    # Newest first: the last-written rows must be the ones that survived.
    assert body["wallet_audit"][0]["reason"] == f"entry-{_WALLET_AUDIT_LIMIT + 4}"
    assert body["gumroad_sales"][0]["gumroad_sale_id"] == f"sale-{_GUMROAD_SALE_LIMIT + 2}"


@pytest.mark.asyncio
async def test_summary_matches_sales_by_email_not_user_id(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Sales join on email, and another address's sales must not leak in.

    ``GumroadSale`` carries no user id, so email is the only link -- which is
    exactly why the match has to be exact rather than partial.
    """
    _, admin_headers = await _signup_admin(async_client, db_session)
    target_email = "mine@example.com"
    target = await _make_user(db_session, target_email)
    db_session.add(
        GumroadSale(
            gumroad_sale_id="mine-1", product_id="p", email=target_email, resource_name="sale"
        )
    )
    db_session.add(
        GumroadSale(
            gumroad_sale_id="theirs-1",
            product_id="p",
            email="other@example.com",
            resource_name="sale",
        )
    )
    await db_session.commit()

    resp = await async_client.get(f"/admin/users/{target}/summary", headers=admin_headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    sale_ids = {sale["gumroad_sale_id"] for sale in resp.json()["gumroad_sales"]}
    assert sale_ids == {"mine-1"}


@pytest.mark.asyncio
async def test_summary_404s_for_an_unknown_user(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An unknown id reports 404 rather than an empty-but-plausible summary."""
    _, admin_headers = await _signup_admin(async_client, db_session)
    resp = await async_client.get("/admin/users/999999/summary", headers=admin_headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
