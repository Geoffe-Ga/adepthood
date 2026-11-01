"""Credential-bearing Creek callbacks kept off the user-facing vault router.

Every route here is called by Creek's control plane with its mounted handoff
bearer, never by a person: the one-time connection handoff, counts-only fleet
alerts, and (R3-2, #3585) the per-call question of whether an agent's access
token still stands, answered ``{"active": bool}`` and nothing more.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum, unique
from typing import Annotated, Final, Literal

from fastapi import Depends, Header, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from error_responses import build_router
from errors import bad_request, conflict, service_unavailable
from models.user_vault_config import UserVaultConfig
from models.vault_activation import VaultActivation, VaultActivationState
from rate_limit import limiter
from routers.auth import session_signing_secret
from schemas.agent_token_status import AgentTokenStatusRequest, AgentTokenStatusResponse
from schemas.vault_activation import CreekConnectionHandoff
from schemas.vault_config import credential_is_usable
from services.creek_provisioning_client import handoff_bearer_is_valid
from services.creek_vault_url import classify_vault_url, vault_base_url
from services.email import (
    EmailDeliveryError,
    EmailMessagePayload,
    EmailSender,
    get_email_sender,
)
from services.managed_vault_rollout import managed_vault_alert_destination
from services.oauth_tokens import AgentTokenClaims, agent_token_active
from services.user_vault_config import (
    load_vault_config,
    lock_vault_connection_owner,
    store_vault_config,
)

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

#: Status lookups one caller address may make. Creek caches an ``active`` answer
#: per (sub, client) for ``REVOCATION_CACHE_SECONDS`` (Creek-Vault#2005), so this
#: is one lookup a second across the fleet it fronts; no higher than the ambient
#: per-path floor, which would cap it there anyway. A refused lookup is refused
#: by Creek fail-closed, so the budget bounds load, never widens access.
STATUS_LOOKUP_RATE_LIMIT: Final = "60/minute"
_INVALID_STATUS_REQUEST: Final = "invalid_agent_token_status"
_NO_STORE: Final = {"Cache-Control": "no-store", "Pragma": "no-cache"}
# Published by hand because the body is read only after the bearer: a declared
# body parameter would be parsed -- and refused with a 422 -- before it.
_STATUS_REQUEST_BODY: Final = {
    "requestBody": {
        "required": True,
        "content": {
            "application/json": {"schema": AgentTokenStatusRequest.model_json_schema()},
        },
    }
}


@unique
class _FleetAlertKind(StrEnum):
    """The exact content-free vocabulary shared with Creek AlertKind.

    Creek's ``creek_mcp/provisioning/budget.py`` ``AlertKind`` is the source of
    truth; ``tests/test_vault_activation.py`` pins this enum to the same exact
    set Creek pins in its own tests (#3507). Widen it receiver-first: this enum
    and that pin together, deployed before any Creek build that sends the kind.
    """

    DUPLICATE_RESOURCE = "duplicate_resource"
    ORPHAN_RESOURCE = "orphan_resource"
    STUCK_DELETION = "stuck_deletion"
    CONTINUOUS_RUNNING = "continuous_running"
    INCOMPLETE_CREATE = "incomplete_create"
    MONTHLY_BUDGET_DEPARTURE = "monthly_budget_departure"
    # A pool credential outlived its activation: an orphaned per-activation
    # key, or (Creek #2037) a rolled-away key's revocation stuck past the
    # deletion bound. Sent today by Creek's fleet reconciler.
    POOL_CREDENTIAL_ORPHAN = "pool_credential_orphan"
    # The organization pool admin key (Creek #1930). Registered in Creek's
    # AlertKind but not yet emitted; Creek waits on this list before wiring it.
    POOL_ADMIN_KEY_UNUSABLE = "pool_admin_key_unusable"
    POOL_ADMIN_KEY_REJECTED = "pool_admin_key_rejected"
    POOL_ADMIN_KEY_NEAR_EXPIRY = "pool_admin_key_near_expiry"
    # Creek #1867: the Fly org token nears or passes its recorded expiry.
    PROVIDER_CREDENTIAL_EXPIRING = "provider_credential_expiring"
    # Creek #1866: the Fly Machines API refused the org token (401/403).
    PROVIDER_CREDENTIAL_REJECTED = "provider_credential_rejected"
    # Creek #2039 (#1896): the attesting Privatemode pool, seen from one vault.
    # Registered in Creek's AlertKind ahead of any delivery path.
    POOL_ATTESTATION_FAILED = "pool_attestation_failed"
    POOL_CREDENTIAL_REJECTED = "pool_credential_rejected"
    POOL_ADMISSION_REFUSED = "pool_admission_refused"
    POOL_VENDOR_RATE_LIMITED = "pool_vendor_rate_limited"
    POOL_QUOTA_EXHAUSTED = "pool_quota_exhausted"


#: What the operator should do about each kind: fixed copy, one line per kind,
#: never filled in from the payload, so the email stays as content-free as it.
_FLEET_ALERT_GUIDANCE: Final[dict[_FleetAlertKind, str]] = {
    _FleetAlertKind.CONTINUOUS_RUNNING: (
        "A vault Machine has run past the continuous-running limit. Reconcile"
        " stops it while its vault is live; otherwise stop it on the Fly console."
    ),
    _FleetAlertKind.DUPLICATE_RESOURCE: (
        "A vault owns more than one Machine, volume or live pool key. Find it in"
        " the fleet report and remove the leftover on the provider's console."
    ),
    _FleetAlertKind.INCOMPLETE_CREATE: (
        "A vault create failed and stayed failed after its one repair attempt."
        " Inspect its app and job in the fleet report before retrying it."
    ),
    _FleetAlertKind.MONTHLY_BUDGET_DEPARTURE: (
        "Estimated spend reached a budget line: the fleet's monthly Fly budget,"
        " or a vault's EUR 5 pool spend alert. Check it against the invoice,"
        " then adjust the budget or the fleet."
    ),
    _FleetAlertKind.ORPHAN_RESOURCE: (
        "A provider resource exists that no vault owns. Confirm it on the Fly"
        " console, then delete it there; Creek never deletes it."
    ),
    _FleetAlertKind.POOL_ADMIN_KEY_NEAR_EXPIRY: (
        "The pool admin key nears its recorded expiry. Install a replacement"
        " before it lapses, or no vault's pool key can be capped, renewed or"
        " revoked."
    ),
    _FleetAlertKind.POOL_ADMIN_KEY_REJECTED: (
        "The pool vendor refused the pool admin key. No vault's pool key can be"
        " capped, renewed or revoked until you install a working one."
    ),
    _FleetAlertKind.POOL_ADMIN_KEY_UNUSABLE: (
        "The control plane's pool admin key is missing, malformed, undated or"
        " expired. No vault's pool key can be capped, renewed or revoked until"
        " you install a valid one."
    ),
    _FleetAlertKind.POOL_ADMISSION_REFUSED: (
        "A vault refused pool calls over its own in-flight or hourly limit. A"
        " one-off is load; a steady count means that limit needs revisiting."
    ),
    _FleetAlertKind.POOL_ATTESTATION_FAILED: (
        "A vault could not verify the pool's attestation, so it sent nothing."
        " Check the pool proxy against its pinned measurement before trusting"
        " it again."
    ),
    _FleetAlertKind.POOL_CREDENTIAL_ORPHAN: (
        "A pool key outlived its vault, or a replaced key's revocation is stuck,"
        " and it can still spend up to its cap. Retry the revocation, or revoke"
        " the key in the vendor's portal."
    ),
    _FleetAlertKind.POOL_CREDENTIAL_REJECTED: (
        "The pool vendor refused a vault's pool key, so that vault's pool calls"
        " are refused. Replace the key."
    ),
    _FleetAlertKind.POOL_QUOTA_EXHAUSTED: (
        "A vault's pool key reached its monthly cost cap, so its pool calls are"
        " refused. Raise the cap or wait for the monthly reset."
    ),
    _FleetAlertKind.POOL_VENDOR_RATE_LIMITED: (
        "The pool vendor rate-limited a vault's calls. A one-off is load; a"
        " steady count means the pool needs more vendor capacity."
    ),
    _FleetAlertKind.PROVIDER_CREDENTIAL_EXPIRING: (
        "The Fly org token nears or has passed its recorded expiry, or none was"
        " recorded. Rotate it and record the new expiry."
    ),
    _FleetAlertKind.PROVIDER_CREDENTIAL_REJECTED: (
        "Fly refused the org token, so the pilot is degraded now. Replace the token."
    ),
    _FleetAlertKind.STUCK_DELETION: (
        "A vault deletion has gone unconfirmed past its bound. Reconcile retries"
        " a retryable failure; finish a non-retryable one on the Fly console."
    ),
}
_ALERT_EMAIL_FOOTER: Final = (
    "This alert carries kinds and counts only. The fleet report on Creek's"
    " control plane has the details, and Creek's runbooks have the full"
    " response for each kind."
)


class _FleetAlertPayload(BaseModel):
    """Counts-only fleet alert; subjects and resource coordinates cannot parse.

    All or nothing: one kind outside the closed vocabulary refuses the whole
    payload (#3507). Creek retries a payload as a unit and keeps it owed until
    a 204, so the known counts are re-sent, not lost, once the kind is admitted;
    a 204 for the known part would acknowledge the unknown kind and Creek would
    drop it. The cost, stated in ``docs/managed-vault-pilot.md``: while a kind
    is unknown here Creek keeps new activations closed.
    """

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
    # Creek hands over its route with ``/v1`` attached; storing the base keeps a
    # redelivery equal to the stored row and the client's paths single-prefixed.
    return payload.model_copy(update={"vault_url": vault_base_url(payload.vault_url)})


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
    """Render sorted kinds, counts and fixed guidance without any resource subject."""
    lines = ["Managed vault fleet alerts:", ""]
    for kind, count in sorted(payload.counts.items(), key=lambda item: item[0].value):
        lines.extend((f"{kind.value}: {count}", f"  {_FLEET_ALERT_GUIDANCE[kind]}", ""))
    lines.extend((_ALERT_EMAIL_FOOTER, ""))
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
    await lock_vault_connection_owner(session, activation.user_id)
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


async def _validated_status_request(
    request: Request,
    authorization: str | None,
) -> AgentTokenStatusRequest:
    """Parse the three-claim question after authenticating its bearer."""
    _authenticate_handoff(authorization)
    try:
        return AgentTokenStatusRequest.model_validate(await request.json())
    except (ValueError, ValidationError):
        raise bad_request(_INVALID_STATUS_REQUEST) from None


@router.post(
    "/agent-token-status",
    response_model=AgentTokenStatusResponse,
    openapi_extra=_STATUS_REQUEST_BODY,
)
@limiter.limit(STATUS_LOOKUP_RATE_LIMIT)
async def agent_token_status(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    authorization: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    """Say whether a verified agent token's grant still stands; every no is the same no."""
    payload = await _validated_status_request(request, authorization)
    active = await agent_token_active(
        session,
        AgentTokenClaims(
            subject=payload.sub,
            client_id=payload.client_id,
            issued_at=datetime.fromtimestamp(payload.iat, UTC),
        ),
        secret=session_signing_secret(),
        now=datetime.now(UTC),
    )
    body = AgentTokenStatusResponse(active=active)
    return JSONResponse(body.model_dump(), headers=_NO_STORE)
