"""add practice_tag, practice_recipe, practice_recipe_step tables

Revision ID: 07b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-05-23 00:00:00.000000

Adds a user-managed recipe library for tier-one mindfulness practices.

* ``practice_tag`` - atomic labels (sight, red, square, "felt inside").
  ``owner_user_id IS NULL`` for system tags; otherwise scoped to one user.

* ``practice_recipe`` - named ordered collection of steps that materialises
  into a ``mode_config`` payload when the user picks it.  Carries the
  generated ``mode`` discriminator so applying a recipe to a UserPractice
  can be rejected at the API edge when the catalog row uses a different
  mode (the override mechanism cannot swap modes).

* ``practice_recipe_step`` - per-step row (FK -> recipe).  ``tag_slug`` is
  intentionally a copy of the originating tag's slug, NOT a foreign key:
  it keeps system recipes self-contained when a user has not yet built
  their own tag library, and means deleting a personal tag does not
  silently break a recipe that referenced it.

Each owner_user_id column has a partial-unique index on slug (system
namespace and per-user namespaces are independent), and recipe steps
are uniquely ordered within their recipe via a (recipe_id, position)
unique index.
"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "07b8c9d0e1f2"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "f6a7b8c9d0e1"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create the three new tables and their supporting indexes."""
    op.create_table(
        "practicetag",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column("label", sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_user_id"],
            ["user.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    # System tags share one namespace; user tags namespace per user.  The
    # two partial unique indexes encode that without colliding with each
    # other: a user can claim ``sight`` even though a system tag named
    # ``sight`` already exists.
    op.create_index(
        "ix_practicetag_system_slug",
        "practicetag",
        ["slug"],
        unique=True,
        postgresql_where=sa.text("owner_user_id IS NULL"),
        sqlite_where=sa.text("owner_user_id IS NULL"),
    )
    op.create_index(
        "ix_practicetag_user_slug",
        "practicetag",
        ["owner_user_id", "slug"],
        unique=True,
        postgresql_where=sa.text("owner_user_id IS NOT NULL"),
        sqlite_where=sa.text("owner_user_id IS NOT NULL"),
    )

    op.create_table(
        "practicerecipe",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column("name", sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column("description", sqlmodel.sql.sqltypes.AutoString(length=2000), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=True),
        sa.Column("mode", sqlmodel.sql.sqltypes.AutoString(length=32), nullable=False),
        sa.Column("rounds", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_user_id"],
            ["user.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "mode IN ('sense_grounding', 'tallied_grounding')",
            name="ck_practicerecipe_mode_valid",
        ),
        sa.CheckConstraint("rounds >= 1 AND rounds <= 10", name="ck_practicerecipe_rounds_range"),
    )
    op.create_index(
        "ix_practicerecipe_system_slug",
        "practicerecipe",
        ["slug"],
        unique=True,
        postgresql_where=sa.text("owner_user_id IS NULL"),
        sqlite_where=sa.text("owner_user_id IS NULL"),
    )
    op.create_index(
        "ix_practicerecipe_user_slug",
        "practicerecipe",
        ["owner_user_id", "slug"],
        unique=True,
        postgresql_where=sa.text("owner_user_id IS NOT NULL"),
        sqlite_where=sa.text("owner_user_id IS NOT NULL"),
    )

    op.create_table(
        "practicerecipestep",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("recipe_id", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("tag_slug", sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column("tag_label", sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column("prompt_label", sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column("target_count", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["recipe_id"],
            ["practicerecipe.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "target_count >= 1 AND target_count <= 20",
            name="ck_practicerecipestep_target_count_range",
        ),
        sa.CheckConstraint("position >= 0", name="ck_practicerecipestep_position_nonneg"),
    )
    op.create_index(
        "ix_practicerecipestep_recipe_position",
        "practicerecipestep",
        ["recipe_id", "position"],
        unique=True,
    )


def downgrade() -> None:
    """Drop the three tables in reverse FK order."""
    op.drop_index("ix_practicerecipestep_recipe_position", table_name="practicerecipestep")
    op.drop_table("practicerecipestep")
    op.drop_index("ix_practicerecipe_user_slug", table_name="practicerecipe")
    op.drop_index("ix_practicerecipe_system_slug", table_name="practicerecipe")
    op.drop_table("practicerecipe")
    op.drop_index("ix_practicetag_user_slug", table_name="practicetag")
    op.drop_index("ix_practicetag_system_slug", table_name="practicetag")
    op.drop_table("practicetag")
