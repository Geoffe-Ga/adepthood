"""Model for tracking which content items a user has read."""

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, UniqueConstraint
from sqlmodel import Field, SQLModel


class ContentCompletion(SQLModel, table=True):
    """Records that a user has read a specific content item.

    The ``(user_id, content_id)`` unique constraint enforces "read once
    per content" at the database level (BUG-COURSE-002).  Without it the
    application-level pre-check in ``mark_content_read`` was racy: two
    concurrent calls could both pass the existence check and both
    insert, leaving the row count out of step with the user-visible
    "read" toggle.
    """

    __table_args__ = (
        UniqueConstraint("user_id", "content_id", name="uq_contentcompletion_user_content"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    content_id: int = Field(foreign_key="stagecontent.id", index=True)
    completed_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
