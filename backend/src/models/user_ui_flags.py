"""Per-user UI flags tracking one-time interface state."""

from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Column
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .user import User

# Booleans default to disabled ("0") so a fresh user starts with no flags set;
# rows are provisioned on first read rather than backfilled. The server_default
# mirrors the migration end-state, keeping ``alembic check`` drift-free.
_DISABLED_SERVER_DEFAULT = "0"


class UserUiFlags(SQLModel, table=True):
    """Per-user record of one-time UI state.

    One row per user tracks lightweight interface flags: whether the welcome
    flow has been seen, whether the energy-scaffolding surface has been
    archived, and which habit (if any) the writing timer checks off. Both flags
    default to ``False`` and the link to ``None`` so a new account starts with a
    clean slate; rows are created on first access rather than backfilled.
    """

    id: int | None = Field(default=None, primary_key=True)
    has_seen_welcome: bool = Field(
        default=False,
        sa_column=Column(Boolean(), nullable=False, server_default=_DISABLED_SERVER_DEFAULT),
    )
    """Whether the user has seen the welcome flow."""
    energy_scaffolding_archived: bool = Field(
        default=False,
        sa_column=Column(Boolean(), nullable=False, server_default=_DISABLED_SERVER_DEFAULT),
    )
    """Whether the user has archived the energy-scaffolding surface."""
    writing_session_habit_id: int | None = Field(
        default=None,
        foreign_key="habit.id",
        ondelete="SET NULL",
        nullable=True,
        index=True,
    )
    """The habit a finished writing session checks off, or ``None`` when unlinked.

    ``ON DELETE SET NULL`` so deleting the habit unlinks the timer instead of
    deleting the user's flags; ``delete_habit`` also clears it explicitly.
    """
    user_id: int = Field(foreign_key="user.id", unique=True, ondelete="CASCADE")
    user: "User" = Relationship(back_populates="ui_flags")
