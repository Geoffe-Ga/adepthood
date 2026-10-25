r"""The keys vault-agent access tokens are signed with, and the set that verifies them (#3533).

A person's vault verifies every agent token Adepthood issues (Creek-Vault#1963)
without sharing any secret with Adepthood, so the signature is asymmetric:
ES256 over P-256, with the public halves published at the JWKS endpoint.

**Operational shape.** ``OAUTH_SIGNING_KEYS`` is a list of PEM private keys,
newest first -- the same shape ``JOURNAL_ENCRYPTION_KEYS`` gives the journal's
MultiFernet. The first key signs; every key is published. Rotation is therefore
add-new (prepend), redeploy, wait out the longest-lived token signed under the
old key, drop-old. Keys may be separated by commas or newlines, and a platform
that stores one-line values may write the PEM's newlines as ``\n``.

**Key ids.** Each key's ``kid`` is its RFC 7638 JWK thumbprint, derived from the
public key rather than configured beside it, so an id can never name the wrong
key and two deployments holding one key agree on its id.

**Fail closed, say nothing.** In production, and on any hosted platform
(staging included), no key configured is an honest "not configured": nothing is
signed and nothing is published. A configured value that is not a list of
distinct P-256 private keys raises :class:`OAuthSigningKeyError` everywhere,
never falls back, and its message names the variable and never a byte of what
it holds. The parser's own exception is suppressed for the same reason.

**A laptop or a CI job gets an ephemeral key.** Off-platform and outside
production -- the same "outside production" ``OAUTH_ISSUER_URL`` falls back to
the local dev server in -- an unset variable is answered with one P-256 key
generated for this process alone, and a warning says so. Tokens it signs verify
only against this process's key set and die with it, which is exactly right for
``uvicorn --reload`` and the contract fuzz, and is why a hosted environment,
where several workers would each invent a different key, never takes this path.

The keys are read once per process (rotation is a deploy); tests call
:func:`reset_cache`.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import ClassVar, Final

from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from services.journal_encryption import (
    PLATFORM_ENVIRONMENT_NAME_ENV_VARS,
    PLATFORM_MARKER_ENV_VARS,
    production_in_force,
)

#: Named once so the startup log, the 503 and the docs all say the same name.
SIGNING_KEYS_ENV_VAR: Final = "OAUTH_SIGNING_KEYS"

logger = logging.getLogger(__name__)

_EPHEMERAL_KEY_EVENT: Final = "oauth_signing_key_ephemeral"

#: The one signing algorithm: ECDSA over P-256 with SHA-256 (RFC 7518 section 3.4).
SIGNING_ALGORITHM: Final = "ES256"

_KEY_TYPE: Final = "EC"
_CURVE_NAME: Final = "P-256"
_KEY_USE: Final = "sig"
#: A P-256 coordinate is 256 bits; RFC 7518 section 6.2.1.2 pads it to 32 bytes.
_COORDINATE_BYTES: Final = 32

#: One PEM block, whatever its label; the label must close what it opened.
_PEM_BLOCK: Final = re.compile(r"-----BEGIN ([A-Z0-9 ]+)-----.+?-----END \1-----", re.DOTALL)
#: What may sit between blocks: separators and nothing else.
_SEPARATORS: Final = ", \t\r\n"


class OAuthSigningKeyError(RuntimeError):
    """``OAUTH_SIGNING_KEYS`` is configured, but not with keys this server can sign with."""

    #: Content-free reason telemetry reports in place of the message.
    safe_code: ClassVar[str] = "oauth_signing_keys_invalid"


@dataclass(frozen=True)
class SigningKey:
    """One configured key: its id, and the private half that never leaves this process."""

    kid: str
    private_key: ec.EllipticCurvePrivateKey = field(repr=False, compare=False)

    def public_jwk(self) -> dict[str, str]:
        """The RFC 7517 JWK of the public half, naming its algorithm and use."""
        return {
            **_public_members(self.private_key.public_key()),
            "kid": self.kid,
            "alg": SIGNING_ALGORITHM,
            "use": _KEY_USE,
        }


def _b64url(data: bytes) -> str:
    """Unpadded base64url, the encoding every JOSE member uses."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _public_members(public_key: ec.EllipticCurvePublicKey) -> dict[str, str]:
    """The required members of a P-256 public JWK (RFC 7518 section 6.2.1)."""
    numbers = public_key.public_numbers()
    return {
        "kty": _KEY_TYPE,
        "crv": _CURVE_NAME,
        "x": _b64url(numbers.x.to_bytes(_COORDINATE_BYTES, "big")),
        "y": _b64url(numbers.y.to_bytes(_COORDINATE_BYTES, "big")),
    }


def jwk_thumbprint(public_key: ec.EllipticCurvePublicKey) -> str:
    """Return the RFC 7638 SHA-256 thumbprint of ``public_key``: its ``kid``.

    The required members only, lexicographically ordered, no whitespace -- the
    one canonical form, so every implementation computes the same id.
    """
    canonical = json.dumps(_public_members(public_key), separators=(",", ":"), sort_keys=True)
    return _b64url(hashlib.sha256(canonical.encode()).digest())


def _refusal(reason: str) -> OAuthSigningKeyError:
    """A refusal naming the variable and the reason, never the value."""
    return OAuthSigningKeyError(f"{SIGNING_KEYS_ENV_VAR} {reason}")


def _configured_blocks() -> tuple[str, ...]:
    """The PEM blocks the variable holds, in order; anything else between them refuses."""
    raw = os.getenv(SIGNING_KEYS_ENV_VAR, "").replace("\\n", "\n")
    blocks = tuple(match.group(0) for match in _PEM_BLOCK.finditer(raw))
    if _PEM_BLOCK.sub("", raw).strip(_SEPARATORS):
        raise _refusal("holds something that is not a PEM key")
    return blocks


def _load(block: str) -> SigningKey:
    """Read one PEM block as a P-256 private key."""
    try:
        key = serialization.load_pem_private_key(block.encode(), password=None)
    except (ValueError, TypeError, UnsupportedAlgorithm):
        raise _refusal("holds a key that cannot be read as an unencrypted private key") from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise _refusal(f"holds a key that is not P-256; {SIGNING_ALGORITHM} needs P-256")
    return SigningKey(kid=jwk_thumbprint(key.public_key()), private_key=key)


def _configured_keys() -> tuple[SigningKey, ...]:
    """The keys the variable lists, each distinct; ``()`` when it lists none."""
    keys = tuple(_load(block) for block in _configured_blocks())
    if len({key.kid for key in keys}) != len(keys):
        raise _refusal("lists the same key twice")
    return keys


def ephemeral_key_allowed() -> bool:
    """Whether an unset ``OAUTH_SIGNING_KEYS`` may be answered with a process-local key.

    Only off-platform and outside production: a hosted environment runs more
    than one worker, and workers that each invented a key would publish key
    sets that disagree with each other's tokens.
    """
    if production_in_force():
        return False
    platform = (*PLATFORM_ENVIRONMENT_NAME_ENV_VARS, *PLATFORM_MARKER_ENV_VARS)
    return not any(os.getenv(name, "").strip() for name in platform)


def _ephemeral_key() -> SigningKey:
    """A P-256 key for this process alone, announced so nobody mistakes it for configuration."""
    key = ec.generate_private_key(ec.SECP256R1())
    logger.warning(_EPHEMERAL_KEY_EVENT, extra={"env_var": SIGNING_KEYS_ENV_VAR})
    return SigningKey(kid=jwk_thumbprint(key.public_key()), private_key=key)


@lru_cache(maxsize=1)
def signing_keys() -> tuple[SigningKey, ...]:
    """Every configured key, newest first.

    ``()`` when none is configured where a key is required; one ephemeral key
    when none is configured on a laptop or in CI (:func:`ephemeral_key_allowed`).

    Raises:
        OAuthSigningKeyError: a value is configured but is not a list of
            distinct P-256 private keys.
    """
    keys = _configured_keys()
    if not keys and ephemeral_key_allowed():
        return (_ephemeral_key(),)
    return keys


def current_signing_key() -> SigningKey | None:
    """The key new tokens are signed with -- the first configured -- or ``None``."""
    keys = signing_keys()
    return keys[0] if keys else None


def published_key_set() -> dict[str, list[dict[str, str]]]:
    """The RFC 7517 JWK Set of every configured key's public half, newest first."""
    return {"keys": [key.public_jwk() for key in signing_keys()]}


def reset_cache() -> None:
    """Forget the keys read so far (tests, or a rotation inside one process)."""
    signing_keys.cache_clear()
