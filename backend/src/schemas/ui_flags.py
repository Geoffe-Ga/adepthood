"""UI-flag schemas for per-user one-time interface state."""

from __future__ import annotations

from pydantic import BaseModel

from bounds import RowIdField
from schemas.partial_update import PartialUpdateModel


class UiFlagsResponse(BaseModel):
    """The caller's UI flags, plus the habit their writing timer checks off.

    ``user_id`` is intentionally excluded — the caller already knows its own
    identity from the JWT, and surfacing surrogate keys aids enumeration.
    ``writing_session_habit_id`` is ``None`` until the writer links a habit, and
    again after they clear the link or delete that habit.
    """

    has_seen_welcome: bool
    energy_scaffolding_archived: bool
    writing_session_habit_id: int | None


class UiFlagsUpdate(PartialUpdateModel):
    """Partial update for the UI flags (PATCH).

    The two booleans are plain, non-nullable fields defaulting to their
    column's own default, so an explicit ``null`` is refused by the annotation
    at a ``loc`` naming the flag rather than reaching a NOT NULL column. Only
    the fields the caller sets are applied -- unspecified flags keep their
    stored value, because the domain dumps with ``exclude_unset=True`` and no
    default here is ever written on its own. An empty payload is rejected (422)
    by :class:`~schemas.partial_update.PartialUpdateModel`.

    ``writing_session_habit_id`` is the one deliberate exception to that
    base's non-null doctrine. Its column *is* nullable -- "no habit linked" is
    a real state -- so an explicit ``null`` is a legitimate value meaning
    "clear the link", not a defect to refuse. The three states still stay
    apart through ``model_fields_set``: omitted leaves the link alone, ``null``
    clears it, and an id sets it once the caller is shown to own that habit.
    The id is bounded like every other row id, so ``0``, a negative or a value
    past int32 is a 422 rather than a database lookup.
    """

    has_seen_welcome: bool = False
    energy_scaffolding_archived: bool = False
    writing_session_habit_id: RowIdField | None = None
