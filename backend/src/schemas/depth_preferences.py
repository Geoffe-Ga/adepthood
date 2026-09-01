"""Depth-preference schemas for the optional program rings."""

from __future__ import annotations

from pydantic import BaseModel

from schemas.partial_update import PartialUpdateModel


class DepthPreferencesResponse(BaseModel):
    """The four ring toggles returned to the caller.

    ``user_id`` is intentionally excluded — the caller already knows its own
    identity from the JWT, and surfacing surrogate keys aids enumeration.
    """

    enable_habits: bool
    enable_practices: bool
    enable_course: bool
    enable_sangha: bool


class DepthPreferencesUpdate(PartialUpdateModel):
    """Partial update for the ring toggles (PATCH).

    Every field is a plain boolean defaulting to its column's own default, so an
    explicit ``null`` is refused by the annotation at a ``loc`` naming the ring
    rather than reaching a NOT NULL column. Only the fields the caller sets are
    applied -- unspecified rings keep their stored value, because the router
    dumps with ``exclude_unset=True`` and no default here is ever written on its
    own. An empty payload is rejected (422) by
    :class:`~schemas.partial_update.PartialUpdateModel`.
    """

    enable_habits: bool = True
    enable_practices: bool = True
    enable_course: bool = True
    enable_sangha: bool = True
