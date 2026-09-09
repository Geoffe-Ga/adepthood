"""A reader's standing choice to set one stage prompt aside.

A ``PromptDismissal`` row records that a reader does not want a particular
prompt of a particular stage offered to them for now. It is a *preference*,
never a completion: no ``PromptResponse`` is written, nothing is marked
answered, and the week gating that governs the prompts still standing is
untouched. Setting a prompt aside is the declinable half of "you choose your
depth" — the band shows the depth the reader actually chose rather than an
unclearable standing to-do list.

The choice is reversible, and reversal is a delete rather than a flag: a
prompt brought back leaves no trace of having been declined, because a record
of what someone chose not to write is not something this application keeps.

At most one dismissal per (reader, stage, prompt) may exist, enforced by a
unique index, so a double tap or a retried request is idempotent. A non-unique
owner index keeps "this reader's dismissals" a range scan.
"""

from datetime import datetime

from sqlalchemy import Column, DateTime, Index
from sqlmodel import Field, SQLModel


class PromptDismissal(SQLModel, table=True):
    """One reader's set-aside of a single ``(stage_number, prompt_ordinal)`` prompt.

    The unique index ``ix_prompt_dismissal_user_prompt`` on
    ``(user_id, stage_number, prompt_ordinal)`` makes re-dismissing the same
    prompt a no-op, and the non-unique ``ix_prompt_dismissal_user_id`` keeps
    owner-scoped lookups a range scan.
    """

    __table_args__ = (
        Index(
            "ix_prompt_dismissal_user_prompt",
            "user_id",
            "stage_number",
            "prompt_ordinal",
            unique=True,
        ),
        Index("ix_prompt_dismissal_user_id", "user_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    #: 1-based stage position, matching :func:`domain.weekly_prompts.stage_prompts`.
    stage_number: int = Field(nullable=False)
    #: 1-based place of the prompt inside that stage's curriculum order.
    prompt_ordinal: int = Field(nullable=False)
    dismissed_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
