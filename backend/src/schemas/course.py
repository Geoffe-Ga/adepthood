"""Course content response schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class ContentItemResponse(BaseModel):
    """A single course content item with drip-feed and read status."""

    id: int
    title: str
    content_type: str
    release_day: int
    url: str | None
    is_locked: bool
    is_read: bool


class CourseProgressResponse(BaseModel):
    """Aggregate read-progress for a stage's content."""

    total_items: int
    read_items: int
    progress_percent: float
    next_unlock_day: int | None


class ContentCompletionResponse(BaseModel):
    """Response after marking content as read."""

    id: int
    user_id: int
    content_id: int
    completed_at: datetime
