"""Tests for the system-recipe + system-tag seeder."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.practice_recipe import PracticeRecipe, PracticeRecipeStep
from models.practice_tag import PracticeTag
from schemas.practice_mode_config import ModeConfigAdapter
from schemas.practice_recipe import (
    PracticeRecipeOut,
    PracticeRecipeStepOut,
    materialise_mode_config,
)
from seed_practice_recipes import (
    SYSTEM_RECIPES,
    SYSTEM_TAGS,
    seed_practice_recipes,
)


@pytest.mark.asyncio
async def test_seed_inserts_all_recipes_and_tags(db_session: AsyncSession) -> None:
    inserted = await seed_practice_recipes(db_session)
    assert inserted == len(SYSTEM_RECIPES) + len(SYSTEM_TAGS)

    tag_count = (
        await db_session.execute(
            select(PracticeTag).where(col(PracticeTag.owner_user_id).is_(None))
        )
    ).all()
    assert len(tag_count) == len(SYSTEM_TAGS)

    recipe_count = (
        await db_session.execute(
            select(PracticeRecipe).where(col(PracticeRecipe.owner_user_id).is_(None))
        )
    ).all()
    assert len(recipe_count) == len(SYSTEM_RECIPES)


@pytest.mark.asyncio
async def test_seed_is_idempotent(db_session: AsyncSession) -> None:
    first = await seed_practice_recipes(db_session)
    assert first > 0
    second = await seed_practice_recipes(db_session)
    assert second == 0


@pytest.mark.asyncio
async def test_seeded_recipes_materialise_to_valid_mode_config(
    db_session: AsyncSession,
) -> None:
    """Every system recipe must round-trip through ModeConfigAdapter cleanly."""
    await seed_practice_recipes(db_session)
    recipes = (
        (
            await db_session.execute(
                select(PracticeRecipe).where(col(PracticeRecipe.owner_user_id).is_(None))
            )
        )
        .scalars()
        .all()
    )
    for recipe in recipes:
        assert recipe.id is not None
        steps = (
            (
                await db_session.execute(
                    select(PracticeRecipeStep)
                    .where(PracticeRecipeStep.recipe_id == recipe.id)
                    .order_by(col(PracticeRecipeStep.position))
                )
            )
            .scalars()
            .all()
        )
        recipe_out = PracticeRecipeOut(
            id=recipe.id,
            slug=recipe.slug,
            name=recipe.name,
            description=recipe.description,
            owner_user_id=None,
            mode=recipe.mode,
            rounds=recipe.rounds,
            created_at=recipe.created_at,
            steps=[PracticeRecipeStepOut.model_validate(s, from_attributes=True) for s in steps],
        )
        materialised = materialise_mode_config(recipe_out)
        # Round-trip the materialised payload through the discriminated union.
        validated = ModeConfigAdapter.validate_python(materialised)
        assert validated.mode == recipe.mode


@pytest.mark.asyncio
async def test_canonical_five_four_three_two_one_seeded(db_session: AsyncSession) -> None:
    """The 5-4-3-2-1 recipe is the linchpin of the tier-one habit; assert shape."""
    await seed_practice_recipes(db_session)
    result = await db_session.execute(
        select(PracticeRecipe).where(PracticeRecipe.slug == "five_four_three_two_one")
    )
    recipe = result.scalar_one()
    assert recipe.mode == "sense_grounding"
    assert recipe.rounds == 1
    steps = (
        (
            await db_session.execute(
                select(PracticeRecipeStep)
                .where(PracticeRecipeStep.recipe_id == recipe.id)
                .order_by(col(PracticeRecipeStep.position))
            )
        )
        .scalars()
        .all()
    )
    assert [s.tag_slug for s in steps] == ["sight", "touch", "hearing", "smell", "taste"]
    assert [s.target_count for s in steps] == [5, 4, 3, 2, 1]
