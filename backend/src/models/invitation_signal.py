"""Detected invitations to descend deeper into a self-chosen ring (sangha-invitation-01).

An ``InvitationSignal`` records that the system observed a resonant moment to
*offer* a deeper depth — never to gate or pressure. Each row pins one
``(user_id, target_type, target_id, kind)`` coordinate: which ring the
invitation points at, an optional concrete target within it, and why the moment
qualifies (readiness / consistency / mastery). A row is created once and either
lives or is dismissed; ``dismissed_at`` records a decline. The uniqueness spans
*all* rows (dismissed included) so a declined invitation is never silently
recreated — the "you choose your depth" principle honoured at the DB level.

Data-layer only: the generation pass and any endpoints live in later issues.
"""

import enum
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Index, Integer
from sqlmodel import Field, SQLModel

# ``target_type`` / ``kind`` store the StrEnum values as short strings; the
# CHECK constraints keep the stored set aligned with the enums below.
_ENUM_MAX = 32

# Bound at module scope so :class:`Index`'s ``*_where`` predicates can resolve
# the column at table-creation time. Both Postgres and SQLite accept the same
# ``IS NULL`` / ``IS NOT NULL`` form (mirrors :mod:`models.practice_tag`), so the
# partial indexes render on the test SQLite DB via ``metadata.create_all`` and
# stay drift-free against the migration.
_TARGET_ID_COLUMN = Column("target_id", Integer, nullable=True)


class InvitationTargetType(enum.StrEnum):
    """Which self-chosen ring an invitation points the user toward."""

    HABIT = "habit"
    PRACTICE = "practice"
    COURSE = "course"
    SANGHA = "sangha"
    EMBODIED_COMMUNITY = "embodied_community"


class InvitationKind(enum.StrEnum):
    """Why the observed moment qualifies as a resonant invitation.

    ``readiness`` marks a first-time opening; ``consistency`` rewards a sustained
    rhythm; ``mastery`` recognises depth already reached in the ring.
    """

    READINESS = "readiness"
    CONSISTENCY = "consistency"
    MASTERY = "mastery"


def _target_type_check() -> CheckConstraint:
    """CHECK derived from ``InvitationTargetType`` so the DB set can't drift."""
    quoted = ", ".join(f"'{t.value}'" for t in InvitationTargetType)
    return CheckConstraint(
        f"target_type IN ({quoted})",
        name="ck_invitation_signal_target_type_valid",
    )


def _kind_check() -> CheckConstraint:
    """CHECK derived from ``InvitationKind`` so the DB set can't drift."""
    quoted = ", ".join(f"'{k.value}'" for k in InvitationKind)
    return CheckConstraint(
        f"kind IN ({quoted})",
        name="ck_invitation_signal_kind_valid",
    )


class InvitationSignal(SQLModel, table=True):
    """One detected invitation to descend into a deeper ring for a user.

    Two partial unique indexes together enforce "at most one live-or-dismissed
    invitation per coordinate", splitting on whether ``target_id`` is set:
    ``ix_invitation_signal_user_target`` covers concrete targets
    ``(user_id, target_type, target_id, kind)`` WHERE ``target_id IS NOT NULL``,
    and ``ix_invitation_signal_user_target_null`` covers ring-level invitations
    ``(user_id, target_type, kind)`` WHERE ``target_id IS NULL`` (needed because
    SQL treats two NULLs as distinct in an ordinary UNIQUE). Declaring both here
    with ``postgresql_where`` and ``sqlite_where`` keeps the metadata aligned
    with the migration so ``alembic check`` sees no drift and
    ``metadata.create_all`` installs the same constraints on the test SQLite DB.
    A non-unique ``ix_invitation_signal_user_id`` makes "all invitations for a
    user" a range scan.
    """

    __table_args__ = (
        Index(
            "ix_invitation_signal_user_target",
            "user_id",
            "target_type",
            "target_id",
            "kind",
            unique=True,
            postgresql_where=_TARGET_ID_COLUMN.is_not(None),
            sqlite_where=_TARGET_ID_COLUMN.is_not(None),
        ),
        Index(
            "ix_invitation_signal_user_target_null",
            "user_id",
            "target_type",
            "kind",
            unique=True,
            postgresql_where=_TARGET_ID_COLUMN.is_(None),
            sqlite_where=_TARGET_ID_COLUMN.is_(None),
        ),
        Index("ix_invitation_signal_user_id", "user_id"),
        _target_type_check(),
        _kind_check(),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    target_type: str = Field(max_length=_ENUM_MAX)
    target_id: int | None = Field(default=None)
    kind: str = Field(max_length=_ENUM_MAX)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    dismissed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
