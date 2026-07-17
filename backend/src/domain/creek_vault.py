"""Pure domain seam for the Creek Vault MCP client.

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

Cross-references the authoritative contract in
``docs/creek-vault-mcp-contract.md``; ontology and tier naming (notably the
``PUBLIC``/``OPEN`` mismatch) come from there.
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
CONTRACT_VERSION = "0.1.0-draft"

# The identifier adepthood presents to Creek Vault so the vault's router can
# scope capabilities and attestation to this consumer.
CONSUMER_ID = "CREEK_MCP_CONSUMER"


class CreekCapability(enum.StrEnum):
    """The MCP capabilities adepthood may call, keyed by their wire names.

    A vault advertises the subset it supports in its ``creek.handshake``
    response; adepthood must never assume a capability exists without first
    seeing it there. Values are the exact method strings sent over the wire.
    """

    HANDSHAKE = "creek.handshake"
    INGEST = "creek.ingest"
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

    ``tier_ceiling`` is applied by the client before the call so the vault's
    router can enforce it; ``aspect_tags`` carries any Aspect/Frequency tags
    already known locally (empty when none). Frozen so the request cannot mutate
    between building it and sending it.
    """

    body: str
    tier_ceiling: VaultTierCeiling
    created_at: datetime
    aspect_tags: tuple[int, ...] = ()


@dataclass(frozen=True)
class VaultIngestResult:
    """Outcome of an ingest attempt.

    ``stored`` is ``False`` (with ``vault_ref`` ``None``) whenever the content
    was not durably written -- notably on the local-fallback path, where the
    operator's Postgres remains the sole system of record and ingest is a no-op
    rather than an error.
    """

    stored: bool
    vault_ref: str | None


@dataclass(frozen=True)
class VaultClassification:
    """Frequency/Wavelength-phase tags Creek assigns to a piece of content."""

    tags: tuple[str, ...]


@dataclass(frozen=True)
class VaultWheelAspect:
    """One Aspect's fullness at a stage, in a vault-computed wheel read.

    A domain-native mirror of the transport's per-Aspect wheel row so the seam's
    return type stays pure Python; the adapter validates the wire payload against
    the Pydantic schema and then projects it onto this value.
    """

    stage_number: int
    aspect: str
    fullness: float


@dataclass(frozen=True)
class VaultWheelBalance:
    """A vault's Wheel-of-Wholeness read: Aspect fullness in canonical order.

    The domain-layer return type of :meth:`CreekVaultClient.wheel` -- a plain,
    immutable value carrying no FastAPI/DB/schema dependency, exactly as the rest
    of this module. The concrete adapter owns the (schema-backed) parse and hands
    back this value, keeping the domain free of the Pydantic response type.
    """

    aspects: tuple[VaultWheelAspect, ...]


class CreekVaultClient(Protocol):
    """The seam adepthood calls into for all vault interaction.

    Both the MCP-backed adapter and the local-fallback no-op implement this
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

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> str:
        """Produce a Higher Self reflection grounded in the user's own corpus."""

    async def wheel(self) -> VaultWheelBalance:
        """Return a Wheel-of-Wholeness balance read from the vault's corpus.

        Unlike the other capabilities, a wheel payload whose *fields* are
        malformed is not normalized to :class:`CreekVaultUnavailableError`: the
        adapter surfaces a parse error so the read/compute path that consumes the
        wheel owns field-level validation. The wheel is an optional read, never a
        write, so a caller that cannot obtain it falls back to computing the
        balance locally.
        """
