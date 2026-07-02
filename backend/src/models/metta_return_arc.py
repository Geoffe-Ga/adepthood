"""The persisted state of a user's Return arc — a declinable Metta rest.

A ``MettaReturnArc`` row records that a user accepted the five-week Return
(see :mod:`domain.metta_return`): when it started, whether it is currently
paused, and when — if ever — the user left it. The arc is entirely opt-in and
carries no penalty: pausing, resuming, and leaving are all first-class,
never-shaming actions, and nothing in this table gates or mutates a user's
stage progress.

At most one *active* arc (``left_at IS NULL``) may exist per user, enforced by a
partial unique index. Leaving sets ``left_at``, which frees that slot so a fresh
arc can be started later. A non-unique owner index keeps "this user's arcs" a
range scan.
"""

from datetime import datetime

from sqlalchemy import Column, DateTime, Index
from sqlmodel import Field, SQLModel

# Bound at module scope so :class:`Index`'s ``*_where`` predicate can resolve the
# column at table-creation time. Both Postgres and SQLite accept the same
# ``IS NULL`` form, so the partial unique index renders on the test SQLite DB
# via ``metadata.create_all`` and stays drift-free against the migration.
_LEFT_AT_COLUMN = Column("left_at", DateTime(timezone=True), nullable=True)


class MettaReturnArc(SQLModel, table=True):
    """One user's Return arc lifecycle row.

    The partial unique index ``ix_metta_return_arc_user_active`` on ``user_id``
    WHERE ``left_at IS NULL`` guarantees a single live arc per user while
    permitting any number of previously-left arcs, so leaving and restarting is
    always allowed. Declaring the predicate with both ``postgresql_where`` and
    ``sqlite_where`` keeps the metadata aligned with the migration so
    ``alembic check`` sees no drift and ``metadata.create_all`` installs the
    same constraint on the test SQLite DB.
    """

    __table_args__ = (
        Index(
            "ix_metta_return_arc_user_active",
            "user_id",
            unique=True,
            postgresql_where=_LEFT_AT_COLUMN.is_(None),
            sqlite_where=_LEFT_AT_COLUMN.is_(None),
        ),
        Index("ix_metta_return_arc_user_id", "user_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    started_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    paused_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    left_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
