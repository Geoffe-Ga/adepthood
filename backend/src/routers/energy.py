"""Energy plan API endpoints — thin HTTP adapter over :mod:`services.energy`."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Header

from schemas import EnergyPlanRequest, EnergyPlanResponse
from services.energy import get_or_generate_plan

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/energy", tags=["energy"])


@router.post("/plan", response_model=EnergyPlanResponse)
async def create_plan(
    payload: EnergyPlanRequest, x_idempotency_key: str | None = Header(default=None)
) -> EnergyPlanResponse:
    """Create an energy plan from submitted habits.

    BUG-INFRA-009: ``generate_plan`` (called via :func:`get_or_generate_plan`)
    performs CPU-bound scheduling work.  Running it inline on the event loop
    would block every other request for the duration of the computation, so
    we offload to the default executor via :func:`asyncio.to_thread`.  The
    cache lookup itself is cheap and could run inline, but keeping the entire
    call off-loop keeps the contract simple — every request returns control
    to the loop while the worker thread runs.
    """
    response = await asyncio.to_thread(get_or_generate_plan, payload, x_idempotency_key)
    logger.info("energy_plan_created", extra={"reason_code": response.reason_code})
    return response
