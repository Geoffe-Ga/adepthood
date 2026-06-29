"""Shared rate-limit key functions, keyed on JWT identity rather than IP.

Lives outside :mod:`rate_limit` (which ``routers.auth`` imports) to avoid a
circular import: this module depends on ``routers.auth`` for the JWT decode.
"""

from __future__ import annotations

from fastapi import HTTPException, Request
from slowapi.util import get_remote_address

from routers.auth import extract_user_id_from_authorization


def per_user_rate_limit_key(request: Request) -> str:
    """Rate-limit key derived from the JWT ``sub`` claim (BUG-PRACTICE-003).

    The default ``slowapi`` key is the remote address, which lets a single user
    rotate IPs to bypass the per-IP cap and, conversely, multiple legitimate
    users behind a shared NAT throttle each other.

    Keying on the JWT's ``sub`` (the stable user id) instead of a hash of the
    bearer token means a logout / refresh flow that mints a new token does NOT
    reset the user's rate-limit bucket -- the budget follows the identity, not
    the credential. Decoding here costs one HMAC-SHA256 per request which is
    dominated by the work the limited endpoints do.

    Falls back to the remote address for malformed or missing tokens so the
    limiter never receives an empty key (and so any pre-auth probe is still
    throttled before FastAPI's DI rejects it).
    """
    try:
        return f"user:{extract_user_id_from_authorization(request.headers.get('authorization'))}"
    except HTTPException:
        # Malformed / missing token (the only thing the decode raises) → fall
        # back to the IP key. A non-HTTP error is a programmer bug and must
        # propagate rather than be silently masked as an anonymous request.
        return get_remote_address(request)
