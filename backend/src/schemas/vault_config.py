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

from collections.abc import Mapping
from enum import StrEnum
from types import MappingProxyType

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


class VaultClassificationState(StrEnum):
    """How far the account's vault sorting has got, from its latest landed pass (#3577).

    Read from the newest classification row that *wrote labels* -- outcome
    ``completed`` or ``incomplete`` -- so a later pass that failed, came back
    ambiguous, or is still in flight never hides what the writing last had done
    to it.

    ``INCOMPLETE`` covers both of its persisted causes on purpose: a pass that
    skipped fragments, and a managed rules floor that finished its own work
    while the semantic sort is still due. The row does not keep which classifier
    ran, and the person's next step is the same for both: none.
    """

    COMPLETE = "complete"
    INCOMPLETE = "incomplete"
    NOT_RUN = "not_run"


#: What each state tells the person, or ``None`` when the honest answer is
#: silence -- the ``VOICE_READINESS_MESSAGES`` precedent
#: (:mod:`schemas.voice_readiness`): the server knows which way the sort ended,
#: so the client renders this sentence and never writes its own. ``COMPLETE`` is
#: the norm and says nothing, and ``NOT_RUN`` says nothing because there is no
#: rough sort to mistake for a finished one. The ``INCOMPLETE`` sentence names
#: no count, no date and no remedy: background passes run without the writer's
#: key today, so promising when the fuller sort lands would be a guess, and a
#: call to action would be the pressure NORTH-STAR §5 forbids.
VAULT_CLASSIFICATION_MESSAGES: Mapping[VaultClassificationState, str | None] = MappingProxyType(
    {
        VaultClassificationState.COMPLETE: None,
        VaultClassificationState.INCOMPLETE: (
            "Some of your writing has only had a rough sort so far. A fuller sort has not "
            "finished yet. Nothing is waiting on you."
        ),
        VaultClassificationState.NOT_RUN: None,
    }
)


class VaultConnectionResponse(OwnedResourcePublic):
    """What a user may be told about their own vault connection.

    Whether one exists, and where it points. Not the credential -- see the
    module docstring -- and not the surrogate row id either, per the
    no-``user_id`` invariant :class:`OwnedResourcePublic` exists to state.

    ``connected`` is carried explicitly rather than left to be inferred from a
    null URL, so a client renders "you have not connected a vault" from a field
    that says so instead of from an absence it has to interpret.

    ``mcp_address`` is the address a person gives an agent they run elsewhere
    (#3534), and the audience every token for that vault names. A managed
    binding keeps ``vault_url`` private. Its agent address is returned only
    after authenticated per-allocation discovery reports the exact owned
    resource and this deployment's issuer. Legacy, disabled, malformed or
    unreachable discovery returns ``None``; the stored binding stays connected.

    ``classification_key_rejected`` is true when the account's latest settled
    vault classification failed because the writer's own provider key was
    refused by its vendor (Creek contract 0.26, #3595). It is read from the
    account's pipeline rows rather than from the connection row, so it holds
    for the deployment-wide vault's owner too, and it carries no key material
    and no vendor text -- the client owns the sentence it renders.

    ``classification_state`` answers a different question from a different row
    (#3577): has the writing had its full sort yet? It is the outcome of the
    latest classification pass that *landed labels*, so a newer failed pass --
    a refused key included -- leaves it where it was; the two fields can both
    stand at once and do not contradict, because one is about the sort the
    writing has had and the other about why the latest attempt at more stopped.
    ``None`` when the account has no vault the pipeline writes to: neither a
    stored connection nor the deployment-wide vault it owns. That owner reads
    ``connected: false`` and still gets a state, for the reason
    ``classification_key_rejected`` holds for them. ``classification_message``
    is the server's sentence for the state, ``None`` except for ``incomplete``
    (:data:`VAULT_CLASSIFICATION_MESSAGES`). Neither carries a count or any
    content.
    """

    connected: bool
    vault_url: str | None
    mcp_address: str | None
    classification_key_rejected: bool = False
    classification_state: VaultClassificationState | None = None
    classification_message: str | None = None
