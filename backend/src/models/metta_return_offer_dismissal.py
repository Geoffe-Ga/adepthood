"""The persisted per-episode dismissal of a user's Return offer.

A ``MettaReturnOfferDismissal`` row records that a user waved away the Return
invitation (see :mod:`domain.metta_return`) for one specific offer episode. An
episode is keyed by the user's current cycle and stage, so any stage or cycle
advance opens a fresh episode whose offer surfaces again — a past dismissal
never silences a future invitation.

At most one dismissal per (user, episode) may exist, enforced by a unique index,
so re-dismissing the same episode is idempotent. A non-unique owner index keeps
"this user's dismissals" a range scan.
"""

from datetime import datetime

from sqlalchemy import Column, DateTime, Index
from sqlmodel import Field, SQLModel


class MettaReturnOfferDismissal(SQLModel, table=True):
    """One user's dismissal of the Return offer for a single episode.

    The unique index ``ix_metta_return_offer_dismissal_user_episode`` on
    ``(user_id, episode_key)`` makes re-dismissing the same episode a no-op, and
    the non-unique ``ix_metta_return_offer_dismissal_user_id`` keeps owner-scoped
    lookups a range scan.
    """

    __table_args__ = (
        Index(
            "ix_metta_return_offer_dismissal_user_episode",
            "user_id",
            "episode_key",
            unique=True,
        ),
        Index("ix_metta_return_offer_dismissal_user_id", "user_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    episode_key: str = Field(nullable=False)
    dismissed_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
