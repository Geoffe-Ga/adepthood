"""Request and response shapes for connecting one user's own Creek Vault.

The asymmetry between the two is the whole security design of this endpoint and
is deliberate rather than an oversight: the request carries a credential, and
the response has nowhere to put one. There is no field named ``api_key`` on any
response schema in this module, so "never return the key" is a property of the
type rather than of every handler remembering.

Both of the request's fields are refused rather than repaired when they are
wrong, with one narrow exception. A URL is judged by
:func:`~services.creek_vault_url.classify_vault_url` in the router, which is the
same judgement the deployment-wide path already runs, so a value cannot be
accepted here and then degraded at request time -- and it is never normalized,
because a vault replicating to an endpoint subtly different from the one
somebody typed is worse than one replicating nowhere and saying so. A credential
is refused unless it could survive an ``Authorization`` header; the exception is
whitespace *around* it, which is trimmed, because that is what a terminal copy
adds and it could not have been part of the secret in the first place.

*Where* the credential is refused is a security decision rather than a layering
one, and it moved. A validator raising here produces a ``RequestValidationError``,
whose entries carry an ``input`` key holding the offending value -- so a schema
that refused an unusable key described it by quoting it, and the one field on
this request that is a secret went back out in the 422. The rule now lives in
the router as :func:`credential_is_usable` plus an explicit refusal code, so what
a client is told is a name this endpoint owns. The trimming validator stays: it
repairs and never raises, so it is not an echo path.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from models.user_vault_config import VAULT_URL_MAX_LENGTH
from schemas._base import OwnedResourcePublic

# Ceiling on the credential a user may store. Generous next to anything a
# bearer scheme actually issues -- a long JWT is a few hundred characters -- and
# present because this value is untrusted input written to a column and carried
# into a request header.
VAULT_API_KEY_MAX_LENGTH = 4096

# The characters an ``Authorization`` header value may carry, as visible ASCII
# (RFC 9110 field values are VCHAR plus optional interior whitespace, and a
# bearer credential never contains the interior kind). Enforced here rather than
# left to the transport because httpx refuses to build a request from a header
# value holding a control character, and that refusal is in no degrade set: a
# credential with a stray newline in it would turn every one of that user's
# journal saves into a 500 instead of quietly skipping an optional capability.
_HEADER_SAFE_FIRST = 0x21
_HEADER_SAFE_LAST = 0x7E


def _is_header_safe(value: str) -> bool:
    """Whether every character of ``value`` may appear in a header field value."""
    return all(_HEADER_SAFE_FIRST <= ord(character) <= _HEADER_SAFE_LAST for character in value)


def credential_is_usable(value: str) -> bool:
    """Whether ``value`` is a credential an ``Authorization`` header could carry.

    One rule rather than a length bound plus a character class, because they are
    one question: can this string be sent? An empty value cannot -- there is no
    credential -- and neither can one holding a control character, a space, or a
    non-ASCII letter.

    A predicate rather than a validator, so the caller chooses what to say about
    a failure. The router answers with a refusal code it owns; a validator could
    only answer with a ``RequestValidationError``, which carries the offending
    value back to the client in its ``input`` key. That is the wrong shape for
    the one field on this request that is a secret.
    """
    return bool(value) and _is_header_safe(value)


class VaultConnectionRequest(BaseModel):
    """Where a user's own vault lives and the credential that opens it.

    ``api_key`` is write-only by construction: it exists on this request and on
    no response, so there is no code path that could return it and no reviewer
    who has to check that none does.
    """

    vault_url: str = Field(max_length=VAULT_URL_MAX_LENGTH)
    api_key: str = Field(max_length=VAULT_API_KEY_MAX_LENGTH)

    @field_validator("api_key")
    @classmethod
    def _trim_pasted_whitespace(cls, value: str) -> str:
        """Drop whitespace around a pasted credential, keeping the secret itself intact.

        A trailing newline is what a terminal copy hands over and it can never
        have been part of a credential a header could carry, so trimming it
        changes nothing about which secret was meant. Whitespace *inside* the
        value is a different matter and is refused below.
        """
        return value.strip()


class VaultConnectionResponse(OwnedResourcePublic):
    """What a user may be told about their own vault connection.

    Whether one exists, and where it points. Not the credential -- see the
    module docstring -- and not the surrogate row id either, per the
    no-``user_id`` invariant :class:`OwnedResourcePublic` exists to state.

    ``connected`` is carried explicitly rather than left to be inferred from a
    null URL, so a client renders "you have not connected a vault" from a field
    that says so instead of from an absence it has to interpret.
    """

    connected: bool
    vault_url: str | None
