"""Model for tracking which Start Here site resources a user has read."""

from datetime import UTC, datetime
from typing import Final

from sqlalchemy import Column, DateTime, UniqueConstraint
from sqlmodel import Field, SQLModel

#: Upper bound on a resource slug. Upstream slugs are short kebab-case names
#: ("energy-scaffolding"); the cap only stops an unbounded column.
RESOURCE_SLUG_MAX_LENGTH: Final[int] = 100


class ResourceCompletion(SQLModel, table=True):
    """Records that a user has read a site resource, keyed by its manifest slug.

    Site resources are not database rows -- the vendored manifest is their
    only home -- so a completion names the resource by ``slug`` rather than by
    a foreign key (issue #3148). A slug that later leaves the manifest simply
    stops counting; the read endpoints only ever join against the slugs the
    current pin ships. The ``(user_id, slug)`` unique constraint makes "read
    once per resource" a database invariant, as
    ``uq_contentcompletion_user_content`` does for chapters, so concurrent
    mark-read calls cannot double-insert.
    """

    __table_args__ = (UniqueConstraint("user_id", "slug", name="uq_resourcecompletion_user_slug"),)

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, ondelete="CASCADE")
    slug: str = Field(max_length=RESOURCE_SLUG_MAX_LENGTH)
    completed_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
