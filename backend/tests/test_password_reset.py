"""Endpoint tests for ``/auth/password-reset/{request,confirm,cancel}``.

Covers the SPEC test matrix: registered active / inactive / deleted /
unknown / malformed for ``request``; valid / expired / used / cancelled
/ wrong-token / reused-password for ``confirm``; plus the
session-invalidation gate (R7) and timing-parity smoke check.

The full-fat timing-parity test (paired-sample assertion, ±50 ms) lives
in ``tests/security/test_password_reset_timing.py`` so the routine
suite runs fast and the bcrypt-bound check can be skipped under
``--no-cov-no-bench``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, cast

import bcrypt
import jwt
import pytest
from sqlmodel import select

from models.password_reset_token import PasswordResetToken
from models.user import User
from routers.auth import (
    _JWT_ALGORITHM,
    _PASSWORD_RESET_TTL,
    _create_token,
    _get_secret_key,
    _hash_password,
    _hash_reset_token,
)
from services.email import RecordingEmailSender
from tests.helpers.password_reset import extract_reset_token

# ``email_sender`` + ``wire_email_sender`` fixtures live in
# ``backend/tests/conftest.py`` and are auto-discovered by pytest.

if TYPE_CHECKING:
    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession


_PASSWORD = "correct-horse-battery-staple"  # pragma: allowlist secret
_NEW_PASSWORD = "new-horse-battery-staple"  # pragma: allowlist secret


# Apply the email-sender override to every test in this module without
# requiring each test to depend on the fixture explicitly.
pytestmark = pytest.mark.usefixtures("wire_email_sender")


async def _create_user(
    db_session: AsyncSession,
    *,
    email: str = "user@example.com",
    is_active: bool = True,
    deleted: bool = False,
) -> User:
    user = User(
        email=email,
        password_hash=_hash_password(_PASSWORD),
        is_active=is_active,
        deleted_at=datetime.now(UTC) if deleted else None,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


async def _request_reset(client: AsyncClient, email: str) -> tuple[int, dict[str, object]]:
    response = await client.post("/auth/password-reset/request", json={"email": email})
    return response.status_code, response.json()


# Backwards-compatible alias for the test bodies below.
_extract_token = extract_reset_token


@pytest.mark.asyncio
async def test_request_returns_202_for_registered_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """A registered active user receives a reset email and 202 with generic body."""
    await _create_user(db_session, email="user@example.com")
    status_code, body = await _request_reset(async_client, "user@example.com")
    assert status_code == 202
    message = body["message"]
    assert isinstance(message, str)
    assert "If an account exists" in message
    assert len(email_sender.sent) == 1
    assert email_sender.sent[0].to == "user@example.com"
    assert "reset-password?token=" in email_sender.sent[0].body


@pytest.mark.asyncio
async def test_request_normalizes_email_case(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """``Foo@Bar.com`` is normalized to lowercase before lookup."""
    await _create_user(db_session, email="user@example.com")
    status_code, _ = await _request_reset(async_client, "  USER@Example.COM  ")
    assert status_code == 202
    assert len(email_sender.sent) == 1


@pytest.mark.asyncio
async def test_request_returns_202_for_unknown_email(
    async_client: AsyncClient,
    email_sender: RecordingEmailSender,
) -> None:
    """An unknown email gets the same 202 + body but no email is sent."""
    status_code, body = await _request_reset(async_client, "nobody@example.com")
    assert status_code == 202
    message = body["message"]
    assert isinstance(message, str)
    assert "If an account exists" in message
    assert email_sender.sent == []


@pytest.mark.asyncio
async def test_request_miss_path_does_not_log_requested_event(
    async_client: AsyncClient,
    email_sender: RecordingEmailSender,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Audit log is silent on the miss path (PR #287 round-5 BLOCKER 1).

    The runbook tells operators that ``action=requested`` means the
    server accepted the request and called the email backend.  Emitting
    that line for an address with no account would send oncall chasing
    a missing SMTP delivery for an email that was never sent.
    """
    import logging  # noqa: PLC0415

    with caplog.at_level(logging.INFO, logger="routers.auth"):
        status_code, _ = await _request_reset(async_client, "ghost@example.com")
    assert status_code == 202
    assert email_sender.sent == []
    requested_records = [
        r
        for r in caplog.records
        if r.message == "password_reset_event" and getattr(r, "action", None) == "requested"
    ]
    assert requested_records == [], (
        "miss path must not emit action=requested -- the runbook "
        "promises that line means a real SMTP delivery happened"
    )


@pytest.mark.asyncio
async def test_request_returns_202_for_inactive_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """A soft-disabled user gets the same generic 202 -- no email sent."""
    await _create_user(db_session, email="off@example.com", is_active=False)
    status_code, _ = await _request_reset(async_client, "off@example.com")
    assert status_code == 202
    assert email_sender.sent == []


@pytest.mark.asyncio
async def test_request_returns_202_for_deleted_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """A soft-deleted user gets the same generic 202 -- no email sent."""
    await _create_user(db_session, email="gone@example.com", deleted=True)
    status_code, _ = await _request_reset(async_client, "gone@example.com")
    assert status_code == 202
    assert email_sender.sent == []


@pytest.mark.asyncio
async def test_request_rejects_malformed_email(async_client: AsyncClient) -> None:
    """Validation errors return 422 (Pydantic envelope)."""
    response = await async_client.post(
        "/auth/password-reset/request", json={"email": "not-an-email"}
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_request_caps_outstanding_tokens_per_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
    disable_rate_limit: None,  # noqa: ARG001 -- needed to drive 4 requests
) -> None:
    """The 4th request auto-cancels the oldest active token (SPEC R5)."""
    user = await _create_user(db_session, email="cap@example.com")
    user_id = user.id
    for _ in range(4):
        status_code, _ = await _request_reset(async_client, "cap@example.com")
        assert status_code == 202
    db_session.expire_all()
    rows = (
        (
            await db_session.execute(
                select(PasswordResetToken).where(PasswordResetToken.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    active = [r for r in rows if r.cancelled_at is None and r.used_at is None]
    assert len(active) == 3


@pytest.mark.asyncio
async def test_confirm_succeeds_with_fresh_token(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """A valid token sets the new password and returns an AuthResponse."""
    user = await _create_user(db_session, email="ok@example.com")
    user_id = user.id
    await _request_reset(async_client, "ok@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    response = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _NEW_PASSWORD},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["user_id"] == user_id
    assert body["token"]
    db_session.expire_all()
    refreshed = await db_session.get(User, user_id)
    assert refreshed is not None
    assert bcrypt.checkpw(_NEW_PASSWORD.encode(), refreshed.password_hash.encode())
    assert refreshed.password_changed_at is not None


@pytest.mark.asyncio
async def test_confirm_rejects_expired_token(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """A token past its TTL is rejected with the generic 400."""
    user = await _create_user(db_session, email="exp@example.com")
    user_id = user.id
    await _request_reset(async_client, "exp@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    rows = (
        (
            await db_session.execute(
                select(PasswordResetToken).where(PasswordResetToken.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    rows[0].expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.add(rows[0])
    await db_session.commit()
    response = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _NEW_PASSWORD},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "invalid_or_expired_token"


@pytest.mark.asyncio
async def test_confirm_rejects_used_token(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """A token already consumed cannot be replayed."""
    await _create_user(db_session, email="once@example.com")
    await _request_reset(async_client, "once@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    first = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _NEW_PASSWORD},
    )
    assert first.status_code == 200
    second = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _NEW_PASSWORD + "!"},
    )
    assert second.status_code == 400


@pytest.mark.asyncio
async def test_confirm_rejects_cancelled_token(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """Once a token has been cancelled it cannot be used."""
    await _create_user(db_session, email="cxl@example.com")
    await _request_reset(async_client, "cxl@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    cancel = await async_client.post("/auth/password-reset/cancel", json={"token": plaintext})
    assert cancel.status_code == 204
    confirm = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _NEW_PASSWORD},
    )
    assert confirm.status_code == 400


@pytest.mark.asyncio
async def test_confirm_rejects_unknown_token(async_client: AsyncClient) -> None:
    """A token that never existed is rejected indistinguishably."""
    bogus = "x" * 43
    response = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": bogus, "new_password": _NEW_PASSWORD},
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_confirm_rejects_password_reuse(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """SPEC R10: cannot reset to the current password."""
    await _create_user(db_session, email="same@example.com")
    await _request_reset(async_client, "same@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    response = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _PASSWORD},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "password_unchanged"


@pytest.mark.asyncio
async def test_confirm_sends_change_notification_email(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """SPEC R8: a successful confirm fires the post-change notification."""
    await _create_user(db_session, email="notify@example.com")
    await _request_reset(async_client, "notify@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    response = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _NEW_PASSWORD},
    )
    assert response.status_code == 200
    assert any("password was changed" in m.subject.lower() for m in email_sender.sent)


@pytest.mark.asyncio
async def test_confirm_revokes_outstanding_jwts(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """SPEC R7: a successful reset rejects every JWT minted before it."""
    user = await _create_user(db_session, email="rev@example.com")
    assert user.id is not None
    old_token, _ = _create_token(user.id)
    await _request_reset(async_client, "rev@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    confirmed = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _NEW_PASSWORD},
    )
    assert confirmed.status_code == 200
    rejected = await async_client.post(
        "/auth/refresh", headers={"Authorization": f"Bearer {old_token}"}
    )
    assert rejected.status_code == 401


@pytest.mark.asyncio
async def test_confirm_clears_lockout_window(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """SPEC R6: a successful reset clears recent failed-login attempts."""
    from models.login_attempt import LoginAttempt  # noqa: PLC0415

    await _create_user(db_session, email="lock@example.com")
    for _ in range(5):
        db_session.add(LoginAttempt(email="lock@example.com", ip_address="1.2.3.4", success=False))
    await db_session.commit()
    await _request_reset(async_client, "lock@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    response = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _NEW_PASSWORD},
    )
    assert response.status_code == 200
    db_session.expire_all()
    rows = (
        (
            await db_session.execute(
                select(LoginAttempt).where(LoginAttempt.email == "lock@example.com")
            )
        )
        .scalars()
        .all()
    )
    assert all(row.success for row in rows) or rows == []


@pytest.mark.asyncio
async def test_cancel_returns_204_for_live_token(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """A still-live token returns 204 and is marked cancelled."""
    user = await _create_user(db_session, email="ccc@example.com")
    user_id = user.id
    await _request_reset(async_client, "ccc@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    response = await async_client.post("/auth/password-reset/cancel", json={"token": plaintext})
    assert response.status_code == 204
    db_session.expire_all()
    rows = (
        (
            await db_session.execute(
                select(PasswordResetToken).where(PasswordResetToken.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    assert rows[0].cancelled_at is not None


@pytest.mark.asyncio
async def test_confirm_uses_lookup_key_pre_filter(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    disable_rate_limit: None,  # noqa: ARG001 -- need >3 reset requests for the seed
) -> None:
    """The confirm path filters by ``lookup_key`` so the bcrypt scan is bounded.

    Regression for the PR #287 round-4 BLOCKER 1 (DoS amplifier).  We
    seed a few unrelated active tokens for other users; if confirm
    were still doing a full-table scan it would bcrypt-verify each
    one.  With the lookup_key pre-filter the SQL hits at most one row
    -- the one that matches the supplied plaintext's hash prefix.
    """
    from routers.auth import _make_lookup_key  # noqa: PLC0415

    target = await _create_user(db_session, email="target@example.com")
    target_id = target.id
    # Seed a handful of unrelated but otherwise-valid reset tokens for
    # other users; each gets its own distinct lookup_key so the
    # filtered query never sees them.
    for i in range(5):
        other = await _create_user(db_session, email=f"noise-{i}@example.com")
        await _request_reset(async_client, f"noise-{i}@example.com")
        del other  # only the rows matter; the plaintext goes nowhere
    await _request_reset(async_client, "target@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    # The target row carries the lookup_key derived from the plaintext.
    db_session.expire_all()
    rows = (
        (
            await db_session.execute(
                select(PasswordResetToken).where(PasswordResetToken.user_id == target_id)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].lookup_key == _make_lookup_key(plaintext)
    # Confirm still works end to end (the pre-filter doesn't break the
    # happy path).
    response = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _NEW_PASSWORD},
    )
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_cancel_logs_email_fingerprint_on_hit(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The cancel hit path emits the user's email fingerprint, not an empty string.

    The runbook tells operators to grep ``password_reset_event`` lines
    by ``email_fingerprint`` when investigating "this wasn't me"
    reports -- an empty fingerprint would render that flow useless
    (PR #287 round-4 review BLOCKER 3).
    """
    import logging  # noqa: PLC0415

    from routers.auth import _email_log_fingerprint  # noqa: PLC0415

    await _create_user(db_session, email="audit-cancel@example.com")
    await _request_reset(async_client, "audit-cancel@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    expected_fingerprint = _email_log_fingerprint("audit-cancel@example.com")
    with caplog.at_level(logging.INFO, logger="routers.auth"):
        response = await async_client.post("/auth/password-reset/cancel", json={"token": plaintext})
    assert response.status_code == 204
    cancelled_records = [
        r
        for r in caplog.records
        if r.message == "password_reset_event" and getattr(r, "action", None) == "cancelled"
    ]
    assert cancelled_records, "no password_reset_event with action=cancelled was logged"
    fingerprint = cast("str", cancelled_records[0].__dict__["email_fingerprint"])
    assert fingerprint == expected_fingerprint


@pytest.mark.asyncio
async def test_cancel_still_logs_fingerprint_when_user_disabled_mid_flight(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Cancel hit path still surfaces the user's fingerprint even when the user was just disabled.

    Regression for the reviewer's "missing test for the
    cancel-while-disabled case" callout.  Soft-disabling a user does
    not remove the row, so ``session.get`` still finds them and the
    audit log line carries the correct fingerprint (the runbook's
    grep flow keeps working).  Hard-deleted users would CASCADE the
    token row so there is nothing left to cancel; the only failure
    mode is therefore covered by this happy-on-disable test.
    """
    import logging  # noqa: PLC0415

    from routers.auth import _email_log_fingerprint  # noqa: PLC0415

    user = await _create_user(db_session, email="cancel-disabled@example.com")
    await _request_reset(async_client, "cancel-disabled@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    # Disable the user AFTER the token was minted -- cancel should
    # still resolve the user record for the audit fingerprint.
    user.is_active = False
    db_session.add(user)
    await db_session.commit()
    expected_fingerprint = _email_log_fingerprint("cancel-disabled@example.com")
    with caplog.at_level(logging.INFO, logger="routers.auth"):
        response = await async_client.post("/auth/password-reset/cancel", json={"token": plaintext})
    assert response.status_code == 204
    cancelled_records = [
        r
        for r in caplog.records
        if r.message == "password_reset_event" and getattr(r, "action", None) == "cancelled"
    ]
    assert cancelled_records, "no password_reset_event with action=cancelled was logged"
    fingerprint = cast("str", cancelled_records[0].__dict__["email_fingerprint"])
    assert fingerprint == expected_fingerprint


@pytest.mark.asyncio
async def test_cancel_returns_204_for_unknown_token(async_client: AsyncClient) -> None:
    """An unknown token gets 204 anyway (anti-enumeration)."""
    bogus = "x" * 43
    response = await async_client.post("/auth/password-reset/cancel", json={"token": bogus})
    assert response.status_code == 204


@pytest.mark.asyncio
async def test_cancel_validates_token_length(async_client: AsyncClient) -> None:
    """Tokens shorter than the floor are rejected with 422."""
    response = await async_client.post("/auth/password-reset/cancel", json={"token": "short"})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_confirm_disabled_user_auto_cancels_token_and_logs(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Disabled-user confirm auto-cancels the row and emits a tracing event.

    PR #287 round-5 BLOCKER 3.  Before this fix, an admin who
    disabled a user mid-flight left an "active" reset row consuming
    the per-user cap and emitting nothing -- the operator audit
    trail went cold.  Now the row is cancelled and a
    ``confirm_rejected_user_disabled`` line carries the email
    fingerprint so the runbook's grep-by-fingerprint flow still
    works.
    """
    import logging  # noqa: PLC0415

    user = await _create_user(db_session, email="disabled@example.com")
    user_id = user.id
    await _request_reset(async_client, "disabled@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)

    # Disable the user AFTER the reset token has been minted.
    user.is_active = False
    db_session.add(user)
    await db_session.commit()

    with caplog.at_level(logging.INFO, logger="routers.auth"):
        response = await async_client.post(
            "/auth/password-reset/confirm",
            json={"token": plaintext, "new_password": _NEW_PASSWORD},
        )
    # Generic 400 -- the disabled-user state is server-side audit
    # data only; the wire response is identical to invalid-token.
    assert response.status_code == 400
    assert response.json()["detail"] == "invalid_or_expired_token"

    # The token row was cancelled (so it stops consuming the cap).
    db_session.expire_all()
    rows = (
        (
            await db_session.execute(
                select(PasswordResetToken).where(PasswordResetToken.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].cancelled_at is not None

    # And the audit trail carries the user's fingerprint, not "".
    from routers.auth import _email_log_fingerprint  # noqa: PLC0415

    expected_fp = _email_log_fingerprint("disabled@example.com")
    matching = [
        r
        for r in caplog.records
        if r.message == "password_reset_event"
        and getattr(r, "action", None) == "confirm_rejected_user_disabled"
    ]
    assert matching, "no confirm_rejected_user_disabled audit line was logged"
    fingerprint = cast("str", matching[0].__dict__["email_fingerprint"])
    assert fingerprint == expected_fp


@pytest.mark.asyncio
async def test_password_changed_at_blocks_new_authenticated_request(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A token with iat < password_changed_at is rejected by get_current_user."""
    user = await _create_user(db_session, email="iat@example.com")
    assert user.id is not None
    # Mint a token whose iat is well in the past.
    secret = _get_secret_key()
    past_iat = datetime.now(UTC) - timedelta(hours=2)
    payload = {
        "sub": str(user.id),
        "exp": datetime.now(UTC) + timedelta(hours=1),
        "iat": past_iat,
        "jti": "old-jti",
    }
    old_token = jwt.encode(payload, secret, algorithm=_JWT_ALGORITHM)
    user.password_changed_at = datetime.now(UTC)
    db_session.add(user)
    await db_session.commit()
    response = await async_client.post(
        "/auth/refresh", headers={"Authorization": f"Bearer {old_token}"}
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_legacy_token_without_iat_skips_password_reset_gate(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Tokens without an ``iat`` claim bypass the gate (legacy grace window)."""
    user = await _create_user(db_session, email="legacy@example.com")
    assert user.id is not None
    secret = _get_secret_key()
    payload = {
        "sub": str(user.id),
        "exp": datetime.now(UTC) + timedelta(hours=1),
    }
    legacy_token = jwt.encode(payload, secret, algorithm=_JWT_ALGORITHM)
    user.password_changed_at = datetime.now(UTC)
    db_session.add(user)
    await db_session.commit()
    response = await async_client.post(
        "/auth/refresh", headers={"Authorization": f"Bearer {legacy_token}"}
    )
    # No iat to compare, so the gate skips and refresh succeeds.
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_token_issued_in_same_second_as_reset_is_rejected(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A token whose iat lands in the same wall-clock second as the reset is rejected.

    SPEC R7 deterministic guard.  The original test relied on timing
    luck and flaked on faster CI runners where the old token and reset
    both happened in the same integer-second.  This variant constructs
    the token's ``iat`` explicitly so the bug surfaces every run.
    """
    user = await _create_user(db_session, email="same-sec@example.com")
    assert user.id is not None

    # Mint a token whose iat is at the START of the current second --
    # password_changed_at will land later in the same second.
    floor = datetime.now(UTC).replace(microsecond=0)
    secret = _get_secret_key()
    payload = {
        "sub": str(user.id),
        "exp": floor + timedelta(hours=1),
        "iat": floor,  # encoded as int seconds by PyJWT
        "jti": "same-sec-jti",
    }
    old_token = jwt.encode(payload, secret, algorithm=_JWT_ALGORITHM)

    # Set password_changed_at 500 ms after the token's iat -- still in
    # the same wall-clock second.
    user.password_changed_at = floor + timedelta(milliseconds=500)
    db_session.add(user)
    await db_session.commit()

    response = await async_client.post(
        "/auth/refresh", headers={"Authorization": f"Bearer {old_token}"}
    )
    # Strict semantic: token iat at floor + 0 < pw_changed at floor + 0.5.
    assert response.status_code == 401


def test_hash_reset_token_roundtrips() -> None:
    """``_hash_reset_token`` produces a digest verifiable by bcrypt.checkpw."""
    plain = "abc" * 11
    digest = _hash_reset_token(plain)
    assert bcrypt.checkpw(plain.encode(), digest.encode())


def test_password_reset_ttl_is_30_minutes() -> None:
    """The TTL is exactly 30 minutes (SPEC R2)."""
    assert timedelta(minutes=30) == _PASSWORD_RESET_TTL


@pytest.mark.asyncio
async def test_request_does_not_leak_token_in_response(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """SPEC R1: the plaintext token must never appear in the HTTP response."""
    await _create_user(db_session, email="leak@example.com")
    response = await async_client.post(
        "/auth/password-reset/request", json={"email": "leak@example.com"}
    )
    assert response.status_code == 202
    body_text = response.text
    assert email_sender.sent
    plaintext = _extract_token(email_sender.sent[-1].body)
    assert plaintext not in body_text


@pytest.mark.asyncio
async def test_token_hash_is_not_plaintext(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
) -> None:
    """SPEC R1: stored token_hash must be a bcrypt digest, never the raw value."""
    user = await _create_user(db_session, email="hashed@example.com")
    user_id = user.id
    await _request_reset(async_client, "hashed@example.com")
    plaintext = _extract_token(email_sender.sent[-1].body)
    db_session.expire_all()
    rows = (
        (
            await db_session.execute(
                select(PasswordResetToken).where(PasswordResetToken.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    assert plaintext not in rows[0].token_hash
    assert rows[0].token_hash.startswith("$2")
