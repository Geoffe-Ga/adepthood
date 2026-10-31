"""The token half of the vault-agent authorization server (#3533).

An agent that a person approved (#3532) arrives here with a one-time code and
its PKCE verifier, and leaves with access bounded by the person's choices:

* an **access token** -- an ES256 JWT that lives :data:`ACCESS_TOKEN_TTL`,
  whose ``aud`` is exactly the person's vault MCP URL and whose ``scope`` is
  what they approved. The vault verifies it against the published key set with
  no call back here (Creek-Vault#1963);
* a **refresh token**, only if they approved ``offline_access`` -- opaque,
  stored only as its SHA-256, alive for :data:`REFRESH_TOKEN_TTL` and rotated
  on every use. Without that approval no refresh token or database row is made.

Everything the token may say was decided at approval and is re-checked here:
the code must be unspent and unexpired, presented by the client it was issued
to with the exact redirect and the verifier that hashes to its challenge; the
grant must still stand; the account must still be active; and the audience must
still be the account's own vault. Each failure is an RFC 6749 error code and no
more -- ``invalid_grant`` does not say which check failed.

**Replay and reuse.** A code presented a second time is refused and every
refresh token under its grant is revoked (OAuth 2.1 section 4.1.3). A refresh
token presented after it was rotated away is refused and its whole family is
revoked (section 4.3.1). Both moves are atomic conditional updates, so two
racing requests cannot both spend one credential.

**Revocation lands on the vault's next lookup.** Revoking a refresh token
(RFC 7009) or a grant (``agent_grant.revoked_at``, set from Settings in #3534)
stops the next refresh. Access tokens are not stored, so none can be marked
revoked; instead the vault asks on every call (owner decision R3-2, #3585):
Creek's control plane sends a verified token's ``sub``, ``client_id`` and
``iat`` to ``POST /internal/vault-provisioning/agent-token-status`` and
:func:`agent_token_active` answers from the same grant and account rules the
refresh applies. Creek caches an ``active`` answer briefly
(``REVOCATION_CACHE_SECONDS``, Creek-Vault#2005), so a revocation lands within
that window. A vault that does not ask -- one with no status credential --
still has :data:`ACCESS_TOKEN_TTL` as its bound.

**Who the token is about.** ``sub`` is the account's stable, opaque consumer
identity. On a managed vault it is the ``consumer_identity`` provisioning handed
the vault (``vaultactivation.consumer_identity``), because a managed vault pins
``sub`` to exactly that value. A self-hosted vault was never provisioned, so its
account's identity is derived -- an HMAC of the account id under a key derived
from the deployment secret -- stable, and meaningless outside this server. The
*agent* is named by the RFC 9068 ``client_id`` claim, so the vault can tell one
agent from another under one person (Creek-Vault#1976).

Nothing on the hot path leaves this process: no Creek call, no provider call,
only the database and a local signature.
"""

from __future__ import annotations

import base64
import enum
import hashlib
import hmac
import logging
import secrets
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Final

import jwt
from sqlalchemy import ColumnElement
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select, update

from domain.dates import ensure_aware
from models.agent_grant import AgentGrant
from models.oauth_authorization_code import OAuthAuthorizationCode
from models.oauth_refresh_token import OAuthRefreshToken
from models.user_vault_config import UserVaultConfig
from models.vault_activation import VaultActivation, VaultActivationState
from services.oauth_authorization import (
    account_may_authorize,
    account_vault_resource,
    code_challenge_is_valid,
    hash_code,
    normalize_resource,
    parse_scope,
)
from services.oauth_signing_keys import SIGNING_ALGORITHM, SigningKey

logger = logging.getLogger(__name__)

# --- lifetimes and shapes ----------------------------------------------------

#: How long an access token is good for. A vault that asks
#: :func:`agent_token_active` on every call (R3-2, #3585) sees a revocation within
#: its own short cache window; this lifetime is the backstop for one that does
#: not ask, and the longest a revocation can take to land there.
ACCESS_TOKEN_TTL: Final = timedelta(minutes=10)

#: How long a refresh token waits to be used. The app's own session lifetime
#: (#2804), for the same reason: it rotates, and a month unused ends it.
REFRESH_TOKEN_TTL: Final = timedelta(days=30)

#: Prefix on every refresh token, so one is recognisable in a pasted log.
REFRESH_PREFIX: Final = "rt_"
# 256 bits of entropy, the authorization code's budget.
_REFRESH_TOKEN_BYTES: Final = 32

#: RFC 9068 section 2.1: the ``typ`` header of a JWT access token.
ACCESS_JWT_TYPE: Final = "at+jwt"
BEARER_TYPE: Final = "Bearer"

GRANT_AUTHORIZATION_CODE: Final = "authorization_code"
GRANT_REFRESH: Final = "refresh_token"

#: Prefix of the subject derived for an account whose vault was not provisioned.
AGENT_SUBJECT_PREFIX: Final = "adepthood-account-"
#: 128 bits of the HMAC: unguessable, and short enough for any audit column.
AGENT_SUBJECT_HEX_DIGITS: Final = 32
# Versioned like the consent ticket's context, so the derivation can be retired
# deliberately rather than by accident.
_SUBJECT_KEY_CONTEXT: Final = b"adepthood/oauth-agent-subject/v1"

_REPLAY_EVENT: Final = "oauth_code_replayed"
_REUSE_EVENT: Final = "oauth_refresh_token_reused"
_ISSUED_EVENT: Final = "oauth_token_issued"


class TokenError(enum.StrEnum):
    """The RFC 6749 section 5.2 / RFC 8707 error codes the token endpoint answers with."""

    INVALID_REQUEST = "invalid_request"
    INVALID_GRANT = "invalid_grant"
    UNSUPPORTED_GRANT_TYPE = "unsupported_grant_type"
    INVALID_SCOPE = "invalid_scope"
    INVALID_TARGET = "invalid_target"


@dataclass(frozen=True)
class Signer:
    """What issuing needs from the deployment: who signs, with what, and when."""

    issuer: str
    key: SigningKey
    subject_secret: str = field(repr=False)
    now: datetime


@dataclass(frozen=True)
class IssuedTokens:
    """A successful token response, before it is put on the wire."""

    access_token: str = field(repr=False)
    refresh_token: str | None = field(repr=False)
    scope: str
    expires_in: int = int(ACCESS_TOKEN_TTL.total_seconds())


@dataclass(frozen=True)
class _CodeRequest:
    """The fields of an ``authorization_code`` request, all present."""

    code: str
    verifier: str = field(repr=False)
    client_id: str
    redirect_uri: str
    resource: str | None


# --- small rules ---------------------------------------------------------------


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def pkce_verifier_matches(verifier: str, challenge: str) -> bool:
    """Return whether ``verifier`` is the RFC 7636 S256 preimage of ``challenge``.

    A verifier has the same shape rule as a challenge (43-128 unreserved
    characters), and the comparison is constant-time.
    """
    if not code_challenge_is_valid(verifier):
        return False
    digest = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return hmac.compare_digest(digest, challenge)


def _resource_matches(presented: str | None, bound: str) -> bool:
    """A resent RFC 8707 ``resource`` must be the bound one, in any spelling of it."""
    return presented is None or normalize_resource(presented) == bound


def _grant_covers(grant: AgentGrant, issued_at: datetime) -> bool:
    """Whether ``grant`` still stands for a credential issued at ``issued_at``.

    Not revoked, and not re-approved since: a re-approval after a revocation
    restarts ``created_at``, so anything minted earlier belongs to the consent
    that was withdrawn.
    """
    return grant.revoked_at is None and ensure_aware(grant.created_at) <= ensure_aware(issued_at)


def _persisted_id(row: AgentGrant | OAuthRefreshToken | OAuthAuthorizationCode) -> int:
    """The primary key of a row read from the database, which always has one."""
    if row.id is None:
        msg = f"{type(row).__name__} was not read from the database"
        raise ValueError(msg)
    return row.id


def mint_refresh_token() -> str:
    """Return a fresh refresh token: the prefix and 256 bits of randomness."""
    return f"{REFRESH_PREFIX}{secrets.token_urlsafe(_REFRESH_TOKEN_BYTES)}"


# --- the subject -----------------------------------------------------------------


def derived_subject(user_id: int, secret: str) -> str:
    """The opaque, stable subject of an account whose vault was not provisioned."""
    key = hmac.new(secret.encode(), _SUBJECT_KEY_CONTEXT, hashlib.sha256).digest()
    digest = hmac.new(key, str(user_id).encode(), hashlib.sha256).hexdigest()
    return f"{AGENT_SUBJECT_PREFIX}{digest[:AGENT_SUBJECT_HEX_DIGITS]}"


async def managed_consumer_identity(session: AsyncSession, user_id: int) -> str | None:
    """The consumer identity provisioning gave the account's ready managed vault, if any."""
    result = await session.execute(
        select(VaultActivation.consumer_identity)
        .join(UserVaultConfig, col(UserVaultConfig.user_id) == col(VaultActivation.user_id))
        .where(
            VaultActivation.user_id == user_id,
            col(UserVaultConfig.provisioned).is_(True),
            VaultActivation.state == VaultActivationState.READY.value,
        )
    )
    return result.scalar_one_or_none()


async def agent_subject(session: AsyncSession, user_id: int, *, secret: str) -> str:
    """Return the ``sub`` every agent token for ``user_id`` carries.

    The managed vault's provisioned consumer identity when there is one -- the
    value that vault pins ``sub`` to -- and otherwise :func:`derived_subject`.
    """
    managed = await managed_consumer_identity(session, user_id)
    return managed if managed is not None else derived_subject(user_id, secret)


# --- minting ---------------------------------------------------------------------


def mint_access_token(
    signer: Signer, *, subject: str, audience: str, scope: str, client_id: str
) -> str:
    """Sign an access token the vault's verifier accepts.

    ``aud`` is one string, never a list: a token two resource servers would
    both accept is how a token gets passed through. The header carries ``kid``
    and ``typ`` and nothing critical. No claim names the person.
    """
    issued_at = int(signer.now.timestamp())
    claims = {
        "iss": signer.issuer,
        "sub": subject,
        "aud": audience,
        "scope": scope,
        "client_id": client_id,
        "iat": issued_at,
        "exp": issued_at + int(ACCESS_TOKEN_TTL.total_seconds()),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(
        claims,
        signer.key.private_key,
        algorithm=SIGNING_ALGORITHM,
        headers={"kid": signer.key.kid, "typ": ACCESS_JWT_TYPE},
    )


@dataclass(frozen=True)
class _Issuance:
    """What one issuance is for: whose grant, which vault, which scopes, which family."""

    grant: AgentGrant
    audience: str
    scope: str
    family_id: str


async def _issue(session: AsyncSession, issuance: _Issuance, signer: Signer) -> IssuedTokens:
    """Sign access, and issue refresh only when the person approved staying connected."""
    grant = issuance.grant
    subject = await agent_subject(session, grant.user_id, secret=signer.subject_secret)
    refresh_token = None
    if "offline_access" in issuance.scope.split():
        refresh_token = mint_refresh_token()
        session.add(
            OAuthRefreshToken(
                token_hash=hash_code(refresh_token),
                family_id=issuance.family_id,
                grant_id=_persisted_id(grant),
                user_id=grant.user_id,
                created_at=signer.now,
                expires_at=signer.now + REFRESH_TOKEN_TTL,
            )
        )
    grant.last_used_at = signer.now
    session.add(grant)
    await session.commit()
    logger.info(_ISSUED_EVENT, extra={"user_id": grant.user_id, "client_id": grant.client_id})
    access_token = mint_access_token(
        signer,
        subject=subject,
        audience=issuance.audience,
        scope=issuance.scope,
        client_id=grant.client_id,
    )
    return IssuedTokens(
        access_token=access_token, refresh_token=refresh_token, scope=issuance.scope
    )


# --- revocation --------------------------------------------------------------------


async def revoke_family(session: AsyncSession, family_id: str, now: datetime) -> None:
    """Revoke every live refresh token in ``family_id``. The caller commits."""
    await session.execute(
        update(OAuthRefreshToken)
        .where(col(OAuthRefreshToken.family_id) == family_id)
        .where(col(OAuthRefreshToken.revoked_at).is_(None))
        .values(revoked_at=now)
    )


async def revoke_grant_tokens(session: AsyncSession, grant_id: int, now: datetime) -> None:
    """Revoke every live refresh token issued under ``grant_id``. The caller commits.

    What Settings' Revoke (#3534) calls beside setting ``agent_grant.revoked_at``,
    and what a replayed code triggers. Either alone already stops the next
    refresh; doing both leaves nothing live to argue about.
    """
    await session.execute(
        update(OAuthRefreshToken)
        .where(col(OAuthRefreshToken.grant_id) == grant_id)
        .where(col(OAuthRefreshToken.revoked_at).is_(None))
        .values(revoked_at=now)
    )


# --- loading ---------------------------------------------------------------------


async def _load_code(session: AsyncSession, code: str) -> OAuthAuthorizationCode | None:
    result = await session.execute(
        select(OAuthAuthorizationCode)
        .where(OAuthAuthorizationCode.code_hash == hash_code(code))
        .execution_options(populate_existing=True)
    )
    return result.scalars().first()


async def _load_refresh(session: AsyncSession, token: str) -> OAuthRefreshToken | None:
    result = await session.execute(
        select(OAuthRefreshToken)
        .where(OAuthRefreshToken.token_hash == hash_code(token))
        .execution_options(populate_existing=True)
    )
    return result.scalars().first()


async def _load_grant(
    session: AsyncSession, *clauses: ColumnElement[bool] | bool
) -> AgentGrant | None:
    result = await session.execute(
        select(AgentGrant).where(*clauses).execution_options(populate_existing=True)
    )
    return result.scalars().first()


async def _account_holds(session: AsyncSession, user_id: int, resource: str) -> bool:
    """The account may still authorize, and ``resource`` is still its own vault."""
    if not await account_may_authorize(session, user_id):
        return False
    return await account_vault_resource(session, user_id) == resource


# --- authorization_code ------------------------------------------------------------


def _read_code_request(form: Mapping[str, str]) -> _CodeRequest | None:
    """The code request's fields, or ``None`` if a required one is missing or empty."""
    names = ("code", "code_verifier", "client_id", "redirect_uri")
    values = [form.get(name, "") for name in names]
    if not all(values):
        return None
    code, verifier, client_id, redirect_uri = values
    return _CodeRequest(code, verifier, client_id, redirect_uri, form.get("resource") or None)


def _binding_error(
    code: OAuthAuthorizationCode, request: _CodeRequest, now: datetime
) -> TokenError | None:
    """The first way ``request`` fails to match what ``code`` was bound to, if any."""
    checks = (
        (ensure_aware(code.expires_at) > now, TokenError.INVALID_GRANT),
        (code.client_id == request.client_id, TokenError.INVALID_GRANT),
        (code.redirect_uri == request.redirect_uri, TokenError.INVALID_GRANT),
        (pkce_verifier_matches(request.verifier, code.code_challenge), TokenError.INVALID_GRANT),
        (_resource_matches(request.resource, code.resource), TokenError.INVALID_TARGET),
    )
    return next((error for holds, error in checks if not holds), None)


async def _replayed(
    session: AsyncSession, code: OAuthAuthorizationCode, now: datetime
) -> TokenError:
    """A spent code came back: revoke what its grant issued, and refuse."""
    grant = await _load_grant(
        session, AgentGrant.user_id == code.user_id, AgentGrant.client_id == code.client_id
    )
    if grant is not None:
        await revoke_grant_tokens(session, _persisted_id(grant), now)
    await session.commit()
    logger.warning(_REPLAY_EVENT, extra={"user_id": code.user_id, "client_id": code.client_id})
    return TokenError.INVALID_GRANT


async def _consume(session: AsyncSession, code: OAuthAuthorizationCode, now: datetime) -> bool:
    """Mark ``code`` spent if nobody else has; ``False`` when a racing request won."""
    result = await session.execute(
        update(OAuthAuthorizationCode)
        .where(col(OAuthAuthorizationCode.id) == _persisted_id(code))
        .where(col(OAuthAuthorizationCode.consumed_at).is_(None))
        .values(consumed_at=now)
        .returning(col(OAuthAuthorizationCode.id))
    )
    return result.scalar_one_or_none() is not None


async def _grant_for_code(session: AsyncSession, code: OAuthAuthorizationCode) -> AgentGrant | None:
    """The standing grant ``code`` was issued under, if the account and its vault still hold."""
    grant = await _load_grant(
        session, AgentGrant.user_id == code.user_id, AgentGrant.client_id == code.client_id
    )
    if grant is None or not _grant_covers(grant, code.created_at):
        return None
    return grant if await _account_holds(session, code.user_id, code.resource) else None


async def _admit_code(
    session: AsyncSession, code: OAuthAuthorizationCode, request: _CodeRequest, now: datetime
) -> AgentGrant | TokenError:
    """Spend ``code`` for ``request``, or say why not."""
    if code.consumed_at is not None:
        return await _replayed(session, code, now)
    error = _binding_error(code, request, now)
    if error is not None:
        return error
    grant = await _grant_for_code(session, code)
    if grant is None:
        return TokenError.INVALID_GRANT
    return grant if await _consume(session, code, now) else await _replayed(session, code, now)


async def exchange_authorization_code(
    session: AsyncSession, form: Mapping[str, str], signer: Signer
) -> IssuedTokens | TokenError:
    """Trade a code and its verifier for a token pair (RFC 6749 section 4.1.3)."""
    request = _read_code_request(form)
    if request is None:
        return TokenError.INVALID_REQUEST
    code = await _load_code(session, request.code)
    if code is None:
        return TokenError.INVALID_GRANT
    admitted = await _admit_code(session, code, request, signer.now)
    if isinstance(admitted, TokenError):
        return admitted
    issuance = _Issuance(admitted, code.resource, code.scope, uuid.uuid4().hex)
    return await _issue(session, issuance, signer)


# --- refresh_token -------------------------------------------------------------------


def _token_live(token: OAuthRefreshToken, now: datetime) -> bool:
    """Not revoked and not expired. Rotation is judged separately, as reuse."""
    return token.revoked_at is None and ensure_aware(token.expires_at) > now


def _grant_admits(grant: AgentGrant, token: OAuthRefreshToken, client_id: str | None) -> bool:
    """The grant still stands for ``token``, and a named client is the grant's own."""
    return _grant_covers(grant, token.created_at) and (
        not client_id or client_id == grant.client_id
    )


async def _grant_for_refresh(
    session: AsyncSession, token: OAuthRefreshToken, client_id: str | None, now: datetime
) -> AgentGrant | None:
    """The standing grant a live ``token`` belongs to, if the account and its vault still hold."""
    if not _token_live(token, now):
        return None
    grant = await _load_grant(session, AgentGrant.id == token.grant_id)
    if grant is None or not _grant_admits(grant, token, client_id):
        return None
    return grant if await _account_holds(session, grant.user_id, grant.resource) else None


def _narrowed_scope(grant: AgentGrant, raw: str) -> str | TokenError:
    """``raw`` as a scope, if every scope in it is one the grant holds."""
    requested = parse_scope(raw)
    if requested is None or not set(requested) <= set(grant.grants):
        return TokenError.INVALID_SCOPE
    return " ".join(requested)


def _requested_scope(grant: AgentGrant, form: Mapping[str, str]) -> str | TokenError:
    """The scope this refresh asks for: the grant's, or a subset of it (RFC 6749 section 6)."""
    if not _resource_matches(form.get("resource") or None, grant.resource):
        return TokenError.INVALID_TARGET
    raw = form.get("scope")
    return _narrowed_scope(grant, raw) if raw else " ".join(grant.grants)


async def _reused(session: AsyncSession, token: OAuthRefreshToken, now: datetime) -> TokenError:
    """A rotated-away token came back: two parties hold it, so its family ends."""
    await revoke_family(session, token.family_id, now)
    await session.commit()
    logger.warning(_REUSE_EVENT, extra={"user_id": token.user_id})
    return TokenError.INVALID_GRANT


async def _rotate(session: AsyncSession, token: OAuthRefreshToken, now: datetime) -> bool:
    """Spend ``token`` if nobody else has; ``False`` when a racing request won."""
    result = await session.execute(
        update(OAuthRefreshToken)
        .where(col(OAuthRefreshToken.id) == _persisted_id(token))
        .where(col(OAuthRefreshToken.rotated_at).is_(None))
        .where(col(OAuthRefreshToken.revoked_at).is_(None))
        .values(rotated_at=now)
        .returning(col(OAuthRefreshToken.id))
    )
    return result.scalar_one_or_none() is not None


async def _admit_refresh(
    session: AsyncSession, token: OAuthRefreshToken, form: Mapping[str, str], now: datetime
) -> tuple[AgentGrant, str] | TokenError:
    """Rotate ``token`` for this request, or say why not."""
    if token.rotated_at is not None:
        return await _reused(session, token, now)
    grant = await _grant_for_refresh(session, token, form.get("client_id"), now)
    if grant is None:
        return TokenError.INVALID_GRANT
    scope = _requested_scope(grant, form)
    if isinstance(scope, TokenError):
        return scope
    return (
        (grant, scope) if await _rotate(session, token, now) else await _reused(session, token, now)
    )


async def exchange_refresh_token(
    session: AsyncSession, form: Mapping[str, str], signer: Signer
) -> IssuedTokens | TokenError:
    """Trade a refresh token for a new pair in the same family (RFC 6749 section 6)."""
    presented = form.get("refresh_token", "")
    if not presented:
        return TokenError.INVALID_REQUEST
    token = await _load_refresh(session, presented)
    if token is None:
        return TokenError.INVALID_GRANT
    admitted = await _admit_refresh(session, token, form, signer.now)
    if isinstance(admitted, TokenError):
        return admitted
    grant, scope = admitted
    return await _issue(session, _Issuance(grant, grant.resource, scope, token.family_id), signer)


_Exchange = Callable[
    [AsyncSession, Mapping[str, str], Signer], Awaitable[IssuedTokens | TokenError]
]

_EXCHANGES: Final[Mapping[str, _Exchange]] = {
    GRANT_AUTHORIZATION_CODE: exchange_authorization_code,
    GRANT_REFRESH: exchange_refresh_token,
}


async def issue_tokens(
    session: AsyncSession, form: Mapping[str, str], signer: Signer
) -> IssuedTokens | TokenError:
    """Answer one token request, whichever grant type it carries."""
    grant_type = form.get("grant_type", "")
    if not grant_type:
        return TokenError.INVALID_REQUEST
    exchange = _EXCHANGES.get(grant_type)
    if exchange is None:
        return TokenError.UNSUPPORTED_GRANT_TYPE
    return await exchange(session, form, signer)


# --- RFC 7009 ------------------------------------------------------------------------


async def _revocable_by(
    session: AsyncSession, token: OAuthRefreshToken, client_id: str | None
) -> bool:
    """Whether the caller may revoke ``token``: anyone holding it, unless it names another client.

    A public client has no secret, so possession of a 256-bit token is the
    proof; a ``client_id`` that names a different client than the token's is
    a request about somebody else's token and changes nothing.
    """
    if not client_id:
        return True
    grant = await _load_grant(session, AgentGrant.id == token.grant_id)
    return grant is not None and grant.client_id == client_id


async def revoke_token(
    session: AsyncSession, form: Mapping[str, str], now: datetime
) -> TokenError | None:
    """Revoke a refresh token and its family (RFC 7009); ``None`` means answer 200.

    An unknown token, an access token, or another client's token is answered
    the same 200 (section 2.2), so the endpoint says nothing about what exists.
    """
    presented = form.get("token", "")
    if not presented:
        return TokenError.INVALID_REQUEST
    token = await _load_refresh(session, presented)
    if token is not None and await _revocable_by(session, token, form.get("client_id")):
        await revoke_family(session, token.family_id, now)
        await session.commit()
    return None


# --- the vault's per-call status lookup (R3-2, #3585) ------------------------------


class TokenStatus(enum.StrEnum):
    """Why a status lookup answered as it did: the closed vocabulary it is logged by.

    Only :attr:`ACTIVE` reaches the caller as ``true``; every other member is the
    same ``false`` on the wire, so which one applied is said to the log alone.
    """

    ACTIVE = "active"
    EXPIRED = "expired"
    UNKNOWN_SUBJECT = "unknown_subject"
    NO_GRANT = "no_grant"
    GRANT_WITHDRAWN = "grant_withdrawn"
    ACCOUNT_INACTIVE = "account_inactive"


_STATUS_EVENT: Final = "oauth_agent_token_status"

#: ``iat`` is a JWT NumericDate -- whole seconds -- and :func:`mint_access_token`
#: truncates, so a token stamped ``t`` was minted somewhere in ``[t, t + 1)``. The
#: grant it was minted under may carry microseconds inside that same second, so
#: coverage is judged against the last instant ``t`` can stand for.
_IAT_LAST_INSTANT: Final = timedelta(seconds=1) - timedelta(microseconds=1)


async def _managed_account(session: AsyncSession, subject: str) -> int | None:
    """The account whose ready managed vault was provisioned with ``subject``, if any."""
    result = await session.execute(
        select(VaultActivation.user_id)
        .join(UserVaultConfig, col(UserVaultConfig.user_id) == col(VaultActivation.user_id))
        .where(
            VaultActivation.consumer_identity == subject,
            col(UserVaultConfig.provisioned).is_(True),
            VaultActivation.state == VaultActivationState.READY.value,
        )
    )
    return result.scalar_one_or_none()


async def _derived_account(
    session: AsyncSession, subject: str, client_id: str, secret: str
) -> int | None:
    """The account whose derived subject is ``subject``, among those that approved ``client_id``.

    A derived subject is an HMAC and cannot be inverted, so the candidates are the
    accounts that ever approved this agent -- revoked ones included, so the log
    can tell a withdrawn grant from a stranger -- each compared in constant time.
    An account with a managed vault signs with its consumer identity instead, so
    its derived value names nothing.
    """
    if not subject.startswith(AGENT_SUBJECT_PREFIX):
        return None
    result = await session.execute(
        select(AgentGrant.user_id).where(col(AgentGrant.client_id) == client_id)
    )
    for candidate in result.scalars().all():
        if hmac.compare_digest(derived_subject(candidate, secret), subject):
            managed = await managed_consumer_identity(session, candidate)
            return candidate if managed is None else None
    return None


async def _grant_status(
    session: AsyncSession, user_id: int, client_id: str, issued_at: datetime
) -> TokenStatus:
    """Whether ``user_id``'s grant to ``client_id`` still covers a token stamped ``issued_at``."""
    grant = await _load_grant(
        session, col(AgentGrant.user_id) == user_id, col(AgentGrant.client_id) == client_id
    )
    if grant is None:
        return TokenStatus.NO_GRANT
    if not _grant_covers(grant, ensure_aware(issued_at) + _IAT_LAST_INSTANT):
        return TokenStatus.GRANT_WITHDRAWN
    if not await account_may_authorize(session, user_id):
        return TokenStatus.ACCOUNT_INACTIVE
    return TokenStatus.ACTIVE


@dataclass(frozen=True)
class AgentTokenClaims:
    """The three claims of a verified access token that decide whether it still stands."""

    subject: str
    client_id: str
    issued_at: datetime


async def agent_token_status(
    session: AsyncSession, claims: AgentTokenClaims, *, secret: str, now: datetime
) -> TokenStatus:
    """Decide, from a token's own claims, whether the access it carries still stands.

    The same rules the token endpoint applies at refresh: the token is within its
    lifetime, ``sub`` is an account this server signs for, that account's grant
    to ``client_id`` is unrevoked and not re-approved since ``iat``
    (:func:`_grant_covers`), and the account may still authorize
    (:func:`account_may_authorize`). Read-only: nothing is stamped or written.
    """
    if ensure_aware(claims.issued_at) + ACCESS_TOKEN_TTL <= ensure_aware(now):
        return TokenStatus.EXPIRED
    user_id = await _managed_account(session, claims.subject)
    if user_id is None:
        user_id = await _derived_account(session, claims.subject, claims.client_id, secret)
    if user_id is None:
        return TokenStatus.UNKNOWN_SUBJECT
    return await _grant_status(session, user_id, claims.client_id, claims.issued_at)


async def agent_token_active(
    session: AsyncSession, claims: AgentTokenClaims, *, secret: str, now: datetime
) -> bool:
    """Whether a token with ``claims`` may still be served; logs the outcome, never the subject."""
    outcome = await agent_token_status(session, claims, secret=secret, now=now)
    logger.info(_STATUS_EVENT, extra={"outcome": outcome.value})
    return outcome is TokenStatus.ACTIVE
