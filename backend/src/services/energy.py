"""Energy-plan generation service with idempotency caching.

The router layer is a thin HTTP adapter: it accepts a request, hands the
payload to :func:`get_or_generate_plan`, and returns the response.  The
idempotency cache lives here (not in the router) so background regeneration
jobs, admin tools, and tests can share the same de-duplication semantics
without reaching into route handlers.
"""

from __future__ import annotations

import logging
from dataclasses import asdict

from cachetools import TTLCache
from fastapi import HTTPException, status

from domain.energy import Habit as DomainHabit
from domain.energy import generate_plan
from schemas import EnergyPlan, EnergyPlanRequest, EnergyPlanResponse

# Idempotency cache prevents duplicate plan generation within the same session.
# - ``CACHE_MAX_ENTRIES = 1000`` supports ~1000 concurrent users before LRU
#   eviction starts.
# - ``CACHE_TTL_SECONDS = 3600`` (1 hour) matches ``_TOKEN_TTL`` in ``auth.py``
#   so cached plans expire alongside the JWT that initiated them.
CACHE_MAX_ENTRIES = 1000
CACHE_TTL_SECONDS = 3600

idempotency_cache: TTLCache[str, EnergyPlanResponse] = TTLCache(
    maxsize=CACHE_MAX_ENTRIES, ttl=CACHE_TTL_SECONDS
)


def build_energy_response(payload: EnergyPlanRequest) -> EnergyPlanResponse:
    """Generate an energy plan from the request payload.

    ``domain.energy.generate_plan`` raises ``ValueError`` for empty habit
    lists; we translate that to a 400 so the HTTP surface is stable.  The
    reason code is logged for audit — it never changes the response body.
    """
    habits = [DomainHabit(**h.model_dump()) for h in payload.habits]
    try:
        plan, reason = generate_plan(habits, payload.start_date)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc).replace(" ", "_"),
        ) from exc
    plan_model = EnergyPlan.model_validate(asdict(plan))
    response = EnergyPlanResponse(plan=plan_model, reason_code=reason)
    logging.info("energy_plan", extra={"reason_code": reason})
    return response


def get_or_generate_plan(
    payload: EnergyPlanRequest, idempotency_key: str | None
) -> EnergyPlanResponse:
    """Return a cached plan for ``idempotency_key`` or compute and cache a new one.

    Callers that do not pass a key always get a freshly-generated plan and
    nothing is cached.  When a key is supplied the cached response is used
    verbatim — including the ``reason_code`` — so clients retrying a failed
    request never see a different outcome for the same request ID.
    """
    if idempotency_key and idempotency_key in idempotency_cache:
        return idempotency_cache[idempotency_key]

    response = build_energy_response(payload)

    if idempotency_key:
        idempotency_cache[idempotency_key] = response

    return response
