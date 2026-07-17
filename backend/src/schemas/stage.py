"""Stage-related response schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from domain.constants import TOTAL_STAGES as MAX_STAGE_NUMBER


class StageExpression(BaseModel):
    """One integrated or shadow expression of a Wavelength phase."""

    name: str
    description: str


class StageManifestation(BaseModel):
    """How a stage manifests in one phase, as an integrated/shadow pair."""

    phase: str
    integrated: StageExpression
    shadow: StageExpression


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
    manifestations: list[StageManifestation] = Field(default_factory=list)


class ProgramCalendarResponse(BaseModel):
    """The server's date-derived program calendar (issue #386).

    Exposes the anchor and both gating views so the frontend can drop its
    client-only fallback if desired: ``calendar_stage``/``calendar_week``
    are derived from ``program_started_at`` against the shared
    ``STAGE_DURATIONS_DAYS`` schedule; ``current_stage`` is the
    advancement-chain value.  Effective unlock is the max of the two —
    the same reconciliation the gating endpoints apply.  ``cycle_number``
    is exposed so the frontend can seed its "Cycle N" indicator on cold start.
    """

    program_started_at: datetime | None
    calendar_stage: int
    calendar_week: int
    current_stage: int
    cycle_number: int = Field(default=1, ge=1)


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
    cycle_number: int = Field(default=1, ge=1)


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
