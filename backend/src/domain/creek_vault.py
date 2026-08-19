"""Pure domain seam for the Creek Vault client.

This module holds the vocabulary and value types adepthood uses to talk to an
optional Creek Vault confidential-compute enclave, and *nothing else*: no
FastAPI, no SQLModel/DB, no ``httpx``. Mirroring :mod:`domain.resonance`, the
transport lives behind an injected :class:`CreekVaultClient` protocol so the
concrete adapter (``services.creek_vault_client``) can be swapped, faked, or
absent entirely without this module ever importing a network or persistence
dependency.

The governing principle is **graceful degradation**: no feature adepthood ships
today depends on a vault being present. Every value type here is designed so a
missing, unreachable, or capability-poor vault collapses to a well-defined
"unavailable" state rather than an error the caller must special-case.

Three invariants are load-bearing and deliberately encoded in the types:

* **Fail closed on tier.** :func:`tier_ceiling_for` raises rather than defaulting
  to :attr:`VaultTierCeiling.OPEN` for an unknown classification. Silently
  widening a tier would let sensitive content leave under a looser ceiling than
  the writer chose -- the opposite of "you choose your depth."
* **Intimate is unspellable on the wire.** :class:`VaultTierCeiling` is
  adepthood's vocabulary and carries ``INTIMATE``; :class:`WireTierCeiling` is
  the narrower one Creek's ``/v1`` publishes and cannot name it at all. Every
  request header is typed on the latter, and :func:`wire_ceiling_for` is the
  only door between them -- so intimate content leaving under a ceiling nobody
  can express is a type error rather than a review someone has to remember.
* **Privacy over debuggability.** The error hierarchy exists so the service layer
  can normalize any transport failure to :class:`CreekVaultUnavailableError`
  *without* echoing the entry body or an API key into the message.

Cross-references ``docs/creek-vault-mcp-contract.md`` for adepthood's own tier
and ontology mapping (notably the ``PUBLIC``/``OPEN`` name mismatch); Creek's
published contract, which that document points at, owns the wire shapes.
"""

from __future__ import annotations

import enum
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

# Semantic contract version adepthood presents at handshake and compares against
# what a vault advertises. A major-version mismatch degrades to unavailable
# rather than risking a call under an incompatible surface.
CONTRACT_VERSION = "0.2.0"


class CreekCapability(enum.StrEnum):
    """The vault capabilities adepthood may call, keyed by their wire names.

    A vault advertises the subset it supports in its capability document;
    adepthood must never assume a capability exists without first seeing it
    there. Values are the ``creek.``-prefixed names the vocabulary was minted
    with, and they stay that way because they are what adepthood's own telemetry
    and error messages are keyed by -- they are this app's name for each
    capability rather than a claim about how it is reached.
    """

    HANDSHAKE = "creek.handshake"
    JOURNAL = "creek.journal"
    UPLOAD = "creek.upload"
    SAVE = "creek.save"
    CLASSIFY = "creek.classify"
    REFLECT = "creek.reflect"
    WHEEL = "creek.wheel"


class VaultTierCeiling(enum.StrEnum):
    """Creek's privacy tier ceiling, applied before every vault call.

    Adepthood owns the mapping from its own ``JournalClassification`` onto this
    enum and labels each call honestly; Creek's router enforces the ceiling at
    the transport boundary. Note the ``OPEN`` name: it is Creek's word for what
    adepthood calls ``PUBLIC`` (see the contract's tier-mapping table).
    """

    OPEN = "open"
    PERSONAL = "personal"
    INTIMATE = "intimate"


class WireTierCeiling(enum.StrEnum):
    """The subset of :class:`VaultTierCeiling` Creek's ``/v1`` wire can express.

    Creek caps every *network* consumer below intimate -- the boundary is the
    network, not the tier -- so the two members here are the only ceilings a
    remote caller may declare, and its own wire enum has exactly these two. A
    separate type rather than a comment saying so: adepthood's
    :class:`VaultTierCeiling` carries an ``INTIMATE`` member that has no wire
    spelling at all, and a type with no way to name it is the only guard that
    cannot be forgotten. Everything that builds a request header is typed on
    *this* enum, so putting an intimate ceiling on the wire is a type error
    rather than a mistake caught at runtime -- and :func:`wire_ceiling_for` is
    the one door between the two vocabularies.

    Values are the wire strings Creek reads out of ``X-Creek-Tier-Ceiling``, so
    they are contract and must not be reworded.
    """

    OPEN = "open"
    PERSONAL = "personal"


# Maps a journal classification *string* onto its tier ceiling. Keyed by the raw
# ``JournalClassification`` values (not the enum) so this domain module stays
# free of DB/model imports, exactly as :mod:`domain.resonance` keeps ``VALID_KINDS``
# as literals. A drift-guard test imports ``JournalClassification`` and asserts
# this key set matches, so the two can never silently diverge.
TIER_CEILING_BY_CLASSIFICATION: Mapping[str, VaultTierCeiling] = {
    "public": VaultTierCeiling.OPEN,
    "personal": VaultTierCeiling.PERSONAL,
    "intimate": VaultTierCeiling.INTIMATE,
}


def tier_ceiling_for(classification: str) -> VaultTierCeiling:
    """Resolve a journal classification to its Creek tier ceiling, failing closed.

    Raises :class:`ValueError` for any unknown or empty classification rather
    than defaulting to :attr:`VaultTierCeiling.OPEN`. Defaulting to the loosest
    ceiling on unrecognized input would let content leave the app under a looser
    privacy tier than the writer chose -- so the safe answer to "I don't know
    this tier" is to refuse the call, not to widen it.
    """
    try:
        return TIER_CEILING_BY_CLASSIFICATION[classification]
    except KeyError:
        raise ValueError(f"unknown journal classification: {classification!r}") from None


# The smallest value that can name a person. User ids are assigned from a
# positive sequence, so anything at or below this floor names nobody -- which is
# what lets :func:`resolve_vault_owner` refuse ``0`` without special-casing it.
_LOWEST_USER_ID = 1

# The only spelling of a user id this binding accepts: ASCII digits, nothing
# else. ``int`` is considerably more generous -- it reads ``1_0`` as ten, ``+7``
# as seven, and every Unicode decimal digit as its numeric value, so an
# ARABIC-INDIC or FULLWIDTH seven is just as much a seven to it. None of that is
# wrong arithmetic; it is the wrong *contract* for a value an operator reads back
# to confirm. A binding whose rendered text and parsed meaning can disagree is
# one nobody can audit by looking at it, and this is the setting that decides
# whose journal a shared corpus accumulates. Narrowing here only ever rejects
# spellings no operator meant to type. (The confusables themselves are named
# rather than shown: the lint that forbids them in source is the same instinct
# this pattern encodes.)
_ASCII_USER_ID = re.compile(r"\A[0-9]+\Z")


def resolve_vault_owner(raw: str | None) -> int | None:
    """Read the single adepthood user a configured vault belongs to, or nobody.

    Adepthood reaches a vault with one deployment-wide identity, so everything it
    replicates lands in one corpus and every answer the vault grounds is drawn
    from that same corpus. The contract carries no tenant of any kind, so the
    only way that corpus can stay one person's is for the deployment to name the
    person: this parses that binding, and ``None`` means the vault is nobody's
    and therefore no one's to write into or read from.

    It fails closed for the same reason :func:`tier_ceiling_for` does, with a
    higher price for guessing. An unparseable ceiling would widen one entry's
    tier; an unparseable owner would decide *whose* journal a shared corpus
    accumulates, so anything that is not plainly a user id resolves to nobody and
    the whole deployment degrades to its local pipeline.

    ``0`` is refused explicitly rather than by accident. It parses, so a check
    that only rejected unreadable text would admit it -- and ``0`` is the
    commonest way an unset numeric variable is spelled, by a default in a
    template, by an integer cast of an empty string, by an orchestrator filling a
    blank. Ids are assigned from a positive sequence (:data:`_LOWEST_USER_ID`),
    so no user is ever ``0`` and admitting it could only ever bind a vault to a
    person who does not exist -- or, worse, to whoever a future sequence hands
    that id to. Negatives are refused on the same reasoning.

    The digits themselves are matched before they are converted
    (:data:`_ASCII_USER_ID`), rather than left to ``int``, whose generosity is
    the wrong contract here: it would silently read ``1_0`` as ten and any
    Unicode decimal digit as its value, so a binding could parse as a user
    nobody would guess from reading it. Surrounding whitespace is still
    forgiven, since it survives a copy-paste and changes nothing about which id
    is named.
    """
    if raw is None:
        return None
    candidate = raw.strip()
    if not _ASCII_USER_ID.match(candidate):
        return None
    owner = int(candidate)
    if owner < _LOWEST_USER_ID:
        return None
    return owner


class VaultErrorCode(enum.StrEnum):
    """The machine-readable failure vocabulary a vault may answer an error with.

    Seven of the nine codes Creek publishes, and deliberately still closed: these
    are the *only* strings the adapter may ever parse out of a vault response.
    Anything else -- a newer code, a typo, or a hostile string smuggling control
    characters toward a log -- is dropped on the floor rather than stored or
    rendered, so a vault can never choose what text appears in adepthood's
    exceptions or telemetry. That drop-unknown-strings property is exactly as it
    was when the vocabulary was smaller; widening the set widens what we can
    classify, never what a vault may put in front of an operator.

    The two published codes deliberately absent are ``unauthenticated`` and
    ``internal_error``. Neither adds anything a member would be read for: a
    refused credential already classifies from its status class alone, and so
    does a server fault, so parsing either code would only give two spellings of
    a decision already made.

    Values are the wire strings, so they are contract and must not be reworded
    casually, and the member order is pinned by a test.
    """

    INVALID_REQUEST = "invalid_request"
    UNSUPPORTED_CAPABILITY = "unsupported_capability"
    INCOMPATIBLE_VERSION = "incompatible_version"
    TEMPORARILY_UNAVAILABLE = "temporarily_unavailable"
    PRIVACY_REFUSED = "privacy_refused"
    NOT_FOUND = "not_found"
    UNAVAILABLE = "unavailable"


class CreekVaultError(RuntimeError):
    """Base type for every Creek Vault failure callers should degrade on.

    Subclasses ``RuntimeError`` so a caller can catch one vault-agnostic type.
    Only genuine vault-seam failures normalize to this hierarchy; an unrelated
    internal bug propagates unchanged so the real defect is not masked.
    """


class CreekVaultUnavailableError(CreekVaultError):
    """A configured vault could not service a call (a transport failure).

    The service layer raises this in place of the underlying transport
    exception. Its message is deliberately static and capability-named -- it
    must never interpolate the entry body or an API key, since exception
    strings surface in logs and tracebacks (privacy invariant).

    ``code`` carries the vault's own reason when it named one we recognize, and
    it lives on *this* type rather than on :class:`CreekVaultContractError`
    because the codes it can hold (``unavailable``, ``temporarily_unavailable``)
    are the vault reporting on **itself** rather than faulting the call we made.
    It defaults to ``None``, which is what every purely transport-level failure
    leaves it as: nothing answered, so nothing named a reason.
    """

    def __init__(self, message: str, *, code: VaultErrorCode | None = None) -> None:
        """Store the static message and, when the vault named one we know, its code."""
        super().__init__(message)
        self.code = code


class CreekVaultContractError(CreekVaultError):
    """The vault answered, and what it refused was *our* end of the contract.

    Raised when a reachable, authenticated vault rejects the call because the
    payload we sent, the contract version we pinned, or the capability we
    claimed is wrong. That makes it a defect on adepthood's side with a concrete
    remedy (fix the request, realign the pins) -- deliberately a different type
    from :class:`CreekVaultUnavailableError`, because "the vault said no" and
    "the vault was not there" call for opposite operator responses and would be
    indistinguishable if they shared a type.

    ``code`` carries the vault's reason only when it is one of our own
    :class:`VaultErrorCode` members; an unrecognized wire string is dropped and
    leaves it ``None``. Like every error in this hierarchy the *message* must
    stay static and content-free -- exception strings reach logs and tracebacks,
    so they may never interpolate the entry body, the API key, or any
    vault-supplied text.
    """

    def __init__(self, message: str, *, code: VaultErrorCode | None = None) -> None:
        """Store the static message and, when the vault named one we know, its code."""
        super().__init__(message)
        self.code = code


class CreekCeilingUnrepresentableError(CreekVaultContractError):
    """A call was about to declare a tier ceiling Creek's wire cannot express.

    Raised by :func:`wire_ceiling_for` **before** anything is sent, so the
    refusal is adepthood's own rather than one the vault has to make for it --
    which is the whole point: the body of an intimate entry may not leave this
    process to be refused elsewhere.

    A :class:`CreekVaultContractError` because that is exactly what an operator
    should read it as: a defect in the request adepthood was building, with a
    remedy on adepthood's side. Its subtype is spelled out so the one refusal
    that means "intimate nearly went on the wire" stays greppable apart from
    every other contract fault. It inherits that type's degrade too, so a caller
    that never expected it drops the replication and keeps the user's own save
    intact rather than crashing their request.
    """


class CreekVaultPayloadError(CreekVaultError):
    """The vault answered, and its answer could not be read as the published shape.

    The third of three sibling stories, and it exists because the other two were
    being made to tell it. :class:`CreekVaultUnavailableError` means the vault
    was not there; :class:`CreekVaultContractError` means a reachable vault
    refused the call we made. This one means a reachable vault accepted the call,
    answered successfully, and sent something adepthood cannot parse as the shape
    Creek publishes -- a body that will not decode, a missing required field, or a
    declared ceiling wider than the one we were willing to accept.

    Keeping it apart is what makes a schema failure *observable* apart from vault
    absence. Folded into unavailability -- as it was -- a vault bug worth
    reporting upstream is indistinguishable from infrastructure worth restoring,
    and only one of those two is anybody's to fix.

    Same privacy discipline as the rest of the hierarchy: the message is static
    and capability-named, and never interpolates the entry body, the credential,
    or any vault-supplied string. The unreadable payload is precisely the input
    least safe to quote.
    """


class CreekVaultAuthError(CreekVaultError):
    """A reachable vault rejected our credential.

    Distinct from :class:`CreekVaultUnavailableError` on purpose: a rejected key
    is a *configuration* problem (unset, stale, or scoped wrong) that a restart
    or a retry will not cure, and reporting it as "no vault present" would hide
    a broken deployment behind the same silence as a deliberately vault-less
    one. Its message is static and capability-named for the same privacy reason
    as the rest of the hierarchy.
    """


class CreekVaultCareEscalationError(Exception):
    """A vault answered a reflection request with its care handoff instead of notes.

    **Deliberately not a** :class:`CreekVaultError`, and that is the whole point
    of the type. :class:`~services.creek_vault_reflect.VaultResonanceLLM` catches
    :class:`CreekVaultError` and answers from the cloud instead; an escalation
    caught there would override the vault's care guard with exactly the model
    prose it refused to produce, for exactly the person it refused it for. Living
    outside that hierarchy makes the escape structural rather than a matter of
    ordering an ``except``.

    **Content-free by construction.** Creek's ``reason``, its ``care_signal``
    message, and its resource list are Creek's own copy, and they are dropped at
    the adapter rather than carried here: adepthood renders only the care surface
    it has reviewed itself, so a vault may never choose the words a distressed
    person reads. Nothing is stored on the instance and nothing is passed to
    ``super().__init__``.

    The name ends in ``Error`` to satisfy the exception-naming rule every other
    type in this module follows, but an escalation is **not a failure**: it is a
    successful, published 200 answer whose content is a routing decision. It is
    raised rather than returned so it cannot be mistaken for a reflection by a
    caller that forgot to check.
    """


class CreekCapabilityUnsupportedError(CreekVaultError):
    """A call was attempted for a capability the current handshake did not advertise.

    Distinct from :class:`CreekVaultUnavailableError`: it does not mean the vault
    is down. Either a reachable vault's handshake did not offer this capability,
    or no vault is configured at all -- the local-fallback client raises it for
    every read/compute capability, since it has no vault to serve them. Either
    way the caller should fall back to its local pipeline for that one feature;
    degradation is per-capability, not all-or-nothing.
    """


# The one translation from adepthood's tier vocabulary into the narrower one
# Creek's wire speaks. Total over the two representable ceilings and *deliberately
# partial* over the third: ``INTIMATE`` is absent rather than folded onto
# ``PERSONAL``, because a mapping that quietly narrows an intimate ceiling would
# make an intimate body sendable under a tier its writer never chose -- which is
# the exact failure the wire vocabulary exists to prevent.
_WIRE_CEILING_BY_TIER: Mapping[VaultTierCeiling, WireTierCeiling] = {
    VaultTierCeiling.OPEN: WireTierCeiling.OPEN,
    VaultTierCeiling.PERSONAL: WireTierCeiling.PERSONAL,
}

# What :func:`wire_ceiling_for` refuses with. Static, like every message in this
# module: the refused ceiling is adepthood's own closed vocabulary rather than
# user text, but there is exactly one value that can reach it, so naming it would
# add nothing an operator does not already learn from the type.
_UNREPRESENTABLE_CEILING_MESSAGE = "creek vault cannot express this tier ceiling on the wire"


def wire_ceiling_for(ceiling: VaultTierCeiling) -> WireTierCeiling:
    """Translate a tier ceiling into the one Creek's wire can carry, or refuse.

    The single door between :class:`VaultTierCeiling` and
    :class:`WireTierCeiling`, and the last of the guards keeping intimate
    content off the network. The write path holds the first two -- it withholds
    an intimate entry by its classification, then again by the tier that
    classification resolves to -- and both run before any client is touched.
    This one is different in kind rather than a third copy: it sits at the
    moment a *request* is built, so it covers every capability, including the
    ones the write path knows nothing about, and it is the only one that would
    still catch a caller reaching the adapter directly.

    Raises :class:`CreekCeilingUnrepresentableError` rather than narrowing to
    :attr:`WireTierCeiling.PERSONAL`, for the reason
    :func:`tier_ceiling_for` fails closed: a translation that widened or
    narrowed on its own would move content across a boundary the writer chose.
    """
    try:
        return _WIRE_CEILING_BY_TIER[ceiling]
    except KeyError:
        raise CreekCeilingUnrepresentableError(_UNREPRESENTABLE_CEILING_MESSAGE) from None


@dataclass(frozen=True)
class HandshakeResult:
    """Immutable outcome of a ``creek.handshake`` negotiation.

    Carries whether the vault is usable at all (:attr:`available`), the
    negotiated ``contract``/``ontology`` versions, the advertised capability set
    (already narrowed to known :class:`CreekCapability` members), and any
    attestation evidence the caller needs to decide whether the enclave is
    trustworthy for the intimate write path. Frozen so a cached handshake cannot
    be mutated out from under later ``is_available``/``supports`` reads.
    """

    available: bool
    contract_version: str | None
    ontology_version: str | None
    capabilities: frozenset[CreekCapability]
    attestation: Mapping[str, object] | None

    @classmethod
    def unavailable(cls) -> HandshakeResult:
        """Return the canonical "no usable vault" result.

        Every degradation path (absent config, transport error, malformed
        payload, version mismatch) collapses to this single value so callers
        have exactly one shape to branch on for "fall back to local."
        """
        return cls(
            available=False,
            contract_version=None,
            ontology_version=None,
            capabilities=frozenset(),
            attestation=None,
        )


@dataclass(frozen=True)
class VaultIngestRequest:
    """A piece of writing plus the metadata Creek needs to store it durably.

    ``entry_id`` is the entry's stable external id: Creek keys the stored
    fragment off it, so re-sending the same id is idempotent and edits the
    fragment in place rather than duplicating it. ``tier`` is
    the entry's own privacy tier and ``tier_ceiling`` is the write ceiling the
    vault's router enforces; for a journal entry both equal the entry's tier,
    so Creek stores at exactly that tier and refuses any widening (it never
    downgrades). Frozen so the request cannot mutate between building it and
    sending it.
    """

    entry_id: int
    body: str
    tier: VaultTierCeiling
    tier_ceiling: VaultTierCeiling
    created_at: datetime


class VaultIngestAction(enum.StrEnum):
    """What the vault actually did with an upserted entry.

    Ingest is keyed off the entry's stable id, so a re-send edits one fragment
    in place instead of creating a second. That makes the outcome three-valued,
    and the distinction is worth carrying rather than flattening into "stored":
    ``UNCHANGED`` says a re-send was a no-op, ``UPDATED`` says the vault's copy
    moved, and only ``CREATED`` is a genuinely new fragment. Values are the wire
    strings the vault answers with.
    """

    CREATED = "created"
    UPDATED = "updated"
    UNCHANGED = "unchanged"


@dataclass(frozen=True)
class VaultIngestResult:
    """Outcome of an ingest attempt.

    ``stored`` is ``False`` (with ``vault_ref`` ``None``) whenever the content
    was not durably written -- notably on the local-fallback path, where the
    operator's Postgres remains the sole system of record and ingest is a no-op
    rather than an error.

    ``action`` is what the vault did with the fragment, when it says so. It
    defaults to ``None`` for the local-fallback path, which has no vault to
    report one, and for every not-stored result, so "the vault did not tell us"
    stays distinguishable from any of the three real outcomes.
    """

    stored: bool
    vault_ref: str | None
    action: VaultIngestAction | None = None


class VaultUploadStatus(enum.StrEnum):
    """The terminal outcome of a :func:`store_upload` attempt.

    Exactly one is always returned, and the three non-accepted values stay apart
    because each sends the user somewhere different: ``VAULT_UNAVAILABLE`` is
    "connect or fix your vault", ``CAPABILITY_UNSUPPORTED`` is "your vault cannot
    take files yet", and ``DEGRADED`` is "it broke, try again". Values are the
    wire strings the API answers with, so they are contract and must not be
    reworded casually.
    """

    ACCEPTED = "accepted"
    VAULT_UNAVAILABLE = "vault_unavailable"
    CAPABILITY_UNSUPPORTED = "capability_unsupported"
    DEGRADED = "degraded"


@dataclass(frozen=True)
class VaultUploadRequest:
    """One user-supplied document handed to the vault for its own ingestors to parse.

    The sibling of :class:`VaultIngestRequest` rather than a widening of it: a
    journal entry is text adepthood already holds, while an upload is a *file*
    -- bytes plus the filename the vault reads an extension off to choose an
    ingestor. Adepthood never parses the document itself and never names a
    source type; guessing one here would override a decision the vault is
    better placed to make.

    ``external_id`` is the stable identity the vault keys the stored fragment
    off, so re-sending the same document edits that fragment in place instead of
    accumulating duplicates -- the same idempotence a journal entry gets from its
    entry id. ``tier`` and ``tier_ceiling`` are both the uploader's own tier, so
    the vault stores at exactly the depth the user chose and refuses any
    widening.

    ``content_base64`` is excluded from ``repr()``: this dataclass is the one
    object carrying a user's document through the seam, and a frozen dataclass's
    generated ``repr`` is exactly what a logging call or a traceback would
    otherwise render in full.
    """

    external_id: str
    filename: str
    content_base64: str = field(repr=False)
    tier: VaultTierCeiling
    tier_ceiling: VaultTierCeiling
    created_at: datetime


@dataclass(frozen=True)
class VaultUploadResult:
    """Outcome of an upload attempt, mirroring :class:`VaultIngestResult`.

    ``stored`` is ``False`` (with ``vault_ref`` ``None``) whenever the document
    was not durably written -- notably on the local-fallback path, where there
    is no vault to hold it and Postgres remains the sole system of record.

    ``tags`` are the per-fragment classification tags the vault assigns *in its
    own ingest pipeline*. Adepthood reads them and never re-derives them: a
    second local classifier would be a second opinion nobody asked for. A vault
    that does not return them yields an empty tuple, which is the expected
    answer today rather than a failure.
    """

    stored: bool
    vault_ref: str | None
    action: VaultIngestAction | None = None
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class VaultClassification:
    """Frequency/Wavelength-phase tags Creek assigns to a piece of content."""

    tags: tuple[str, ...]


class VaultReflectionStatus(enum.StrEnum):
    """The two statuses a successful reflection response may carry.

    Exactly the pair Creek's ``ReflectionResponse`` publishes, spelled Creek's
    way, because these are wire strings a payload is matched against: a member
    adepthood invented would never match anything a vault sent. ``escalate`` is
    deliberately **not** a member -- it arrives as a different published document
    at the same status and leaves this seam as
    :class:`CreekVaultCareEscalationError`, so it can never be read as a
    reflection that merely had nothing to say.
    """

    OK = "ok"
    EMPTY = "empty"


@dataclass(frozen=True)
class VaultReflectionNote:
    """One margin note a vault produced, already in adepthood's own vocabulary.

    ``kind`` is the *projected* marginalia kind, not Creek's: the adapter maps
    Creek's seven note kinds onto adepthood's before building this value, so
    nothing downstream has to know Creek's ontology or risk rendering a note as
    something the user never wrote. ``quote`` is carried verbatim, because the
    resonance pass anchors it character-for-character against the entry body.
    """

    kind: str
    quote: str
    note: str


@dataclass(frozen=True)
class VaultReflection:
    """A vault's whole answer to one reflection request, structured rather than flattened.

    The seam returns this instead of a string so the outcomes stay
    distinguishable: an ``EMPTY`` answer is a vault saying it has nothing to add,
    an ``OK`` answer with zero surviving notes is a vault that answered with
    nothing adepthood can render, and neither is a failure -- while an unreadable
    payload raises and an escalation raises something else again. Collapsing all
    of those onto one blank string is what made a vault bug, a legitimate silence,
    and a care handoff indistinguishable at the call site.

    ``essay`` is free model prose the vault may attach, and ``essay_grounded`` is
    the published claim about it. The essay is **not the user's own words**, so it
    must never be rendered, anchored, logged, or interpolated into an exception --
    it is carried only so the seam is honest about what the vault answered, and
    the consumer is where that restraint is enforced. ``essay_grounded`` is
    required by the published contract and only ``False`` is admissible at
    contract 0.2, so a payload claiming a grounded essay is rejected whole rather
    than read past.

    ``routed_tier`` is the tier the vault says it actually keyed the call with,
    verified against the ceiling the caller was willing to accept before this
    value is ever built.
    """

    status: VaultReflectionStatus
    notes: tuple[VaultReflectionNote, ...]
    essay: str | None
    essay_grounded: bool
    routed_tier: VaultTierCeiling


@dataclass(frozen=True)
class VaultWheelAspect:
    """One Aspect's fullness at a stage, in a vault-computed wheel read.

    A domain-native mirror of the transport's per-Aspect wheel row so the seam's
    return type stays pure Python; the adapter owns the wire shape and projects
    it onto this value.
    """

    stage_number: int
    aspect: str
    fullness: float


@dataclass(frozen=True)
class VaultWheelBalance:
    """A vault's Wheel-of-Wholeness read: Aspect fullness in canonical order.

    The domain-layer return type of :meth:`CreekVaultClient.wheel` -- a plain,
    immutable value carrying no FastAPI/DB/schema dependency, exactly as the rest
    of this module. The concrete adapter owns the parse and hands back this
    value, keeping the domain free of any wire or response type.
    """

    aspects: tuple[VaultWheelAspect, ...]


class CreekVaultClient(Protocol):
    """The seam adepthood calls into for all vault interaction.

    Both the HTTP-backed adapter and the local-fallback no-op implement this
    protocol, so callers depend only on this surface and never on whether a
    vault is actually present. Parameters are positional-only so concrete
    implementations may name (or underscore-ignore) them freely while remaining
    structurally compatible.
    """

    async def handshake(self) -> HandshakeResult:
        """Probe the vault and return the negotiated capability/version result.

        Never raises: an absent, unreachable, or incompatible vault yields
        :meth:`HandshakeResult.unavailable` so callers can branch on the result
        instead of guarding a call in ``try``/``except``.
        """

    def is_available(self) -> bool:
        """Return whether the most recent handshake found a usable vault."""

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether the most recent handshake advertised ``capability``."""

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Hand a piece of writing to the vault for durable storage."""

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Hand one user-supplied document to the vault for its ingestors to parse.

        Separate from :meth:`ingest` because the two carry different things and
        are advertised separately: a vault may accept journal text without
        accepting files, so a caller must gate on
        :attr:`CreekCapability.UPLOAD` rather than assuming journal ingest
        implies it.

        Fails exactly as ingest does -- a refused request as
        :class:`CreekVaultContractError`, a rejected credential as
        :class:`CreekVaultAuthError`, an absent or unreadable vault as
        :class:`CreekVaultUnavailableError`, and a capability the vault never
        advertised as :class:`CreekCapabilityUnsupportedError` raised *before*
        any document bytes reach the wire.
        """

    async def classify(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Request Frequency/Wavelength-phase tags for ``body``."""

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Produce a Higher Self reflection grounded in the user's own corpus.

        Answers with a structured :class:`VaultReflection` so the vault's real
        outcome survives the seam. A vault that had nothing to say answers
        :attr:`VaultReflectionStatus.EMPTY`, and one whose notes did not survive
        projection answers :attr:`VaultReflectionStatus.OK` with an empty note
        tuple: both are the vault answering successfully, and it is the consumer
        that decides such an answer means deferring to the cloud.

        Failures normalize into this module's hierarchy exactly as
        :meth:`wheel`'s do -- an unreadable answer as
        :class:`CreekVaultPayloadError`, a refusal as
        :class:`CreekVaultContractError`, an absent vault as
        :class:`CreekVaultUnavailableError` -- so the three stay countable apart.

        A care escalation is none of those. It raises
        :class:`CreekVaultCareEscalationError`, which is outside that hierarchy
        on purpose so a caller degrading on :class:`CreekVaultError` cannot
        answer a person in acute distress with the cloud prose the vault's care
        guard just refused to produce.
        """

    async def wheel(self) -> VaultWheelBalance:
        """Return a Wheel-of-Wholeness balance read from the vault's corpus.

        Degrades exactly like every other capability: a malformed, refused, or
        otherwise unreadable payload is normalized into this module's error
        hierarchy rather than surfacing a parse error -- an unreadable answer as
        :class:`CreekVaultPayloadError`, a refusal as
        :class:`CreekVaultContractError`, an absent vault as
        :class:`CreekVaultUnavailableError`, so the three stay countable apart.
        Domain-range validation of a well-formed balance belongs to the
        read/compute path that consumes it. The wheel is an optional read, never
        a write, so a caller that cannot obtain it falls back to computing the
        balance locally.
        """
