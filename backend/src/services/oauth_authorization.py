"""The rules an agent's authorization request is judged by, and the code it earns.

Adepthood is the OAuth 2.1 authorization server for a person's vault agents
(#3532); the vault is the resource server and verifies what this issues
(Creek-Vault#1963). This module holds the part of that which is *policy* -- what
a well-formed request is, which redirects may be registered and matched, whose
vault a request may name, and what an approval writes -- so the router is left
holding only HTTP. The token endpoint (#3533) reads the same constants and the
same code rows.

Four properties are the whole point, and each is enforced here rather than
remembered by a caller:

* **PKCE S256 or nothing.** No ``plain`` method and no request without a
  challenge: a public client has no secret, so the verifier is the only thing
  binding a code to the agent that asked for it.
* **Exact redirects.** A presented ``redirect_uri`` must equal one the client
  registered. The single relaxation is the one RFC 8252 asks for: a loopback
  redirect matches on any port, because Claude Code and OpenClaw listen on an
  ephemeral one chosen per sign-in.
* **The audience is the person's own vault.** RFC 8707's ``resource`` must name
  the MCP URL of the vault bound to the signed-in account and nothing else, so
  no approval can mint a token for somebody else's vault.
* **A code is a digest at rest.** Only its SHA-256 is stored; it lives sixty
  seconds and is bound to every value above.

The consent ticket is how an approval survives the round trip from the page the
person reads to the button they press. It is a short-lived JWT carrying the
validated request and the account, signed with a key *derived* from the
deployment secret rather than with the secret itself -- the app's own session
tokens are signed with that secret, and a ticket must never be accepted as a
session nor a session as a ticket.
"""

from __future__ import annotations

import enum
import hashlib
import hmac
import ipaddress
import os
import re
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final
from urllib.parse import SplitResult, urlencode, urlsplit, urlunsplit

import jwt
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.agent_grant import AgentGrant
from models.oauth_authorization_code import OAuthAuthorizationCode
from models.oauth_client import OAUTH_URI_MAX_LENGTH
from models.vault_activation import VaultActivation, VaultActivationState
from services.creek_vault_url import vault_base_url
from services.user_vault_config import load_vault_config

# --- the server's own identity ---------------------------------------------

#: The public origin this authorization server answers as. Configuration, never
#: the request's ``Host``: the issuer is written into every token the vault
#: verifies, so a value an attacker could choose per request is a value they
#: could make the vault trust.
OAUTH_ISSUER_ENV_VAR: Final = "OAUTH_ISSUER_URL"

#: Where ``uvicorn --reload`` serves the API on a laptop. Only ever used outside
#: production.
DEV_ISSUER: Final = "http://localhost:8000"

_PRODUCTION: Final = "production"

#: Every grant an agent may ask for. The four ``vault:`` grants are Creek's tool
#: profiles (Creek-Vault#1964), spelled identically there; ``offline_access`` is
#: the OIDC convention for "may hold a refresh token" (#3533). Order is the
#: order the consent page lists them and the order a stored scope is written in.
SUPPORTED_SCOPES: Final = (
    "vault:read",
    "vault:desk",
    "vault:journal",
    "vault:pipeline",
    "offline_access",
)

_SUPPORTED_SCOPE_SET: Final = frozenset(SUPPORTED_SCOPES)

RESPONSE_TYPE_CODE: Final = "code"
PKCE_METHOD_S256: Final = "S256"
GRANT_TYPES: Final = ("authorization_code", "refresh_token")
#: The one client authentication method: none, because every client is public.
PUBLIC_CLIENT_AUTH_METHOD: Final = "none"

AUTHORIZE_PATH: Final = "/oauth/authorize"
EXCHANGE_PATH: Final = "/oauth/token"
REGISTER_PATH: Final = "/oauth/register"
REVOKE_PATH: Final = "/oauth/revoke"
JWKS_PATH: Final = "/.well-known/jwks.json"

#: The path the vault serves MCP on, beside ``/v1`` in the same process.
MCP_PATH: Final = "/mcp"

# --- lifetimes ---------------------------------------------------------------

#: How long an authorization code may wait to be exchanged. The agent is already
#: listening when the person presses Approve, so the exchange takes a second;
#: sixty is generous and still short enough that a leaked code is stale.
AUTHORIZATION_CODE_TTL: Final = timedelta(seconds=60)

#: How long the consent page stays approvable after it was rendered. Long enough
#: to read four lines and decide; short enough that a tab left open overnight is
#: not a standing approval.
CONSENT_TICKET_TTL: Final = timedelta(minutes=10)

# --- shapes ------------------------------------------------------------------

#: Prefix on every authorization code, so one is recognisable in a log a person
#: pastes and is never mistaken for a session token.
CODE_PREFIX: Final = "ac_"

# 32 bytes is 256 bits of entropy, the same budget the password-reset token uses.
_CODE_BYTES: Final = 32

# RFC 7636 section 4.2: a challenge is 43-128 characters of the unreserved set.
_CODE_CHALLENGE: Final = re.compile(r"[A-Za-z0-9\-._~]{43,128}")

_LOOPBACK_HOSTS: Final = frozenset({"localhost", "127.0.0.1", "::1"})
_HTTPS: Final = "https"
_HTTP: Final = "http"

# --- the consent ticket ------------------------------------------------------

#: The ``typ`` claim every consent ticket carries and every read requires.
CONSENT_TICKET_TYPE: Final = "oauth_consent"
_TICKET_ALGORITHM: Final = "HS256"
# The context string the ticket key is derived under. Versioned so a change to
# what a ticket carries can retire every outstanding ticket at once.
_TICKET_KEY_CONTEXT: Final = b"adepthood/oauth-consent-ticket/v1"
# The claims a ticket carries the request in, in the order they are read back.
_TICKET_REQUEST_CLAIMS: Final = ("cid", "ru", "cc", "sc", "st", "res")


class AuthorizationError(enum.StrEnum):
    """The RFC 6749 / RFC 8707 error codes the authorization endpoint answers with."""

    INVALID_REQUEST = "invalid_request"
    UNAUTHORIZED_CLIENT = "unauthorized_client"
    ACCESS_DENIED = "access_denied"
    UNSUPPORTED_RESPONSE_TYPE = "unsupported_response_type"
    INVALID_SCOPE = "invalid_scope"
    INVALID_TARGET = "invalid_target"


@dataclass(frozen=True)
class AuthorizationRequest:
    """A validated authorization request: everything an approval will bind a code to.

    ``client_id`` and ``redirect_uri`` are carried as presented; whether the
    client exists and the redirect is one it registered is decided against the
    registry, before this value is built from the rest of the query.
    """

    client_id: str
    redirect_uri: str
    code_challenge: str
    scopes: tuple[str, ...]
    state: str
    resource: str

    @property
    def scope(self) -> str:
        """The scopes as the space-separated string OAuth carries on the wire."""
        return " ".join(self.scopes)


# --- metadata ----------------------------------------------------------------


def configured_issuer() -> str | None:
    """Return the issuer this deployment answers as, or ``None`` when it has none.

    Read per call, like ``APP_BASE_URL``, so a test or a repointed staging
    deploy needs no restart. Outside production an unset value falls back to the
    local dev server; production has no fallback, because there is nothing
    honest to fall back to.
    """
    configured = os.getenv(OAUTH_ISSUER_ENV_VAR, "").strip().rstrip("/")
    if configured:
        return configured
    if os.getenv("ENV", "development") == _PRODUCTION:
        return None
    return DEV_ISSUER


def authorization_server_metadata(issuer: str) -> dict[str, object]:
    """Return the RFC 8414 document for ``issuer``.

    Advertises exactly what the endpoints enforce and nothing more: ``code``
    only, S256 only, public clients only. Claude selects client metadata
    documents only when ``client_id_metadata_document_supported`` is present
    alongside a registration endpoint, which is why both appear.
    """
    return {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}{AUTHORIZE_PATH}",
        "token_endpoint": f"{issuer}{EXCHANGE_PATH}",
        "registration_endpoint": f"{issuer}{REGISTER_PATH}",
        "jwks_uri": f"{issuer}{JWKS_PATH}",
        "revocation_endpoint": f"{issuer}{REVOKE_PATH}",
        "response_types_supported": [RESPONSE_TYPE_CODE],
        "grant_types_supported": list(GRANT_TYPES),
        "code_challenge_methods_supported": [PKCE_METHOD_S256],
        "token_endpoint_auth_methods_supported": [PUBLIC_CLIENT_AUTH_METHOD],
        "client_id_metadata_document_supported": True,
        "scopes_supported": list(SUPPORTED_SCOPES),
        "authorization_response_iss_parameter_supported": True,
    }


# --- redirect URIs -------------------------------------------------------------


def _split(uri: str) -> SplitResult | None:
    """Parse ``uri``, or return ``None`` for one the parser refuses.

    The parser's ``ValueError`` is discarded unbound: it quotes the netloc it
    refused, and that string came from a request.
    """
    try:
        parts = urlsplit(uri)
        _ = parts.port
    except ValueError:
        return None
    return parts


def _is_loopback_host(host: str | None) -> bool:
    """Whether ``host`` names this computer: a loopback name or address literal."""
    if host is None:
        return False
    if host in _LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _transport_is_acceptable(parts: SplitResult) -> bool:
    """``https`` anywhere, or plain ``http`` to this computer only."""
    if parts.scheme == _HTTPS:
        return True
    return parts.scheme == _HTTP and _is_loopback_host(parts.hostname)


def _carries_no_extras(parts: SplitResult, raw: str) -> bool:
    """No fragment -- not even an empty one -- and no userinfo.

    The fragment is tested on the raw string as well as the parse because
    ``urlsplit`` reports ``""`` for a fragment that is absent and for one that is
    present but empty, and only the raw string can tell those apart.
    """
    return not (parts.fragment or "#" in raw) and parts.username is None


def _is_secure_destination(parts: SplitResult, raw: str) -> bool:
    """The shape rules shared by a redirect and a resource, on a parsed value."""
    if not parts.hostname or not _carries_no_extras(parts, raw):
        return False
    return _transport_is_acceptable(parts)


def redirect_uri_is_registrable(uri: str) -> bool:
    """Return whether a client may register ``uri`` as somewhere to be sent back to.

    ``https`` anywhere, or plain ``http`` to this computer only. No fragment
    (RFC 6749 section 3.1.2), no userinfo, no custom scheme -- a ``javascript:``
    or app-scheme redirect is a way to run code or reach an app the person did
    not choose -- and nothing longer than the column that stores it.
    """
    if not uri or len(uri) > OAUTH_URI_MAX_LENGTH:
        return False
    parts = _split(uri)
    return parts is not None and _is_secure_destination(parts, uri)


def is_loopback_redirect(uri: str) -> bool:
    """Return whether ``uri`` sends the person back to a program on this computer."""
    parts = _split(uri)
    return parts is not None and _is_loopback_host(parts.hostname)


def _without_port(parts: SplitResult) -> tuple[str, str | None, str, str]:
    """The parts a loopback redirect is matched on: everything but the port."""
    return (parts.scheme, parts.hostname, parts.path, parts.query)


def _matches(registered: str, presented: str, presented_parts: SplitResult) -> bool:
    """Whether one registered redirect admits the presented one."""
    if registered == presented:
        return True
    registered_parts = _split(registered)
    if registered_parts is None or not _is_loopback_host(registered_parts.hostname):
        return False
    if registered_parts.scheme != _HTTP:
        return False
    return _without_port(registered_parts) == _without_port(presented_parts)


def redirect_uri_matches(registered: Sequence[str], presented: str) -> bool:
    """Return whether ``presented`` is one of the client's ``registered`` redirects.

    Exact string equality, except that an ``http`` loopback redirect matches on
    any port (RFC 8252 section 7.3) -- scheme, host spelling, path and query
    must still agree. A redirect that does not match is never followed, so this
    is the whole of the open-redirect defence.
    """
    presented_parts = _split(presented)
    if presented_parts is None or not _is_secure_destination(presented_parts, presented):
        return False
    return any(_matches(candidate, presented, presented_parts) for candidate in registered)


def redirect_host(uri: str) -> str:
    """Return the host ``uri`` sends the person back to, for the consent page to name."""
    parts = _split(uri)
    return (parts.hostname or "") if parts is not None else ""


def redirect_with(redirect_uri: str, params: Mapping[str, str]) -> str:
    """Return ``redirect_uri`` with ``params`` appended to its query, encoded.

    A query the client registered is kept: the parameters are added after it,
    never spliced into it.
    """
    separator = "&" if "?" in redirect_uri else "?"
    return f"{redirect_uri}{separator}{urlencode(params)}"


# --- scope, PKCE, resource -------------------------------------------------------


def parse_scope(raw: str | None) -> tuple[str, ...] | None:
    """Return the requested scopes in the server's order, or ``None`` if refused.

    A non-empty subset of :data:`SUPPORTED_SCOPES`. An unknown scope refuses the
    request rather than being dropped: silently granting less than was asked is
    how an agent ends up failing later with nobody able to say why.
    """
    requested = frozenset((raw or "").split())
    if not requested or not requested <= _SUPPORTED_SCOPE_SET:
        return None
    return tuple(filter(requested.__contains__, SUPPORTED_SCOPES))


def code_challenge_is_valid(challenge: str) -> bool:
    """Return whether ``challenge`` has the shape RFC 7636 requires."""
    return _CODE_CHALLENGE.fullmatch(challenge) is not None


def _has_query(parts: SplitResult, raw: str) -> bool:
    """Whether a query is present, empty or not -- the same raw-string reasoning as fragments."""
    return bool(parts.query) or "?" in raw


def normalize_resource(resource: str) -> str | None:
    """Return ``resource`` in the one spelling it is compared in, or ``None`` if refused.

    Scheme and host are case-folded and a trailing slash dropped, so two
    spellings of one vault compare equal. A fragment is refused (RFC 8707
    section 2), and so are a query and userinfo: neither has any business in
    an audience the vault compares exactly. Plain ``http`` is accepted only for
    a vault on this computer: the self-hosted tracer.
    """
    parts = _split(resource)
    if parts is None or not _is_secure_destination(parts, resource) or _has_query(parts, resource):
        return None
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), "", ""))


def vault_mcp_url(vault_url: str) -> str:
    """Return the MCP URL of the vault whose ``/v1`` address is ``vault_url``."""
    return f"{vault_base_url(vault_url).rstrip('/')}{MCP_PATH}"


async def _activation_is_ready(session: AsyncSession, user_id: int) -> bool:
    """Whether the account's managed allocation has reached ``ready``."""
    result = await session.execute(
        select(VaultActivation.state).where(VaultActivation.user_id == user_id)
    )
    return result.scalar_one_or_none() == VaultActivationState.READY.value


async def account_vault_resource(session: AsyncSession, user_id: int) -> str | None:
    """Return the MCP URL of the vault bound to ``user_id``, or ``None`` for none.

    The only audience a request signed in as this account may name. A managed
    vault counts only once its activation is ``ready``, matching the rule that
    keeps a handed-off credential inert until then. Until Creek-Vault#1962 gives
    a managed vault a public MCP address of its own, the stored address plus
    ``/mcp`` is the resource, for both kinds of vault.

    The deployment-wide vault an operator configures by environment is not an
    account's vault in this sense and is never a resource here.
    """
    config = await load_vault_config(session, user_id)
    if config is None:
        return None
    if config.provisioned and not await _activation_is_ready(session, user_id):
        return None
    return normalize_resource(vault_mcp_url(config.vault_url))


# --- the whole request -----------------------------------------------------------


def _protocol_error(params: Mapping[str, str]) -> AuthorizationError | None:
    """Name the first protocol rule ``params`` breaks, before scope and resource."""
    if params.get("response_type") != RESPONSE_TYPE_CODE:
        return AuthorizationError.UNSUPPORTED_RESPONSE_TYPE
    if params.get("code_challenge_method") != PKCE_METHOD_S256:
        return AuthorizationError.INVALID_REQUEST
    if not code_challenge_is_valid(params.get("code_challenge", "")):
        return AuthorizationError.INVALID_REQUEST
    if not params.get("state"):
        return AuthorizationError.INVALID_REQUEST
    return None


def read_authorization_request(
    params: Mapping[str, str],
) -> AuthorizationRequest | AuthorizationError:
    """Read an authorization query into a request, or name the rule it breaks.

    The order is deliberate: protocol shape first, then scope, then resource. A
    request wrong in several ways is answered about its protocol fault, so the
    resource -- the one field that names a vault -- is judged last and only on
    an otherwise well-formed request. Whether the resource is *this account's*
    vault is a separate question, asked once the person has signed in.
    """
    error = _protocol_error(params)
    if error is not None:
        return error
    scopes = parse_scope(params.get("scope"))
    if scopes is None:
        return AuthorizationError.INVALID_SCOPE
    resource = normalize_resource(params.get("resource", ""))
    if resource is None:
        return AuthorizationError.INVALID_TARGET
    return AuthorizationRequest(
        client_id=params.get("client_id", ""),
        redirect_uri=params.get("redirect_uri", ""),
        code_challenge=params["code_challenge"],
        scopes=scopes,
        state=params["state"],
        resource=resource,
    )


# --- consent tickets ---------------------------------------------------------------


def consent_ticket_key(secret: str) -> bytes:
    """Derive the consent-ticket signing key from the deployment secret.

    HMAC-SHA256 under a fixed context string, so the key is as strong as the
    secret and shares nothing usable with it: a session JWT does not verify
    under this key, and a ticket does not verify under the secret.
    """
    return hmac.new(secret.encode(), _TICKET_KEY_CONTEXT, hashlib.sha256).digest()


def sign_consent_ticket(
    request: AuthorizationRequest, user_id: int, *, secret: str, now: datetime
) -> str:
    """Return a ticket binding ``request`` to ``user_id`` until it expires."""
    claims = {
        "typ": CONSENT_TICKET_TYPE,
        "uid": user_id,
        "cid": request.client_id,
        "ru": request.redirect_uri,
        "cc": request.code_challenge,
        "sc": request.scope,
        "st": request.state,
        "res": request.resource,
        "iat": now,
        "exp": now + CONSENT_TICKET_TTL,
    }
    return jwt.encode(claims, consent_ticket_key(secret), algorithm=_TICKET_ALGORITHM)


def _string_claims(claims: Mapping[str, object]) -> tuple[str, ...] | None:
    """Return the ticket's request fields in order, or ``None`` if any is missing."""
    values = [claims.get(name) for name in _TICKET_REQUEST_CLAIMS]
    strings = [value for value in values if isinstance(value, str)]
    return tuple(strings) if len(strings) == len(_TICKET_REQUEST_CLAIMS) else None


def _ticket_request(claims: Mapping[str, object]) -> tuple[AuthorizationRequest, int] | None:
    """Rebuild the request a ticket carries, or ``None`` if any field is missing."""
    strings = _string_claims(claims)
    user_id = claims.get("uid")
    if strings is None or not isinstance(user_id, int):
        return None
    client_id, redirect_uri, challenge, scope, state, resource = strings
    scopes = parse_scope(scope)
    if scopes is None:
        return None
    request = AuthorizationRequest(
        client_id=client_id,
        redirect_uri=redirect_uri,
        code_challenge=challenge,
        scopes=scopes,
        state=state,
        resource=resource,
    )
    return request, user_id


def read_consent_ticket(
    ticket: str, *, secret: str, now: datetime
) -> tuple[AuthorizationRequest, int] | None:
    """Return the request and account a ticket binds, or ``None`` if it does not verify.

    Expired, tampered, signed under another key, of another ``typ``, or missing
    a field: every one of those is the same ``None``, because the caller's only
    honest answer to any of them is "start again".

    Expiry is checked against the caller's ``now`` rather than PyJWT's own
    clock, so the clock that signed a ticket and the clock that reads it are
    one clock -- in a test and in a request alike.
    """
    try:
        claims = jwt.decode(
            ticket,
            consent_ticket_key(secret),
            algorithms=[_TICKET_ALGORITHM],
            options={"verify_exp": False, "verify_iat": False, "require": ["exp", "typ"]},
        )
    except jwt.PyJWTError:
        return None
    expires = claims.get("exp")
    if claims.get("typ") != CONSENT_TICKET_TYPE or not isinstance(expires, int | float):
        return None
    if now.timestamp() >= expires:
        return None
    return _ticket_request(claims)


# --- issuing a code --------------------------------------------------------------


def mint_code() -> str:
    """Return a fresh authorization code: the prefix and 256 bits of randomness."""
    return f"{CODE_PREFIX}{secrets.token_urlsafe(_CODE_BYTES)}"


def hash_code(code: str) -> str:
    """Return the digest a code is stored and looked up under.

    SHA-256 rather than a slow password hash: the code is 256 random bits, so
    there is nothing for a slow hash to protect against, and the token
    endpoint needs an indexed lookup rather than a scan.
    """
    return hashlib.sha256(code.encode()).hexdigest()


async def _record_grant(
    session: AsyncSession, request: AuthorizationRequest, user_id: int, now: datetime
) -> None:
    """Create or restate the account's standing grant for this agent."""
    result = await session.execute(
        select(AgentGrant).where(
            AgentGrant.user_id == user_id, AgentGrant.client_id == request.client_id
        )
    )
    grant = result.scalars().first()
    if grant is None:
        grant = AgentGrant(user_id=user_id, client_id=request.client_id, created_at=now)
    elif grant.revoked_at is not None:
        # A new consent after a revocation, not a continuation of the old one.
        grant.revoked_at = None
        grant.created_at = now
    grant.grants = list(request.scopes)
    grant.resource = request.resource
    session.add(grant)


async def issue_authorization_code(
    session: AsyncSession,
    request: AuthorizationRequest,
    user_id: int,
    *,
    now: datetime | None = None,
) -> str:
    """Store a one-time code for an approved request, record the grant, and return the code.

    The caller has already established that the person approved this exact
    request and that its resource is their vault. The code row and the grant
    commit together, so an agent is never sent a code for a grant that was
    not recorded.
    """
    issued_at = now or datetime.now(UTC)
    code = mint_code()
    session.add(
        OAuthAuthorizationCode(
            code_hash=hash_code(code),
            client_id=request.client_id,
            user_id=user_id,
            redirect_uri=request.redirect_uri,
            code_challenge=request.code_challenge,
            code_challenge_method=PKCE_METHOD_S256,
            resource=request.resource,
            scope=request.scope,
            created_at=issued_at,
            expires_at=issued_at + AUTHORIZATION_CODE_TTL,
        )
    )
    await _record_grant(session, request, user_id, issued_at)
    await session.commit()
    return code
