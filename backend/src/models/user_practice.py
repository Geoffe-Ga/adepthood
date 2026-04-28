from datetime import date

from sqlalchemy import Column, Date, Index
from sqlmodel import Field, SQLModel

# Bound at module scope so :class:`Index`'s ``*_where`` predicates can
# resolve the column at table-creation time.  Both Postgres and SQLite
# accept the same ``IS NULL`` form, so the predicate is identical
# across dialects.
_END_DATE_COLUMN = Column("end_date", Date, nullable=True)


class UserPractice(SQLModel, table=True):
    """Connects a user to a selected Practice for a given stage.

    Tracks the time window of engagement with the practice.

    The partial unique index ``ix_user_practice_active_stage`` enforces
    "at most one open ``UserPractice`` per ``(user, stage)``" at the
    database level (BUG-PRACTICE-005, BUG-PRACTICE-011).  ``end_date IS
    NULL`` is the canonical "still active" predicate, so the index lets
    historical (closed) selections accumulate while the live selection
    remains a single row.  Mirrors the constraint from migration
    ``f6a7b8c9d0e1`` so SQLite tests inherit the same enforcement via
    ``metadata.create_all``.
    """

    __table_args__ = (
        Index(
            "ix_user_practice_active_stage",
            "user_id",
            "stage_number",
            unique=True,
            postgresql_where=_END_DATE_COLUMN.is_(None),
            sqlite_where=_END_DATE_COLUMN.is_(None),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id")
    practice_id: int = Field(foreign_key="practice.id")
    stage_number: int
    start_date: date
    end_date: date | None = Field(default=None, sa_column=_END_DATE_COLUMN)
