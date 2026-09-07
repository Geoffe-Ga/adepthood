"""Secret-minimizing HTTP boundary for Creek's provisioning control plane."""

from __future__ import annotations

import hmac
import os
from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
from pathlib import Path
from typing import Annotated, Final, Literal, Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from models.vault_activation import VaultActivationState
from schemas.vault_activation import (
    VaultKeyCeremonyChallenge,
    VaultKeyCeremonySubmission,
)
from services.creek_vault_url import classify_vault_url

PROVISIONING_URL_ENV_VAR: Final[str] = "CREEK_PROVISIONING_URL"
PROVISIONING_AUTH_FILE_ENV_VAR: Final[str] = "CREEK_PROVISIONING_AUTH_FILE"
HANDOFF_AUTH_FILE_ENV_VAR: Final[str] = "CREEK_PROVISIONING_HANDOFF_AUTH_FILE"

FAILURE_PROVIDER_UNAVAILABLE: Final[str] = "provider_unavailable"
FAILURE_PROVIDER_REJECTED: Final[str] = "provider_rejected"
FAILURE_MALFORMED_RESPONSE: Final[str] = "malformed_completion"

_EXPECTED_CONTRACT_MAJOR: Final[str] = "1"
_CONTRACT_HEADER: Final[str] = "Creek-Provisioning-Version"
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
_ALL_STATES: Final[frozenset[str]] = frozenset(state.value for state in VaultActivationState)


class ProvisioningUnavailableError(RuntimeError):
    """The Creek control plane could not give a trustworthy answer."""


class ProvisioningRejectedError(RuntimeError):
    """Creek refused an operation without exposing its response payload."""

    def __init__(self, code: str = FAILURE_PROVIDER_REJECTED) -> None:
        """Retain only one allowlisted stable code, never Creek's raw body."""
        safe_code = code if code in _CEREMONY_REJECTION_CODES else FAILURE_PROVIDER_REJECTED
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
        return FAILURE_PROVIDER_REJECTED
    if not isinstance(payload, dict):
        return FAILURE_PROVIDER_REJECTED
    code = payload.get("code")
    if not isinstance(code, str) or code not in _CEREMONY_REJECTION_CODES:
        return FAILURE_PROVIDER_REJECTED
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
    if expected is None:
        return False
    if authorization is None:
        return False
    return _bearer_matches(authorization, expected)


def _bearer_matches(authorization: str, expected: str) -> bool:
    """Compare one syntactically valid bearer without timing leaks."""
    scheme, separator, supplied = authorization.partition(" ")
    if separator != " ":
        return False
    if scheme.lower() != "bearer":
        return False
    if not supplied:
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
