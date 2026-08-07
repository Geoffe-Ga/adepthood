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

Two invariants are load-bearing and deliberately encoded in the types:

* **Fail closed on tier.** :func:`tier_ceiling_for` raises rather than defaulting
  to :attr:`VaultTierCeiling.OPEN` for an unknown classification. Silently
  widening a tier would let sensitive content leave under a looser ceiling than
  the writer chose -- the opposite of "you choose your depth."
* **Privacy over debuggability.** The error hierarchy exists so the service layer
  can normalize any transport failure to :class:`CreekVaultUnavailableError`
  *without* echoing the entry body or an API key into the message.

Cross-references ``docs/creek-vault-mcp-contract.md`` for adepthood's own tier
and ontology mapping (notably the ``PUBLIC``/``OPEN`` name mismatch); Creek's
published contract, which that document points at, owns the wire shapes.
"""

from __future__ import annotations

import enum
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

# Semantic contract version adepthood presents at handshake and compares against
# what a vault advertises. A major-version mismatch degrades to unavailable
# rather than risking a call under an incompatible surface.
CONTRACT_VERSION = "0.2.0"

# The identifier adepthood presents to Creek Vault so the vault's router can
# scope capabilities and attestation to this consumer.
CONSUMER_ID = "CREEK_MCP_CONSUMER"


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
