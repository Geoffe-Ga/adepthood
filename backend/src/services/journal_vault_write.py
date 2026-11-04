"""Hand one saved journal entry to its writer's vault, exactly as a save does.

Moved out of :mod:`routers.journal` so a second caller -- the corpus sort for a
vault-bound writer (:mod:`services.corpus_vault_sort`) -- sends an entry down
the same path a journal save does rather than a copy of it: the same
destination binding (#3095), the same Intimate-fold masking (#3059), the same
ref reconciliation, the same lineage shadow and the same pipeline nudge.

The caller holds the account barrier and the entry's vault-mutation lock, and
relays any provider key; this module takes neither, because both are
per-request facts the router already owns.
"""

from __future__ import annotations

import enum
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import resolved_vault_destination
from domain.creek_vault import CreekVaultClient, VaultTierCeiling, tier_ceiling_for
from models.journal_entry import JournalEntry
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline
from services.creek_vault_withdraw import is_pre_binding_copy
from services.creek_vault_write import VaultWriteOutcome, VaultWriteStatus, store_and_classify
from services.folded_quote_privacy import egress_body
from services.privacy_lineage import LineageOperation, observe_entry_lineage

logger = logging.getLogger(__name__)


def _apply_vault_outcome(entry: JournalEntry, outcome: VaultWriteOutcome) -> bool:
    """Reconcile an entry's ``vault_ref`` / ``vault_tags`` columns to a write outcome.

    Returns whether a column actually changed, so the caller commits only then:

    - ``INGESTED`` writes the new ref + tags (a re-ingest overwrites any prior
      ref; tags are empty while per-entry vault classification is deferred).
    - ``SKIPPED_INTIMATE`` leaves a prior ref untouched. That ref is the durable
      proof that a remote copy still needs withdrawal; only Creek's confirmed,
      content-free destructive inverse may clear it.
    - ``DEGRADED`` / ``UNAVAILABLE`` / ``SUSPENDED`` are transient, so any
      existing ref is kept untouched rather than dropped on a passing network
      blip or an operator's temporary suspension.
    """
    if outcome.status is VaultWriteStatus.INGESTED:
        entry.vault_ref = outcome.vault_ref
        entry.vault_tags = list(outcome.tags)
        return True
    return False


async def record_vault_outcome(
    session: AsyncSession,
    entry: JournalEntry,
    vault_client: CreekVaultClient,
    *,
    drive_pipeline: bool = True,
) -> VaultWriteOutcome | None:
    """Store a committed entry via the Creek Vault, reconciling its ref columns.

    Returns the write's outcome, or ``None`` when nothing was offered (an
    unsaved entry, or one whose earlier copy is owed to another vault). A save
    ignores it; a sort reads it to stop on a vault that cannot take writing.

    ``drive_pipeline=False`` skips the classification nudge after an ingest. A
    background sort (``services.corpus_sort_run``) sends many entries in a row,
    and a nudge per entry spawned classification polling on the same client
    beside the next send -- enough concurrent requests to make a managed vault
    shed (``503 temporarily_unavailable``). The sort nudges once when it is done.

    Best-effort: :func:`store_and_classify` never raises a vault error, so a
    missing, unreachable, or intimate-skipped write leaves the entry saved. An
    entry with no id yet returns immediately -- the vault keys its stored
    fragment off the stable entry id, so an unsaved draft has nothing to
    send. Column reconciliation lives in :func:`_apply_vault_outcome`; only a
    real column change re-commits, so the common no-op paths stay free of a
    redundant write.

    The pipeline call is last and is a non-event for this request: it degrades
    silently on a vault that never advertised the capability, stands down inside
    its own per-stage interval, runs only the two cheap stages from here, bounds
    itself in elapsed time, and never raises. It keeps the connection discipline
    described below rather than undoing it -- it commits before it dials, so no
    pooled connection is held across its network calls either. It is reached
    only on an ``INGESTED`` outcome, because a pass over a corpus that did not
    just gain a fragment has nothing new to classify.

    The commit below the id check is what keeps a pooled connection out of the
    network round trip. Callers reach here having already committed the entry,
    but each then calls ``session.refresh``, which opens a *fresh* transaction
    -- and an open transaction is a checked-out connection. Left in place it
    would be held for the whole vault request, so pool capacity would be
    governed by the vault's latency rather than our own query time: the pool is
    at SQLAlchemy's defaults (five plus ten overflow) and the vault's
    whole-request deadline is thirty seconds, so fifteen concurrent writes
    against a *slow* vault would starve every other database-backed endpoint. A
    vault that is down is already safe; this is about one that answers slowly.
    Ending the transaction here returns the connection immediately, and the
    session transparently checks out a new one for the outcome write below.
    """
    if entry.id is None:
        return None
    binding = await _bind_vault_destination(session, entry, vault_client)
    if binding is _Binding.WITHHOLD:
        return None
    # A passage folded in from a quote of an Intimate source never reaches the
    # vault inside this entry (#3059, owner decision R5-2).
    body = await egress_body(session, entry, entry.message)
    await session.commit()
    outcome = await store_and_classify(
        vault_client,
        entry_id=entry.id,
        body=body,
        classification=entry.classification,
        created_at=entry.timestamp,
    )
    # Bitwise ``|``, not ``or``: both helpers mutate ``entry`` and must both run.
    if _apply_vault_outcome(entry, outcome) | _unbind_if_nothing_sent(entry, binding, outcome):
        session.add(entry)
        await session.commit()
        await session.refresh(entry)
    await _after_vault_write(session, entry, vault_client, outcome, drive_pipeline=drive_pipeline)
    return outcome


async def _after_vault_write(
    session: AsyncSession,
    entry: JournalEntry,
    vault_client: CreekVaultClient,
    outcome: VaultWriteOutcome,
    *,
    drive_pipeline: bool,
) -> None:
    """Shadow-count a write that dialled, then drive the pipeline after one that stored.

    The shadow (#3059) fires whenever the ingest was dialled: a DEGRADED write
    -- a lost acknowledgement, or ``stored=False`` -- has still handed the body
    to the vault. ``_NOTHING_SENT`` is the same predicate that decides whether
    the staged destination is kept. It commits straight away so nothing is held
    across what follows; the pipeline runs only on a durable INGESTED write.
    """
    if outcome.status not in _NOTHING_SENT:
        await observe_entry_lineage(session, LineageOperation.VAULT_WRITE, entry)
        await session.commit()
    if drive_pipeline and outcome.status is VaultWriteStatus.INGESTED:
        await drive_vault_pipeline(
            session,
            vault_client,
            user_id=entry.user_id,
            trigger=VaultPipelineTrigger.JOURNAL_WRITE,
        )


class _Binding(enum.Enum):
    """What staging a vault destination decided about one write."""

    WITHHOLD = "withhold"  # an earlier copy is owed to another vault: do not offer
    UNCHANGED = "unchanged"  # proceed; the recorded destination is already right
    BOUND = "bound"  # proceed; this write staged a new destination


#: Write outcomes that provably dialled no ingest: nothing reached any vault. A
#: SUSPENDED write was refused by the operator switch before the wire (#3107);
#: DEGRADED is absent because its ingest was dialled and may have landed.
_NOTHING_SENT = frozenset(
    {
        VaultWriteStatus.SKIPPED_INTIMATE,
        VaultWriteStatus.UNAVAILABLE,
        VaultWriteStatus.SUSPENDED,
    }
)


async def _bind_vault_destination(
    session: AsyncSession, entry: JournalEntry, vault_client: CreekVaultClient
) -> _Binding:
    """Record which vault is about to be offered this entry, or withhold the offer.

    Staged before the ingest dial (and committed with the caller's pre-dial
    commit), so a crash or a lost acknowledgement after Creek stores the entry
    still leaves a durable withdrawal marker bound to that vault. Nothing is
    staged when nothing can be sent: a local fallback dials nothing, and an
    Intimate entry is withheld from the wire before any dial. An entry whose
    earlier copy is owed to a *different* vault keeps that marker and is not
    offered to the new one: a single marker cannot describe two copies, and
    the owed one wins. A pre-binding copy is re-sent but never bound: its
    original may sit in an earlier vault, so adopting the connected one would
    let that vault report it withdrawn (#3095).

    The fingerprint comes from the same config read that built the request's
    client (:func:`resolved_vault_destination`), so a reconnect landing after
    that read cannot bind this write to a vault it does not dial.
    """
    undialled = _binding_without_a_dial(entry, vault_client)
    if undialled is not None:
        return undialled
    destination = await resolved_vault_destination(session, entry.user_id)
    if entry.vault_destination not in {None, destination}:
        logger.warning(
            "journal_vault_write_withheld",
            extra={"entry_id": entry.id, "reason": "destination_changed"},
        )
        return _Binding.WITHHOLD
    if _keeps_its_binding(entry, destination):
        return _Binding.UNCHANGED
    entry.vault_destination = destination
    session.add(entry)
    return _Binding.BOUND


def _keeps_its_binding(entry: JournalEntry, destination: str | None) -> bool:
    """Whether this send leaves ``entry``'s destination as it is.

    It is already bound, there is no vault to bind to, or its copy predates
    binding and so must never adopt the vault connected now (#3095).
    """
    return entry.vault_destination is not None or destination is None or is_pre_binding_copy(entry)


def _binding_without_a_dial(entry: JournalEntry, vault_client: CreekVaultClient) -> _Binding | None:
    """Decide the writes that can send nothing, so they stage nothing; ``None`` otherwise."""
    if type(vault_client) is LocalFallbackCreekVaultClient:
        return _Binding.UNCHANGED if entry.vault_destination is None else _Binding.WITHHOLD
    if tier_ceiling_for(entry.classification) is VaultTierCeiling.INTIMATE:
        return _Binding.UNCHANGED
    return None


def _unbind_if_nothing_sent(
    entry: JournalEntry, binding: _Binding, outcome: VaultWriteOutcome
) -> bool:
    """Drop a destination this write staged when the write provably sent nothing.

    A handshake that turned the write away, an Intimate skip, or an ingest the
    operator's vault-send suspension refused before the wire (#3107) sent no
    body; leaving the marker would make the entry owe a withdrawal for a copy
    that does not exist. A degraded ingest *was* dialled and keeps it.
    """
    if binding is not _Binding.BOUND or outcome.status not in _NOTHING_SENT:
        return False
    entry.vault_destination = None
    return True
