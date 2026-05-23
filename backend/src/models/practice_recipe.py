"""Recipes: named ordered collections of steps that materialise into a mode_config.

A recipe is the user-facing unit in the tier-one customise flow.
Examples: ``5-4-3-2-1 Grounding``, ``Find the Rainbow``, ``Four
Elements``.  Each recipe holds an ordered list of
:class:`PracticeRecipeStep` rows whose tag + prompt + count combine to
produce a ``mode_config`` payload at apply time.

System recipes (``owner_user_id IS NULL``) are seeded read-only; user
recipes are full CRUD.  The "edit" flow in the client forks a user
copy of a system recipe rather than mutating the shared row.

``mode`` mirrors the practice-mode discriminator the recipe is built
for (``sense_grounding`` for per-prompt label structures like
5-4-3-2-1, ``tallied_grounding`` for rounds-by-categories).  Apply
checks the catalog's ``mode`` against this field and refuses
cross-mode swaps -- the override mechanism cannot change ``mode``
itself.

``rounds`` is stored at the recipe level (not per-step) so
"rounds-by-categories" recipes like ``Find the Rainbow x3`` can be
expressed without expanding every round into its own duplicated
steps.  For ``sense_grounding`` mode the rounds value is always 1.
"""

from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, SQLModel

from domain.practice_modes import PracticeMode

# Bounds mirrored from schemas.practice_mode_config so the DB CHECK
# constraint and the Pydantic validator agree.  Drift between the two
# would surface as a 500 (the DB rejecting what the schema accepted),
# so a single named constant per bound is preferable to an enum here.
_RECIPE_ROUNDS_MIN = 1
_RECIPE_ROUNDS_MAX = 10
_STEP_TARGET_COUNT_MIN = 1
_STEP_TARGET_COUNT_MAX = 20
# Recipes that can be applied directly into a UserPractice override:
# the override mechanism cannot change ``mode`` so a recipe whose
# ``mode`` does not match the catalog row is rejected at apply time.
RECIPE_MODES: tuple[str, ...] = (
    PracticeMode.SENSE_GROUNDING.value,
    PracticeMode.TALLIED_GROUNDING.value,
)


def _recipe_mode_check() -> CheckConstraint:
    """Pin ``mode`` to the recipe-capable subset of :data:`PracticeMode`."""
    quoted = ", ".join(f"'{m}'" for m in RECIPE_MODES)
    return CheckConstraint(f"mode IN ({quoted})", name="ck_practicerecipe_mode_valid")


class PracticeRecipe(SQLModel, table=True):
    """A reusable named template that materialises into a ``mode_config``.

    The partial-unique indexes on ``slug`` live at the DB layer
    (migration ``07b8c9d0e1f2``) for the same reason as
    :class:`~models.practice_tag.PracticeTag`: system and per-user
    namespaces are independent and alembic autogenerate cannot
    round-trip the partial predicate.

    ``created_at`` is timezone-aware so the picker can show "added
    today" without timezone gymnastics on the client.
    """

    __table_args__ = (
        _recipe_mode_check(),
        CheckConstraint(
            f"rounds >= {_RECIPE_ROUNDS_MIN} AND rounds <= {_RECIPE_ROUNDS_MAX}",
            name="ck_practicerecipe_rounds_range",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    slug: str = Field(
        max_length=64,
        description="Snake-case machine slug; pattern enforced by the schema layer.",
    )
    name: str = Field(max_length=255)
    description: str = Field(max_length=2_000)
    owner_user_id: int | None = Field(
        default=None,
        foreign_key="user.id",
        ondelete="CASCADE",
        description="NULL for system recipes; otherwise the owning user.",
    )
    mode: str = Field(
        max_length=32,
        description="Target practice mode this recipe materialises into.",
    )
    rounds: int = Field(default=1)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )


class PracticeRecipeStep(SQLModel, table=True):
    """One ordered step in a :class:`PracticeRecipe`.

    ``tag_slug`` and ``tag_label`` are copies of the originating
    :class:`~models.practice_tag.PracticeTag` fields rather than a
    foreign key: a recipe must keep working after the user deletes
    the personal tag it was built from, and a system recipe must be
    self-contained even when the user has no matching tag in their
    personal library.

    The ``(recipe_id, position)`` unique index lives at the DB layer
    (migration ``07b8c9d0e1f2``) and is mirrored here so SQLite tests
    inherit the same enforcement via ``metadata.create_all``.
    """

    __table_args__ = (
        Index(
            "ix_practicerecipestep_recipe_position",
            "recipe_id",
            "position",
            unique=True,
        ),
        CheckConstraint(
            (
                f"target_count >= {_STEP_TARGET_COUNT_MIN} "
                f"AND target_count <= {_STEP_TARGET_COUNT_MAX}"
            ),
            name="ck_practicerecipestep_target_count_range",
        ),
        CheckConstraint("position >= 0", name="ck_practicerecipestep_position_nonneg"),
    )

    id: int | None = Field(default=None, primary_key=True)
    recipe_id: int = Field(foreign_key="practicerecipe.id", ondelete="CASCADE", index=True)
    position: int = Field(description="Zero-based ordering within the recipe.")
    tag_slug: str = Field(max_length=64)
    tag_label: str = Field(max_length=255)
    prompt_label: str = Field(max_length=255)
    target_count: int = Field(default=1)
