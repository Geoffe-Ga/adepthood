"""Stage-related response schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class StageResponse(BaseModel):
    """Public representation of a CourseStage with user progress overlay."""

    id: int
    title: str
    subtitle: str
    stage_number: int
    overview_url: str
    category: str
    aspect: str
    spiral_dynamics_color: str
    growing_up_stage: str
    divine_gender_polarity: str
    relationship_to_free_will: str
    free_will_description: str
    is_unlocked: bool = False
    progress: float = 0.0


class StageProgressResponse(BaseModel):
    """Detailed progress breakdown for a single stage."""

    habits_progress: float = 0.0
    practice_sessions_completed: int = 0
    course_items_completed: int = 0
    overall_progress: float = 0.0


class StageProgressUpdate(BaseModel):
    """Payload for updating current stage."""

    current_stage: int


class StageProgressRecord(BaseModel):
    """Response after updating stage progress."""

    id: int
    user_id: int
    current_stage: int
    completed_stages: list[int]


class PracticeHistoryItem(BaseModel):
    """A practice's aggregated history within a stage."""

    name: str
    sessions_completed: int
    total_minutes: float
    last_session: datetime | None


class HabitHistoryItem(BaseModel):
    """A habit's aggregated history within a stage."""

    name: str
    icon: str
    goals_achieved: dict[str, bool]
    best_streak: int
    total_completions: int


class StageHistoryResponse(BaseModel):
    """Aggregated history of practices and habits for a stage."""

    stage_number: int
    practices: list[PracticeHistoryItem]
    habits: list[HabitHistoryItem]
