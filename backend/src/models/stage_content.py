from __future__ import annotations

from sqlmodel import Field, SQLModel


class StageContent(SQLModel, table=True):
    """
    Represents individual content entries (essays, prompts, etc.) tied to a course stage.
    Each item can be scheduled based on the number of days since the user began the stage.
    """

    id: int | None = Field(default=None, primary_key=True)
    course_stage_id: int = Field(foreign_key="coursestage.id")
    title: str
    content_type: str  # e.g., "essay", "prompt", "video"
    release_day: int
    url: str
