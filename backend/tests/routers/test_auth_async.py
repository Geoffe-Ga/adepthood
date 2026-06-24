"""Async-offload tests: bcrypt CPU work must run off the event-loop thread.

Guards §5.3 (event-loop blocking) for ``routers.auth``: every bcrypt hash
or verify reachable from an ``async def`` handler must execute via
``asyncio.to_thread`` so the ~250 ms cost-12 work does not pin the single
worker and serialize concurrent auth requests.  Each helper test records
the thread bcrypt actually runs on and asserts it differs from the
event-loop thread, so reverting any helper to a synchronous call fails its
test.  The integration tests then confirm the call sites stay offloaded and
that status codes / anti-enumeration behaviour are unchanged.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from http import HTTPStatus
from typing import TYPE_CHECKING

import bcrypt
import pytest

from models.user import User
from routers.auth import (
    _consume_dummy_bcrypt,
    _consume_dummy_password_verify,
    _hash_password,
    _hash_reset_token,
    _reject_if_password_reuse,
    _verify_password,
    _verify_reset_token,
)

if TYPE_CHECKING:
    from httpx import AsyncClient

# A syntactically valid 60-char bcrypt digest (``$2b$12$`` + 53 chars) so the
# hash helpers' ``.decode()`` / ``str`` handling still works while the real
# (slow) KDF is replaced by a thread-recording stub.
_FAKE_BCRYPT_HASH = "$2b$12$" + "a" * 53

_VALID_PASSWORD = "securepassword123"  # pragma: allowlist secret


def _recording_stub(recorder: dict[str, int], result: object) -> Callable[..., object]:
    """Return a bcrypt stand-in that records the thread it runs on.

    ``recorder["thread_ident"]`` captures ``threading.get_ident()`` at call
    time so a test can assert the work executed off the event-loop thread.
    """

    def _stub(*_args: object, **_kwargs: object) -> object:
        recorder["thread_ident"] = threading.get_ident()
        return result

    return _stub


@pytest.mark.asyncio
async def test_hash_password_offloads_to_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    """``_hash_password`` runs bcrypt.hashpw off the event-loop thread."""
    recorder: dict[str, int] = {}
    monkeypatch.setattr(bcrypt, "hashpw", _recording_stub(recorder, _FAKE_BCRYPT_HASH.encode()))

    result = await _hash_password(_VALID_PASSWORD)

    assert result == _FAKE_BCRYPT_HASH
    assert recorder["thread_ident"] != threading.get_ident()


@pytest.mark.asyncio
async def test_verify_password_offloads_to_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    """``_verify_password`` runs bcrypt.checkpw off the event-loop thread."""
    recorder: dict[str, int] = {}
    monkeypatch.setattr(bcrypt, "checkpw", _recording_stub(recorder, result=True))

    assert await _verify_password(_VALID_PASSWORD, _FAKE_BCRYPT_HASH) is True
    assert recorder["thread_ident"] != threading.get_ident()


@pytest.mark.asyncio
async def test_hash_reset_token_offloads_to_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    """``_hash_reset_token`` runs bcrypt.hashpw off the event-loop thread."""
    recorder: dict[str, int] = {}
    monkeypatch.setattr(bcrypt, "hashpw", _recording_stub(recorder, _FAKE_BCRYPT_HASH.encode()))

    result = await _hash_reset_token("a-256-bit-random-token")

    assert result == _FAKE_BCRYPT_HASH
    assert recorder["thread_ident"] != threading.get_ident()


@pytest.mark.asyncio
async def test_verify_reset_token_offloads_to_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    """``_verify_reset_token`` runs bcrypt.checkpw off the event-loop thread."""
    recorder: dict[str, int] = {}
    monkeypatch.setattr(bcrypt, "checkpw", _recording_stub(recorder, result=True))

    assert await _verify_reset_token("plaintext", _FAKE_BCRYPT_HASH) is True
    assert recorder["thread_ident"] != threading.get_ident()


@pytest.mark.asyncio
async def test_consume_dummy_bcrypt_offloads_to_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    """The reset-request anti-enumeration dummy verify runs off the loop thread."""
    recorder: dict[str, int] = {}
    monkeypatch.setattr(bcrypt, "checkpw", _recording_stub(recorder, result=False))

    await _consume_dummy_bcrypt()

    assert recorder["thread_ident"] != threading.get_ident()


@pytest.mark.asyncio
async def test_consume_dummy_password_verify_offloads_to_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The confirm-miss anti-enumeration dummy verify runs off the loop thread."""
    recorder: dict[str, int] = {}
    monkeypatch.setattr(bcrypt, "checkpw", _recording_stub(recorder, result=False))

    await _consume_dummy_password_verify()

    assert recorder["thread_ident"] != threading.get_ident()


@pytest.mark.asyncio
async def test_reject_if_password_reuse_offloads_to_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``_reject_if_password_reuse`` verifies the password off the loop thread."""
    recorder: dict[str, int] = {}
    # ``False`` -> not a reuse, so the helper returns without raising.
    monkeypatch.setattr(bcrypt, "checkpw", _recording_stub(recorder, result=False))
    user = User(email="reuse@example.com", password_hash=_FAKE_BCRYPT_HASH)

    await _reject_if_password_reuse(user, "a-fresh-password")

    assert recorder["thread_ident"] != threading.get_ident()


@pytest.mark.asyncio
async def test_signup_hashes_password_off_event_loop_thread(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A real signup request hashes the password off the event-loop thread.

    Exercises the call site (not just the helper) so reverting ``signup`` to
    a synchronous hash is caught even if the helper stays async.
    """
    recorder: dict[str, int] = {}
    real_hashpw = bcrypt.hashpw

    def spy(password: bytes, salt: bytes) -> bytes:
        recorder["thread_ident"] = threading.get_ident()
        return real_hashpw(password, salt)

    monkeypatch.setattr(bcrypt, "hashpw", spy)

    resp = await async_client.post(
        "/auth/signup",
        json={"email": "async-offload@example.com", "password": _VALID_PASSWORD},
    )

    assert resp.status_code == HTTPStatus.OK
    assert recorder["thread_ident"] != threading.get_ident()


@pytest.mark.asyncio
async def test_signup_login_status_codes_unchanged(async_client: AsyncClient) -> None:
    """Offloading must not change signup/login status codes or anti-enumeration.

    Success paths still return 200; a wrong password and a nonexistent
    account both still return 401 (the absent-account path runs without a
    real verify, exactly as before).
    """
    email = "regression@example.com"
    signup = await async_client.post(
        "/auth/signup",
        json={"email": email, "password": _VALID_PASSWORD},
    )
    assert signup.status_code == HTTPStatus.OK

    good_login = await async_client.post(
        "/auth/login",
        json={"email": email, "password": _VALID_PASSWORD},
    )
    assert good_login.status_code == HTTPStatus.OK

    wrong_password = await async_client.post(
        "/auth/login",
        json={"email": email, "password": "wrongpassword123"},  # pragma: allowlist secret
    )
    assert wrong_password.status_code == HTTPStatus.UNAUTHORIZED

    absent_account = await async_client.post(
        "/auth/login",
        json={"email": "nobody@example.com", "password": _VALID_PASSWORD},
    )
    assert absent_account.status_code == HTTPStatus.UNAUTHORIZED
