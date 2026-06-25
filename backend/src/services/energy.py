"""Energy-plan generation service with idempotency caching.

The router layer is a thin HTTP adapter: it accepts a request, resolves the
caller's trusted habit costs server-side via :func:`resolve_trusted_habits`,
then hands those to :func:`get_or_generate_plan` and returns the response. The
idempotency cache lives here (not in the router) so background regeneration
jobs, admin tools, and tests can share the same de-duplication semantics
without reaching into route handlers.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import date

from cachetools import TTLCache
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.energy import Habit as DomainHabit
from domain.energy import generate_plan
from errors import forbidden, not_found
from models.habit import Habit
from schemas import EnergyPlan, EnergyPlanRequest, EnergyPlanResponse

logger = logging.getLogger(__name__)

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


async def _load_owned_habits(
    session: AsyncSession, user_id: int, requested_ids: list[int]
) -> dict[int, Habit]:
    """Fetch the caller's Habit rows for ``requested_ids``, keyed by id."""
    result = await session.execute(
        select(Habit).where(col(Habit.id).in_(requested_ids), Habit.user_id == user_id)
    )
    return {habit.id: habit for habit in result.scalars().all() if habit.id is not None}


async def _ensure_all_owned(
    session: AsyncSession, requested_ids: list[int], owned: dict[int, Habit]
) -> None:
    """Raise 403/404 if any requested id is not owned by the caller.

    403 ``habit_not_owned`` when the id exists for another user, else 404
    ``habit`` — the 404→403 split from ``dependencies.ownership``.
    """
    missing = [habit_id for habit_id in requested_ids if habit_id not in owned]
    if not missing:
        return
    existing = await session.execute(select(Habit.id).where(col(Habit.id).in_(missing)))
    if set(existing.scalars().all()):
        raise forbidden("habit_not_owned")
    raise not_found("habit")


def _build_domain_habits(payload: EnergyPlanRequest, owned: dict[int, Habit]) -> list[DomainHabit]:
    """Build the domain habit list from stored costs, in request order."""
    return [
        DomainHabit(
            id=requested.id,
            name=owned[requested.id].name,
            energy_cost=owned[requested.id].energy_cost,
            energy_return=owned[requested.id].energy_return,
        )
        for requested in payload.habits
    ]


async def resolve_trusted_habits(
    session: AsyncSession, user_id: int, payload: EnergyPlanRequest
) -> list[DomainHabit]:
    """Build the planner's habit list from the caller's own stored Habit rows.

    Closes the remainder of BUG-PRACTICE-010: ``energy_cost`` / ``energy_return``
    come solely from ``Habit`` rows owned by ``user_id``; any costs in the
    request payload are ignored. A requested id the caller does not own raises
    403/404. An empty request resolves to ``[]`` and the empty-plan 400 is
    raised downstream.
    """
    requested_ids = [habit.id for habit in payload.habits]
    if not requested_ids:
        return []
    owned = await _load_owned_habits(session, user_id, requested_ids)
    await _ensure_all_owned(session, requested_ids, owned)
    return _build_domain_habits(payload, owned)


def build_energy_response(habits: list[DomainHabit], start_date: date) -> EnergyPlanResponse:
    """Generate an energy plan from already-resolved (trusted) habits.

    ``domain.energy.generate_plan`` raises ``ValueError`` for empty habit
    lists; we translate that to a 400 so the HTTP surface is stable.  The
    reason code is logged for audit — it never changes the response body.
    """
    try:
        plan, reason = generate_plan(habits, start_date)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc).replace(" ", "_"),
        ) from exc
    plan_model = EnergyPlan.model_validate(asdict(plan))
    response = EnergyPlanResponse(plan=plan_model, reason_code=reason)
    logger.info("energy_plan", extra={"reason_code": reason})
    return response


def get_or_generate_plan(
    habits: list[DomainHabit], start_date: date, idempotency_key: str | None
) -> EnergyPlanResponse:
    """Return a cached plan for ``idempotency_key`` or compute and cache a new one.

    Callers that do not pass a key always get a freshly-generated plan and
    nothing is cached.  When a key is supplied the cached response is used
    verbatim — including the ``reason_code`` — so clients retrying a failed
    request never see a different outcome for the same request ID.
    """
    if idempotency_key and idempotency_key in idempotency_cache:
        return idempotency_cache[idempotency_key]

    response = build_energy_response(habits, start_date)

    if idempotency_key:
        idempotency_cache[idempotency_key] = response

    return response
