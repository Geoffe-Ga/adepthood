"""The shared rate-limit key function catches only ``HTTPException``.

A malformed/missing token (the only thing the JWT decode raises) falls back to
the IP key; a programmer bug must propagate rather than be silently masked as an
anonymous request (audit §5.3 broad except). The practices + practice_share
routers now share this single implementation (``rate_limit_keys``).
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from rate_limit_keys import per_user_rate_limit_key

# ``per_user_rate_limit_key`` resolves ``extract_user_id_from_authorization`` from
# its own module globals at call time, so monkeypatch it there.
_TARGET = "rate_limit_keys.extract_user_id_from_authorization"


def _request(*, authorization: str | None = None, client_ip: str = "203.0.113.7") -> Request:
    headers = [(b"authorization", authorization.encode())] if authorization is not None else []
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": headers,
        "client": (client_ip, 12345),
    }
    return Request(scope)


def test_valid_token_keys_by_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_TARGET, lambda _auth: 42)
    assert per_user_rate_limit_key(_request(authorization="Bearer good")) == "user:42"


def test_malformed_token_falls_back_to_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(_auth: str | None) -> int:
        raise HTTPException(status_code=401, detail="invalid")

    monkeypatch.setattr(_TARGET, _raise)
    assert per_user_rate_limit_key(_request(client_ip="198.51.100.4")) == "198.51.100.4"


def test_programmer_bug_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-HTTP error is a bug and must surface, not silently key by IP."""

    def _boom(_auth: str | None) -> int:
        raise RuntimeError("decode bug")

    monkeypatch.setattr(_TARGET, _boom)
    with pytest.raises(RuntimeError):
        per_user_rate_limit_key(_request())
