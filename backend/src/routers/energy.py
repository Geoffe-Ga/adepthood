"""Energy plan API endpoints — thin HTTP adapter over :mod:`services.energy`."""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Header

from routers.auth import get_current_user
from schemas import EnergyPlanRequest, EnergyPlanResponse
from services.energy import get_or_generate_plan

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/energy", tags=["energy"])


@router.post("/plan", response_model=EnergyPlanResponse)
async def create_plan(
    payload: EnergyPlanRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    x_idempotency_key: Annotated[str | None, Header()] = None,
) -> EnergyPlanResponse:
    """Create an energy plan from submitted habits.

    Auth is required (BUG-PRACTICE-010): the planner runs CPU-bound
    scheduling work on a thread pool, so an unauthenticated endpoint
    would let a single attacker spawn arbitrary expensive work for free.
    Habit list size is already capped at ``MAX_HABITS_PER_PLAN`` in the
    request schema; loading per-habit ``energy_cost`` / ``energy_return``
    server-side from ``Habit.user_id == current_user`` -- so the planner
    is not steered by client-supplied costs -- is a deliberate follow-up
    that touches :mod:`services.energy` and is tracked separately to
    keep this PR scoped to the auth gate.

    BUG-INFRA-009: ``generate_plan`` (called via :func:`get_or_generate_plan`)
    performs CPU-bound scheduling work.  Running it inline on the event loop
    would block every other request for the duration of the computation, so
    we offload to the default executor via :func:`asyncio.to_thread`.  The
    cache lookup itself is cheap and could run inline, but keeping the entire
    call off-loop keeps the contract simple — every request returns control
    to the loop while the worker thread runs.
    """
    response = await asyncio.to_thread(get_or_generate_plan, payload, x_idempotency_key)
    logger.info(
        "energy_plan_created",
        extra={"user_id": current_user, "reason_code": response.reason_code},
    )
    return response
