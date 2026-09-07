"""Explicit private-vault activation and Creek's internal handoff endpoint."""

from __future__ import annotations

from typing import Annotated, NoReturn

from fastapi import Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from error_responses import build_router
from errors import conflict, service_unavailable
from models.vault_activation import VaultActivation, VaultActivationState
from routers.auth import get_current_user
from schemas.vault_activation import (
    VaultActivationResponse,
    VaultKeyCeremonyChallenge,
    VaultKeyCeremonySubmission,
)
from services.creek_provisioning import (
    complete_vault_key_ceremony,
    fetch_vault_key_ceremony,
    load_vault_activation,
    poll_vault_activation,
    retry_vault_activation,
    submit_vault_activation,
)
from services.creek_provisioning_client import (
    CEREMONY_REJECTION_CODES,
    CreekProvisioningClient,
    ProvisioningRejectedError,
    ProvisioningUnavailableError,
    get_creek_provisioning_client,
)

router = build_router(
    prefix="/vault",
    tags=["vault"],
    extra_statuses=(status.HTTP_409_CONFLICT, status.HTTP_503_SERVICE_UNAVAILABLE),
)
_INACTIVE_RESPONSE = VaultActivationResponse(
    active=False,
    state="inactive",
    retryable=False,
    failure_reason=None,
    credential_received=False,
    attested_confidential=None,
)
_POLLABLE_STATES = {
    VaultActivationState.SUBMITTING.value,
    VaultActivationState.PENDING.value,
    VaultActivationState.PROVISIONING.value,
    VaultActivationState.AWAITING_KEY_CEREMONY.value,
    VaultActivationState.AWAITING_HANDOFF.value,
}


def _to_response(activation: VaultActivation | None) -> VaultActivationResponse:
    if activation is None:
        return _INACTIVE_RESPONSE.model_copy()
    return VaultActivationResponse(
        active=True,
        state=activation.state,
        retryable=activation.retryable,
        failure_reason=activation.failure_reason,
        credential_received=activation.credential_received_at is not None,
        attested_confidential=activation.attested_confidential,
    )


def _raise_ceremony_error(error: Exception) -> NoReturn:
    """Translate Creek's bounded failures without exposing its response body."""
    if isinstance(error, ProvisioningRejectedError) and error.code in CEREMONY_REJECTION_CODES:
        raise conflict(error.code) from None
    raise service_unavailable("vault_provisioning_unavailable") from None


async def _load_ceremony_activation(
    session: AsyncSession,
    user_id: int,
) -> VaultActivation:
    """Resolve only this account's awaiting allocation before releasing the DB."""
    activation = await load_vault_activation(session, user_id)
    if (
        activation is None
        or activation.state != VaultActivationState.AWAITING_KEY_CEREMONY.value
        or activation.creek_job_id is None
    ):
        raise conflict("invalid_transition")
    return activation


@router.post(
    "/activation",
    response_model=VaultActivationResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def activate_private_vault(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    client: Annotated[CreekProvisioningClient, Depends(get_creek_provisioning_client)],
) -> VaultActivationResponse:
    """Explicitly create or replay this account's one durable Creek activation."""
    activation = await submit_vault_activation(session, user_id, client)
    return _to_response(activation)


@router.get("/activation", response_model=VaultActivationResponse)
async def get_private_vault_activation(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    client: Annotated[CreekProvisioningClient, Depends(get_creek_provisioning_client)],
) -> VaultActivationResponse:
    """Return stable progress, polling Creek outside the request transaction."""
    activation = await load_vault_activation(session, user_id)
    if activation is not None and activation.state in _POLLABLE_STATES:
        activation = await poll_vault_activation(session, activation, client)
    return _to_response(activation)


@router.post(
    "/activation/retry",
    response_model=VaultActivationResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def retry_private_vault_activation(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    client: Annotated[CreekProvisioningClient, Depends(get_creek_provisioning_client)],
) -> VaultActivationResponse:
    """Retry exactly the existing activation after a safe, retryable failure."""
    activation = await load_vault_activation(session, user_id)
    if activation is None or activation.state != VaultActivationState.FAILED.value:
        raise conflict("vault_activation_not_retryable")
    if not activation.retryable:
        raise conflict("vault_activation_not_retryable")
    activation = await retry_vault_activation(session, activation, client)
    return _to_response(activation)


@router.get(
    "/activation/key-ceremony",
    response_model=VaultKeyCeremonyChallenge,
)
async def get_private_vault_key_ceremony(
    response: Response,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    client: Annotated[CreekProvisioningClient, Depends(get_creek_provisioning_client)],
) -> VaultKeyCeremonyChallenge:
    """Relay this account's public challenge without exposing Creek credentials."""
    response.headers["Cache-Control"] = "no-store"
    activation = await _load_ceremony_activation(session, user_id)
    try:
        return await fetch_vault_key_ceremony(session, activation, client)
    except (ProvisioningRejectedError, ProvisioningUnavailableError) as error:
        _raise_ceremony_error(error)


@router.put(
    "/activation/key-ceremony",
    response_model=VaultActivationResponse,
)
async def complete_private_vault_key_ceremony(
    payload: VaultKeyCeremonySubmission,
    response: Response,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    client: Annotated[CreekProvisioningClient, Depends(get_creek_provisioning_client)],
) -> VaultActivationResponse:
    """Relay only a validated ciphertext artifact and return secret-free progress."""
    response.headers["Cache-Control"] = "no-store"
    activation = await _load_ceremony_activation(session, user_id)
    try:
        activation = await complete_vault_key_ceremony(
            session,
            activation,
            payload,
            client,
        )
    except (ProvisioningRejectedError, ProvisioningUnavailableError) as error:
        _raise_ceremony_error(error)
    return _to_response(activation)
