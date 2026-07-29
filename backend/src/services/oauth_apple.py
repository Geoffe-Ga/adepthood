"""Apple's adapter over the provider-neutral OIDC verifier.

Everything Apple-specific lives here and nowhere else: the published JWKS
endpoint, the single legitimate issuer, the accepted ``aud`` allowlist, and the
projection of Apple's claim names onto :class:`services.oidc.OIDCIdentity`.
Verification itself — algorithm pinning, required claims, the single collapsed
failure mode — belongs to :mod:`services.oidc` and is shared byte-for-byte with
:mod:`services.oauth_google`.

Four things about Apple are worth stating outright, because each one is a place
a well-meaning special case would open a hole:

**Private-relay addresses are safe to link on.** A Hide My Email address is
minted by Apple per (Apple user, application) and routes only to that Apple
user's real mailbox. It is provider-verified like any other Apple address, it
is unique to this app, and it can never collide with some third party's real
address — so an existing Adepthood account already bearing that address can
only have been created by the same Apple user, coming back. Refusing to link on
it would strand exactly the users who chose the most private option.

**``is_private_email`` is deliberately never read.** It describes the shape of
the address, not whether Apple vouches for it, so branching on it would be
special-casing a class of user for no security gain — precisely the divergence
the shared ladder exists to prevent. Only ``email_verified`` decides trust.

**There is no client-secret round trip.** The app posts the ``id_token`` it
already holds and JWKS verification is the whole proof; no authorization-code
exchange happens, so no client secret is needed. That matters because Apple's
"client secret" is not a static string at all but a short-lived ES256 JWT the
server would have to mint and rotate from a downloaded private key — an entire
key-custody problem this flow simply never acquires.

**The APTITUDE license gate applies unchanged.** Creating an account still
requires a license whose Gumroad purchase email matches the address the token
carries. For a Hide My Email user whose purchase was made under their real
address those two differ, so the create rung refuses — as the generic 409 that
every other refusal also returns, which is the point: the response says nothing
about why. That is a known, accepted consequence of keeping one ladder with no
provider-shaped exceptions in it.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

from jwt import PyJWKClient

from services.oidc import (
    OIDCIdentity,
    build_bounded_jwk_client,
    claim_str,
    verify_oidc_id_token,
)

__all__ = [
    "APPLE_ISSUERS",
    "APPLE_JWKS_URL",
    "APPLE_OAUTH_CLIENT_IDS_ENV_VAR",
    "build_jwk_client",
    "verify_apple_id_token",
]

# Comma-separated Apple client ids accepted as the ``aud`` claim: the iOS
# bundle id the native app signs in with, plus the Services id the web flow
# uses. One variable rather than one per platform because the check is pure
# membership and a single list is what an operator can read back.
APPLE_OAUTH_CLIENT_IDS_ENV_VAR = "APPLE_OAUTH_CLIENT_IDS"
_CLIENT_ID_SEPARATOR = ","

# Apple's published JWKS endpoint. HTTPS on an Apple host is not decoration:
# the keys fetched from here are the entire basis for trusting a token.
APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"

# Apple signs with exactly one issuer spelling — unlike Google, which mints two
# interchangeable ones. Keeping this set at one element means a token claiming
# any other issuer, including a bare-hostname lookalike, fails verification.
APPLE_ISSUERS = frozenset({"https://appleid.apple.com"})

# Apple's claim names, spelled once so a typo cannot silently disable a check.
_SUBJECT_CLAIM = "sub"
_EMAIL_CLAIM = "email"
_EMAIL_VERIFIED_CLAIM = "email_verified"

# The one string Apple may spell a true ``email_verified`` with. Compared
# exactly, never coerced: ``bool("false")`` is ``True``, so a truthy test here
# would read Apple's explicit refusal to vouch for an address as proof of it.
_VERIFIED_TRUE_STRING = "true"


def _apple_client_ids() -> list[str]:
    """Read the accepted ``aud`` allowlist from the environment at call time.

    Read per request rather than at import so rotating or adding a platform's
    client id needs no restart, and tolerant of padding, empty entries, and a
    trailing separator in the deployment config. An unset or blank variable
    yields an empty list, which makes the verifier reject every token — the
    fail-closed direction.
    """
    raw = os.getenv(APPLE_OAUTH_CLIENT_IDS_ENV_VAR, "")
    return [client_id.strip() for client_id in raw.split(_CLIENT_ID_SEPARATOR) if client_id.strip()]


def build_jwk_client() -> PyJWKClient:
    """Construct the Apple JWKS client, timeout and caches explicitly bounded.

    The bounds live in :func:`services.oidc.build_bounded_jwk_client` so Apple
    and Google cannot drift apart on them; all this adapter contributes is the
    endpoint.
    """
    return build_bounded_jwk_client(APPLE_JWKS_URL)


@lru_cache(maxsize=1)
def _get_jwk_client() -> PyJWKClient:
    """Return the process-wide, key-caching JWKS client for Apple.

    Cached because refetching Apple's key set on every sign-in would put a
    network round trip on the login path and hammer an endpoint whose contents
    change on the order of days; the client's ``lifespan`` bounds how stale that
    cache may get so a rotation still lands without a restart.

    This function is also the module's only outbound-network seam, which is why
    :func:`verify_apple_id_token` resolves it per call rather than binding a
    client at import time: tests replace it wholesale to stay offline.
    """
    return build_jwk_client()


def _apple_email_verified(claims: dict[str, Any]) -> bool:
    """Return whether Apple vouches for the token's email address.

    Apple sends ``email_verified`` as the *string* ``"true"`` or ``"false"``
    from some flows and as a real JSON boolean from others, so both spellings of
    true have to be honoured. Everything else — the string ``"false"``, boolean
    ``False``, an absent claim, or anything unrecognised — is not a vouch.

    The exact comparison is the whole point. ``bool("false")`` is ``True``, so a
    truthy coercion would turn Apple's explicit "we have not verified this
    address" into proof of ownership and hand the account it names to whoever
    asked. The rule stays in this adapter rather than in
    :mod:`services.oidc` because applying it to every provider at once is the
    same mistake with a wider blast radius.
    """
    value = claims.get(_EMAIL_VERIFIED_CLAIM)
    return value is True or value == _VERIFIED_TRUE_STRING


def _identity_from_claims(claims: dict[str, Any]) -> OIDCIdentity:
    """Project Apple's verified claim set onto the neutral identity shape.

    ``name`` is always ``None``: Apple never puts the user's name in the token.
    It arrives once, in the sign-in request body, and the router — not this
    adapter — decides what to do with it.

    ``email`` is absent from every sign-in after the first, which is why the
    ladder keys on ``subject``. A token with no usable ``email`` reports
    ``email_verified=False``, because an address that is not there cannot have
    been verified.
    """
    email = claim_str(claims, _EMAIL_CLAIM)
    return OIDCIdentity(
        subject=str(claims[_SUBJECT_CLAIM]),
        email=email,
        email_verified=email is not None and _apple_email_verified(claims),
        name=None,
    )


async def verify_apple_id_token(token: str) -> OIDCIdentity:
    """Verify an Apple-issued ``id_token`` and return the identity it names.

    Args:
        token: The compact-serialized ``id_token`` the client received from
            Sign in with Apple.

    Returns:
        The verified identity — subject, optional email, and whether Apple
        vouches for that email.

    Raises:
        OIDCTokenError: For every verification failure, with a static message
            that never embeds the token.
    """
    claims = await verify_oidc_id_token(
        token,
        key_provider=_get_jwk_client(),
        issuers=APPLE_ISSUERS,
        audiences=_apple_client_ids(),
    )
    return _identity_from_claims(claims)
