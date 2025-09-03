"""Pydantic models for energy planning."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel


class Habit(BaseModel):
    id: int
    name: str
    energy: int


class EnergyPlanItem(BaseModel):
    habit_id: int
    date: date


class EnergyPlan(BaseModel):
    items: list[EnergyPlanItem]
    net_energy: int


class EnergyPlanRequest(BaseModel):
    habits: list[Habit]
    start_date: date


class EnergyPlanResponse(BaseModel):
    plan: EnergyPlan
    reason_code: str
