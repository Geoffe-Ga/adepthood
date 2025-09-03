from __future__ import annotations

from sqlmodel import Field, SQLModel


class CourseStage(SQLModel, table=True):
    """
    Represents a single educational stage in the APTITUDE course.
    Includes metadata used for organizing curriculum content, contextually
    relevant theory (e.g., Spiral Dynamics color, developmental stage, etc.),
    and aesthetic display.
    """

    id: int | None = Field(default=None, primary_key=True)
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
