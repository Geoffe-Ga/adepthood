"""Credential-bearing Creek callback kept off the user-facing vault router."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, Response, status
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from error_responses import build_router
from errors import bad_request, conflict
from models.user_vault_config import UserVaultConfig
from models.vault_activation import VaultActivation, VaultActivationState
from schemas.vault_activation import CreekConnectionHandoff
from schemas.vault_config import credential_is_usable
from services.creek_provisioning_client import handoff_bearer_is_valid
from services.creek_vault_url import classify_vault_url
from services.user_vault_config import load_vault_config, store_vault_config

router = build_router(
    prefix="/internal/vault-provisioning",
    tags=["internal-vault-provisioning"],
)


def _unauthorized_handoff() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid_provisioning_handoff",
    )


async def _validated_handoff(
    request: Request,
    authorization: str | None,
) -> CreekConnectionHandoff:
    """Parse only the strict callback contract after authenticating its bearer."""
    if not handoff_bearer_is_valid(authorization):
        raise _unauthorized_handoff()
    try:
        payload = CreekConnectionHandoff.model_validate(await request.json())
    except (ValueError, ValidationError):
        raise bad_request("invalid_provisioning_handoff") from None
    if classify_vault_url(payload.vault_url) is not None or not credential_is_usable(
        payload.consumer_credential
    ):
        raise bad_request("invalid_provisioning_handoff")
    return payload


async def _owned_activation(
    session: AsyncSession,
    payload: CreekConnectionHandoff,
) -> VaultActivation:
    """Resolve the activation by both opaque job and consumer identity."""
    result = await session.execute(
        select(VaultActivation).where(
            VaultActivation.creek_job_id == payload.job_id,
            VaultActivation.consumer_identity == payload.consumer_identity,
        )
    )
    activation = result.scalars().first()
    if activation is None:
        raise _unauthorized_handoff()
    return activation


def _connection_conflicts(
    existing: UserVaultConfig | None,
    payload: CreekConnectionHandoff,
) -> bool:
    return existing is not None and (
        existing.vault_url != payload.vault_url or existing.api_key != payload.consumer_credential
    )


async def _persist_handoff(
    session: AsyncSession,
    activation: VaultActivation,
    payload: CreekConnectionHandoff,
) -> None:
    """Persist one idempotent encrypted handoff and settle its activation."""
    existing = await load_vault_config(session, activation.user_id)
    if _connection_conflicts(existing, payload):
        raise conflict("provisioning_handoff_conflict")
    await store_vault_config(
        session,
        activation.user_id,
        vault_url=payload.vault_url,
        api_key=payload.consumer_credential,
        provisioned=True,
    )
    activation.credential_received_at = activation.credential_received_at or datetime.now(UTC)
    if activation.state == VaultActivationState.AWAITING_HANDOFF.value:
        activation.state = VaultActivationState.READY.value
    activation.updated_at = datetime.now(UTC)
    session.add(activation)
    await session.commit()


@router.post("/completions", status_code=status.HTTP_204_NO_CONTENT)
async def receive_creek_connection_handoff(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    """Store Creek's one-time URL/credential delivery without ever echoing it."""
    payload = await _validated_handoff(request, authorization)
    activation = await _owned_activation(session, payload)
    await _persist_handoff(session, activation, payload)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
