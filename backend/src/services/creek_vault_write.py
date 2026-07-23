"""Creek Vault write path: store a journal entry durably, degrading safely.

This is the thin orchestration layer the journal router calls after an entry is
committed. It sits atop the pure :mod:`domain.creek_vault` seam and the concrete
adapters in :mod:`services.creek_vault_client`, and its whole job is to turn the
seam's fine-grained handshake/ingest surface into one best-effort call that
*never raises a vault error* -- so the user's entry is saved regardless of
whether a vault is present, reachable, or capable.

The governing rule is **graceful degradation**: a missing, unreachable, or
capability-poor vault collapses to a well-defined :class:`VaultWriteStatus`
rather than an exception the router must special-case. Per-entry vault
classification is deferred: the write path never calls a classify capability,
so a successful write always carries an empty tag tuple.

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
    is always empty for now, since per-entry vault classification is deferred.
    Frozen so a recorded outcome cannot mutate between the write path and the
    caller that persists it.
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
    the JOURNAL capability. Either being false degrades the write to UNAVAILABLE.
    """
    return client.is_available() and client.supports(CreekCapability.JOURNAL)


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


async def store_and_classify(
    client: CreekVaultClient,
    *,
    entry_id: int,
    body: str,
    classification: str,
    created_at: datetime,
) -> VaultWriteOutcome:
    """Store ``body`` in the vault, degrading rather than raising.

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
    5. On a durable ingest the call returns :attr:`VaultWriteStatus.INGESTED`
       with the ref and an empty tag tuple -- per-entry vault classification is
       deferred, so no classify capability is ever called here.

    The entry's own tier and the write ceiling are both set to the resolved
    tier, so the vault stores at exactly the tier the writer chose. Never
    raises :class:`~domain.creek_vault.CreekVaultError`: the caller can persist
    the entry unconditionally and only records vault metadata on INGESTED.
    """
    if classification == JournalClassification.INTIMATE:
        return _SKIPPED_INTIMATE_OUTCOME
    tier_ceiling = tier_ceiling_for(classification)
    await client.handshake()
    if not _ingest_ready(client):
        return _UNAVAILABLE_OUTCOME
    request = VaultIngestRequest(
        entry_id=entry_id,
        body=body,
        tier=tier_ceiling,
        tier_ceiling=tier_ceiling,
        created_at=created_at,
    )
    vault_ref = await _try_ingest(client, request)
    if vault_ref is None:
        return _DEGRADED_OUTCOME
    return VaultWriteOutcome(status=VaultWriteStatus.INGESTED, vault_ref=vault_ref, tags=())


def get_creek_vault_client() -> CreekVaultClient:
    """Return a per-request Creek Vault client for FastAPI dependency injection.

    A thin wrapper over :func:`~services.creek_vault_client.build_creek_vault_client`
    with no module-level cache, so a test can override this provider and a
    reconfigured deployment picks up the change on the next request.
    """
    return build_creek_vault_client()
