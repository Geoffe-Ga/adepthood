"""Stage-related response schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from domain.constants import TOTAL_STAGES as MAX_STAGE_NUMBER


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
    """Payload asserting the client's expected ``current_stage`` after advance.

    The router ignores this value as a write; it is only used as a
    server-vs-client sanity assertion.  ``extra='forbid'`` blocks the
    adjacent injection vector where a client attempts to set
    ``completed_stages`` directly in the same PUT body, which the server
    derives from its own state.
    """

    model_config = ConfigDict(extra="forbid")

    current_stage: int = Field(ge=1, le=MAX_STAGE_NUMBER)


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
