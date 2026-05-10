from typing import Any

from sqlalchemy import JSON, CheckConstraint, Column
from sqlmodel import Field, SQLModel

from domain.practice_modes import ALL_MODES, PracticeMode


def _mode_check_constraint() -> CheckConstraint:
    """CHECK constraint pinning ``mode`` to the documented enum members.

    Generated from :data:`ALL_MODES` so adding a new mode in
    :mod:`domain.practice_modes` is a one-edit change — the constraint and
    the enum cannot drift.
    """
    quoted = ", ".join(f"'{m}'" for m in ALL_MODES)
    return CheckConstraint(f"mode IN ({quoted})", name="ck_practice_mode_valid")


class Practice(SQLModel, table=True):
    """Defines a single practice users can perform."""

    __table_args__ = (_mode_check_constraint(),)

    id: int | None = Field(default=None, primary_key=True)
    stage_number: int
    name: str = Field(max_length=255)
    description: str = Field(max_length=2_000)
    instructions: str = Field(max_length=10_000)
    default_duration_minutes: float
    submitted_by_user_id: int | None = Field(
        default=None, foreign_key="user.id", ondelete="SET NULL"
    )
    approved: bool = True
    mode: str = Field(
        default=PracticeMode.MEDITATION_TIMER.value,
        max_length=32,
        description="Engine discriminator; see domain.practice_modes.PracticeMode.",
    )
    mode_config: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSON, nullable=False, server_default="{}"),
        description=(
            "Per-mode configuration payload validated against the matching "
            "schemas.practice_mode_config.ModeConfig union at the API edge."
        ),
    )
