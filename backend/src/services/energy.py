"""Energy-plan generation service with durable, cross-worker persistence.

The router layer is a thin HTTP adapter: it resolves the caller's trusted habit
costs server-side via :func:`resolve_trusted_habits`, then hands those to
:func:`get_or_create_persisted_plan`, which generates the plan (CPU-bound work
off-loaded to a thread) and stores it in the ``energyplan`` table. A keyed
retry returns the stored plan verbatim — across process restarts and workers —
instead of regenerating (the per-process ``TTLCache`` this replaces could not).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict
from datetime import date

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.energy import Habit as DomainHabit
from domain.energy import generate_plan
from errors import forbidden, not_found
from models.energy_plan import EnergyPlan as EnergyPlanRecord
from models.habit import Habit
from schemas import EnergyPlan, EnergyPlanRequest, EnergyPlanResponse

logger = logging.getLogger(__name__)


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


def _row_to_response(row: EnergyPlanRecord) -> EnergyPlanResponse:
    """Rebuild the response from a stored row (reverse of :func:`_persist`)."""
    return EnergyPlanResponse(
        plan=EnergyPlan.model_validate_json(row.plan_json),
        reason_code=row.reason_code,
    )


async def _load_persisted_plan(
    session: AsyncSession, user_id: int, idempotency_key: str
) -> EnergyPlanResponse | None:
    """Return the stored plan for ``(user_id, idempotency_key)`` if one exists."""
    result = await session.execute(
        select(EnergyPlanRecord).where(
            EnergyPlanRecord.user_id == user_id,
            EnergyPlanRecord.idempotency_key == idempotency_key,
        )
    )
    row = result.scalars().first()
    return _row_to_response(row) if row is not None else None


async def _persist(
    session: AsyncSession, user_id: int, idempotency_key: str | None, response: EnergyPlanResponse
) -> EnergyPlanResponse:
    """Store ``response`` and return it; on a keyed race, return the stored row.

    Unkeyed requests (``idempotency_key is None``) each get their own row — the
    partial UNIQUE index only constrains non-NULL keys. A concurrent insert for
    the same ``(user_id, key)`` raises ``IntegrityError``; we roll back and read
    the winner's row so both callers see the same plan.
    """
    row = EnergyPlanRecord(
        user_id=user_id,
        idempotency_key=idempotency_key,
        plan_json=response.plan.model_dump_json(),
        reason_code=response.reason_code,
    )
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        if idempotency_key is not None:
            existing = await _load_persisted_plan(session, user_id, idempotency_key)
            if existing is not None:
                return existing
        raise
    return response


async def get_or_create_persisted_plan(
    session: AsyncSession,
    user_id: int,
    habits: list[DomainHabit],
    start_date: date,
    idempotency_key: str | None,
) -> EnergyPlanResponse:
    """Return the caller's stored plan for ``idempotency_key`` or generate + store one.

    A keyed request first reads the persisted ``EnergyPlan`` row; on a hit it is
    replayed verbatim (cross-restart / cross-worker). On a miss — or for an
    unkeyed request — the plan is generated (CPU-bound work off-loaded via
    :func:`asyncio.to_thread` per BUG-INFRA-009) and persisted before returning.
    """
    if idempotency_key is not None:
        existing = await _load_persisted_plan(session, user_id, idempotency_key)
        if existing is not None:
            return existing
    response = await asyncio.to_thread(build_energy_response, habits, start_date)
    return await _persist(session, user_id, idempotency_key, response)
