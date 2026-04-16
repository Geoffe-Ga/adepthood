"""Pydantic schemas for API models."""

from schemas.checkin import CheckInRequest, CheckInResult
from schemas.energy import (
    EnergyPlan,
    EnergyPlanItem,
    EnergyPlanRequest,
    EnergyPlanResponse,
)
from schemas.energy import Habit as EnergyHabit
from schemas.goal import Goal
from schemas.habit import Habit, HabitWithGoals
from schemas.habit_stats import HabitStats
from schemas.milestone import Milestone
from schemas.pagination import (
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    Page,
    PaginationParams,
    build_page,
)
from schemas.practice import PracticeSessionCreate, PracticeSessionResponse

__all__ = [
    "DEFAULT_PAGE_SIZE",
    "MAX_PAGE_SIZE",
    "CheckInRequest",
    "CheckInResult",
    "EnergyHabit",
    "EnergyPlan",
    "EnergyPlanItem",
    "EnergyPlanRequest",
    "EnergyPlanResponse",
    "Goal",
    "Habit",
    "HabitStats",
    "HabitWithGoals",
    "Milestone",
    "Page",
    "PaginationParams",
    "PracticeSessionCreate",
    "PracticeSessionResponse",
    "build_page",
]
