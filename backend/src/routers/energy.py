"""Energy plan API endpoints."""

from __future__ import annotations

import logging
from dataclasses import asdict

from cachetools import TTLCache
from fastapi import APIRouter, Header

from domain.energy import Habit as DomainHabit
from domain.energy import generate_plan
from schemas import EnergyPlan, EnergyPlanRequest, EnergyPlanResponse

router = APIRouter(prefix="/v1/energy", tags=["energy"])

# TTL-bounded idempotency cache: max 1000 entries, 1 hour TTL
_idempotency_cache: TTLCache[str, EnergyPlanResponse] = TTLCache(maxsize=1000, ttl=3600)


@router.post("/plan", response_model=EnergyPlanResponse)
def create_plan(
    payload: EnergyPlanRequest, x_idempotency_key: str | None = Header(default=None)
) -> EnergyPlanResponse:
    """Create an energy plan from submitted habits."""

    if x_idempotency_key and x_idempotency_key in _idempotency_cache:
        return _idempotency_cache[x_idempotency_key]

    habits = [DomainHabit(**h.model_dump()) for h in payload.habits]
    plan, reason = generate_plan(habits, payload.start_date)
    plan_model = EnergyPlan.model_validate(asdict(plan))
    response = EnergyPlanResponse(plan=plan_model, reason_code=reason)
    logging.info("energy_plan", extra={"reason_code": reason})

    if x_idempotency_key:
        _idempotency_cache[x_idempotency_key] = response

    return response
