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

**Intimate documents do not leave this process.** They are withheld here, before
the vault is contacted at all, and the reason is the wire rather than a policy
this module invented: Creek's published ``UploadRequest.tier`` is typed to the
two ceilings a remote caller may declare, so ``intimate`` has no spelling on
``/v1`` and omission is not defaultable either. Adepthood's
:func:`~domain.creek_vault.wire_ceiling_for` is the single door onto that
vocabulary and refuses rather than narrowing, and this module asks it that
question first -- exactly as :mod:`services.creek_vault_write` withholds an
intimate journal entry before its client is touched.

An earlier amendment to Decision 6 of
``docs/adr/0004-creek-vault-http-application-boundary.md`` reasoned that an
intimate document *could* be forwarded, because the vault is the user's own
corpus behind one operator-held ``CREEK_VAULT_URL`` rather than a third-party
service, and this path calls no LLM at any tier. That reasoning about the
*destination* still stands and is not what changed. What changed is that the
upload became a real HTTP call: while ``upload()`` refused unconditionally,
"intimate is forwarded" was a statement nothing could test, and the first
request built at that tier would have been refused at adepthood's own wire door
regardless. The privacy answer is unchanged -- intimate bytes never egress --
and it is now the answer the code actually gives.

The asymmetry that amendment left behind is therefore closed rather than
tracked: both write paths withhold intimate material, for one reason, at one
door. Nothing here re-derives it.

The vault's own router still enforces the ceiling it is handed, so a vault that
declines to store at the declared ceiling refuses the write and this path
degrades honestly rather than silently downgrading the tier to make the call
succeed.
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
    CreekCeilingUnrepresentableError,
    CreekVaultAuthError,
    CreekVaultClient,
    CreekVaultContractError,
    CreekVaultError,
    VaultErrorCode,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultUploadStatus,
    tier_ceiling_for,
    wire_ceiling_for,
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

    These exist so the failures stay countable apart, each with its own remedy:
    ``CONTRACT`` is a defect in adepthood's own request, ``AUTH`` is a credential
    to rotate, ``UNAVAILABLE`` is infrastructure, ``UNSUPPORTED_CAPABILITY`` is
    an upload refused as unsupported *after* the handshake advertised it,
    ``CEILING_UNREPRESENTABLE`` is a document whose tier Creek's wire cannot
    express, and ``NOT_STORED`` is a vault that answered successfully yet did not
    durably keep the document.

    Three of them reach the user as a single
    :attr:`VaultUploadStatus.DEGRADED` -- that is the point of degrading. The
    other two answer :attr:`VaultUploadStatus.CAPABILITY_UNSUPPORTED`, because
    neither is a fault a retry clears. See :func:`_failed_outcome_for`, and note
    that the two stay separate *here* even though they converge there: an
    operator watching documents pile up needs to know whether the vault is
    refusing them or the tier vocabulary is.
    """

    CONTRACT = "contract"
    AUTH = "auth"
    UNAVAILABLE = "unavailable"
    UNSUPPORTED_CAPABILITY = "unsupported_capability"
    CEILING_UNREPRESENTABLE = "ceiling_unrepresentable"
    NOT_STORED = "not_stored"


# Vault error codes that describe a *negotiation* rather than a mishap: the
# capability is not served to this caller, at this version, and will not be
# however many times they ask. They earn the same answer as an unadvertised
# capability for the same reason -- no retry reaches them -- and are named here
# rather than folded into the generic contract branch because that branch's whole
# meaning is "it broke, try again".
#
# Deliberately not including ``invalid_request`` or ``privacy_refused``: both are
# genuine defects in the request adepthood built or the material it asked for,
# fixable on this side, and neither says the route is closed to this caller.
_UNNEGOTIABLE_CODES: frozenset[VaultErrorCode] = frozenset(
    {VaultErrorCode.UNSUPPORTED_CAPABILITY, VaultErrorCode.INCOMPATIBLE_VERSION}
)


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


def _is_unnegotiable(error: CreekVaultError) -> bool:
    """Return whether ``error`` says the route is closed to this caller.

    Two shapes say it. A :class:`CreekCapabilityUnsupportedError` is the vault
    having withdrawn ``upload`` between the handshake and the call -- a real race
    now that a 0.8 vault advertises it, and one the person holding the document
    cannot influence. A contract error carrying one of :data:`_UNNEGOTIABLE_CODES`
    is the vault refusing at the route itself, which from contract 0.8.0 is a
    routine runtime state rather than a theoretical one: the capability list is
    keyed on the caller's declared minor, so a vault can be reachable, advertise
    honestly to others, and still answer this caller ``incompatible_version``.
    """
    if isinstance(error, CreekCapabilityUnsupportedError):
        return True
    return isinstance(error, CreekVaultContractError) and error.code in _UNNEGOTIABLE_CODES


def _failed_outcome_for(error: CreekVaultError) -> VaultUploadOutcome:
    """Choose the outcome one failed upload call is answered with.

    The split is between failures a retry can clear and failures it cannot, and
    it only became meaningful once the call was genuinely made. While
    ``upload()`` refused unconditionally, every failure a real deployment reached
    here was that refusal, so ``DEGRADED`` -- whose whole meaning is "it broke,
    try again" -- was telling people to retry something no retry could reach.
    That is why the refused-capability branch exists.

    Now that a document actually goes over the wire, the other half of the split
    is live for the first time: a dropped connection, a rejected credential, a
    5xx, a body adepthood could not read are *mishaps* during a working upload,
    and trying again is exactly the right advice. They keep ``DEGRADED``.
    :func:`_is_unnegotiable` names the two shapes that do not: a capability
    withdrawn under us, and a route refused to this caller's version. Both leave
    the person in the same place as an unadvertised capability, so both answer
    the same status the pre-call gate does.
    """
    if _is_unnegotiable(error):
        return _UNSUPPORTED_OUTCOME
    return _DEGRADED_OUTCOME


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
) -> VaultUploadResult | VaultUploadOutcome:
    """Attempt an upload, answering with the result or the outcome the failure earns.

    A :class:`CreekVaultError` (the seam's normalized transport failure) and a
    ``stored=False`` result both end the attempt here, as a finished outcome the
    caller returns rather than a raise or a fabricated ref. The failing outcome
    is returned instead of a bare ``None`` because not every failure means the
    same thing to the user -- see :func:`_failed_outcome_for` -- and only this
    frame still holds the error that decides which.

    Each path logs its own reason on the way out, because this is where the
    document is dropped and nothing downstream will hear of it again.
    """
    try:
        result = await client.upload(request)
    except CreekVaultError as error:
        _log_degraded(request, _degrade_fields(error))
        return _failed_outcome_for(error)
    if not result.stored:
        _log_degraded(request, {"reason": UploadDegradeReason.NOT_STORED.value})
        return _DEGRADED_OUTCOME
    _log_stored(request, result)
    return result


def _upload_request_for(
    document: UploadedDocument, tier_ceiling: VaultTierCeiling
) -> VaultUploadRequest:
    """Build the seam's request for one document at the tier its owner chose.

    Both the document's ``tier`` and the write ``tier_ceiling`` are the resolved
    tier, so the vault stores at exactly the depth the uploader chose -- never
    widened so a call can succeed, and never narrowed.

    Built before the vault is probed, and deliberately: nothing here touches the
    network, and having the request in hand is what lets the withheld path below
    log which upload it withheld.
    """
    return VaultUploadRequest(
        external_id=upload_external_id(document.owner_user_id, document.filename),
        filename=document.filename,
        content_base64=document.content_base64,
        tier=tier_ceiling,
        tier_ceiling=tier_ceiling,
        created_at=document.created_at,
    )


def _expressible_on_the_wire(tier_ceiling: VaultTierCeiling) -> bool:
    """Return whether ``tier_ceiling`` has a spelling Creek's ``/v1`` can carry.

    Asked *through* :func:`~domain.creek_vault.wire_ceiling_for` rather than by a
    membership test of this module's own. That function is the single door
    between adepthood's three tiers and the two Creek publishes, and a second
    reading of the same rule is how two readings of it come to disagree -- which
    on this seam would mean an intimate document filed at a depth its owner never
    chose.
    """
    try:
        wire_ceiling_for(tier_ceiling)
    except CreekCeilingUnrepresentableError:
        return False
    return True


async def _vault_refusal(client: CreekVaultClient) -> VaultUploadOutcome | None:
    """Probe the vault and name what stops the upload, or ``None`` if nothing does.

    An unreachable vault and a vault that cannot take files are separated because
    they are separate problems with separate fixes, and the person holding the
    document needs to be told which one they have.

    Gated on UPLOAD specifically, never on JOURNAL: a vault that takes journal
    text has said nothing about whether it takes files, and treating one as the
    other would put a user's document on the wire toward a surface that never
    claimed it.
    """
    await client.handshake()
    if not client.is_available():
        return _UNAVAILABLE_OUTCOME
    if not client.supports(CreekCapability.UPLOAD):
        return _UNSUPPORTED_OUTCOME
    return None


async def store_upload(
    client: CreekVaultClient, document: UploadedDocument, /
) -> VaultUploadOutcome:
    """Forward one document to the vault, degrading rather than raising.

    The order of checks is load-bearing:

    1. :func:`~domain.creek_vault.tier_ceiling_for` resolves the tier, raising
       ``ValueError`` (fail closed) for an unknown classification -- this
       propagates, since an unrecognized tier must never widen to OPEN.
    2. A tier Creek's wire cannot express stops here, before the vault is
       contacted at all, exactly as the journal write withholds an intimate entry
       before its client is touched. Today that is ``intimate`` and only
       ``intimate``. The status is the one that promises no retry, because none
       is possible: ``UploadRequest.tier`` is typed to the two ceilings a remote
       caller may name, so this is a fact about the contract rather than about
       today's weather.
    3. A handshake probes the vault -- see :func:`_vault_refusal`.
    4. The upload runs. A mishap during it degrades to
       :attr:`VaultUploadStatus.DEGRADED`; a capability withdrawn under us, or a
       route refused to our version, lands on
       :attr:`VaultUploadStatus.CAPABILITY_UNSUPPORTED` alongside step 3. See
       :func:`_failed_outcome_for` for why those two are not the same sentence.
    5. On a durable upload the call returns :attr:`VaultUploadStatus.ACCEPTED`
       with the fragment ref and whatever tags the vault's own pipeline assigned.

    Never raises :class:`~domain.creek_vault.CreekVaultError`: the router answers
    the user from the status alone.
    """
    tier_ceiling = tier_ceiling_for(document.classification)
    request = _upload_request_for(document, tier_ceiling)
    if not _expressible_on_the_wire(tier_ceiling):
        _log_degraded(request, {"reason": UploadDegradeReason.CEILING_UNREPRESENTABLE.value})
        return _UNSUPPORTED_OUTCOME
    refusal = await _vault_refusal(client)
    if refusal is not None:
        return refusal
    attempt = await _try_upload(client, request)
    if isinstance(attempt, VaultUploadOutcome):
        return attempt
    return VaultUploadOutcome(
        status=VaultUploadStatus.ACCEPTED, vault_ref=attempt.vault_ref, tags=attempt.tags
    )
