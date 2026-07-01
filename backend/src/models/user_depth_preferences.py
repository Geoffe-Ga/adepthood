"""User depth-preference toggles for the optional program rings."""

from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Column
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .user import User

# Booleans default to enabled ("1") so a fresh user, and every legacy row the
# migration backfills, starts with all optional depths opted-in. The
# server_default mirrors the migration end-state, keeping ``alembic check``
# drift-free.
_ENABLED_SERVER_DEFAULT = "1"


class UserDepthPreferences(SQLModel, table=True):
    """Per-user opt-in flags for the optional program rings.

    One row per user records which of the self-chosen depths — habit
    scaffolding, the practice ramp, the course reading, and the Digital
    Sangha — the user has enabled. Nothing is gated; these toggles simply
    let the user quiet rings they have not chosen. Every flag defaults to
    ``True`` so a new account starts fully opted-in and can decline depths
    later.
    """

    id: int | None = Field(default=None, primary_key=True)
    enable_habits: bool = Field(
        default=True,
        sa_column=Column(Boolean(), nullable=False, server_default=_ENABLED_SERVER_DEFAULT),
    )
    """Whether the habit-scaffolding ring is offered to this user."""
    enable_practices: bool = Field(
        default=True,
        sa_column=Column(Boolean(), nullable=False, server_default=_ENABLED_SERVER_DEFAULT),
    )
    """Whether the practice-ramp ring is offered to this user."""
    enable_course: bool = Field(
        default=True,
        sa_column=Column(Boolean(), nullable=False, server_default=_ENABLED_SERVER_DEFAULT),
    )
    """Whether the course-reading ring is offered to this user."""
    enable_sangha: bool = Field(
        default=True,
        sa_column=Column(Boolean(), nullable=False, server_default=_ENABLED_SERVER_DEFAULT),
    )
    """Whether the Digital Sangha ring is offered to this user."""
    user_id: int = Field(foreign_key="user.id", unique=True, ondelete="CASCADE")
    user: "User" = Relationship(back_populates="depth_preferences")
