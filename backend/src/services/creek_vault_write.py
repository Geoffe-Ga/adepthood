"""Creek Vault write path: store a journal entry, then classify it, degrading safely.

This is the thin orchestration layer the journal router calls after an entry is
committed. It sits atop the pure :mod:`domain.creek_vault` seam and the concrete
adapters in :mod:`services.creek_vault_client`, and its whole job is to turn the
seam's fine-grained handshake/ingest/classify surface into one best-effort call
that *never raises a vault error* -- so the user's entry is saved regardless of
whether a vault is present, reachable, or capable.

The governing rule is **graceful degradation**: a missing, unreachable, or
capability-poor vault collapses to a well-defined :class:`VaultWriteStatus`
rather than an exception the router must special-case. A classify failure never
undoes a successful ingest -- classification is optional enrichment layered on
top of durable storage, not a precondition for it.

**Intimate content is deliberately not sent here.** An entry classified
``intimate`` short-circuits to :attr:`VaultWriteStatus.SKIPPED_INTIMATE` before
any vault call -- not even a handshake. This is a considered deferral, not a
permanent prohibition: the Creek Vault contract's intimate transit path
(``docs/creek-vault-mcp-contract.md`` decisions (a) ciphertext-only, client-held
key the operator cannot decrypt, and (b) attestation-gated transit) is not yet
built. Until that path exists, routing intimate bodies through this plaintext
ingest surface would violate the writer's chosen depth, so the safe answer is to
withhold them here and revisit once the encrypted, attested channel lands.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from datetime import datetime

from domain.creek_vault import (
    CreekCapability,
    CreekVaultClient,
    CreekVaultError,
    VaultIngestRequest,
    VaultTierCeiling,
    tier_ceiling_for,
)
from models.journal_entry import JournalClassification
from services.creek_vault_client import build_creek_vault_client


class VaultWriteStatus(enum.StrEnum):
    """The terminal outcome of a :func:`store_and_classify` attempt.

    Exactly one of these is always returned; the router branches on it to decide
    whether to persist a vault ref. ``INGESTED`` is the only status that carries a
    ``vault_ref``; every other status is a no-op for the entry's stored columns.
    """

    INGESTED = "ingested"
    SKIPPED_INTIMATE = "skipped_intimate"
    UNAVAILABLE = "unavailable"
    DEGRADED = "degraded"


@dataclass(frozen=True)
class VaultWriteOutcome:
    """Immutable result of a vault write attempt: a status plus any earned metadata.

    ``vault_ref`` is populated only on :attr:`VaultWriteStatus.INGESTED`; ``tags``
    carries the vault's classification (empty when the vault does not support, or
    fails, classification). Frozen so a recorded outcome cannot mutate between the
    write path and the caller that persists it.
    """

    status: VaultWriteStatus
    vault_ref: str | None
    tags: tuple[str, ...]


# The three non-ingested outcomes are value-identical every time, so they are
# interned as module constants rather than rebuilt on each degrade path.
_SKIPPED_INTIMATE_OUTCOME = VaultWriteOutcome(
    status=VaultWriteStatus.SKIPPED_INTIMATE, vault_ref=None, tags=()
)
_UNAVAILABLE_OUTCOME = VaultWriteOutcome(
    status=VaultWriteStatus.UNAVAILABLE, vault_ref=None, tags=()
)
_DEGRADED_OUTCOME = VaultWriteOutcome(status=VaultWriteStatus.DEGRADED, vault_ref=None, tags=())


def _ingest_ready(client: CreekVaultClient) -> bool:
    """Return whether the last handshake found a vault that can ingest.

    Both conditions must hold: the vault is available at all, and it advertised
    the INGEST capability. Either being false degrades the write to UNAVAILABLE.
    """
    return client.is_available() and client.supports(CreekCapability.INGEST)


async def _try_ingest(client: CreekVaultClient, request: VaultIngestRequest) -> str | None:
    """Attempt an ingest, returning the vault ref on durable storage or ``None``.

    A :class:`CreekVaultError` (the seam's normalized transport failure) and a
    ``stored=False`` result both collapse to ``None`` -- the caller treats either
    as a degraded write rather than propagating the error or fabricating a ref.
    """
    try:
        result = await client.ingest(request)
    except CreekVaultError:
        return None
    return result.vault_ref if result.stored else None


async def _try_classify(
    client: CreekVaultClient, body: str, tier_ceiling: VaultTierCeiling
) -> tuple[str, ...]:
    """Classify ``body`` when supported, swallowing failure to an empty tag tuple.

    Classification is optional enrichment: a vault that does not advertise
    CLASSIFY, or one whose classify call raises, yields no tags rather than
    demoting the already-successful ingest. ``tier_ceiling`` is the resolved
    :class:`~domain.creek_vault.VaultTierCeiling` passed straight through.
    """
    if not client.supports(CreekCapability.CLASSIFY):
        return ()
    try:
        classification = await client.classify(body, tier_ceiling)
    except CreekVaultError:
        return ()
    return classification.tags


async def store_and_classify(
    client: CreekVaultClient,
    *,
    body: str,
    classification: str,
    created_at: datetime,
    aspect_tags: tuple[int, ...] = (),
) -> VaultWriteOutcome:
    """Store ``body`` in the vault and classify it, degrading rather than raising.

    The order of checks is load-bearing:

    1. An ``intimate`` classification short-circuits to
       :attr:`VaultWriteStatus.SKIPPED_INTIMATE` *before touching the client* --
       see the module docstring for why intimate bodies are withheld.
    2. :func:`~domain.creek_vault.tier_ceiling_for` resolves the tier, raising
       ``ValueError`` (fail closed) for an unknown classification -- this error
       propagates, since an unrecognized tier must never widen to OPEN.
    3. A handshake probes the vault; an unavailable or non-ingesting vault
       degrades to :attr:`VaultWriteStatus.UNAVAILABLE`.
    4. Ingest runs; a transport failure or a ``stored=False`` result degrades to
       :attr:`VaultWriteStatus.DEGRADED`.
    5. On a durable ingest, classification runs as optional enrichment and the
       call returns :attr:`VaultWriteStatus.INGESTED` with the ref and any tags.

    Never raises :class:`~domain.creek_vault.CreekVaultError`: the caller can
    persist the entry unconditionally and only records vault metadata on INGESTED.
    """
    if classification == JournalClassification.INTIMATE:
        return _SKIPPED_INTIMATE_OUTCOME
    tier_ceiling = tier_ceiling_for(classification)
    await client.handshake()
    if not _ingest_ready(client):
        return _UNAVAILABLE_OUTCOME
    request = VaultIngestRequest(
        body=body,
        tier_ceiling=tier_ceiling,
        created_at=created_at,
        aspect_tags=aspect_tags,
    )
    vault_ref = await _try_ingest(client, request)
    if vault_ref is None:
        return _DEGRADED_OUTCOME
    tags = await _try_classify(client, body, tier_ceiling)
    return VaultWriteOutcome(status=VaultWriteStatus.INGESTED, vault_ref=vault_ref, tags=tags)


def get_creek_vault_client() -> CreekVaultClient:
    """Return a per-request Creek Vault client for FastAPI dependency injection.

    A thin wrapper over :func:`~services.creek_vault_client.build_creek_vault_client`
    with no module-level cache, so a test can override this provider and a
    reconfigured deployment picks up the change on the next request.
    """
    return build_creek_vault_client()
