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

**A failed replication is dropped, not queued.** There is no retry, no
dead-letter queue, and no backlog today: a write that degrades is logged with a
countable :class:`VaultDegradeReason` and then forgotten, and the entry is never
re-sent unless the user edits it again. That is a deliberate floor, not an
oversight -- the local Postgres row is the system of record, the user's save
already succeeded, and the vault holds a convenience copy. Nothing the user can
see is lost by dropping it, whereas a queue would need durable storage of entry
bodies outside Postgres, which is a privacy decision nobody has made. The logs
exist so an operator can tell *why* replication is failing, and how often,
before that decision is ever needed.

**Intimate content is deliberately not sent here.** An entry classified
``intimate`` short-circuits to :attr:`VaultWriteStatus.SKIPPED_INTIMATE` before
any vault call -- not even a handshake. This is a considered deferral, not a
permanent prohibition: the intimate-transit path recorded in Decision 6 of
``docs/adr/0004-creek-vault-http-application-boundary.md`` -- (a) ciphertext
under a user-held key the operator cannot decrypt, (b) writes only against an
attested enclave -- is entirely unshipped. Until it exists, routing intimate
bodies through this plaintext ingest surface would violate the writer's chosen
depth, so the safe answer is to withhold them here until that channel lands.
"""

from __future__ import annotations

import enum
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime

from domain.creek_vault import (
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultClient,
    CreekVaultContractError,
    CreekVaultError,
    VaultIngestRequest,
    VaultIngestResult,
    tier_ceiling_for,
)
from models.journal_entry import JournalClassification
from services.creek_vault_client import build_creek_vault_client

_LOGGER = logging.getLogger(__name__)


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


class VaultDegradeReason(enum.StrEnum):
    """Why one vault write failed to replicate, in terms an operator can act on.

    The caller sees a single :attr:`VaultWriteStatus.DEGRADED` -- that is the
    point of degrading -- so these reasons exist purely so the failures stay
    countable *apart*, and every one of them has a different remedy: ``CONTRACT``
    is a defect in adepthood's own request, ``AUTH`` is a credential to rotate,
    ``UNAVAILABLE`` is infrastructure, ``UNSUPPORTED_CAPABILITY`` is a vault that
    never offered journal ingest, and ``NOT_STORED`` is a vault that answered
    successfully yet did not durably keep the entry. Values are the wire strings
    telemetry counts by, so they are part of this module's contract and must not
    be reworded casually.
    """

    CONTRACT = "contract"
    AUTH = "auth"
    UNAVAILABLE = "unavailable"
    UNSUPPORTED_CAPABILITY = "unsupported_capability"
    NOT_STORED = "not_stored"


# The two static log events this module emits. Static because a vault error's
# own message can carry the entry body or a string the vault chose: everything
# variable travels in the structured ``extra`` fields instead, each of which is
# either an id, one of our own enum values, or a capability wire name.
_DEGRADED_EVENT = "creek vault write degraded"
_INGESTED_EVENT = "creek vault write ingested"


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


def _degrade_reason_for(error: CreekVaultError) -> VaultDegradeReason:
    """Attribute one vault error to the reason an operator would act on.

    Ordered most-specific first, and ``UNAVAILABLE`` is the catch-all rather
    than a match: a vault error type this module has not heard of is far more
    likely to be an availability fault than a contract one, and guessing
    "contract" would send someone hunting a bug in adepthood that is not there.
    """
    if isinstance(error, CreekVaultContractError):
        return VaultDegradeReason.CONTRACT
    if isinstance(error, CreekVaultAuthError):
        return VaultDegradeReason.AUTH
    if isinstance(error, CreekCapabilityUnsupportedError):
        return VaultDegradeReason.UNSUPPORTED_CAPABILITY
    return VaultDegradeReason.UNAVAILABLE


def _degrade_fields(error: CreekVaultError) -> dict[str, object]:
    """Build the content-free fields describing why a write degraded.

    ``code`` appears only when the error carries one of *our own*
    :class:`~domain.creek_vault.VaultErrorCode` members: the adapter has already
    dropped anything a vault sent that we do not recognize, so this can never
    put a vault-chosen string into a log line.
    """
    fields: dict[str, object] = {"reason": _degrade_reason_for(error).value}
    if isinstance(error, CreekVaultContractError) and error.code is not None:
        fields["code"] = error.code.value
    return fields


def _log_extra(request: VaultIngestRequest, fields: Mapping[str, object]) -> dict[str, object]:
    """Compose the structured payload every vault-write log record carries.

    Deliberately only identifiers and closed vocabularies -- the entry body, the
    API key, and any raw vault-supplied string are absent by construction rather
    than by redaction, so there is nothing here to forget to scrub.
    """
    return {
        "capability": CreekCapability.JOURNAL.value,
        "entry_id": request.entry_id,
        **fields,
    }


def _log_degraded(request: VaultIngestRequest, fields: Mapping[str, object]) -> None:
    """Record a dropped replication at WARNING with a static message.

    The exception is deliberately neither formatted into the message nor passed
    as ``exc_info``: its text may quote the entry body or the vault's own prose,
    and this record is the one place both would otherwise escape. What an
    operator needs -- which entry, which capability, which reason -- is in the
    structured fields.
    """
    _LOGGER.warning(_DEGRADED_EVENT, extra=_log_extra(request, fields))


def _log_ingested(request: VaultIngestRequest, result: VaultIngestResult) -> None:
    """Record a durable write at INFO, carrying which action the vault took.

    INFO rather than WARNING because nothing is wrong; the action is worth
    keeping because it is how an operator sees that a re-sent entry edited its
    existing fragment instead of creating a second one. Transports that do not
    report an action log ``None``, which honestly says "the vault did not say".
    """
    action = result.action.value if result.action is not None else None
    _LOGGER.info(_INGESTED_EVENT, extra=_log_extra(request, {"action": action}))


async def _try_ingest(client: CreekVaultClient, request: VaultIngestRequest) -> str | None:
    """Attempt an ingest, returning the vault ref on durable storage or ``None``.

    A :class:`CreekVaultError` (the seam's normalized transport failure) and a
    ``stored=False`` result both collapse to ``None`` -- the caller treats either
    as a degraded write rather than propagating the error or fabricating a ref.
    Each path logs its own reason on the way out, because this is where the
    replication is dropped and nothing downstream will ever hear of it again.
    """
    try:
        result = await client.ingest(request)
    except CreekVaultError as error:
        _log_degraded(request, _degrade_fields(error))
        return None
    if not result.stored:
        _log_degraded(request, {"reason": VaultDegradeReason.NOT_STORED.value})
        return None
    _log_ingested(request, result)
    return result.vault_ref


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
