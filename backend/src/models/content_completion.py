"""Model for tracking which content items a user has read."""

from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


class ContentCompletion(SQLModel, table=True):
    """Records that a user has read a specific content item."""

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    content_id: int = Field(foreign_key="stagecontent.id", index=True)
    completed_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
