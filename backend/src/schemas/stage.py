"""Stage-related response schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


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


class StageCorrespondenceProvenance(BaseModel):
    """Which stage-correspondence artifact a Stage row was last reconciled from.

    Every field is ``None`` until the stage seeder has reconciled the row
    (for instance straight after the migration, if seeding failed), so the
    list never 500s on an unreconciled row.
    """

    source_repo: str | None = Field(description="Upstream repository, as ``owner/name``.")
    source_sha: str | None = Field(
        description="Upstream commit the artifact was generated from (the content pin)."
    )
    source_path: str | None = Field(description="Path of the source CSV in that commit.")
    source_sha256: str | None = Field(description="Hex sha256 of the source CSV's bytes.")
    schema_version: str | None = Field(description="The artifact's shape version.")
    reconciled_at: datetime | None = Field(
        description="When the seeder last inserted or changed this row."
    )


class StageCorrespondenceResponse(BaseModel):
    """One Stage's canonical correspondences, keyed by its stable colour slug (#2665).

    Global reference data: the same for every user, with no progress overlay.
    """

    stage_key: str = Field(description="Stable colour-slug id, e.g. ``beige`` .. ``clearlight``.")
    stage_number: int = Field(description="The Stage's 1-based position in the program.")
    start_week: int = Field(description="Program week the Stage opens on.")
    category: str = Field(description="Wheel category the Stage belongs to.")
    aspect: str = Field(description="Aspect of that category the Stage develops.")
    spiral_dynamics_color: str = Field(description="Spiral Dynamics colour of the Stage.")
    growing_up_stage: str = Field(description="Developmental (Growing Up) stage name.")
    divine_gender_polarity: str = Field(description="Divine gender polarity of the Stage.")
    relationship_to_free_will: str = Field(description="Archetype of free will at this Stage.")
    free_will_description: str = Field(description="Prose describing that relationship.")
    provenance: StageCorrespondenceProvenance = Field(
        description="Source of these values; fields are null until the row is reconciled."
    )


class ProgramCalendarResponse(BaseModel):
    """The server's date-derived program calendar.

    Exposes the anchor and both answers so the frontend can drop its
    client-only fallback if desired: ``calendar_stage``/``calendar_week``
    are derived from ``program_started_at`` against the shared
    ``STAGE_DURATIONS_DAYS`` schedule and pace what the program *offers*;
    ``current_stage`` is the record of what the user has *entered*, which
    the endpoint brings up to the calendar before answering. Effective
    unlock is ``domain.stage_authority.open_through`` — the union of the
    two, never the record alone. ``cycle_number`` is exposed so the
    frontend can seed its "Cycle N" indicator on cold start.
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
