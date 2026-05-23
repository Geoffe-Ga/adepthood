"""Practice-recipe API -- library + apply-to-user-practice endpoints.

Six endpoints around :class:`models.practice_recipe.PracticeRecipe`:

* ``GET /practice-recipes`` -- list system + caller-owned recipes,
  optionally filtered by ``mode``.
* ``POST /practice-recipes`` -- create a personal recipe.  The client's
  "fork a system recipe to edit it" flow calls this with the system
  recipe's payload after picking a new slug.
* ``GET /practice-recipes/{recipe_id}`` -- read one recipe and its steps.
* ``PATCH /practice-recipes/{recipe_id}`` -- replace name + description +
  rounds + steps wholesale.  Slug and mode are immutable.
* ``DELETE /practice-recipes/{recipe_id}`` -- delete a personal recipe.
* ``POST /practice-recipes/{recipe_id}/apply-to/{user_practice_id}`` --
  materialise the recipe and copy it into
  ``UserPractice.mode_config_override``.  Re-uses the same catalog-mode
  check the customise endpoint runs so the override invariant ("mode
  may not change") cannot be bypassed via the recipe path.

System recipes (``owner_user_id IS NULL``) are read-only.  Mutation
attempts return ``403 cannot_modify_system_recipe``.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, or_, select

from database import get_session
from dependencies.ownership import require_owned_user_practice
from domain.practice_resolution import effective_config, effective_name
from errors import bad_request, conflict, forbidden, not_found
from models.practice import Practice
from models.practice_recipe import PracticeRecipe, PracticeRecipeStep
from models.user_practice import UserPractice
from routers.auth import get_current_user
from schemas.practice import UserPracticeDetail
from schemas.practice_mode_config import ModeConfigAdapter
from schemas.practice_recipe import (
    PracticeRecipeCreate,
    PracticeRecipeOut,
    PracticeRecipeStepOut,
    PracticeRecipeUpdate,
    materialise_mode_config,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/practice-recipes", tags=["practice-recipes"])


async def _load_steps(recipe_id: int, session: AsyncSession) -> list[PracticeRecipeStep]:
    """Fetch a recipe's steps in display order."""
    result = await session.execute(
        select(PracticeRecipeStep)
        .where(PracticeRecipeStep.recipe_id == recipe_id)
        .order_by(col(PracticeRecipeStep.position))
    )
    return list(result.scalars().all())


def _to_out(recipe: PracticeRecipe, steps: list[PracticeRecipeStep]) -> PracticeRecipeOut:
    """Build the wire DTO for a recipe + its already-loaded steps."""
    return PracticeRecipeOut(
        id=recipe.id or 0,
        slug=recipe.slug,
        name=recipe.name,
        description=recipe.description,
        owner_user_id=recipe.owner_user_id,
        mode=recipe.mode,
        rounds=recipe.rounds,
        created_at=recipe.created_at,
        steps=[PracticeRecipeStepOut.model_validate(s, from_attributes=True) for s in steps],
    )


async def _load_visible_recipe(
    recipe_id: int, user_id: int, session: AsyncSession
) -> PracticeRecipe:
    """Fetch a recipe the caller is allowed to see, else raise 404."""
    result = await session.execute(
        select(PracticeRecipe).where(
            PracticeRecipe.id == recipe_id,
            or_(
                col(PracticeRecipe.owner_user_id).is_(None),
                PracticeRecipe.owner_user_id == user_id,
            ),
        )
    )
    recipe = result.scalar_one_or_none()
    if recipe is None:
        raise not_found("practice_recipe")
    return recipe


def _require_personal(recipe: PracticeRecipe) -> None:
    """Reject mutation of a system recipe with a stable 403 detail."""
    if recipe.owner_user_id is None:
        raise forbidden("cannot_modify_system_recipe")


def _build_step_rows(recipe_id: int, payload_steps: list[Any]) -> list[PracticeRecipeStep]:
    """Materialise per-step input rows with positional ordering."""
    return [
        PracticeRecipeStep(
            recipe_id=recipe_id,
            position=index,
            tag_slug=step.tag_slug,
            tag_label=step.tag_label,
            prompt_label=step.prompt_label,
            target_count=step.target_count,
        )
        for index, step in enumerate(payload_steps)
    ]


@router.get("/", response_model=list[PracticeRecipeOut])
async def list_practice_recipes(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    mode: Annotated[str | None, Query(description="Filter by recipe mode.")] = None,
) -> list[PracticeRecipeOut]:
    """List every recipe visible to the caller, optionally filtered by mode."""
    query = select(PracticeRecipe).where(
        or_(
            col(PracticeRecipe.owner_user_id).is_(None),
            PracticeRecipe.owner_user_id == user_id,
        )
    )
    if mode is not None:
        query = query.where(PracticeRecipe.mode == mode)
    query = query.order_by(col(PracticeRecipe.owner_user_id).nulls_first(), PracticeRecipe.name)
    result = await session.execute(query)
    recipes = list(result.scalars().all())
    out: list[PracticeRecipeOut] = []
    for recipe in recipes:
        recipe_id = recipe.id
        if recipe_id is None:
            continue
        steps = await _load_steps(recipe_id, session)
        out.append(_to_out(recipe, steps))
    return out


@router.post("/", response_model=PracticeRecipeOut, status_code=status.HTTP_201_CREATED)
async def create_practice_recipe(
    payload: PracticeRecipeCreate,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PracticeRecipeOut:
    """Create a personal recipe owned by the caller."""
    recipe = PracticeRecipe(
        slug=payload.slug,
        name=payload.name,
        description=payload.description,
        owner_user_id=user_id,
        mode=payload.mode,
        rounds=payload.rounds,
    )
    session.add(recipe)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise conflict("recipe_slug_taken") from exc
    recipe_id = recipe.id
    if recipe_id is None:  # pragma: no cover - flush always populates the PK
        await session.rollback()
        raise bad_request("recipe_persist_failed")
    steps = _build_step_rows(recipe_id, list(payload.steps))
    session.add_all(steps)
    await session.commit()
    await session.refresh(recipe)
    logger.info(
        "practice_recipe_created",
        extra={"recipe_id": recipe.id, "user_id": user_id, "slug": recipe.slug},
    )
    return _to_out(recipe, steps)


@router.get("/{recipe_id}", response_model=PracticeRecipeOut)
async def get_practice_recipe(
    recipe_id: int,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PracticeRecipeOut:
    """Read one recipe + its steps."""
    recipe = await _load_visible_recipe(recipe_id, user_id, session)
    steps = await _load_steps(recipe_id, session)
    return _to_out(recipe, steps)


@router.patch("/{recipe_id}", response_model=PracticeRecipeOut)
async def update_practice_recipe(
    recipe_id: int,
    payload: PracticeRecipeUpdate,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PracticeRecipeOut:
    """Replace name + description + rounds + steps wholesale.

    Slug and mode are immutable -- a slug rename would break any
    UserPractice that captured the recipe by id, and a mode swap would
    invalidate the step tag mappings.  Steps are wholesale-replaced
    rather than diffed: simpler, and the client always sends the full
    list anyway.
    """
    recipe = await _load_visible_recipe(recipe_id, user_id, session)
    _require_personal(recipe)
    # Replay the mode-aware invariants ``PracticeRecipeCreate`` enforces
    # so PATCH cannot land an inconsistent state (e.g. rounds != 1 for
    # a sense_grounding recipe).  Re-validate via the create schema --
    # cheaper than duplicating the rules.
    try:
        PracticeRecipeCreate(
            slug=recipe.slug,
            name=payload.name,
            description=payload.description,
            mode=recipe.mode,
            rounds=payload.rounds,
            steps=payload.steps,
        )
    except ValidationError as exc:
        raise bad_request("recipe_invariant_violated") from exc

    recipe.name = payload.name
    recipe.description = payload.description
    recipe.rounds = payload.rounds
    session.add(recipe)
    # Wipe + replace steps in one transaction.
    existing = await _load_steps(recipe_id, session)
    for old in existing:
        await session.delete(old)
    await session.flush()
    new_steps = _build_step_rows(recipe_id, list(payload.steps))
    session.add_all(new_steps)
    await session.commit()
    await session.refresh(recipe)
    return _to_out(recipe, new_steps)


@router.delete("/{recipe_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_practice_recipe(
    recipe_id: int,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """Delete a personal recipe.

    Cascade on ``PracticeRecipeStep.recipe_id`` removes the step rows;
    UserPractice rows are unaffected (the recipe only ever populated
    their override JSON, never pointed at the recipe by FK).
    """
    recipe = await _load_visible_recipe(recipe_id, user_id, session)
    _require_personal(recipe)
    await session.delete(recipe)
    await session.commit()
    logger.info("practice_recipe_deleted", extra={"recipe_id": recipe_id, "user_id": user_id})


def _validate_materialised_against_catalog(
    materialised: dict[str, Any], practice: Practice
) -> None:
    """Run the materialised config through the same gate the customise route uses.

    Shared with ``user_practices.customize_user_practice`` in spirit:
    both paths land in ``UserPractice.mode_config_override`` and both
    must (a) parse cleanly under ``ModeConfigAdapter`` and (b) match
    the catalog ``mode``.
    """
    try:
        cfg = ModeConfigAdapter.validate_python(materialised)
    except ValidationError as exc:
        raise bad_request("recipe_invalid_for_mode") from exc
    if cfg.mode != practice.mode:
        raise bad_request("mode_mismatch")


@router.post(
    "/{recipe_id}/apply-to/{user_practice_id}",
    response_model=UserPracticeDetail,
)
async def apply_recipe_to_user_practice(
    recipe_id: int,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_practice: Annotated[UserPractice, Depends(require_owned_user_practice)],
) -> dict[str, Any]:
    """Materialise a recipe and store it as the UserPractice's override.

    Re-uses ``require_owned_user_practice`` (the same dependency the
    customise endpoint uses) so the ownership rule for overrides is
    enforced in exactly one place.  Mode mismatch returns ``400
    mode_mismatch`` to mirror the customise endpoint's error shape.
    """
    recipe = await _load_visible_recipe(recipe_id, user_id, session)
    steps = await _load_steps(recipe_id, session)
    recipe_out = _to_out(recipe, steps)
    materialised = materialise_mode_config(recipe_out)

    practice_result = await session.execute(
        select(Practice).where(Practice.id == user_practice.practice_id)
    )
    practice = practice_result.scalar_one_or_none()
    if practice is None:
        raise not_found("practice")
    _validate_materialised_against_catalog(materialised, practice)

    user_practice.mode_config_override = materialised
    session.add(user_practice)
    await session.commit()
    await session.refresh(user_practice)
    logger.info(
        "practice_recipe_applied",
        extra={
            "recipe_id": recipe_id,
            "user_practice_id": user_practice.id,
            "user_id": user_id,
        },
    )
    return {
        "id": user_practice.id,
        "practice_id": user_practice.practice_id,
        "stage_number": user_practice.stage_number,
        "start_date": user_practice.start_date,
        "end_date": user_practice.end_date,
        "custom_name": user_practice.custom_name,
        "mode_config_override": user_practice.mode_config_override,
        "effective_name": effective_name(practice, user_practice),
        "effective_config": effective_config(practice, user_practice).model_dump(),
        "sessions": [],
    }
