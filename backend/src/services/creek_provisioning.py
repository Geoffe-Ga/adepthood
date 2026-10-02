"""Durable Adepthood consumer for Creek's asynchronous provisioning API."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final
from uuid import uuid4

from sqlalchemy import and_, delete, or_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from errors import INTERNAL_ERROR
from models.vault_activation import (
    VaultActivation,
    VaultActivationState,
    VaultCustodyMode,
    VaultTeardownReceipt,
)
from services.creek_provisioning_client import (
    FAILURE_MALFORMED_RESPONSE,
    FAILURE_PROVIDER_REJECTED,
    FAILURE_PROVIDER_UNAVAILABLE,
    CreekProvisioningClient,
    CreekProvisioningJob,
    ProvisioningRejectedError,
    ProvisioningUnavailableError,
)

_ACTIVE_STATES: Final[frozenset[str]] = frozenset(
    {
        VaultActivationState.SUBMITTING.value,
        VaultActivationState.PENDING.value,
        VaultActivationState.PROVISIONING.value,
        VaultActivationState.AWAITING_HANDOFF.value,
        VaultActivationState.DELETING.value,
    }
)
_KNOWN_CUSTODY_MODES: Final[frozenset[str]] = frozenset(
    {
        VaultCustodyMode.PROVIDER_MANAGED.value,
        VaultCustodyMode.WRAPPED_ARTIFACT_ONLY.value,
    }
)


@dataclass(frozen=True, slots=True)
class _RecoveryIdentity:
    """Scalar identity retained across commits, rollbacks, and Creek I/O."""

    row_id: int
    user_id: int
    activation_id: str
    creek_job_id: str


async def load_vault_activation(
    session: AsyncSession,
    user_id: int,
) -> VaultActivation | None:
    result = await session.execute(
        select(VaultActivation).where(VaultActivation.user_id == user_id)
    )
    return result.scalars().first()


async def ensure_vault_activation(
    session: AsyncSession,
    user_id: int,
) -> VaultActivation:
    """Create or return one stable activation identity under the DB constraint."""
    existing = await load_vault_activation(session, user_id)
    if existing is not None:
        await session.commit()
        return existing
    activation = VaultActivation(
        user_id=user_id,
        activation_id=f"activation-{uuid4()}",
        consumer_identity=f"adepthood-user-{uuid4()}",
    )
    session.add(activation)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        winner = await load_vault_activation(session, user_id)
        if winner is None:
            raise
        await session.commit()
        return winner
    await session.refresh(activation)
    await session.commit()
    return activation


def _mark_local_failure(
    activation: VaultActivation,
    reason: str,
    *,
    retryable: bool,
) -> None:
    activation.state = VaultActivationState.FAILED.value
    activation.retryable = retryable
    activation.failure_reason = reason
    activation.updated_at = datetime.now(UTC)


def _apply_job(activation: VaultActivation, job: CreekProvisioningJob) -> None:
    """Apply only a response bound to this durable activation."""
    if not _job_matches_activation(activation, job):
        _mark_local_failure(activation, FAILURE_MALFORMED_RESPONSE, retryable=True)
        return
    activation.creek_job_id = job.job_id
    if _job_has_malformed_custody(job):
        _mark_local_failure(activation, FAILURE_MALFORMED_RESPONSE, retryable=True)
        return
    activation.custody_mode = job.custody_mode
    activation.attested_confidential = job.attested_confidential
    if job.state == "awaiting_key_ceremony":
        _reject_legacy_ceremony(activation, job)
        return
    if _job_awaits_handoff(activation, job):
        activation.state = VaultActivationState.AWAITING_HANDOFF.value
        activation.retryable = False
        activation.failure_reason = None
        activation.updated_at = datetime.now(UTC)
        return
    activation.state = job.state
    activation.retryable = job.retryable
    activation.failure_reason = job.failure_reason
    activation.updated_at = datetime.now(UTC)


def _job_matches_activation(
    activation: VaultActivation,
    job: CreekProvisioningJob,
) -> bool:
    """Bind Creek's response to both durable identities before applying it."""
    job_id_matches = activation.creek_job_id is None or job.job_id == activation.creek_job_id
    return job.activation_id == activation.activation_id and job_id_matches


def _job_has_malformed_custody(job: CreekProvisioningJob) -> bool:
    """Reject custody combinations that could overstate managed-vault privacy."""
    return (
        job.custody_mode not in _KNOWN_CUSTODY_MODES | {None}
        or (job.state == VaultActivationState.READY.value and job.custody_mode is None)
        or (job.custody_mode is not None and job.attested_confidential is not False)
    )


def _reject_legacy_ceremony(
    activation: VaultActivation,
    job: CreekProvisioningJob,
) -> None:
    """Terminalize a legacy contract without implying current ceremony support."""
    activation.custody_mode = job.custody_mode or VaultCustodyMode.WRAPPED_ARTIFACT_ONLY.value
    activation.attested_confidential = False
    _mark_local_failure(activation, FAILURE_PROVIDER_REJECTED, retryable=False)


def _job_awaits_handoff(
    activation: VaultActivation,
    job: CreekProvisioningJob,
) -> bool:
    """Keep Creek's ready state inert until its credential callback arrives."""
    return (
        job.state == VaultActivationState.READY.value and activation.credential_received_at is None
    )


async def _store_job(
    session: AsyncSession,
    activation: VaultActivation,
    operation: Callable[[], Awaitable[CreekProvisioningJob]],
) -> VaultActivation:
    """Run one already-transaction-free network operation and persist its result."""
    try:
        job = await operation()
    except ProvisioningUnavailableError:
        _mark_local_failure(activation, FAILURE_PROVIDER_UNAVAILABLE, retryable=True)
    except ProvisioningRejectedError:
        _mark_local_failure(activation, FAILURE_PROVIDER_REJECTED, retryable=False)
    else:
        # Creek completes its authenticated credential handoff before publishing
        # ``ready``.  Reload the row after the network boundary so a concurrent
        # handoff transaction is visible before we decide whether to expose ready.
        await session.refresh(activation)
        _apply_job(activation, job)
    session.add(activation)
    await session.commit()
    await session.refresh(activation)
    return activation


async def submit_vault_activation(
    session: AsyncSession,
    user_id: int,
    client: CreekProvisioningClient,
) -> VaultActivation:
    """Persist identity first, release the transaction, then submit idempotently."""
    activation = await ensure_vault_activation(session, user_id)
    return await _store_job(
        session,
        activation,
        lambda: client.activate(activation.activation_id, activation.consumer_identity),
    )


async def poll_vault_activation(
    session: AsyncSession,
    activation: VaultActivation,
    client: CreekProvisioningClient,
) -> VaultActivation:
    """Refresh a nonterminal job without holding its SELECT transaction."""
    await session.commit()
    if activation.creek_job_id is None:
        return await _store_job(
            session,
            activation,
            lambda: client.activate(activation.activation_id, activation.consumer_identity),
        )
    return await _store_job(
        session,
        activation,
        lambda: client.status(activation.creek_job_id or ""),
    )


async def retry_vault_activation(
    session: AsyncSession,
    activation: VaultActivation,
    client: CreekProvisioningClient,
) -> VaultActivation:
    """Retry the same durable activation or Creek job after releasing the DB."""
    await session.commit()
    if activation.creek_job_id is None:

        async def operation() -> CreekProvisioningJob:
            return await client.activate(
                activation.activation_id,
                activation.consumer_identity,
            )
    else:

        async def operation() -> CreekProvisioningJob:
            return await client.retry(activation.creek_job_id or "")

    return await _store_job(session, activation, operation)


def vault_activation_recovery_is_available(activation: VaultActivation | None) -> bool:
    """Return whether one failed create may enter confirmed teardown recovery."""
    return (
        activation is not None
        and activation.state == VaultActivationState.FAILED.value
        and not activation.retryable
        and activation.failure_reason == FAILURE_PROVIDER_REJECTED
        and activation.creek_job_id is not None
    )


async def recover_vault_activation(
    session: AsyncSession,
    activation: VaultActivation,
    client: CreekProvisioningClient,
) -> VaultActivation | None:
    """Delete one failed allocation before atomically minting a fresh identity."""
    identity = _recovery_identity(activation)
    if identity is None:
        return None
    if not await _persist_recovery_intent(session, identity):
        return await _load_recovery_successor(session, identity)
    receipt = await _request_vault_teardown_for_job(
        session,
        identity.creek_job_id,
        client,
    )
    return await _finish_activation_recovery(session, identity, receipt, client)


async def _finish_activation_recovery(
    session: AsyncSession,
    identity: _RecoveryIdentity,
    receipt: VaultTeardownReceipt,
    client: CreekProvisioningClient,
) -> VaultActivation | None:
    """Project one teardown receipt without retaining a mutable ORM identity."""
    if receipt.confirmed_at is not None:
        return await _continue_confirmed_recovery(session, identity, client)
    if receipt.state == VaultActivationState.FAILED.value and not receipt.retryable:
        return await _fail_activation_recovery(session, identity)
    return await _store_pending_recovery(session, identity, receipt)


def _recovery_identity(activation: VaultActivation) -> _RecoveryIdentity | None:
    """Copy durable identifiers before receipt contention can roll back the ORM."""
    if activation.id is None or activation.creek_job_id is None:
        return None
    return _RecoveryIdentity(
        row_id=activation.id,
        user_id=activation.user_id,
        activation_id=activation.activation_id,
        creek_job_id=activation.creek_job_id,
    )


async def _persist_recovery_intent(
    session: AsyncSession,
    identity: _RecoveryIdentity,
) -> bool:
    """Persist cleanup intent with a CAS that cannot overtake account erasure."""
    now = datetime.now(UTC)
    result = await session.execute(
        update(VaultActivation)
        .where(
            col(VaultActivation.id) == identity.row_id,
            col(VaultActivation.user_id) == identity.user_id,
            col(VaultActivation.activation_id) == identity.activation_id,
            col(VaultActivation.creek_job_id) == identity.creek_job_id,
            or_(
                and_(
                    col(VaultActivation.state) == VaultActivationState.FAILED.value,
                    col(VaultActivation.retryable).is_(False),
                    col(VaultActivation.failure_reason) == FAILURE_PROVIDER_REJECTED,
                ),
                and_(
                    col(VaultActivation.state) == VaultActivationState.DELETING.value,
                    col(VaultActivation.recovery_requested_at).is_not(None),
                ),
            ),
        )
        .values(
            state=VaultActivationState.DELETING.value,
            retryable=False,
            failure_reason=None,
            recovery_requested_at=now,
            updated_at=now,
        )
        .returning(col(VaultActivation.id))
    )
    persisted = result.scalar_one_or_none() is not None
    await session.commit()
    return persisted


async def _store_pending_recovery(
    session: AsyncSession,
    identity: _RecoveryIdentity,
    receipt: VaultTeardownReceipt,
) -> VaultActivation | None:
    """Project an unconfirmed teardown onto the durable activation state."""
    return await _project_recovery_state(
        session,
        identity,
        state=VaultActivationState.DELETING.value,
        retryable=receipt.retryable,
        failure_reason=receipt.failure_reason,
    )


async def _continue_confirmed_recovery(
    session: AsyncSession,
    identity: _RecoveryIdentity,
    client: CreekProvisioningClient,
) -> VaultActivation | None:
    """Replace a deleted generation and idempotently submit its successor."""
    fresh, replacement_authorized = await _replace_deleted_activation(
        session,
        identity=identity,
    )
    if fresh is None:
        return None
    if not replacement_authorized:
        return fresh
    return await _store_job(
        session,
        fresh,
        lambda: client.activate(fresh.activation_id, fresh.consumer_identity),
    )


async def _fail_activation_recovery(
    session: AsyncSession,
    identity: _RecoveryIdentity,
) -> VaultActivation | None:
    """Close a teardown that cannot safely authorize a replacement identity."""
    return await _project_recovery_state(
        session,
        identity,
        state=VaultActivationState.FAILED.value,
        retryable=False,
        failure_reason=INTERNAL_ERROR,
    )


async def _project_recovery_state(
    session: AsyncSession,
    identity: _RecoveryIdentity,
    *,
    state: str,
    retryable: bool,
    failure_reason: str | None,
) -> VaultActivation | None:
    """CAS one recovery projection, or return the generation that superseded it."""
    values: dict[str, object] = {
        "state": state,
        "retryable": retryable,
        "failure_reason": failure_reason,
        "updated_at": datetime.now(UTC),
    }
    if state == VaultActivationState.FAILED.value and not retryable:
        values["recovery_requested_at"] = None
    result = await session.execute(
        update(VaultActivation)
        .where(
            col(VaultActivation.id) == identity.row_id,
            col(VaultActivation.user_id) == identity.user_id,
            col(VaultActivation.activation_id) == identity.activation_id,
            col(VaultActivation.creek_job_id) == identity.creek_job_id,
            col(VaultActivation.state) == VaultActivationState.DELETING.value,
            col(VaultActivation.recovery_requested_at).is_not(None),
        )
        .values(**values)
        .returning(col(VaultActivation.id))
    )
    projected = result.scalar_one_or_none() is not None
    await session.commit()
    if not projected:
        return await _load_recovery_successor(session, identity)
    current = await _load_current_activation(session, identity.user_id)
    await session.commit()
    return current


async def _load_recovery_successor(
    session: AsyncSession,
    identity: _RecoveryIdentity,
) -> VaultActivation | None:
    """Return only a newer generation; the erased generation is not recoverable."""
    winner = await _load_current_activation(session, identity.user_id)
    await session.commit()
    if winner is None or winner.activation_id == identity.activation_id:
        return None
    return winner


async def _load_current_activation(
    session: AsyncSession,
    user_id: int,
) -> VaultActivation | None:
    """Refresh identity-map state after a competing writer may replace one row."""
    result = await session.execute(
        select(VaultActivation)
        .where(VaultActivation.user_id == user_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().first()


async def _replace_deleted_activation(
    session: AsyncSession,
    *,
    identity: _RecoveryIdentity,
) -> tuple[VaultActivation | None, bool]:
    """Swap one confirmed-deleted generation without exposing an empty slot."""
    result = await session.execute(
        delete(VaultActivation)
        .where(
            col(VaultActivation.id) == identity.row_id,
            col(VaultActivation.state) == VaultActivationState.DELETING.value,
            col(VaultActivation.creek_job_id) == identity.creek_job_id,
            col(VaultActivation.recovery_requested_at).is_not(None),
        )
        .returning(col(VaultActivation.id))
    )
    if result.scalar_one_or_none() is None:
        await session.commit()
        return await _load_recovery_successor(session, identity), False
    fresh = VaultActivation(
        user_id=identity.user_id,
        activation_id=f"activation-{uuid4()}",
        consumer_identity=f"adepthood-user-{uuid4()}",
    )
    session.add(fresh)
    # Keep the confirmed receipt until the teardown reconciler removes it. A
    # concurrent recovery request may still be committing the same confirmed
    # Creek response; deleting the row here would turn that harmless duplicate
    # into a stale ORM update and a 500. The receipt is content-free and its
    # confirmed state remains the durable proof that minting this generation
    # was authorized.
    await session.commit()
    await session.refresh(fresh)
    await session.commit()
    return fresh, True


async def request_vault_teardown(
    session: AsyncSession,
    activation: VaultActivation,
    client: CreekProvisioningClient,
) -> VaultTeardownReceipt | None:
    """Durably detach a deletion receipt, then ask Creek outside the transaction."""
    job_id = activation.creek_job_id
    if job_id is None:
        await session.commit()
        return None
    return await _request_vault_teardown_for_job(session, job_id, client)


async def _request_vault_teardown_for_job(
    session: AsyncSession,
    job_id: str,
    client: CreekProvisioningClient,
) -> VaultTeardownReceipt:
    """Request teardown from a scalar identity that survives receipt contention."""
    receipt = await _ensure_teardown_receipt(session, job_id)
    update = await _fetch_teardown_update(client, job_id, issue_delete=True)
    _apply_teardown_update(receipt, update)
    receipt.attempts += 1
    receipt.updated_at = datetime.now(UTC)
    session.add(receipt)
    await session.commit()
    return receipt


async def _load_teardown_receipt(
    session: AsyncSession,
    job_id: str,
) -> VaultTeardownReceipt | None:
    result = await session.execute(
        select(VaultTeardownReceipt).where(VaultTeardownReceipt.creek_job_id == job_id)
    )
    return result.scalars().first()


async def _create_teardown_receipt(
    session: AsyncSession,
    job_id: str,
) -> VaultTeardownReceipt:
    receipt = VaultTeardownReceipt(creek_job_id=job_id)
    session.add(receipt)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        winner = await _load_teardown_receipt(session, job_id)
        if winner is None:
            raise
        await session.commit()
        return winner
    return receipt


async def _ensure_teardown_receipt(
    session: AsyncSession,
    job_id: str,
) -> VaultTeardownReceipt:
    receipt = await _load_teardown_receipt(session, job_id)
    if receipt is not None:
        await session.commit()
        return receipt
    return await _create_teardown_receipt(session, job_id)


TeardownUpdate = tuple[CreekProvisioningJob | None, str | None, bool]


async def _fetch_teardown_update(
    client: CreekProvisioningClient,
    job_id: str,
    *,
    issue_delete: bool,
) -> TeardownUpdate:
    operation = client.delete if issue_delete else client.status
    try:
        return await operation(job_id), None, False
    except ProvisioningUnavailableError:
        return None, FAILURE_PROVIDER_UNAVAILABLE, True
    except ProvisioningRejectedError:
        return None, FAILURE_PROVIDER_REJECTED, False


def _apply_teardown_update(
    receipt: VaultTeardownReceipt,
    update: TeardownUpdate,
) -> None:
    job, failure_reason, retryable = update
    if job is not None:
        _apply_teardown_job(receipt, job)
        return
    receipt.state = VaultActivationState.FAILED.value
    receipt.failure_reason = failure_reason
    receipt.retryable = retryable


def _apply_teardown_job(
    receipt: VaultTeardownReceipt,
    job: CreekProvisioningJob,
) -> None:
    if job.job_id != receipt.creek_job_id or job.state not in {
        VaultActivationState.DELETING.value,
        VaultActivationState.DELETED.value,
        VaultActivationState.FAILED.value,
    }:
        receipt.state = VaultActivationState.FAILED.value
        receipt.retryable = True
        receipt.failure_reason = FAILURE_MALFORMED_RESPONSE
        return
    receipt.state = job.state
    receipt.retryable = job.retryable
    receipt.failure_reason = job.failure_reason
    if job.state == VaultActivationState.DELETED.value:
        receipt.confirmed_at = datetime.now(UTC)


SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


async def reconcile_vault_teardowns(
    session_factory: SessionFactory,
    client: CreekProvisioningClient,
) -> None:
    """Resume every unconfirmed upstream deletion after a process restart."""
    pending = await _pending_teardowns(session_factory)
    for job_id, prior_state, retryable in pending:
        update = await _fetch_teardown_update(
            client,
            job_id,
            issue_delete=prior_state == VaultActivationState.FAILED.value and retryable,
        )
        await _store_reconciled_teardown(session_factory, job_id, update)


async def _pending_teardowns(
    session_factory: SessionFactory,
) -> tuple[tuple[str, str, bool], ...]:
    """Remove confirmed receipts and snapshot work before any network call."""
    async with session_factory() as session:
        result = await session.execute(select(VaultTeardownReceipt))
        receipts = tuple(result.scalars())
        pending = tuple(
            (row.creek_job_id, row.state, row.retryable)
            for row in receipts
            if row.confirmed_at is None
        )
        for confirmed_receipt in receipts:
            if confirmed_receipt.confirmed_at is not None:
                await session.delete(confirmed_receipt)
        await session.commit()
    return pending


async def _store_reconciled_teardown(
    session_factory: SessionFactory,
    job_id: str,
    update: TeardownUpdate,
) -> None:
    """Apply a network result only if its content-free receipt still exists."""
    async with session_factory() as session:
        current = await _load_teardown_receipt(session, job_id)
        if current is None or current.confirmed_at is not None:
            await session.commit()
            return
        _apply_teardown_update(current, update)
        if current.confirmed_at is not None:
            await session.delete(current)
        else:
            current.attempts += 1
            current.updated_at = datetime.now(UTC)
            session.add(current)
        await session.commit()


async def resume_vault_activations(
    session_factory: SessionFactory,
    client: CreekProvisioningClient,
) -> None:
    """Poll each durable in-flight activation once during application startup."""
    async with session_factory() as session:
        result = await session.execute(
            select(VaultActivation).where(col(VaultActivation.state).in_(_ACTIVE_STATES))
        )
        user_ids = tuple(row.user_id for row in result.scalars())
        await session.commit()
    for user_id in user_ids:
        async with session_factory() as session:
            await _resume_vault_activation(session, user_id, client)


async def _resume_vault_activation(
    session: AsyncSession,
    user_id: int,
    client: CreekProvisioningClient,
) -> None:
    """Resume one activation without confusing erasure with recovery."""
    activation = await load_vault_activation(session, user_id)
    if activation is None:
        return
    if activation.state != VaultActivationState.DELETING.value:
        await poll_vault_activation(session, activation, client)
        return
    if activation.recovery_requested_at is not None:
        await recover_vault_activation(session, activation, client)
