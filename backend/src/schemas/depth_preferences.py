"""Depth-preference schemas for the optional program rings."""

from __future__ import annotations

from typing import Self

from pydantic import BaseModel, model_validator


class DepthPreferencesResponse(BaseModel):
    """The four ring toggles returned to the caller.

    ``user_id`` is intentionally excluded — the caller already knows its own
    identity from the JWT, and surfacing surrogate keys aids enumeration.
    """

    enable_habits: bool
    enable_practices: bool
    enable_course: bool
    enable_sangha: bool


class DepthPreferencesUpdate(BaseModel):
    """Partial update for the ring toggles (PATCH).

    Every field is optional; an empty payload is rejected (422) so a no-op
    PATCH cannot reach the database. Only the fields the caller sets are
    applied — unspecified rings keep their stored value.
    """

    enable_habits: bool | None = None
    enable_practices: bool | None = None
    enable_course: bool | None = None
    enable_sangha: bool | None = None

    @model_validator(mode="after")
    def _require_at_least_one_field(self) -> Self:
        provided = (
            self.enable_habits,
            self.enable_practices,
            self.enable_course,
            self.enable_sangha,
        )
        if all(value is None for value in provided):
            msg = "at least one field must be provided"
            raise ValueError(msg)
        return self
