"""Google's adapter over the provider-neutral OIDC verifier.

Everything Google-specific lives here and nowhere else: the published JWKS
endpoint, the two interchangeable spellings of Google's issuer, the accepted
``aud`` allowlist, and the projection of Google's claim names onto
:class:`services.oidc.OIDCIdentity`. The verification itself — algorithm
pinning, required claims, the single collapsed failure mode — belongs to
:mod:`services.oidc`, so :mod:`services.oauth_apple` sits beside this one
without re-deriving (or subtly weakening) any of it.

The client-id allowlist is read from the environment at call time, so rotating
or adding a platform's OAuth client needs no restart. It fails closed: unset or
blank means Google sign-in rejects every token rather than accepting any.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

from jwt import PyJWKClient

from services.oidc import (
    JWKS_TIMEOUT_SECONDS,
    OIDCIdentity,
    build_bounded_jwk_client,
    claim_str,
    verify_oidc_id_token,
)

__all__ = [
    "GOOGLE_ISSUERS",
    "GOOGLE_JWKS_URL",
    "GOOGLE_OAUTH_CLIENT_IDS_ENV_VAR",
    "JWKS_TIMEOUT_SECONDS",
    "build_jwk_client",
    "verify_google_id_token",
]

# Comma-separated OAuth client ids (iOS / Android / web) accepted as the
# ``aud`` claim. One variable rather than one per platform because the check is
# pure membership and a single list is what an operator can read back.
GOOGLE_OAUTH_CLIENT_IDS_ENV_VAR = "GOOGLE_OAUTH_CLIENT_IDS"
_CLIENT_ID_SEPARATOR = ","

# Google's published JWKS endpoint. HTTPS on a Google host is not decoration:
# the keys fetched from here are the entire basis for trusting a token.
GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"

# Google mints ``iss`` as either spelling depending on the client library that
# requested the token, and both are legitimate, so both must verify.
GOOGLE_ISSUERS = frozenset({"https://accounts.google.com", "accounts.google.com"})

# Google's claim names, spelled once so a typo cannot silently disable a check.
_SUBJECT_CLAIM = "sub"
_EMAIL_CLAIM = "email"
_EMAIL_VERIFIED_CLAIM = "email_verified"
_NAME_CLAIM = "name"


def _google_client_ids() -> list[str]:
    """Read the accepted ``aud`` allowlist from the environment at call time.

    Tolerant in exactly the way the Gumroad product allowlists are: padding,
    empty entries, and a trailing separator in the deployment config are all
    harmless. An unset or blank variable yields an empty list, which makes the
    verifier reject every token — the fail-closed direction.
    """
    raw = os.getenv(GOOGLE_OAUTH_CLIENT_IDS_ENV_VAR, "")
    return [client_id.strip() for client_id in raw.split(_CLIENT_ID_SEPARATOR) if client_id.strip()]


def build_jwk_client() -> PyJWKClient:
    """Construct the Google JWKS client, timeout and caches explicitly bounded.

    The bounds themselves live in :func:`services.oidc.build_bounded_jwk_client`
    so Google and Apple cannot drift apart on the one setting -- ``timeout`` --
    whose absence turns junk tokens into parked threads in the pool bcrypt
    shares. All this adapter contributes is the endpoint.
    """
    return build_bounded_jwk_client(GOOGLE_JWKS_URL)


@lru_cache(maxsize=1)
def _get_jwk_client() -> PyJWKClient:
    """Return the process-wide, key-caching JWKS client for Google.

    Cached because refetching Google's key set on every sign-in would put a
    network round trip on the login path and hammer an endpoint whose contents
    change on the order of days; ``lifespan`` bounds how stale that cache may
    get so a rotation still lands without a restart.

    This function is also the module's only outbound-network seam, which is why
    :func:`verify_google_id_token` resolves it per call rather than binding a
    client at import time: tests replace it wholesale to stay offline.
    """
    return build_jwk_client()


def _identity_from_claims(claims: dict[str, Any]) -> OIDCIdentity:
    """Project Google's verified claim set onto the neutral identity shape.

    ``email_verified`` is honoured only for a real JSON ``true``. Google sends
    a boolean; the string ``"true"`` some other providers send is deliberately
    not coerced, and the coercion is not pushed down into the shared core
    either — a truthy-string rule applied everywhere is precisely how an
    unverified address ends up linking to somebody else's account. A token with
    no usable ``email`` reports ``email_verified=False``, because an address
    that is not there cannot have been verified.
    """
    email = claim_str(claims, _EMAIL_CLAIM)
    return OIDCIdentity(
        subject=str(claims[_SUBJECT_CLAIM]),
        email=email,
        email_verified=email is not None and claims.get(_EMAIL_VERIFIED_CLAIM) is True,
        name=claim_str(claims, _NAME_CLAIM),
    )


async def verify_google_id_token(token: str) -> OIDCIdentity:
    """Verify a Google-issued ``id_token`` and return the identity it names.

    Args:
        token: The compact-serialized ``id_token`` the client received from
            Google's sign-in SDK.

    Returns:
        The verified identity — subject, optional email, and whether Google
        vouches for that email.

    Raises:
        OIDCTokenError: For every verification failure, with a static message
            that never embeds the token.
    """
    claims = await verify_oidc_id_token(
        token,
        key_provider=_get_jwk_client(),
        issuers=GOOGLE_ISSUERS,
        audiences=_google_client_ids(),
    )
    return _identity_from_claims(claims)
