"""Energy plan API endpoints — thin HTTP adapter over :mod:`services.energy`."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from models.energy_plan import IDEM_KEY_MAX_LENGTH
from routers.auth import get_current_user
from schemas import EnergyPlanRequest, EnergyPlanResponse
from services.energy import get_or_create_persisted_plan, resolve_trusted_habits

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/energy", tags=["energy"])


@router.post("/plan", response_model=EnergyPlanResponse)
async def create_plan(
    payload: EnergyPlanRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    x_idempotency_key: Annotated[str | None, Header(max_length=IDEM_KEY_MAX_LENGTH)] = None,
) -> EnergyPlanResponse:
    """Create an energy plan from the caller's own habits.

    Auth is required (BUG-PRACTICE-010): the planner runs CPU-bound
    scheduling work on a thread pool, so an unauthenticated endpoint would let
    a single attacker spawn arbitrary expensive work for free. Habit list size
    is capped at ``MAX_HABITS_PER_PLAN`` in the request schema.

    ``energy_cost`` / ``energy_return`` are loaded server-side from ``Habit``
    rows owned by ``current_user`` (``resolve_trusted_habits``); client-sent
    costs are ignored and a habit the caller does not own returns 403/404. This
    closes the remainder of BUG-PRACTICE-010 — the plan can no longer be
    steered by forged client values.

    The generated plan is persisted to the ``energyplan`` table keyed by
    ``(current_user, X-Idempotency-Key)``, so a keyed retry replays the stored
    plan across restarts and workers. ``generate_plan`` is CPU-bound and runs
    off the event loop (BUG-INFRA-009); see ``get_or_create_persisted_plan``.
    """
    trusted = await resolve_trusted_habits(session, current_user, payload)
    response = await get_or_create_persisted_plan(
        session, current_user, trusted, payload.start_date, x_idempotency_key
    )
    logger.info(
        "energy_plan_created",
        extra={"user_id": current_user, "reason_code": response.reason_code},
    )
    return response
