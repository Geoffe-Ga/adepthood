"""Course content response schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from schemas._base import OwnedResourcePublic


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


class ContentCompletionResponse(OwnedResourcePublic):
    """Response after marking content as read.

    ``user_id`` is intentionally excluded (BUG-T7): the completion is
    always created for ``current_user``, so echoing it back is redundant
    and aids enumeration.
    """

    id: int
    content_id: int
    completed_at: datetime


class ContentBodyResponse(BaseModel):
    """Raw Markdown body + metadata for native in-app rendering.

    Issue #393 replaced the legacy CMS proxy fields: ``body_html`` and
    the "Open original" ``url`` are gone; ``body_markdown`` is vendored
    Markdown served verbatim from local content (no server-side
    rendering), and ``content_type`` lets the reader pick a layout.  The
    frontend Markdown renderer lands in the follow-up issue (#394).
    ``title`` comes from the manifest; the client should prefer it over
    ``ContentItemResponse.title``, which is what the backend seeded.
    """

    title: str
    content_type: str
    body_markdown: str


class SiteResourceResponse(BaseModel):
    """One entry in the always-available "Site Resources" list."""

    slug: str
    title: str
    description: str
    url: str
