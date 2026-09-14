"""Explicit managed-vault activation and Creek's internal handoff endpoint."""

from __future__ import annotations

from typing import Annotated, TypeGuard

from fastapi import Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from error_responses import build_router
from errors import conflict, service_unavailable
from models.vault_activation import VaultActivation, VaultActivationState
from routers.auth import get_current_user
from schemas.vault_activation import VaultActivationResponse
from services.creek_provisioning import (
    load_vault_activation,
    poll_vault_activation,
    retry_vault_activation,
    submit_vault_activation,
)
from services.creek_provisioning_client import (
    CreekProvisioningClient,
    get_creek_provisioning_client,
)
from services.managed_vault_rollout import managed_vault_activation_is_available

router = build_router(
    prefix="/vault",
    tags=["vault"],
    extra_statuses=(status.HTTP_409_CONFLICT, status.HTTP_503_SERVICE_UNAVAILABLE),
)
_INACTIVE_RESPONSE = VaultActivationResponse(
    active=False,
    state="inactive",
    new_activation_available=False,
    retryable=False,
    failure_reason=None,
    credential_received=False,
    attested_confidential=None,
    custody_mode=None,
)
_POLLABLE_STATES = {
    VaultActivationState.SUBMITTING.value,
    VaultActivationState.PENDING.value,
    VaultActivationState.PROVISIONING.value,
    VaultActivationState.AWAITING_HANDOFF.value,
}


def _to_response(
    activation: VaultActivation | None,
    *,
    new_activation_available: bool,
) -> VaultActivationResponse:
    if activation is None:
        return _INACTIVE_RESPONSE.model_copy(
            update={"new_activation_available": new_activation_available}
        )
    return VaultActivationResponse(
        active=True,
        state=activation.state,
        new_activation_available=new_activation_available,
        retryable=activation.retryable,
        failure_reason=activation.failure_reason,
        credential_received=activation.credential_received_at is not None,
        attested_confidential=activation.attested_confidential,
        custody_mode=activation.custody_mode,
    )


async def _closed_rollout_response(
    session: AsyncSession,
    activation: VaultActivation | None,
) -> VaultActivationResponse:
    """Replay an admitted activation; refuse only a brand-new identity."""
    if activation is None:
        raise service_unavailable("managed_vault_activation_unavailable")
    await session.commit()
    return _to_response(activation, new_activation_available=False)


def _should_poll(
    activation: VaultActivation | None,
) -> TypeGuard[VaultActivation]:
    return activation is not None and activation.state in _POLLABLE_STATES


@router.post(
    "/activation",
    response_model=VaultActivationResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def activate_managed_vault(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    client: Annotated[CreekProvisioningClient, Depends(get_creek_provisioning_client)],
) -> VaultActivationResponse:
    """Explicitly create or replay this account's one durable Creek activation."""
    existing = await load_vault_activation(session, user_id)
    available = managed_vault_activation_is_available(user_id)
    if not available:
        return await _closed_rollout_response(session, existing)
    activation = await submit_vault_activation(session, user_id, client)
    return _to_response(activation, new_activation_available=available)


@router.get("/activation", response_model=VaultActivationResponse)
async def get_managed_vault_activation(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    client: Annotated[CreekProvisioningClient, Depends(get_creek_provisioning_client)],
) -> VaultActivationResponse:
    """Return stable progress, polling Creek outside the request transaction."""
    activation = await load_vault_activation(session, user_id)
    available = managed_vault_activation_is_available(user_id)
    if _should_poll(activation):
        activation = await poll_vault_activation(session, activation, client)
    return _to_response(
        activation,
        new_activation_available=available,
    )


@router.post(
    "/activation/retry",
    response_model=VaultActivationResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def retry_managed_vault_activation(
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
    available = managed_vault_activation_is_available(user_id)
    activation = await retry_vault_activation(session, activation, client)
    return _to_response(activation, new_activation_available=available)
