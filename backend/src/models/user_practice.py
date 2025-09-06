from __future__ import annotations

from datetime import date

from sqlmodel import Field, SQLModel


class UserPractice(SQLModel, table=True):
    """
    Connects a user to a selected Practice for a given stage. Tracks the time window
    of engagement with the practice.
    """

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id")
    practice_id: int = Field(foreign_key="practice.id")
    stage_number: int
    start_date: date
    end_date: date | None = None
