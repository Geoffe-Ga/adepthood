"""Pydantic models for energy planning."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

# Bounds matching ``schemas.habit.HabitCreate`` so the energy planner
# accepts the same range the rest of the app already validates against
# (BUG-SCHEMA-007).  ``id`` and ``name`` are user-controlled too —
# ``id`` is positive and ``name`` capped to a sane length so a payload
# with a 5MB string can't tie up the planner thread.
ENERGY_VALUE_MIN = 0
ENERGY_VALUE_MAX = 1_000
HABIT_NAME_MAX_LENGTH = 255
MAX_HABITS_PER_PLAN = 100


class Habit(BaseModel):
    id: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=HABIT_NAME_MAX_LENGTH)
    energy_cost: int = Field(ge=ENERGY_VALUE_MIN, le=ENERGY_VALUE_MAX)
    energy_return: int = Field(ge=ENERGY_VALUE_MIN, le=ENERGY_VALUE_MAX)


class EnergyPlanItem(BaseModel):
    habit_id: int
    date: date


class EnergyPlan(BaseModel):
    items: list[EnergyPlanItem]
    net_energy: int


class EnergyPlanRequest(BaseModel):
    habits: list[Habit] = Field(max_length=MAX_HABITS_PER_PLAN)
    start_date: date


class EnergyPlanResponse(BaseModel):
    plan: EnergyPlan
    reason_code: str
