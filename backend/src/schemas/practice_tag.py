"""Wire DTOs for the personal-tag library endpoints.

Five routes around :class:`models.practice_tag.PracticeTag`:

* ``GET /practice-tags`` -- list system tags + the caller's personal tags.
* ``POST /practice-tags`` -- create a personal tag.
* ``GET /practice-tags/{tag_id}`` -- read one (system or personal).
* ``PATCH /practice-tags/{tag_id}`` -- rename a personal tag.
* ``DELETE /practice-tags/{tag_id}`` -- delete a personal tag.

System tags (``owner_user_id IS NULL``) are read-only and the router
rejects mutation attempts with ``403 cannot_modify_system_tag``.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# Mirror ``schemas.practice_mode_config._TALLIED_KEY_*`` so the recipe
# step layer (which copies a tag's slug by value) cannot accept a slug
# the tag layer rejected.  Drift would surface as a 500 at apply
# time; the shared constants keep validation symmetric.
TAG_SLUG_MAX = 64
TAG_SLUG_PATTERN = r"^[a-z][a-z0-9_]*$"
TAG_LABEL_MAX = 255


class PracticeTagOut(BaseModel):
    """List / read response for one tag row."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    label: str
    owner_user_id: int | None
    created_at: datetime


class PracticeTagCreate(BaseModel):
    """Body accepted by ``POST /practice-tags``.

    The router always sets ``owner_user_id`` from the JWT subject, so
    the body never carries it.  Clients cannot create a system tag.
    """

    slug: str = Field(min_length=1, max_length=TAG_SLUG_MAX, pattern=TAG_SLUG_PATTERN)
    label: str = Field(min_length=1, max_length=TAG_LABEL_MAX)


class PracticeTagUpdate(BaseModel):
    """Body accepted by ``PATCH /practice-tags/{tag_id}``.

    ``slug`` is immutable post-create: recipe steps copy the slug by
    value at build time and a rename here would leave them pointing at
    a stale machine identifier.  Only the display ``label`` is patchable.
    """

    label: str = Field(min_length=1, max_length=TAG_LABEL_MAX)
