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
    request schema.

    .. warning::

       The auth gate alone does NOT close BUG-PRACTICE-010 in full.
       The planner is still steered by client-supplied
       ``energy_cost`` / ``energy_return`` values per habit, so an
       authenticated user can submit any habit id with arbitrary costs
       and influence the plan.  Loading those values server-side from
       ``Habit`` rows owned by ``current_user`` -- and rejecting any
       client-sent costs -- is the remaining piece.  It needs a
       ``services.energy`` refactor and is deliberately deferred to
       12B wave 2; the ``current_user`` parameter is plumbed in so the
       follow-up is purely additive.

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
