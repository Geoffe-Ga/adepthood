"""UI-flag schemas for per-user one-time interface state."""

from __future__ import annotations

from pydantic import BaseModel

from schemas.partial_update import PartialUpdateModel


class UiFlagsResponse(BaseModel):
    """The two UI flags returned to the caller.

    ``user_id`` is intentionally excluded — the caller already knows its own
    identity from the JWT, and surfacing surrogate keys aids enumeration.
    """

    has_seen_welcome: bool
    energy_scaffolding_archived: bool


class UiFlagsUpdate(PartialUpdateModel):
    """Partial update for the UI flags (PATCH).

    Every field is a plain boolean defaulting to its column's own default, so an
    explicit ``null`` is refused by the annotation at a ``loc`` naming the flag
    rather than reaching a NOT NULL column. Only the fields the caller sets are
    applied -- unspecified flags keep their stored value, because the router
    dumps with ``exclude_unset=True`` and no default here is ever written on its
    own. An empty payload is rejected (422) by
    :class:`~schemas.partial_update.PartialUpdateModel`.
    """

    has_seen_welcome: bool = False
    energy_scaffolding_archived: bool = False
