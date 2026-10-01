"""Credential-bearing Creek callback kept off the user-facing vault router."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum, unique
from typing import Annotated, Literal

from fastapi import Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from error_responses import build_router
from errors import bad_request, conflict, service_unavailable
from models.user_vault_config import UserVaultConfig
from models.vault_activation import VaultActivation, VaultActivationState
from schemas.vault_activation import CreekConnectionHandoff
from schemas.vault_config import credential_is_usable
from services.creek_provisioning_client import handoff_bearer_is_valid
from services.creek_vault_url import classify_vault_url
from services.email import (
    EmailDeliveryError,
    EmailMessagePayload,
    EmailSender,
    get_email_sender,
)
from services.managed_vault_rollout import managed_vault_alert_destination
from services.user_vault_config import load_vault_config, store_vault_config

router = build_router(
    prefix="/internal/vault-provisioning",
    tags=["internal-vault-provisioning"],
    extra_statuses=(status.HTTP_409_CONFLICT, status.HTTP_503_SERVICE_UNAVAILABLE),
)
_TERMINAL_HANDOFF_STATES = frozenset(
    {
        VaultActivationState.FAILED.value,
        VaultActivationState.DELETING.value,
        VaultActivationState.DELETED.value,
    }
)
_ALERT_EMAIL_SUBJECT = "Managed vault pilot alert"


@unique
class _FleetAlertKind(StrEnum):
    """The exact content-free vocabulary shared with Creek AlertKind."""

    DUPLICATE_RESOURCE = "duplicate_resource"
    ORPHAN_RESOURCE = "orphan_resource"
    STUCK_DELETION = "stuck_deletion"
    CONTINUOUS_RUNNING = "continuous_running"
    MONTHLY_BUDGET_DEPARTURE = "monthly_budget_departure"


class _FleetAlertPayload(BaseModel):
    """Counts-only fleet alert; subjects and resource coordinates cannot parse."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_name: Literal["creek_fleet_alert_v1"] = Field(alias="schema")
    counts: dict[
        _FleetAlertKind,
        Annotated[int, Field(strict=True, gt=0)],
    ] = Field(min_length=1, max_length=len(_FleetAlertKind))


def _unauthorized_handoff() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid_provisioning_handoff",
    )


def _authenticate_handoff(authorization: str | None) -> None:
    """Authenticate the shared mounted bearer before touching a request body."""
    if not handoff_bearer_is_valid(authorization):
        raise _unauthorized_handoff()


async def _validated_handoff(
    request: Request,
    authorization: str | None,
) -> CreekConnectionHandoff:
    """Parse only the strict callback contract after authenticating its bearer."""
    _authenticate_handoff(authorization)
    try:
        payload = CreekConnectionHandoff.model_validate(await request.json())
    except (ValueError, ValidationError):
        raise bad_request("invalid_provisioning_handoff") from None
    if classify_vault_url(payload.vault_url) is not None or not credential_is_usable(
        payload.consumer_credential
    ):
        raise bad_request("invalid_provisioning_handoff")
    return payload


async def _validated_fleet_alert(
    request: Request,
    authorization: str | None,
) -> _FleetAlertPayload:
    """Parse the closed counts-only contract after authenticating its bearer."""
    _authenticate_handoff(authorization)
    try:
        return _FleetAlertPayload.model_validate(await request.json())
    except (ValueError, ValidationError):
        raise bad_request("invalid_fleet_alert") from None


def _fleet_alert_email(
    payload: _FleetAlertPayload,
    destination: str,
) -> EmailMessagePayload:
    """Render sorted enum values and counts without any resource subject."""
    lines = [
        "Managed vault fleet alerts:",
        *(
            f"{kind.value}: {count}"
            for kind, count in sorted(payload.counts.items(), key=lambda item: item[0].value)
        ),
        "",
    ]
    return EmailMessagePayload(
        to=destination,
        subject=_ALERT_EMAIL_SUBJECT,
        body="\n".join(lines),
    )


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
    if activation.state in _TERMINAL_HANDOFF_STATES:
        raise conflict("invalid_transition")
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


@router.post("/alerts", status_code=status.HTTP_204_NO_CONTENT)
async def receive_creek_fleet_alert(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    """Deliver one authenticated, counts-only fleet alert to operations."""
    payload = await _validated_fleet_alert(request, authorization)
    destination = managed_vault_alert_destination()
    if destination is None:
        raise service_unavailable("managed_vault_alert_delivery_unavailable")
    sender: EmailSender = get_email_sender()
    try:
        await sender.send(
            _fleet_alert_email(payload, destination),
            redact_for_log=None,
        )
    except EmailDeliveryError:
        raise service_unavailable("managed_vault_alert_delivery_unavailable") from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)
