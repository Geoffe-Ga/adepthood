"""Durable storage for generated energy plans.

Generated plans used to live only in a per-process ``TTLCache``: they were
lost on restart and, under multiple workers, the same ``idempotency_key``
yielded different plans on different workers. This table makes the plan a
durable, cross-worker record — a keyed retry returns the stored plan verbatim.

One row is written per generated plan. Keyed requests are deduplicated by a
partial UNIQUE index on ``(user_id, idempotency_key)`` (only where the key is
non-NULL), mirroring the prod/SQLite partial-index convention used elsewhere.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Index, String, Text
from sqlmodel import Field, SQLModel

# Client-supplied idempotency keys are short opaque tokens; 255 leaves ample
# headroom while keeping the partial-unique index narrow. Public so the router
# can reject an over-long ``X-Idempotency-Key`` with a clean 422 instead of a
# native DB error.
IDEM_KEY_MAX_LENGTH = 255
# Reason codes are bounded enum-like strings (e.g. ``generated_21_day_plan``).
_REASON_CODE_WIDTH = 64

# Detached column used ONLY to build the partial-index WHERE expression
# (mirrors the ``_OWNER_COLUMN`` pattern in ``practice_recipe``). It matches
# the real ``idempotency_key`` column by name at DDL-compile time and is never
# attached to the table itself.
_IDEM_KEY_COLUMN = Column("idempotency_key", String(IDEM_KEY_MAX_LENGTH), nullable=True)


class EnergyPlan(SQLModel, table=True):
    """A durably-stored generated energy plan, deduplicated by idempotency key.

    ``plan_json`` is the serialized ``schemas.energy.EnergyPlan`` payload and
    ``reason_code`` the generator's reason; together they reconstruct the exact
    ``EnergyPlanResponse`` a retry should replay. ``idempotency_key`` is NULL
    for unkeyed requests (each gets its own row); keyed requests collide on the
    partial UNIQUE index so a concurrent duplicate insert raises
    ``IntegrityError`` and the caller re-reads the stored row.
    """

    __tablename__ = "energyplan"
    __table_args__ = (
        Index(
            "ix_energyplan_user_idem_key",
            "user_id",
            "idempotency_key",
            unique=True,
            postgresql_where=_IDEM_KEY_COLUMN.is_not(None),
            sqlite_where=_IDEM_KEY_COLUMN.is_not(None),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, ondelete="CASCADE")
    idempotency_key: str | None = Field(
        default=None,
        sa_column=Column(String(IDEM_KEY_MAX_LENGTH), nullable=True),
    )
    # Serialized ``schemas.energy.EnergyPlan`` (JSON string). ``Text`` (not
    # ``String``) so the model matches the migration's ``sa.Text()`` exactly and
    # ``alembic --autogenerate`` does not flag a spurious diff.
    plan_json: str = Field(sa_column=Column(Text, nullable=False))
    reason_code: str = Field(sa_column=Column(String(_REASON_CODE_WIDTH), nullable=False))
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
