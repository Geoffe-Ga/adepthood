"""Personal tag library entries for the practice-recipe builder.

A tag is the smallest unit a recipe step is built from: ``sight``,
``red``, ``square``, ``earth``, ``felt_inside``.  It carries a slug
(snake-case, machine-stable) and a label (display string), nothing
else -- visual styling lives in the client.

``owner_user_id`` partitions the namespace.  ``NULL`` marks a system
tag the seeder owns; a non-NULL value scopes the tag to one user.  The
partial-unique indexes (migration ``07b8c9d0e1f2``) keep the two
namespaces independent so a user can claim ``sight`` even when a
system tag with the same slug already exists -- their personal copy
hides nothing and overrides nothing.

The recipe step layer (see :mod:`models.practice_recipe`) stores a
copy of the tag's ``slug`` rather than a foreign key, so deleting a
personal tag here never silently breaks a recipe that referenced it.
"""

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime
from sqlmodel import Field, SQLModel


class PracticeTag(SQLModel, table=True):
    """One label in the recipe-builder's tag library.

    The partial-unique indexes on ``slug`` (one for ``owner_user_id IS
    NULL``, one for ``owner_user_id IS NOT NULL``) live at the DB
    layer in migration ``07b8c9d0e1f2``; they are intentionally NOT
    declared in ``__table_args__`` so ``alembic check`` does not flag
    spurious drift against the partial predicate.
    """

    id: int | None = Field(default=None, primary_key=True)
    slug: str = Field(
        max_length=64,
        description="Snake-case machine slug; pattern enforced by the schema layer.",
    )
    label: str = Field(max_length=255, description="Human-facing display string.")
    owner_user_id: int | None = Field(
        default=None,
        foreign_key="user.id",
        ondelete="CASCADE",
        description="NULL for system tags; otherwise the owning user.",
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
