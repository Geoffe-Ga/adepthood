"""End-to-end happy-path test for the password-recovery flow.

Drives the full backend journey: signup -> request -> simulate email
delivery (recording fake) -> confirm -> verify the user is logged in
on the new device AND every prior session is revoked (R7) -- in a
single test that mirrors the user-visible sequence.

The frontend equivalent lives in
``frontend/src/features/Auth/__tests__/ForgotPasswordScreen.test.tsx``
+ ``ResetPasswordScreen.test.tsx`` and the AuthContext suite.  Backend
parity here is what catches a regression where the wire shape drifts
from what the screens expect.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from services.email import RecordingEmailSender
from tests.helpers.password_reset import extract_reset_token

# ``email_sender`` + ``wire_email_sender`` fixtures live in
# ``backend/tests/conftest.py`` and are auto-discovered by pytest.

if TYPE_CHECKING:
    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession


_ORIGINAL_PASSWORD = "old-horse-battery-staple"  # pragma: allowlist secret
_NEW_PASSWORD = "fresh-horse-battery-staple"  # pragma: allowlist secret


pytestmark = pytest.mark.usefixtures("wire_email_sender")


# Local alias to keep the existing test body unchanged.
_extract_reset_token = extract_reset_token


@pytest.mark.asyncio
async def test_signup_request_confirm_flow_logs_in_and_revokes_old_session(
    async_client: AsyncClient,
    db_session: AsyncSession,  # noqa: ARG001 -- fixture for DB lifecycle
    email_sender: RecordingEmailSender,
) -> None:
    """Drive the full forgotten-password flow end to end."""
    signup = await async_client.post(
        "/auth/signup",
        json={"email": "e2e@example.com", "password": _ORIGINAL_PASSWORD},
    )
    assert signup.status_code == 200, signup.text
    signup_body = signup.json()
    assert signup_body["user_id"] > 0
    original_token = signup_body["token"]

    reset_request = await async_client.post(
        "/auth/password-reset/request", json={"email": "e2e@example.com"}
    )
    assert reset_request.status_code == 202

    assert email_sender.sent
    plaintext = _extract_reset_token(email_sender.sent[-1].body)

    confirm = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": plaintext, "new_password": _NEW_PASSWORD},
    )
    assert confirm.status_code == 200, confirm.text
    new_token = confirm.json()["token"]
    assert new_token
    assert new_token != original_token

    # SPEC R7: the original signup token must now be rejected because
    # ``password_changed_at`` was advanced.
    revoked_refresh = await async_client.post(
        "/auth/refresh", headers={"Authorization": f"Bearer {original_token}"}
    )
    assert revoked_refresh.status_code == 401

    # The new token works.
    fresh_refresh = await async_client.post(
        "/auth/refresh", headers={"Authorization": f"Bearer {new_token}"}
    )
    assert fresh_refresh.status_code == 200

    # Login with the new password succeeds.
    login_new = await async_client.post(
        "/auth/login",
        json={"email": "e2e@example.com", "password": _NEW_PASSWORD},
    )
    assert login_new.status_code == 200

    # Login with the old password fails -- it was actually changed.
    login_old = await async_client.post(
        "/auth/login",
        json={"email": "e2e@example.com", "password": _ORIGINAL_PASSWORD},
    )
    assert login_old.status_code == 401

    # SPEC R8: a change-notification email was sent to the registered
    # address after the reset completed.
    assert any(
        msg.to == "e2e@example.com" and "changed" in msg.subject.lower()
        for msg in email_sender.sent
    )
