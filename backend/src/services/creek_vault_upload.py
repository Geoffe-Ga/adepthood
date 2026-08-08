"""Creek Vault upload path: hand one user document to the vault, degrading safely.

The document sibling of :mod:`services.creek_vault_write`. Where that module
replicates writing adepthood already holds in Postgres, this one forwards a file
the user chose -- a PDF, a spreadsheet, an export, a photographed page -- so the
Higher Self corpus can be grounded in more of their life than the in-app journal
alone. Adepthood carries the bytes and the filename and nothing else: the vault's
own ingestor registry reads the extension and decides how to parse it, so no
document parsing, format sniffing, or source-type guessing happens here.

Like the write path, every function takes the client as a parameter and
constructs none, which keeps this module out of the tenancy decision entirely --
that belongs to :func:`dependencies.creek_vault.get_creek_vault_client`.

The governing rule is again **graceful degradation**, with one difference that
matters to the caller. A journal entry is already saved in Postgres before
replication is attempted, so its degrade is invisible. An upload has no local
system of record: if the vault will not take the document, there is nowhere else
it goes. So the outcomes here are deliberately finer-grained than
:class:`~services.creek_vault_write.VaultWriteStatus` -- an unreachable vault, a
vault that cannot accept files, and a call that failed mid-flight are three
different things to tell a user, and flattening them would leave them with
"something went wrong" and no next step.

**An upload is never queued or retried.** There is no spool of pending
documents, for the same reason the write path keeps no backlog: durably storing
user document bytes outside the vault is a privacy decision nobody has made. A
failed upload is reported honestly to the person who made it, and they can try
again.

**Intimate documents are forwarded to the vault, and to nothing else.** A
document classified ``intimate`` is uploaded at the ``INTIMATE`` tier ceiling
like any other, because the vault is the user's *own* private corpus rather than
a third-party service: the deployment points at one operator-held
``CREEK_VAULT_URL``, and reaching it is not the cloud disclosure the privacy
floor exists to prevent. What the floor still forbids -- an intimate document
reaching a cloud LLM -- this path never does, since it calls no LLM at all.

This was ratified as an amendment to Decision 6 of
``docs/adr/0004-creek-vault-http-application-boundary.md``; read that decision
for the transit topology, and the amendment for why the upload surface is
treated as vault-only rather than skip-only. Note the asymmetry it leaves
behind: :mod:`services.creek_vault_write` still withholds intimate *journal
entries*, which is deliberately untouched here and tracked for reconciliation
in issue #2152 -- widening a shipped write path is not something to do as a side
effect of adding a new one.

The vault's own router still enforces the ceiling it is handed, so a vault that
declines to store at ``INTIMATE`` refuses the write and this path degrades
honestly rather than silently downgrading the tier to make the call succeed.
"""

from __future__ import annotations

import enum
import hashlib
import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime

from domain.creek_vault import (
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultClient,
    CreekVaultContractError,
    CreekVaultError,
    VaultUploadRequest,
    VaultUploadResult,
    VaultUploadStatus,
    tier_ceiling_for,
)

_LOGGER = logging.getLogger(__name__)

# Prefix on every generated external id, so a fragment adepthood uploaded is
# recognizable as one in a vault that also holds journal entries.
_EXTERNAL_ID_PREFIX = "adepthood-upload-"

# How much of the identity digest the external id carries. 32 hex characters is
# 128 bits: far beyond any collision an installation's document count could
# reach, while keeping the id short enough to read in a log or a URL.
_EXTERNAL_ID_DIGEST_CHARS = 32

# Separator between the two identity components inside the pre-image. A NUL can
# appear in neither an integer nor a filename, so no pair of distinct
# (owner, filename) inputs can collide by rearrangement across the boundary.
_IDENTITY_SEPARATOR = "\x00"


class UploadDegradeReason(enum.StrEnum):
    """Why one upload failed mid-flight, in terms an operator can act on.

    The user sees a single :attr:`VaultUploadStatus.DEGRADED` -- that is the
    point of degrading -- so these exist purely so the failures stay countable
    apart, each with its own remedy: ``CONTRACT`` is a defect in adepthood's own
    request, ``AUTH`` is a credential to rotate, ``UNAVAILABLE`` is
    infrastructure, ``UNSUPPORTED_CAPABILITY`` is a vault that withdrew the
    capability between the handshake and the call, and ``NOT_STORED`` is a vault
    that answered successfully yet did not durably keep the document.
    """

    CONTRACT = "contract"
    AUTH = "auth"
    UNAVAILABLE = "unavailable"
    UNSUPPORTED_CAPABILITY = "unsupported_capability"
    NOT_STORED = "not_stored"


# The two static log events this module emits. Static because a vault error's
# own message can quote the document or a string the vault chose: everything
# variable travels in the structured ``extra`` fields, each of which is either
# a generated id or one of our own enum values. The filename is absent from both
# -- a user names their files after their life, and "divorce-settlement.pdf" is
# content, not metadata.
_DEGRADED_EVENT = "creek vault upload degraded"
_UPLOADED_EVENT = "creek vault upload stored"


@dataclass(frozen=True)
class UploadedDocument:
    """One document as the caller received it, before any vault vocabulary applies.

    The router's own DTO stops at the router: this is the same document expressed
    in terms this layer owns, so :func:`store_upload` depends on the schema
    package no more than the write path does. Bundling the five facts also keeps
    the call site readable -- five loose keyword arguments in a row is where a
    filename and a classification get transposed silently.

    ``content_base64`` is excluded from ``repr()`` for the same reason it is on
    :class:`~domain.creek_vault.VaultUploadRequest`: this object is the document,
    and a generated ``repr`` is what a traceback would otherwise render in full.
    """

    owner_user_id: int
    filename: str
    content_base64: str = field(repr=False)
    classification: str
    created_at: datetime


@dataclass(frozen=True)
class VaultUploadOutcome:
    """Immutable result of an upload attempt: a status plus any earned metadata.

    ``vault_ref`` is populated only on :attr:`VaultUploadStatus.ACCEPTED`.
    ``tags`` are whatever the vault's own ingest pipeline classified the
    document as, which is an empty tuple until the vault returns them -- and
    empty is the correct, expected answer rather than a failure. Frozen so a
    recorded outcome cannot mutate between the service and the router.
    """

    status: VaultUploadStatus
    vault_ref: str | None
    tags: tuple[str, ...]


# The three non-accepted outcomes are value-identical every time, so they are
# interned as module constants rather than rebuilt on each path.
_UNAVAILABLE_OUTCOME = VaultUploadOutcome(
    status=VaultUploadStatus.VAULT_UNAVAILABLE, vault_ref=None, tags=()
)
_UNSUPPORTED_OUTCOME = VaultUploadOutcome(
    status=VaultUploadStatus.CAPABILITY_UNSUPPORTED, vault_ref=None, tags=()
)
_DEGRADED_OUTCOME = VaultUploadOutcome(status=VaultUploadStatus.DEGRADED, vault_ref=None, tags=())


def upload_external_id(owner_user_id: int, filename: str) -> str:
    """Derive the stable fragment id one user's document is always addressed by.

    A pure function of the upload's identity -- who uploaded it and what they
    called it -- which is what makes a re-send idempotent: the same document
    sent twice addresses one fragment, so the vault edits it in place instead of
    accumulating a copy per attempt. That is the same guarantee a journal entry
    gets from its entry id, obtained without a local row to hold one, so no
    table and no migration stand between a user and their first upload.

    The filename is *hashed rather than carried*, for two reasons that point the
    same way. It travels in a URL, and a filename is the user's own words about
    their life -- "my-divorce-settlement.pdf" is content, and content does not
    belong in a request line, an access log, or a proxy's history. Hashing also
    makes the id inert by construction: a digest has no separators, no dots, and
    nothing to escape, so it cannot redirect the request that carries a
    document.

    Including the owner is what keeps two users' identically-named files apart;
    without it, everyone's ``notes.pdf`` would be one shared fragment that each
    upload overwrote.
    """
    identity = f"{owner_user_id}{_IDENTITY_SEPARATOR}{filename}".encode()
    digest = hashlib.sha256(identity).hexdigest()[:_EXTERNAL_ID_DIGEST_CHARS]
    return f"{_EXTERNAL_ID_PREFIX}{digest}"


def _degrade_reason_for(error: CreekVaultError) -> UploadDegradeReason:
    """Attribute one vault error to the reason an operator would act on.

    Ordered most-specific first, with ``UNAVAILABLE`` as the catch-all rather
    than a match: an error type this module has not heard of is far more likely
    to be an availability fault than a contract one, and guessing "contract"
    would send someone hunting a bug in adepthood that is not there.
    """
    if isinstance(error, CreekVaultContractError):
        return UploadDegradeReason.CONTRACT
    if isinstance(error, CreekVaultAuthError):
        return UploadDegradeReason.AUTH
    if isinstance(error, CreekCapabilityUnsupportedError):
        return UploadDegradeReason.UNSUPPORTED_CAPABILITY
    return UploadDegradeReason.UNAVAILABLE


def _degrade_fields(error: CreekVaultError) -> dict[str, object]:
    """Build the content-free fields describing why an upload degraded.

    ``code`` appears only when the error carries one of *our own*
    :class:`~domain.creek_vault.VaultErrorCode` members: the adapter has already
    dropped anything a vault sent that we do not recognize, so this can never put
    a vault-chosen string into a log line.
    """
    fields: dict[str, object] = {"reason": _degrade_reason_for(error).value}
    if isinstance(error, CreekVaultContractError) and error.code is not None:
        fields["code"] = error.code.value
    return fields


def _log_extra(request: VaultUploadRequest, fields: Mapping[str, object]) -> dict[str, object]:
    """Compose the structured payload every upload log record carries.

    Deliberately only the generated external id and closed vocabularies. The
    document bytes and the filename are absent by construction rather than by
    redaction, so there is nothing here to forget to scrub -- and the external
    id is still enough to find the fragment the failure was about.
    """
    return {
        "capability": CreekCapability.UPLOAD.value,
        "external_id": request.external_id,
        **fields,
    }


def _log_degraded(request: VaultUploadRequest, fields: Mapping[str, object]) -> None:
    """Record a failed upload at WARNING with a static message.

    The exception is deliberately neither formatted into the message nor passed
    as ``exc_info``: its text may quote the document or the vault's own prose,
    and this record is the one place either would otherwise escape.
    """
    _LOGGER.warning(_DEGRADED_EVENT, extra=_log_extra(request, fields))


def _log_stored(request: VaultUploadRequest, result: VaultUploadResult) -> None:
    """Record a durable upload at INFO, carrying which action the vault took.

    INFO rather than WARNING because nothing is wrong. The action is worth
    keeping because it is how an operator sees that a re-uploaded document
    edited its existing fragment instead of creating a second one. A transport
    that does not report an action logs ``None``, which honestly says "the vault
    did not say".
    """
    action = result.action.value if result.action is not None else None
    _LOGGER.info(_UPLOADED_EVENT, extra=_log_extra(request, {"action": action}))


async def _try_upload(
    client: CreekVaultClient, request: VaultUploadRequest
) -> VaultUploadResult | None:
    """Attempt an upload, returning the result on durable storage or ``None``.

    A :class:`CreekVaultError` (the seam's normalized transport failure) and a
    ``stored=False`` result both collapse to ``None`` -- the caller treats either
    as a degraded upload rather than propagating the error or fabricating a ref.
    Each path logs its own reason on the way out, because this is where the
    document is dropped and nothing downstream will hear of it again.
    """
    try:
        result = await client.upload(request)
    except CreekVaultError as error:
        _log_degraded(request, _degrade_fields(error))
        return None
    if not result.stored:
        _log_degraded(request, {"reason": UploadDegradeReason.NOT_STORED.value})
        return None
    _log_stored(request, result)
    return result


async def store_upload(
    client: CreekVaultClient, document: UploadedDocument, /
) -> VaultUploadOutcome:
    """Forward one document to the vault, degrading rather than raising.

    The order of checks is load-bearing:

    1. :func:`~domain.creek_vault.tier_ceiling_for` resolves the tier, raising
       ``ValueError`` (fail closed) for an unknown classification -- this
       propagates, since an unrecognized tier must never widen to OPEN. Every
       tier is forwarded, ``intimate`` included; see the module docstring for
       why the vault is not the disclosure the privacy floor guards against.
    2. A handshake probes the vault. An unreachable one degrades to
       :attr:`VaultUploadStatus.VAULT_UNAVAILABLE`; a reachable one that never
       advertised ``creek.upload`` degrades to
       :attr:`VaultUploadStatus.CAPABILITY_UNSUPPORTED`. The two are separated
       because they are separate problems with separate fixes.
    3. The upload runs; a transport failure or a ``stored=False`` result degrades
       to :attr:`VaultUploadStatus.DEGRADED`.
    4. On a durable upload the call returns :attr:`VaultUploadStatus.ACCEPTED`
       with the fragment ref and whatever tags the vault's own pipeline assigned.

    Both the document's tier and the write ceiling are set to the resolved tier,
    so the vault stores at exactly the depth the uploader chose -- never widened
    so a call can succeed, and never narrowed. Never raises
    :class:`~domain.creek_vault.CreekVaultError`: the router answers the user
    from the status alone.
    """
    tier_ceiling = tier_ceiling_for(document.classification)
    await client.handshake()
    if not client.is_available():
        return _UNAVAILABLE_OUTCOME
    # Gated on UPLOAD specifically, never on JOURNAL: a vault that takes journal
    # text has said nothing about whether it takes files, and treating one as the
    # other would put a user's document on the wire toward a surface that never
    # claimed it. Kept a separate branch from the availability check above because
    # the two are separate problems the user has to be told apart.
    if not client.supports(CreekCapability.UPLOAD):
        return _UNSUPPORTED_OUTCOME
    request = VaultUploadRequest(
        external_id=upload_external_id(document.owner_user_id, document.filename),
        filename=document.filename,
        content_base64=document.content_base64,
        tier=tier_ceiling,
        tier_ceiling=tier_ceiling,
        created_at=document.created_at,
    )
    result = await _try_upload(client, request)
    if result is None:
        return _DEGRADED_OUTCOME
    return VaultUploadOutcome(
        status=VaultUploadStatus.ACCEPTED, vault_ref=result.vault_ref, tags=result.tags
    )
