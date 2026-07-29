"""Provider-neutral OpenID Connect ``id_token`` verification.

One verifier, one failure mode. Every way a token can fail — a signature that
does not check out, an audience belonging to another client, an issuer nobody
recognises, an expired or claim-less payload, a JWKS lookup that cannot
resolve the ``kid`` — collapses into a single :class:`OIDCTokenError` carrying
a static message. Callers therefore cannot accidentally build an oracle out of
the exception, and the raw token (a replayable credential) never travels
inside an exception, a log record, or a response body.

Two properties carry the security of the whole module:

* ``algorithms`` is supplied by the caller and never read from the token's own
  header. That single decision closes both the ``alg: none`` forgery and the
  RS256-to-HS256 confusion attack, where a verifier that trusts the header
  treats the public key as a shared HMAC secret and lets anyone who can read
  the published JWKS mint tokens for any account.
* An empty ``audiences`` fails closed. A deployment that has not configured
  its client ids rejects every token rather than accepting all of them.

The module is provider-neutral on purpose: Google's adapter lives in
:mod:`services.oauth_google` and Apple's in :mod:`services.oauth_apple`, each
reusing this core by supplying its own issuers, audiences, and key provider.
Claim-shape quirks (Apple's string-valued ``email_verified``, for instance)
belong in the adapters — coercing them here is how an unverified address would
end up trusted by every provider at once.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

import jwt
from jwt import PyJWKClient

if TYPE_CHECKING:
    from collections.abc import Collection, Sequence

    from jwt import PyJWK
    from jwt.algorithms import AllowedPublicKeys

__all__ = [
    "JWKS_TIMEOUT_SECONDS",
    "OIDCIdentity",
    "OIDCKeyProvider",
    "OIDCSigningKey",
    "OIDCTokenError",
    "build_bounded_jwk_client",
    "claim_str",
    "verify_oidc_id_token",
]

# Signature algorithms accepted unless a caller narrows or widens the set.
# RS256 is what Google and Apple both publish; asymmetric-only is the point.
DEFAULT_OIDC_ALGORITHMS: tuple[str, ...] = ("RS256",)

# Claims a token must actually carry. Without ``require`` PyJWT silently skips
# validating a claim that is simply absent, so a token with no ``exp`` would
# never expire and one with no ``sub`` would name no user.
_REQUIRED_CLAIMS: tuple[str, ...] = ("exp", "iat", "aud", "iss", "sub")

# The two messages this module ever raises with. Static by construction: any
# interpolation of caller input here would be a channel for the token itself
# to reach a log line or an error body.
_INVALID_TOKEN_MESSAGE = "oidc id_token failed verification"  # noqa: S105  # nosec B105  # pragma: allowlist secret
_UNCONFIGURED_AUDIENCE_MESSAGE = "no oidc audience configured"

# How long a cached JWKS set may be reused before it is refetched. An hour is
# far shorter than any provider's key-rotation cadence (days), so a rotated key
# is picked up automatically, while ordinary sign-ins pay no network round trip.
_JWKS_CACHE_SECONDS = 3600.0

# Ceiling on individually cached signing keys. Providers publish a handful at a
# time; the bound keeps a malformed ``kid`` stream from growing the cache.
_MAX_CACHED_KEYS = 16

# Wall-clock budget for a JWKS fetch. PyJWT's own default is 30 seconds, which
# is far too generous here: a token naming a ``kid`` outside the cached set
# makes the client refetch immediately (bypassing ``lifespan``), and that fetch
# runs in the shared default thread pool -- the same pool bcrypt uses. An
# unauthenticated caller sending random ``kid`` values could therefore park
# workers that logins and signups need. Five seconds mirrors
# ``GUMROAD_TIMEOUT_SECONDS`` and the reasoning behind it: verification sits on
# an interactive path, so a wedged endpoint must fail fast rather than hold a
# request -- and a thread -- open.
JWKS_TIMEOUT_SECONDS: float = 5.0


class OIDCTokenError(Exception):
    """Every ``id_token`` verification failure, collapsed into one type.

    Deliberately undifferentiated: a caller that could tell "expired" from
    "wrong audience" from "unknown signing key" would be tempted to say so on
    the wire, and that difference is an oracle for anyone probing the endpoint.
    """


@dataclass(frozen=True)
class OIDCIdentity:
    """The verified subset of an ``id_token`` the sign-in ladder consumes.

    ``subject`` is the provider's stable, per-application user id and is the
    only field safe to key an account link on — ``email`` can be reassigned by
    the provider and ``name`` is free text. ``email_verified`` is the flag that
    decides whether ``email`` may be trusted to match an existing account at
    all; ``False`` means the address proves nothing.
    """

    subject: str
    email: str | None
    email_verified: bool
    name: str | None


class OIDCSigningKey(Protocol):
    """What a JWKS client hands back for a token's ``kid``: a key carrier."""

    @property
    def key(self) -> AllowedPublicKeys | PyJWK | str | bytes:
        """The material the signature is verified against."""


class OIDCKeyProvider(Protocol):
    """The one capability this module needs from a JWKS client.

    Narrowed to a protocol rather than typed as ``PyJWKClient`` so tests can
    substitute an offline stand-in without a network fetch, and so an adapter
    is free to bring a differently-sourced key set.
    """

    def get_signing_key_from_jwt(self, token: str) -> OIDCSigningKey:
        """Resolve the signing key named by ``token``'s ``kid`` header."""


def build_bounded_jwk_client(jwks_url: str) -> PyJWKClient:
    """Construct a JWKS client for ``jwks_url`` with every cache and timeout bounded.

    Shared by every provider adapter so the bounds are derived once rather than
    re-typed (and eventually mistyped) per provider. Split out from each
    adapter's cached accessor so the bounds can be asserted without reaching
    through an ``lru_cache`` — and without the network, since constructing a
    client fetches nothing.

    Every argument here is a limit rather than a default. ``timeout`` in
    particular is not optional: PyJWT's 30-second default, combined with the
    forced refetch an unrecognised ``kid`` triggers, is how a stream of junk
    tokens turns into parked threads in the pool bcrypt shares.

    Args:
        jwks_url: The provider's published JWKS endpoint.

    Returns:
        A key-caching client bound to that endpoint.
    """
    return PyJWKClient(
        jwks_url,
        cache_keys=True,
        max_cached_keys=_MAX_CACHED_KEYS,
        lifespan=_JWKS_CACHE_SECONDS,
        timeout=JWKS_TIMEOUT_SECONDS,
    )


def claim_str(claims: dict[str, Any], name: str) -> str | None:
    """Return a non-blank string claim, or ``None`` when absent or malformed.

    Shared by the adapters because "is this claim a usable string?" is a
    question about JSON, not about any one provider — the provider-specific
    judgement is which claims get read and what they mean, and that stays in
    the adapters.
    """
    value = claims.get(name)
    if not isinstance(value, str) or not value.strip():
        return None
    return value


async def _decode_verified_claims(
    token: str,
    key_provider: OIDCKeyProvider,
    audiences: list[str],
    algorithms: Sequence[str],
) -> dict[str, Any]:
    """Resolve the signing key off-loop, then verify ``token`` against it.

    ``PyJWKClient`` is synchronous urllib under the hood, so the lookup runs in
    a worker thread; calling it inline would park the whole event loop behind a
    network fetch on the login path.

    ``from None`` is load-bearing rather than stylistic: it severs
    ``__cause__`` so the raw token embedded in a PyJWT error's context can
    never surface through an exception chain into a log or a 500 body.
    """
    try:
        signing_key = await asyncio.to_thread(key_provider.get_signing_key_from_jwt, token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=list(algorithms),
            audience=audiences,
            options={"require": list(_REQUIRED_CLAIMS)},
        )
    except jwt.PyJWTError:
        raise OIDCTokenError(_INVALID_TOKEN_MESSAGE) from None
    return claims


async def verify_oidc_id_token(
    token: str,
    *,
    key_provider: OIDCKeyProvider,
    issuers: Collection[str],
    audiences: Collection[str],
    algorithms: Sequence[str] = DEFAULT_OIDC_ALGORITHMS,
) -> dict[str, Any]:
    """Verify ``token`` and return its claim set, or raise :class:`OIDCTokenError`.

    The audience check runs before anything else so an unconfigured deployment
    costs no JWKS lookup and, more importantly, cannot accidentally accept a
    token minted for some other application.

    The issuer is checked here as an explicit membership test rather than
    through PyJWT's ``issuer=`` argument, whose single-value semantics vary
    across releases — and Google signs with two interchangeable spellings of
    its own issuer, so both must pass under either release.

    Args:
        token: The compact-serialized ``id_token`` presented by the client.
        key_provider: Resolves the signing key named by the token's ``kid``.
        issuers: Every ``iss`` spelling this provider is allowed to use.
        audiences: Accepted ``aud`` values; empty means "reject everything".
        algorithms: Accepted signature algorithms — never read from the token.

    Returns:
        The verified claim set.

    Raises:
        OIDCTokenError: On any verification failure, with a static message.
    """
    accepted_audiences = list(audiences)
    if not accepted_audiences:
        raise OIDCTokenError(_UNCONFIGURED_AUDIENCE_MESSAGE)
    claims = await _decode_verified_claims(token, key_provider, accepted_audiences, algorithms)
    if claims.get("iss") not in issuers:
        raise OIDCTokenError(_INVALID_TOKEN_MESSAGE)
    return claims
