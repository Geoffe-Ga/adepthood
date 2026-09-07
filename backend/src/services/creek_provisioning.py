"""Durable Adepthood consumer for Creek's asynchronous provisioning API."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime
from typing import Final
from uuid import uuid4

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.vault_activation import (
    VaultActivation,
    VaultActivationState,
    VaultTeardownReceipt,
)
from schemas.vault_activation import VaultKeyCeremonyChallenge, VaultKeyCeremonySubmission
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
        VaultActivationState.AWAITING_KEY_CEREMONY.value,
        VaultActivationState.AWAITING_HANDOFF.value,
    }
)


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
    job_id_matches = activation.creek_job_id is None or job.job_id == activation.creek_job_id
    if job.activation_id != activation.activation_id or not job_id_matches:
        _mark_local_failure(activation, FAILURE_MALFORMED_RESPONSE, retryable=True)
        return
    activation.creek_job_id = job.job_id
    if _job_awaits_handoff(activation, job):
        activation.state = VaultActivationState.AWAITING_HANDOFF.value
        activation.retryable = False
        activation.failure_reason = None
        activation.attested_confidential = job.attested_confidential
        activation.updated_at = datetime.now(UTC)
        return
    activation.state = job.state
    activation.retryable = job.retryable
    activation.failure_reason = job.failure_reason
    activation.attested_confidential = job.attested_confidential
    activation.updated_at = datetime.now(UTC)


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


async def fetch_vault_key_ceremony(
    session: AsyncSession,
    activation: VaultActivation,
    client: CreekProvisioningClient,
) -> VaultKeyCeremonyChallenge:
    """Fetch and bind one public challenge with no database transaction held."""
    job_id = activation.creek_job_id
    if job_id is None:
        raise ProvisioningRejectedError("invalid_transition")
    await session.commit()
    challenge = await client.key_ceremony(job_id)
    if challenge.job_id != job_id or challenge.activation_id != activation.activation_id:
        raise ProvisioningUnavailableError("provisioning response malformed")
    return challenge


async def complete_vault_key_ceremony(
    session: AsyncSession,
    activation: VaultActivation,
    submission: VaultKeyCeremonySubmission,
    client: CreekProvisioningClient,
) -> VaultActivation:
    """Relay ciphertext outside the transaction and durably apply Creek's job state."""
    job_id = activation.creek_job_id
    if job_id is None:
        raise ProvisioningRejectedError("invalid_transition")
    await session.commit()
    job = await client.complete_key_ceremony(job_id, submission)
    _apply_job(activation, job)
    session.add(activation)
    await session.commit()
    await session.refresh(activation)
    return activation


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
            activation = await load_vault_activation(session, user_id)
            if activation is not None:
                await poll_vault_activation(session, activation, client)
