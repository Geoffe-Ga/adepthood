from sqlmodel import Field, SQLModel


class Practice(SQLModel, table=True):
    """Defines a single practice users can perform."""

    id: int | None = Field(default=None, primary_key=True)
    stage_number: int
    name: str = Field(max_length=255)
    description: str = Field(max_length=2_000)
    instructions: str = Field(max_length=10_000)
    default_duration_minutes: float
    submitted_by_user_id: int | None = Field(
        default=None, foreign_key="user.id", ondelete="SET NULL"
    )
    approved: bool = True
