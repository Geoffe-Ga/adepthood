"""The rate-limit key functions catch only ``HTTPException``.

A malformed/missing token (the only thing the JWT decode raises) falls back to
the IP key; a programmer bug must propagate rather than be silently masked as an
anonymous request (audit §5.3 broad except).
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from routers.practice_share import _per_user_rate_limit_key as share_key
from routers.practices import _per_user_rate_limit_key as practices_key

# Each case: the key function under test + the dotted target whose
# ``extract_user_id_from_authorization`` we monkeypatch (it is resolved from the
# function's own module globals at call time).
_CASES = [
    pytest.param(
        practices_key,
        "routers.practices.extract_user_id_from_authorization",
        id="practices",
    ),
    pytest.param(
        share_key,
        "routers.practice_share.extract_user_id_from_authorization",
        id="practice_share",
    ),
]


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


@pytest.mark.parametrize(("key_fn", "target"), _CASES)
def test_valid_token_keys_by_user(
    key_fn: Callable[[Request], str], target: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(target, lambda _auth: 42)
    assert key_fn(_request(authorization="Bearer good")) == "user:42"


@pytest.mark.parametrize(("key_fn", "target"), _CASES)
def test_malformed_token_falls_back_to_ip(
    key_fn: Callable[[Request], str], target: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _raise(_auth: str | None) -> int:
        raise HTTPException(status_code=401, detail="invalid")

    monkeypatch.setattr(target, _raise)
    assert key_fn(_request(client_ip="198.51.100.4")) == "198.51.100.4"


@pytest.mark.parametrize(("key_fn", "target"), _CASES)
def test_programmer_bug_propagates(
    key_fn: Callable[[Request], str], target: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-HTTP error is a bug and must surface, not silently key by IP."""

    def _boom(_auth: str | None) -> int:
        raise RuntimeError("decode bug")

    monkeypatch.setattr(target, _boom)
    with pytest.raises(RuntimeError):
        key_fn(_request())
