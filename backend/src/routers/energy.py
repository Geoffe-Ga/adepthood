"""Energy plan API endpoints."""

from __future__ import annotations

import logging
from dataclasses import asdict

from cachetools import TTLCache
from fastapi import APIRouter, Header

from domain.energy import Habit as DomainHabit
from domain.energy import generate_plan
from errors import bad_request
from schemas import EnergyPlan, EnergyPlanRequest, EnergyPlanResponse

router = APIRouter(prefix="/v1/energy", tags=["energy"])

# Idempotency cache prevents duplicate plan generation within the same session.
# - maxsize=1000: supports ~1000 concurrent users before eviction (LRU).
# - ttl=3600 (1 hour): matches _TOKEN_TTL in auth.py so cached plans expire
#   alongside the JWT that initiated them.
_CACHE_MAX_ENTRIES = 1000
_CACHE_TTL_SECONDS = 3600
_idempotency_cache: TTLCache[str, EnergyPlanResponse] = TTLCache(
    maxsize=_CACHE_MAX_ENTRIES, ttl=_CACHE_TTL_SECONDS
)


def _build_energy_response(payload: EnergyPlanRequest) -> EnergyPlanResponse:
    """Generate an energy plan from the request payload."""
    habits = [DomainHabit(**h.model_dump()) for h in payload.habits]
    try:
        plan, reason = generate_plan(habits, payload.start_date)
    except ValueError as exc:
        raise bad_request(str(exc).replace(" ", "_")) from exc
    plan_model = EnergyPlan.model_validate(asdict(plan))
    response = EnergyPlanResponse(plan=plan_model, reason_code=reason)
    logging.info("energy_plan", extra={"reason_code": reason})
    return response


@router.post("/plan", response_model=EnergyPlanResponse)
def create_plan(
    payload: EnergyPlanRequest, x_idempotency_key: str | None = Header(default=None)
) -> EnergyPlanResponse:
    """Create an energy plan from submitted habits."""
    if x_idempotency_key and x_idempotency_key in _idempotency_cache:
        return _idempotency_cache[x_idempotency_key]

    response = _build_energy_response(payload)

    if x_idempotency_key:
        _idempotency_cache[x_idempotency_key] = response

    return response
