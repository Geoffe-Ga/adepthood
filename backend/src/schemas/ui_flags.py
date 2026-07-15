"""UI-flag schemas for per-user one-time interface state."""

from __future__ import annotations

from typing import Self

from pydantic import BaseModel, model_validator


class UiFlagsResponse(BaseModel):
    """The two UI flags returned to the caller.

    ``user_id`` is intentionally excluded — the caller already knows its own
    identity from the JWT, and surfacing surrogate keys aids enumeration.
    """

    has_seen_welcome: bool
    energy_scaffolding_archived: bool


class UiFlagsUpdate(BaseModel):
    """Partial update for the UI flags (PATCH).

    Every field is optional; an empty payload is rejected (422) so a no-op
    PATCH cannot reach the database. Only the fields the caller sets are
    applied — unspecified flags keep their stored value.
    """

    has_seen_welcome: bool | None = None
    energy_scaffolding_archived: bool | None = None

    @model_validator(mode="after")
    def _require_at_least_one_field(self) -> Self:
        provided = (
            self.has_seen_welcome,
            self.energy_scaffolding_archived,
        )
        if all(value is None for value in provided):
            msg = "at least one field must be provided"
            raise ValueError(msg)
        return self
