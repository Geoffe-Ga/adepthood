"""The front half of the OAuth 2.1 authorization server for a person's vault agents (#3532).

An agent -- Claude Code, a ChatGPT connector, OpenClaw -- connects to a person's
vault by sending them here. This router serves what that takes:

* ``GET /.well-known/oauth-authorization-server`` -- RFC 8414 metadata, so an
  agent can find everything else from the issuer alone;
* ``POST /oauth/register`` -- RFC 7591 dynamic registration of a public client;
  a client whose ``client_id`` is an ``https`` URL needs none, its metadata
  document is fetched instead;
* ``GET /oauth/authorize`` -- the browser lands here. The request is checked,
  the person signs in if they have not, and a consent page names what the
  agent asked for;
* ``POST /oauth/authorize/sign-in`` and ``POST /oauth/authorize/decision`` --
  the two forms that page posts;
* ``GET /oauth/consent.css`` -- its stylesheet, same-origin because the API's
  CSP admits nothing else.

The token endpoint, JWKS and revocation the metadata advertises arrive with
#3533; Creek-Vault#1963 verifies what they issue.

**When to redirect, and when not to.** RFC 6749 section 4.1.2.1 draws the line
and this router follows it exactly. Until the client is known and the
``redirect_uri`` is one it registered, nothing on the request is trusted, so a
fault is shown to the person on a page here and the browser goes nowhere --
redirecting to an unverified address is precisely an open redirect. Once both
are verified, a protocol fault (no PKCE, ``plain`` PKCE, a bad scope, a missing
``state``) is sent back to the agent as an ``error`` parameter, which is how the
agent learns what to fix.

**The resource is the exception, deliberately.** A request naming a vault that
is not the signed-in account's own is refused here with ``invalid_target`` and
no redirect: it is not a protocol fault the agent can fix but an attempt on
somebody else's vault, and the page says so without naming any vault at all.
No code row is written. The audit line records the account and nothing about
the address.

**Signing in.** The browser carries no app session, so a person who is not
signed in is shown a sign-in form that posts to this router and runs through
exactly the gates ``POST /auth/login`` does -- the same lockout, the same
attempt log, the same uniform refusal. A caller that does present the app's
own bearer token (a native client that opened the page with one) is taken as
signed in. Accounts that only ever signed in with Google or Apple have no
password to type here; that path is a follow-up.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated, Final

from fastapi import Depends, Header, Query, Request, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.exceptions import HTTPException

from client_ip import resolve_client_ip
from database import get_session
from dependencies.oauth_form import FORM_MEDIA_TYPE, read_form, single_valued
from domain.dates import ensure_aware
from error_responses import (
    RefusalResponse,
    ResponseDeclarations,
    build_router,
    refusal_responses,
)
from errors import service_unavailable
from models.oauth_client import OAuthClient
from rate_limit import limiter
from routers.auth import (
    AuthRequest,
    get_current_user,
    session_signing_secret,
    verify_password_sign_in,
)
from schemas.oauth import (
    AuthorizationQuery,
    ClientRegistrationRequest,
    ClientRegistrationResponse,
    OAuthErrorResponse,
)
from services.oauth_authorization import (
    GRANT_TYPES,
    PUBLIC_CLIENT_AUTH_METHOD,
    RESPONSE_TYPE_CODE,
    AuthorizationError,
    AuthorizationRequest,
    account_may_authorize,
    account_vault_resource,
    authorization_server_metadata,
    configured_issuer,
    is_loopback_redirect,
    issue_authorization_code,
    read_authorization_request,
    read_consent_ticket,
    redirect_host,
    redirect_uri_matches,
    redirect_with,
    sign_consent_ticket,
)
from services.oauth_client_metadata import MetadataRefusal, validate_client_metadata
from services.oauth_clients import load_client, register_client, resolve_client
from services.oauth_consent_page import (
    RefusalKind,
    render_consent,
    render_refusal,
    render_sign_in,
    render_stylesheet,
)
from services.oauth_consent_selection import selected_request

logger = logging.getLogger(__name__)

router = build_router(tags=["oauth"], extra_statuses=(status.HTTP_503_SERVICE_UNAVAILABLE,))

#: Registrations one address may make. An agent registers once per install; a
#: burst well past that is somebody filling the registry.
REGISTRATION_RATE_LIMIT: Final = "20/hour"

#: Sign-in attempts one address may make on the consent page: the same budget as
#: ``POST /auth/login``, so this form is no cheaper a place to guess a password.
SIGN_IN_RATE_LIMIT: Final = "5/minute"

#: The query parameters an authorization request is made of, carried through the
#: sign-in form in hidden fields and nothing else.
AUTHORIZATION_PARAMETERS: Final = (
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "state",
    "scope",
    "resource",
)

_APPROVE: Final = "approve"
_DECLINE: Final = "decline"
_NO_STORE: Final = {"Cache-Control": "no-store", "Pragma": "no-cache"}
_RESOURCE_REFUSED_EVENT: Final = "oauth_resource_refused"

_HTML_MEDIA_TYPE: Final = "text/html"
_FORM_BODY: Final[dict[str, object]] = {
    "requestBody": {
        "required": True,
        "content": {FORM_MEDIA_TYPE: {"schema": {"type": "object"}}},
    }
}


def _html_page() -> dict[str, object]:
    """A fresh ``content`` entry for a rendered page.

    Fresh on every call because FastAPI adds a status's JSON model to the very
    ``content`` mapping it is handed: one shared constant would leak each
    route's JSON declaration into every other route's page.
    """
    return {_HTML_MEDIA_TYPE: {"schema": {"type": "string"}}}


def _page_responses(*page_statuses: int) -> ResponseDeclarations:
    """Declare HTML for the statuses a consent-page operation renders a page for.

    Only those. Every other status the operation publishes -- the limiter's 429,
    the framework's 422, the shared refusal contract -- is the JSON the rest of
    the API sends, and a page status can be that JSON too (a throttle or a lost
    database answers before any page is drawn). That is why the operations are
    declared with ``response_class=Response``: an ``HTMLResponse`` class would
    publish every inherited JSON refusal as ``text/html``, which is the mismatch
    the contract fuzz caught on a throttled sign-in.
    """
    refusals = refusal_responses(page_statuses)
    return {
        status.HTTP_200_OK: {"description": "The page.", "content": _html_page()},
        status.HTTP_303_SEE_OTHER: {"description": "Back to the agent with a code or an error."},
        **{
            code: {**declaration, "content": _html_page()} for code, declaration in refusals.items()
        },
    }


#: ``GET /oauth/authorize``: a refusal page (400) or the unconfigured-issuer
#: page (503). Each operation gets its own declarations rather than sharing one
#: mapping, for the same reason :func:`_html_page` is fresh.
_AUTHORIZE_RESPONSES: Final = _page_responses(
    status.HTTP_400_BAD_REQUEST, status.HTTP_503_SERVICE_UNAVAILABLE
)

#: The decision form: the same two pages as the authorization request.
_DECISION_RESPONSES: Final = _page_responses(
    status.HTTP_400_BAD_REQUEST, status.HTTP_503_SERVICE_UNAVAILABLE
)

#: The sign-in form adds the "did not match" page (401).
_SIGN_IN_PAGE_RESPONSES: Final = _page_responses(
    status.HTTP_400_BAD_REQUEST,
    status.HTTP_401_UNAUTHORIZED,
    status.HTTP_503_SERVICE_UNAVAILABLE,
)

#: RFC 7591's error for refused client metadata, or -- for a body that is not
#: JSON at all -- the framework's own parse refusal, sent before this router runs.
_REGISTRATION_400: Final[ResponseDeclarations] = {
    status.HTTP_400_BAD_REQUEST: {
        "model": OAuthErrorResponse | RefusalResponse,
        "description": "Client metadata RFC 7591 refuses, or a body that is not JSON.",
    }
}

# --- small pieces -------------------------------------------------------------


def _page(html: str, status_code: int = status.HTTP_200_OK) -> HTMLResponse:
    """A page that is never cached: it may carry a consent ticket."""
    return HTMLResponse(html, status_code=status_code, headers=_NO_STORE)


def _refusal(kind: RefusalKind, error: AuthorizationError | str) -> HTMLResponse:
    """A page telling the person the request stopped, with no redirect anywhere."""
    status_code = (
        status.HTTP_503_SERVICE_UNAVAILABLE
        if kind is RefusalKind.UNAVAILABLE
        else status.HTTP_400_BAD_REQUEST
    )
    return _page(render_refusal(kind, str(error)), status_code)


def _issuer() -> str:
    """The configured issuer, or a 503: no honest answer exists without one."""
    issuer = configured_issuer()
    if issuer is None:
        raise service_unavailable("oauth_issuer_unconfigured")
    return issuer


def _back_to_agent(redirect_uri: str, params: dict[str, str], *, issuer: str) -> RedirectResponse:
    """Send the browser back to the agent's verified redirect, naming this issuer (RFC 9207)."""
    return RedirectResponse(
        redirect_with(redirect_uri, {**params, "iss": issuer}),
        status_code=status.HTTP_303_SEE_OTHER,
        headers=_NO_STORE,
    )


def _error_to_agent(
    redirect_uri: str, error: AuthorizationError, state: str | None, *, issuer: str
) -> RedirectResponse:
    """Report a protocol fault to the agent, carrying its ``state`` back if it sent one."""
    params = {"error": error.value}
    if state:
        params["state"] = state
    return _back_to_agent(redirect_uri, params, issuer=issuer)


# --- admission ------------------------------------------------------------------


async def _admit_client(
    session: AsyncSession, params: dict[str, str]
) -> OAuthClient | HTMLResponse:
    """Resolve the client and verify the redirect, or stop here without redirecting."""
    client_id = params.get("client_id", "")
    client = await resolve_client(session, client_id) if client_id else None
    if client is None:
        return _refusal(RefusalKind.UNKNOWN_AGENT, AuthorizationError.INVALID_REQUEST)
    if not redirect_uri_matches(client.redirect_uris, params.get("redirect_uri", "")):
        return _refusal(RefusalKind.UNREGISTERED_RETURN, AuthorizationError.INVALID_REQUEST)
    return client


async def _admit(
    session: AsyncSession, params: dict[str, str] | None, issuer: str
) -> tuple[OAuthClient, AuthorizationRequest] | Response:
    """Admit an authorization request, or answer it.

    A page before the redirect is verified; a redirect carrying the RFC error
    after.
    """
    if params is None:
        return _refusal(RefusalKind.MALFORMED, AuthorizationError.INVALID_REQUEST)
    client = await _admit_client(session, params)
    if isinstance(client, Response):
        return client
    request = read_authorization_request(params)
    if request is AuthorizationError.INVALID_TARGET:
        return _refusal(RefusalKind.MALFORMED, request)
    if isinstance(request, AuthorizationError):
        return _error_to_agent(params["redirect_uri"], request, params.get("state"), issuer=issuer)
    return client, request


async def _signed_in_user(session: AsyncSession, authorization: str | None) -> int | None:
    """The account an app bearer token names, or ``None`` when there is no usable one."""
    if authorization is None:
        return None
    try:
        return await get_current_user(session, authorization)
    except HTTPException:
        return None


async def _consent_or_refusal(
    session: AsyncSession, client: OAuthClient, request: AuthorizationRequest, user_id: int
) -> HTMLResponse:
    """Render the decision page if the resource is this account's vault; refuse if not."""
    own_resource = await account_vault_resource(session, user_id)
    if own_resource != request.resource:
        logger.warning(_RESOURCE_REFUSED_EVENT, extra={"user_id": user_id})
        kind = RefusalKind.NO_VAULT if own_resource is None else RefusalKind.OTHER_VAULT
        return _refusal(kind, AuthorizationError.INVALID_TARGET)
    ticket = sign_consent_ticket(
        request, user_id, secret=session_signing_secret(), now=datetime.now(UTC)
    )
    return _page(
        render_consent(
            agent_name=client.client_name,
            scopes=request.scopes,
            return_host=redirect_host(request.redirect_uri),
            local_program=is_loopback_redirect(request.redirect_uri),
            ticket=ticket,
        )
    )


def _carried(params: dict[str, str]) -> dict[str, str]:
    """The authorization parameters the sign-in form carries back, and only those."""
    return {name: params[name] for name in AUTHORIZATION_PARAMETERS if name in params}


# --- routes -----------------------------------------------------------------------


@router.get("/.well-known/oauth-authorization-server")
async def authorization_server_metadata_document() -> JSONResponse:
    """Publish RFC 8414 metadata for this authorization server."""
    return JSONResponse(authorization_server_metadata(_issuer()))


@router.post(
    "/oauth/register",
    status_code=status.HTTP_201_CREATED,
    response_model=ClientRegistrationResponse,
    responses=_REGISTRATION_400,
)
@limiter.limit(REGISTRATION_RATE_LIMIT)
async def register_oauth_client(
    request: Request,
    payload: ClientRegistrationRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ClientRegistrationResponse | JSONResponse:
    """Register a public client (RFC 7591). The response carries no secret, ever."""
    metadata = validate_client_metadata(payload)
    if isinstance(metadata, MetadataRefusal):
        body = OAuthErrorResponse(
            error=metadata.error.value, error_description=metadata.description
        )
        return JSONResponse(body.model_dump(), status_code=status.HTTP_400_BAD_REQUEST)
    client = await register_client(session, metadata)
    # The registry is anonymous, so the address is the one thing that ties a
    # burst of registrations together for whoever has to clean one up.
    logger.info(
        "oauth_client_registered",
        extra={"client_id": client.client_id, "ip_address": resolve_client_ip(request)},
    )
    return ClientRegistrationResponse(
        client_id=client.client_id,
        client_id_issued_at=int(ensure_aware(client.created_at).timestamp()),
        client_name=client.client_name,
        redirect_uris=client.redirect_uris,
        logo_uri=client.logo_uri,
        grant_types=list(GRANT_TYPES),
        response_types=[RESPONSE_TYPE_CODE],
        token_endpoint_auth_method=PUBLIC_CLIENT_AUTH_METHOD,
    )


@router.get("/oauth/authorize", response_class=Response, responses=_AUTHORIZE_RESPONSES)
async def authorize(
    request: Request,
    query: Annotated[AuthorizationQuery, Query()],
    session: Annotated[AsyncSession, Depends(get_session)],
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    """Check an authorization request and show the person what it asks for.

    ``query`` declares the parameters for the published schema; the handler
    reads the raw query so a parameter sent twice is refused rather than
    silently resolved to one of its values.
    """
    del query
    issuer = configured_issuer()
    if issuer is None:
        return _refusal(RefusalKind.UNAVAILABLE, "temporarily_unavailable")
    admitted = await _admit(session, single_valued(request.query_params.multi_items()), issuer)
    if isinstance(admitted, Response):
        return admitted
    client, authorization_request = admitted
    user_id = await _signed_in_user(session, authorization)
    if user_id is None:
        return _page(render_sign_in(_carried(dict(request.query_params)), refused=False))
    return await _consent_or_refusal(session, client, authorization_request, user_id)


def _sign_in_payload(form: dict[str, str]) -> AuthRequest | None:
    """The email and password as the login schema reads them, or ``None`` if unusable."""
    try:
        return AuthRequest(email=form.get("email", ""), password=form.get("password", ""))
    except ValidationError:
        return None


async def _signed_in_with_password(
    request: Request, session: AsyncSession, form: dict[str, str]
) -> int | None:
    """The account the form's email and password sign in to, or ``None``."""
    payload = _sign_in_payload(form)
    if payload is None:
        return None
    try:
        user = await verify_password_sign_in(session, payload, resolve_client_ip(request))
    except HTTPException:
        return None
    return user.id


@router.post(
    "/oauth/authorize/sign-in",
    response_class=Response,
    responses=_SIGN_IN_PAGE_RESPONSES,
    openapi_extra=_FORM_BODY,
)
@limiter.limit(SIGN_IN_RATE_LIMIT)
async def authorize_sign_in(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Sign the person in on the consent page, then show them the decision."""
    issuer = configured_issuer()
    if issuer is None:
        return _refusal(RefusalKind.UNAVAILABLE, "temporarily_unavailable")
    form = await read_form(request)
    if form is None:
        return _refusal(RefusalKind.MALFORMED, AuthorizationError.INVALID_REQUEST)
    admitted = await _admit(session, _carried(form), issuer)
    if isinstance(admitted, Response):
        return admitted
    client, authorization_request = admitted
    user_id = await _signed_in_with_password(request, session, form)
    if user_id is None:
        page = render_sign_in(_carried(form), refused=True)
        return _page(page, status.HTTP_401_UNAUTHORIZED)
    return await _consent_or_refusal(session, client, authorization_request, user_id)


async def _approve(
    session: AsyncSession, request: AuthorizationRequest, user_id: int, issuer: str
) -> Response:
    """Issue the code -- after checking, once more, that the account and its vault still stand."""
    if not await account_may_authorize(session, user_id):
        return _refusal(RefusalKind.EXPIRED, AuthorizationError.ACCESS_DENIED)
    if await account_vault_resource(session, user_id) != request.resource:
        logger.warning(_RESOURCE_REFUSED_EVENT, extra={"user_id": user_id})
        return _refusal(RefusalKind.OTHER_VAULT, AuthorizationError.INVALID_TARGET)
    code = await issue_authorization_code(session, request, user_id)
    return _back_to_agent(
        request.redirect_uri, {"code": code, "state": request.state}, issuer=issuer
    )


async def _ticketed_request(
    session: AsyncSession, ticket: str
) -> tuple[AuthorizationRequest, int] | HTMLResponse:
    """The request and account a ticket carries, if it verifies and its client still stands.

    The client is re-read rather than trusted from the ticket: an agent removed
    from the registry, or whose document no longer lists this redirect, is sent
    nothing.
    """
    read = read_consent_ticket(ticket, secret=session_signing_secret(), now=datetime.now(UTC))
    if read is None:
        return _refusal(RefusalKind.EXPIRED, AuthorizationError.INVALID_REQUEST)
    authorization_request, _user_id = read
    client = await load_client(session, authorization_request.client_id)
    if client is None or not redirect_uri_matches(
        client.redirect_uris, authorization_request.redirect_uri
    ):
        return _refusal(RefusalKind.UNKNOWN_AGENT, AuthorizationError.INVALID_REQUEST)
    return read


async def _act_on(
    form: dict[str, str],
    session: AsyncSession,
    request: AuthorizationRequest,
    user_id: int,
    *,
    issuer: str,
) -> Response:
    """Approve or Decline -- the only two answers -- or stop on anything else."""
    decision = form.get("decision")
    if decision == _APPROVE:
        approved = selected_request(request, form)
        if isinstance(approved, AuthorizationError):
            return _error_to_agent(request.redirect_uri, approved, request.state, issuer=issuer)
        return await _approve(session, approved, user_id, issuer)
    if decision == _DECLINE:
        return _error_to_agent(
            request.redirect_uri, AuthorizationError.ACCESS_DENIED, request.state, issuer=issuer
        )
    return _refusal(RefusalKind.MALFORMED, AuthorizationError.INVALID_REQUEST)


@router.post(
    "/oauth/authorize/decision",
    response_class=Response,
    responses=_DECISION_RESPONSES,
    openapi_extra=_FORM_BODY,
)
async def authorize_decision(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Act on Approve or Decline for the request the consent ticket carries."""
    issuer = configured_issuer()
    if issuer is None:
        return _refusal(RefusalKind.UNAVAILABLE, "temporarily_unavailable")
    form = await read_form(request) or {}
    ticketed = await _ticketed_request(session, form.get("ticket", ""))
    if isinstance(ticketed, Response):
        return ticketed
    authorization_request, user_id = ticketed
    return await _act_on(form, session, authorization_request, user_id, issuer=issuer)


@router.get("/oauth/consent.css", response_class=Response)
async def consent_stylesheet() -> Response:
    """Serve the consent page's stylesheet."""
    return Response(
        render_stylesheet(),
        media_type="text/css",
        headers={"Cache-Control": "public, max-age=3600"},
    )
