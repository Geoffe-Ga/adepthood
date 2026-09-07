"""Durable Adepthood consumer for Creek's asynchronous provisioning API."""

from __future__ import annotations

import hmac
import os
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime
from http import HTTPStatus
from pathlib import Path
from typing import Annotated, Final, Literal, Protocol
from uuid import uuid4

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.vault_activation import (
    VaultActivation,
    VaultActivationState,
    VaultTeardownReceipt,
)
from schemas.vault_activation import (
    VaultKeyCeremonyChallenge,
    VaultKeyCeremonySubmission,
)
from services.creek_vault_url import classify_vault_url

PROVISIONING_URL_ENV_VAR: Final[str] = "CREEK_PROVISIONING_URL"
PROVISIONING_AUTH_FILE_ENV_VAR: Final[str] = "CREEK_PROVISIONING_AUTH_FILE"
HANDOFF_AUTH_FILE_ENV_VAR: Final[str] = "CREEK_PROVISIONING_HANDOFF_AUTH_FILE"

_EXPECTED_CONTRACT_MAJOR: Final[str] = "1"
_CONTRACT_HEADER: Final[str] = "Creek-Provisioning-Version"
_FAILURE_PROVIDER_UNAVAILABLE: Final[str] = "provider_unavailable"
_FAILURE_PROVIDER_REJECTED: Final[str] = "provider_rejected"
_FAILURE_MALFORMED_RESPONSE: Final[str] = "malformed_completion"
_CEREMONY_REJECTION_CODES: Final[frozenset[str]] = frozenset(
    {
        "invalid_request",
        "job_unavailable",
        "invalid_transition",
        "ceremony_conflict",
        "ceremony_expired",
    }
)
_IDENTIFIER = Annotated[str, Field(min_length=1, max_length=200)]
_STATUS_URL = Annotated[str, Field(min_length=1, max_length=500)]
_UPSTREAM_STATE = Literal[
    "pending",
    "provisioning",
    "awaiting_key_ceremony",
    "ready",
    "failed",
    "deleting",
    "deleted",
]
_UPSTREAM_FAILURE = Literal[
    "provider_unavailable",
    "provider_rejected",
    "handoff_failed",
    "internal_error",
]
_ACTIVE_STATES: Final[frozenset[str]] = frozenset(
    {
        VaultActivationState.SUBMITTING.value,
        VaultActivationState.PENDING.value,
        VaultActivationState.PROVISIONING.value,
        VaultActivationState.AWAITING_KEY_CEREMONY.value,
        VaultActivationState.AWAITING_HANDOFF.value,
    }
)
_ALL_STATES: Final[frozenset[str]] = frozenset(state.value for state in VaultActivationState)


class ProvisioningUnavailableError(RuntimeError):
    """The Creek control plane could not give a trustworthy answer."""


class ProvisioningRejectedError(RuntimeError):
    """Creek refused an operation without exposing its response payload."""

    def __init__(self, code: str = _FAILURE_PROVIDER_REJECTED) -> None:
        """Retain only one allowlisted stable code, never Creek's raw body."""
        safe_code = code if code in _CEREMONY_REJECTION_CODES else _FAILURE_PROVIDER_REJECTED
        super().__init__(safe_code)
        self.code = safe_code


@dataclass(frozen=True, slots=True)
class CreekProvisioningJob:
    """Secret-free subset of the Creek job contract used by Adepthood."""

    job_id: str
    activation_id: str
    state: str
    attempts: int
    retryable: bool
    failure_reason: str | None
    attested_confidential: bool | None


class CreekProvisioningClient(Protocol):
    """Network boundary used by routes, startup recovery, and tests."""

    async def activate(
        self,
        activation_id: str,
        consumer_identity: str,
    ) -> CreekProvisioningJob:
        """Create or replay one durable allocation request."""

    async def status(self, job_id: str) -> CreekProvisioningJob:
        """Read one owned job."""

    async def retry(self, job_id: str) -> CreekProvisioningJob:
        """Retry one safely retryable job."""

    async def delete(self, job_id: str) -> CreekProvisioningJob:
        """Idempotently request upstream teardown."""

    async def key_ceremony(self, job_id: str) -> VaultKeyCeremonyChallenge:
        """Fetch one public challenge for an awaiting job."""

    async def complete_key_ceremony(
        self,
        job_id: str,
        submission: VaultKeyCeremonySubmission,
    ) -> CreekProvisioningJob:
        """Relay one strictly validated ciphertext-only completion."""


class _CreekJobWire(BaseModel):
    """Strict parser for the current Creek v1 public job response."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    job_id: _IDENTIFIER
    activation_id: _IDENTIFIER
    state: _UPSTREAM_STATE
    attempts: Annotated[int, Field(ge=0)]
    retryable: bool
    failure_reason: _UPSTREAM_FAILURE | None
    created_at: datetime
    updated_at: datetime
    attested_confidential: bool | None
    status_url: _STATUS_URL

    @field_validator("created_at", "updated_at")
    @classmethod
    def _timezone_aware(cls, value: datetime) -> datetime:
        """Reject ambiguous upstream clocks before they enter recovery logic."""
        if value.tzinfo is None:
            raise ValueError("provisioning timestamp must be timezone-aware")
        return value


def _stable_rejection_code(response: httpx.Response) -> str:
    """Extract only Creek's allowlisted code and discard every other body field."""
    try:
        payload = response.json()
    except ValueError:
        return _FAILURE_PROVIDER_REJECTED
    if not isinstance(payload, dict):
        return _FAILURE_PROVIDER_REJECTED
    code = payload.get("code")
    if not isinstance(code, str) or code not in _CEREMONY_REJECTION_CODES:
        return _FAILURE_PROVIDER_REJECTED
    return code


class HttpCreekProvisioningClient:
    """Bearer-authenticated Creek v1 transport with secret-free failures."""

    def __init__(self, base_url: str, token: str, client: httpx.AsyncClient) -> None:
        """Bind one requester bearer to the shared bounded transport."""
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._client = client

    async def activate(
        self,
        activation_id: str,
        consumer_identity: str,
    ) -> CreekProvisioningJob:
        return await self._request(
            "POST",
            "/control/v1/activations",
            json={
                "activation_id": activation_id,
                "consumer_identity": consumer_identity,
            },
            expected_status=202,
        )

    async def status(self, job_id: str) -> CreekProvisioningJob:
        return await self._request(
            "GET",
            f"/control/v1/jobs/{job_id}",
            expected_status=200,
        )

    async def retry(self, job_id: str) -> CreekProvisioningJob:
        return await self._request(
            "POST",
            f"/control/v1/jobs/{job_id}/retry",
            expected_status=202,
        )

    async def delete(self, job_id: str) -> CreekProvisioningJob:
        return await self._request(
            "DELETE",
            f"/control/v1/jobs/{job_id}",
            expected_status=202,
        )

    async def key_ceremony(self, job_id: str) -> VaultKeyCeremonyChallenge:
        response = await self._send(
            "GET",
            f"/control/v1/jobs/{job_id}/key-ceremony",
            expected_status=200,
        )
        try:
            return VaultKeyCeremonyChallenge.model_validate(response.json())
        except (ValueError, ValidationError):
            raise ProvisioningUnavailableError("provisioning response malformed") from None

    async def complete_key_ceremony(
        self,
        job_id: str,
        submission: VaultKeyCeremonySubmission,
    ) -> CreekProvisioningJob:
        return await self._request(
            "PUT",
            f"/control/v1/jobs/{job_id}/key-ceremony",
            json=submission.model_dump(mode="json"),
            expected_status=200,
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        expected_status: int,
        json: dict[str, object] | None = None,
    ) -> CreekProvisioningJob:
        response = await self._send(
            method,
            path,
            expected_status=expected_status,
            json=json,
        )
        try:
            wire = _CreekJobWire.model_validate(response.json())
        except (ValueError, ValidationError):
            raise ProvisioningUnavailableError("provisioning response malformed") from None
        if wire.state not in _ALL_STATES:
            raise ProvisioningUnavailableError("provisioning response malformed")
        return CreekProvisioningJob(
            job_id=wire.job_id,
            activation_id=wire.activation_id,
            state=wire.state,
            attempts=wire.attempts,
            retryable=wire.retryable,
            failure_reason=wire.failure_reason,
            attested_confidential=wire.attested_confidential,
        )

    async def _send(
        self,
        method: str,
        path: str,
        *,
        expected_status: int,
        json: dict[str, object] | None = None,
    ) -> httpx.Response:
        """Send one authenticated request and retain no untrusted response detail."""
        try:
            response = await self._client.request(
                method,
                f"{self._base_url}{path}",
                headers={"Authorization": f"Bearer {self._token}"},
                json=json,
            )
        except httpx.HTTPError:
            raise ProvisioningUnavailableError("provisioning unavailable") from None
        if response.status_code >= HTTPStatus.INTERNAL_SERVER_ERROR:
            raise ProvisioningUnavailableError("provisioning unavailable")
        version = response.headers.get(_CONTRACT_HEADER, "")
        if version.partition(".")[0] != _EXPECTED_CONTRACT_MAJOR:
            raise ProvisioningUnavailableError("provisioning contract unavailable")
        if response.status_code != expected_status:
            raise ProvisioningRejectedError(_stable_rejection_code(response))
        return response


class _UnavailableProvisioningClient:
    """Configured absence that activation records as a retryable failure."""

    @staticmethod
    def _raise() -> CreekProvisioningJob:
        raise ProvisioningUnavailableError("provisioning unavailable")

    async def activate(
        self,
        activation_id: str,
        consumer_identity: str,
    ) -> CreekProvisioningJob:
        del activation_id, consumer_identity
        return self._raise()

    async def status(self, job_id: str) -> CreekProvisioningJob:
        del job_id
        return self._raise()

    async def retry(self, job_id: str) -> CreekProvisioningJob:
        del job_id
        return self._raise()

    async def delete(self, job_id: str) -> CreekProvisioningJob:
        del job_id
        return self._raise()

    async def key_ceremony(self, job_id: str) -> VaultKeyCeremonyChallenge:
        del job_id
        raise ProvisioningUnavailableError("provisioning unavailable")

    async def complete_key_ceremony(
        self,
        job_id: str,
        submission: VaultKeyCeremonySubmission,
    ) -> CreekProvisioningJob:
        del job_id, submission
        return self._raise()


@dataclass(slots=True)
class _HttpClientPool:
    """Mutable holder avoids rebinding module globals during lazy lifecycle."""

    client: httpx.AsyncClient | None = None


_HTTP_POOL = _HttpClientPool()


def _read_mounted_token(env_var: str) -> str | None:
    """Read a non-empty bearer from its mounted file without logging its value."""
    raw_path = os.getenv(env_var, "").strip()
    if not raw_path:
        return None
    try:
        token = Path(raw_path).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def handoff_bearer_is_valid(authorization: str | None) -> bool:
    """Authenticate Creek's callback against a separately mounted bearer."""
    expected = _read_mounted_token(HANDOFF_AUTH_FILE_ENV_VAR)
    if expected is None or authorization is None:
        return False
    scheme, separator, supplied = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not supplied:
        return False
    return hmac.compare_digest(supplied, expected)


def get_creek_provisioning_client() -> CreekProvisioningClient:
    """Resolve the backend-only Creek client; an incomplete config fails softly."""
    base_url = os.getenv(PROVISIONING_URL_ENV_VAR, "").strip()
    token = _read_mounted_token(PROVISIONING_AUTH_FILE_ENV_VAR)
    if not base_url or token is None or classify_vault_url(base_url) is not None:
        return _UnavailableProvisioningClient()
    if _HTTP_POOL.client is None:
        _HTTP_POOL.client = httpx.AsyncClient(timeout=10.0)
    return HttpCreekProvisioningClient(base_url, token, _HTTP_POOL.client)


async def close_creek_provisioning_http_pool() -> None:
    """Close the lazily allocated control-plane transport on app shutdown."""
    client, _HTTP_POOL.client = _HTTP_POOL.client, None
    if client is not None:
        await client.aclose()


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
    if job.activation_id != activation.activation_id:
        _mark_local_failure(activation, _FAILURE_MALFORMED_RESPONSE, retryable=True)
        return
    if activation.creek_job_id is not None and job.job_id != activation.creek_job_id:
        _mark_local_failure(activation, _FAILURE_MALFORMED_RESPONSE, retryable=True)
        return
    activation.creek_job_id = job.job_id
    if job.state == VaultActivationState.READY.value and activation.credential_received_at is None:
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


async def _store_job(
    session: AsyncSession,
    activation: VaultActivation,
    operation: Callable[[], Awaitable[CreekProvisioningJob]],
) -> VaultActivation:
    """Run one already-transaction-free network operation and persist its result."""
    try:
        job = await operation()
    except ProvisioningUnavailableError:
        _mark_local_failure(activation, _FAILURE_PROVIDER_UNAVAILABLE, retryable=True)
    except ProvisioningRejectedError:
        _mark_local_failure(activation, _FAILURE_PROVIDER_REJECTED, retryable=False)
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
    result = await session.execute(
        select(VaultTeardownReceipt).where(VaultTeardownReceipt.creek_job_id == job_id)
    )
    receipt = result.scalars().first()
    if receipt is None:
        receipt = VaultTeardownReceipt(creek_job_id=job_id)
        session.add(receipt)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            result = await session.execute(
                select(VaultTeardownReceipt).where(VaultTeardownReceipt.creek_job_id == job_id)
            )
            receipt = result.scalars().first()
            if receipt is None:
                raise
            await session.commit()
    else:
        await session.commit()
    try:
        job = await client.delete(job_id)
    except ProvisioningUnavailableError:
        receipt.state = VaultActivationState.FAILED.value
        receipt.retryable = True
        receipt.failure_reason = _FAILURE_PROVIDER_UNAVAILABLE
    except ProvisioningRejectedError:
        receipt.state = VaultActivationState.FAILED.value
        receipt.retryable = False
        receipt.failure_reason = _FAILURE_PROVIDER_REJECTED
    else:
        _apply_teardown_job(receipt, job)
    receipt.attempts += 1
    receipt.updated_at = datetime.now(UTC)
    session.add(receipt)
    await session.commit()
    return receipt


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
        receipt.failure_reason = _FAILURE_MALFORMED_RESPONSE
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
    for job_id, prior_state, retryable in pending:
        job: CreekProvisioningJob | None = None
        failure_reason: str | None = None
        failure_retryable = False
        try:
            if prior_state == VaultActivationState.FAILED.value and retryable:
                job = await client.delete(job_id)
            else:
                job = await client.status(job_id)
        except ProvisioningUnavailableError:
            failure_reason = _FAILURE_PROVIDER_UNAVAILABLE
            failure_retryable = True
        except ProvisioningRejectedError:
            failure_reason = _FAILURE_PROVIDER_REJECTED
        async with session_factory() as session:
            result = await session.execute(
                select(VaultTeardownReceipt).where(VaultTeardownReceipt.creek_job_id == job_id)
            )
            current_receipt = result.scalars().first()
            if current_receipt is None or current_receipt.confirmed_at is not None:
                await session.commit()
                continue
            if job is None:
                current_receipt.state = VaultActivationState.FAILED.value
                current_receipt.failure_reason = failure_reason
                current_receipt.retryable = failure_retryable
            else:
                _apply_teardown_job(current_receipt, job)
            if current_receipt.confirmed_at is not None:
                await session.delete(current_receipt)
                await session.commit()
                continue
            current_receipt.attempts += 1
            current_receipt.updated_at = datetime.now(UTC)
            session.add(current_receipt)
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
