"""Energy plan API endpoints — thin HTTP adapter over :mod:`services.energy`."""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from routers.auth import get_current_user
from schemas import EnergyPlanRequest, EnergyPlanResponse
from services.energy import get_or_generate_plan, resolve_trusted_habits

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/energy", tags=["energy"])


@router.post("/plan", response_model=EnergyPlanResponse)
async def create_plan(
    payload: EnergyPlanRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    x_idempotency_key: Annotated[str | None, Header()] = None,
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

    BUG-INFRA-009: ``generate_plan`` performs CPU-bound scheduling work, so it
    is offloaded via :func:`asyncio.to_thread`; the (async) habit lookup runs
    on the event loop first, then the CPU work runs off-loop.
    """
    trusted = await resolve_trusted_habits(session, current_user, payload)
    response = await asyncio.to_thread(
        get_or_generate_plan, trusted, payload.start_date, x_idempotency_key
    )
    logger.info(
        "energy_plan_created",
        extra={"user_id": current_user, "reason_code": response.reason_code},
    )
    return response
