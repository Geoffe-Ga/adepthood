"""Durable, content-free intent for a classification snapshot follow-up.

A vault write can finish while another worker owns the active classification
row's terminalization lock.  PostgreSQL correctly refuses to make the waiting
``UPDATE`` match that row after its outcome changes, so the run row alone is
not a safe rendezvous point.  This one-row-per-user marker is written before
the run-row join is attempted.  The terminalizer consumes it into a queued run;
if terminalization won first, the writer consumes it while creating that same
queue entry.

Only the trigger scope is retained.  Fragment identity, path, title, excerpt,
and body are deliberately absent.
"""

from sqlalchemy import CheckConstraint, Index
from sqlmodel import Field, SQLModel

_TRIGGER_WIDTH = 20


class VaultPipelineFollowUp(SQLModel, table=True):
    """The strongest scope awaiting a post-snapshot classification pass."""

    __tablename__ = "vaultpipelinefollowup"
    __table_args__ = (
        Index(
            "ix_vaultpipelinefollowup_user_id_unique",
            "user_id",
            unique=True,
        ),
        CheckConstraint(
            "trigger IN ('journal_write', 'document_import')",
            name="ck_vaultpipelinefollowup_trigger_valid",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    trigger: str = Field(max_length=_TRIGGER_WIDTH)
