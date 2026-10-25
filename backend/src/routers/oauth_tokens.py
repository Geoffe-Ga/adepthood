"""The back half of the vault-agent authorization server: tokens, keys, revocation (#3533).

The front half (:mod:`routers.oauth`, #3532) ends with an agent holding a
one-time code. This router serves what the metadata advertises for the rest:

* ``POST /oauth/token`` -- RFC 6749 section 4.1.3 and section 6: a code and its
  PKCE verifier, or a refresh token, for an ES256 access token whose audience is
  the person's vault, and a rotated refresh token only with approved offline access;
* ``GET /.well-known/jwks.json`` -- the public keys the vault verifies those
  tokens with (Creek-Vault#1963), current and previous;
* ``POST /oauth/revoke`` -- RFC 7009: an agent signing out ends its refresh
  token's family.

**Form encoding only.** Every OAuth client posts
``application/x-www-form-urlencoded`` to these endpoints and Claude sends
nothing else, so a body in any other encoding -- JSON included -- is answered
with the RFC's own ``invalid_request``, never a ``415`` or a ``422`` a client
cannot switch on.

**Nothing leaves.** No handler here makes an outbound call: the database and a
local signature are the whole hot path, comfortably inside the budgets clients
give a token request.

**Never cached.** Token responses and token errors carry ``Cache-Control:
no-store`` (RFC 6749 section 5.1). The key set is cached for the five minutes
the vault caches it for anyway.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated, Final

from fastapi import Depends, Request, status
from fastapi.responses import JSONResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.oauth_form import FORM_MEDIA_TYPE, read_form
from error_responses import ResponseDeclarations, build_router
from errors import service_unavailable
from rate_limit import limiter
from routers.auth import session_signing_secret
from schemas.oauth import JsonWebKeySet, OAuthErrorResponse, TokenResponse
from services.oauth_authorization import configured_issuer
from services.oauth_signing_keys import (
    OAuthSigningKeyError,
    SigningKey,
    current_signing_key,
    published_key_set,
)
from services.oauth_tokens import (
    BEARER_TYPE,
    Signer,
    TokenError,
    issue_tokens,
    revoke_token,
)

logger = logging.getLogger(__name__)

router = build_router(tags=["oauth"], extra_statuses=(status.HTTP_503_SERVICE_UNAVAILABLE,))

#: Token requests one address may make. An agent exchanges once and refreshes
#: every ten minutes; a hosted connector's servers refresh for many people from
#: few addresses, so the budget is generous. The secrets are 256 bits, so this
#: bounds load rather than guessing.
EXCHANGE_RATE_LIMIT: Final = "60/minute"

#: Revocations one address may make: an agent signs out rarely.
REVOKE_RATE_LIMIT: Final = "30/minute"

#: How long a client may cache the key set: the vault's own refresh interval.
JWKS_MAX_AGE_SECONDS: Final = 300

_NO_STORE: Final = {"Cache-Control": "no-store", "Pragma": "no-cache"}
_SIGNING_KEYS_INVALID_EVENT: Final = "oauth_signing_keys_invalid"


def _form_body(*fields: str) -> dict[str, object]:
    """Publish a form-encoded body with ``fields`` as optional string properties."""
    properties = {name: {"type": "string"} for name in fields}
    schema = {"type": "object", "properties": properties}
    return {"requestBody": {"required": True, "content": {FORM_MEDIA_TYPE: {"schema": schema}}}}


_TOKEN_FORM: Final = _form_body(
    "grant_type",
    "code",
    "code_verifier",
    "client_id",
    "redirect_uri",
    "resource",
    "refresh_token",
    "scope",
)
_REVOKE_FORM: Final = _form_body("token", "token_type_hint", "client_id")

_OAUTH_400: Final[ResponseDeclarations] = {
    status.HTTP_400_BAD_REQUEST: {
        "model": OAuthErrorResponse,
        "description": "An RFC 6749 section 5.2 error.",
    }
}
_REVOKE_RESPONSES: Final[ResponseDeclarations] = {
    **_OAUTH_400,
    status.HTTP_200_OK: {"description": "Revoked, or nothing to revoke (RFC 7009 2.2)."},
}


def _issuer() -> str:
    """The configured issuer, or a 503: every token names it."""
    issuer = configured_issuer()
    if issuer is None:
        raise service_unavailable("oauth_issuer_unconfigured")
    return issuer


def _readable_signing_key() -> tuple[SigningKey | None, bool]:
    """The current key, and whether the configuration could be read at all.

    The refusal is reduced to a flag here rather than carried out: its
    traceback's frames hold the PEM the parser was reading, and nothing that
    might log or report an exception should ever be handed one.
    """
    try:
        return current_signing_key(), True
    except OAuthSigningKeyError:
        return None, False


def _signing_key() -> SigningKey:
    """The key new tokens are signed with, or a 503 naming why there is none."""
    key, readable = _readable_signing_key()
    if not readable:
        logger.error(_SIGNING_KEYS_INVALID_EVENT)
        raise service_unavailable("oauth_signing_unavailable")
    if key is None:
        raise service_unavailable("oauth_signing_unconfigured")
    return key


def _oauth_error(error: TokenError) -> JSONResponse:
    """An RFC 6749 error body: the code a client switches on, uncached."""
    return JSONResponse(
        {"error": error.value}, status_code=status.HTTP_400_BAD_REQUEST, headers=_NO_STORE
    )


@router.post(
    "/oauth/token",
    response_model=TokenResponse,
    responses=_OAUTH_400,
    openapi_extra=_TOKEN_FORM,
)
@limiter.limit(EXCHANGE_RATE_LIMIT)
async def exchange_token(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> JSONResponse:
    """Exchange a code or refresh token; staying connected requires approved offline access."""
    signer = Signer(
        issuer=_issuer(),
        key=_signing_key(),
        subject_secret=session_signing_secret(),
        now=datetime.now(UTC),
    )
    form = await read_form(request)
    if form is None:
        return _oauth_error(TokenError.INVALID_REQUEST)
    issued = await issue_tokens(session, form, signer)
    if isinstance(issued, TokenError):
        return _oauth_error(issued)
    body = TokenResponse(
        access_token=issued.access_token,
        token_type=BEARER_TYPE,
        expires_in=issued.expires_in,
        refresh_token=issued.refresh_token,
        scope=issued.scope,
    )
    return JSONResponse(body.model_dump(exclude_none=True), headers=_NO_STORE)


@router.get("/.well-known/jwks.json", response_model=JsonWebKeySet)
async def json_web_key_set() -> JSONResponse:
    """Publish the public halves of every configured signing key, newest first."""
    _signing_key()
    return JSONResponse(
        published_key_set(),
        headers={"Cache-Control": f"public, max-age={JWKS_MAX_AGE_SECONDS}"},
    )


@router.post(
    "/oauth/revoke",
    response_class=Response,
    responses=_REVOKE_RESPONSES,
    openapi_extra=_REVOKE_FORM,
)
@limiter.limit(REVOKE_RATE_LIMIT)
async def revoke(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Revoke a refresh token and every rotation of it (RFC 7009)."""
    _issuer()
    form = await read_form(request)
    if form is None:
        return _oauth_error(TokenError.INVALID_REQUEST)
    error = await revoke_token(session, form, datetime.now(UTC))
    if error is not None:
        return _oauth_error(error)
    return Response(status_code=status.HTTP_200_OK, headers=_NO_STORE)
