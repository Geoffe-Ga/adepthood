"""A per-user lease on one of a fixed number of concurrent generation slots (#623).

The owner ratified "maximum **2 concurrent generations/user**" (decision record
§1, ``prompts/claude-comms/2026-09-05-resonance-economy-decision.md``). The cap
must hold across every worker, and production runs ``WEB_CONCURRENCY=2`` by
default, so an in-process semaphore would admit twice the ratified number. The
lease therefore lives in the database: one row per held slot, and
``UNIQUE(user_id, slot)`` makes a third concurrent insert fail on any worker.

A lease is transient operational state, never content. It is deleted when its
generation ends. While the generation runs, a heartbeat keeps ``expires_at``
one TTL ahead (:data:`services.generation_guardrails.GENERATION_SLOT_TTL_SECONDS`),
so a live generation's lease never expires however long it waits or dials;
only a crashed worker's lease, whose heartbeat died with it, ages past
``expires_at`` and is reclaimed.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Integer, UniqueConstraint
from sqlmodel import Field, SQLModel


class GenerationSlot(SQLModel, table=True):
    """One held generation slot: ``slot`` is in ``range(MAX_CONCURRENT_GENERATIONS_PER_USER)``."""

    __tablename__ = "generationslot"
    __table_args__ = (UniqueConstraint("user_id", "slot", name="uq_generationslot_user_slot"),)

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, ondelete="CASCADE")
    slot: int = Field(sa_column=Column(Integer, nullable=False))
    acquired_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    expires_at: datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
