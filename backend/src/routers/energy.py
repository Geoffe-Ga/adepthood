"""Energy plan API endpoints — thin HTTP adapter over :mod:`services.energy`."""

from __future__ import annotations

from fastapi import APIRouter, Header

from schemas import EnergyPlanRequest, EnergyPlanResponse
from services.energy import get_or_generate_plan

router = APIRouter(prefix="/v1/energy", tags=["energy"])


@router.post("/plan", response_model=EnergyPlanResponse)
def create_plan(
    payload: EnergyPlanRequest, x_idempotency_key: str | None = Header(default=None)
) -> EnergyPlanResponse:
    """Create an energy plan from submitted habits."""
    return get_or_generate_plan(payload, x_idempotency_key)
