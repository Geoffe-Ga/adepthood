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
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, Query, status
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.selectable import Select
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import (
    require_owned_user_practice,
    require_personal_row,
    system_or_owned_clause,
    visible_to_user,
)
from domain.practice_resolution import effective_config, effective_name
from errors import bad_request, conflict, not_found
from models.practice import Practice
from models.practice_recipe import PracticeRecipe, PracticeRecipeStep
from models.user_practice import UserPractice
from routers.auth import get_current_user
from routers.user_practices import (
    EmbeddedSessionsParams,
    _validate_mode_config_against_catalog,
    build_user_practice_detail,
    load_recent_sessions,
)
from schemas import Page, PaginationParams, build_page
from schemas.pagination import paginate_query
from schemas.practice import UserPracticeDetail
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
    """Fetch one recipe's steps in display order.

    Used by single-recipe endpoints (GET / PATCH / apply); the list
    endpoint uses :func:`_load_steps_for_recipes` instead to avoid an
    N+1 query as the recipe library grows.
    """
    result = await session.execute(
        select(PracticeRecipeStep)
        .where(PracticeRecipeStep.recipe_id == recipe_id)
        .order_by(col(PracticeRecipeStep.position))
    )
    return list(result.scalars().all())


async def _load_steps_for_recipes(
    recipe_ids: list[int], session: AsyncSession
) -> dict[int, list[PracticeRecipeStep]]:
    """Fetch steps for many recipes in a single query, grouped by recipe id.

    Returns a ``defaultdict``-style mapping so callers can index by
    recipe id without a key-existence check; recipes with no steps
    return an empty list.  Ordering inside each list mirrors
    :func:`_load_steps` (position ascending).
    """
    if not recipe_ids:
        return {}
    result = await session.execute(
        select(PracticeRecipeStep)
        .where(col(PracticeRecipeStep.recipe_id).in_(recipe_ids))
        .order_by(col(PracticeRecipeStep.recipe_id), col(PracticeRecipeStep.position))
    )
    grouped: dict[int, list[PracticeRecipeStep]] = {rid: [] for rid in recipe_ids}
    for step in result.scalars():
        grouped[step.recipe_id].append(step)
    return grouped


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
            system_or_owned_clause(
                col(PracticeRecipe.id), col(PracticeRecipe.owner_user_id), recipe_id, user_id
            )
        )
    )
    recipe = result.scalar_one_or_none()
    if recipe is None:
        raise not_found("practice_recipe")
    return recipe


def _require_personal(recipe: PracticeRecipe) -> None:
    """Reject mutation of a system recipe with a stable 403 detail."""
    require_personal_row(recipe.owner_user_id, system_detail="cannot_modify_system_recipe")


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


def _build_recipe_list_query(user_id: int, mode: str | None) -> Select[tuple[PracticeRecipe]]:
    """Build the `WHERE`-clause query for visible recipes, optionally mode-filtered.

    Extracted so :func:`list_practice_recipes` stays at xenon rank A;
    the visibility + mode + ordering branches add up to enough
    complexity that inlining them pushes the endpoint to rank B.
    """
    query = select(PracticeRecipe).where(
        visible_to_user(col(PracticeRecipe.owner_user_id), user_id)
    )
    if mode is not None:
        query = query.where(PracticeRecipe.mode == mode)
    return query.order_by(col(PracticeRecipe.owner_user_id).nulls_first(), PracticeRecipe.name)


async def _hydrate_recipes_with_steps(
    recipes: list[PracticeRecipe], session: AsyncSession
) -> list[PracticeRecipeOut]:
    """Attach each recipe's step list via a single batched lookup.

    ``recipe.id`` is typed ``int | None`` because the SQLModel base
    permits unflushed rows, but rows loaded from a SELECT always
    carry their PK -- the ``cast`` reflects that invariant without
    re-filtering and keeps this helper at xenon rank A.
    """
    ids = [cast("int", r.id) for r in recipes]
    steps_by_recipe = await _load_steps_for_recipes(ids, session)
    return [_to_out(r, steps_by_recipe.get(cast("int", r.id), [])) for r in recipes]


@router.get("/", response_model=None)
async def list_practice_recipes(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
    mode: Annotated[str | None, Query(description="Filter by recipe mode.")] = None,
) -> Page[PracticeRecipeOut] | list[PracticeRecipeOut]:
    """List recipes visible to the caller; paginated on ``?paginate=true``.

    Batches the step lookup into a single ``WHERE recipe_id IN (...)``
    query so the picker, which fires this endpoint every time the sheet
    opens, scales with library size instead of N+1.  Pagination slices the
    recipe rows (and the ``mode`` filter feeds the count) *before*
    hydration, so the step lookup stays bounded to the current page
    (issue #470).
    """
    query = _build_recipe_list_query(user_id, mode)
    recipes, total = await paginate_query(session, query, pagination)
    hydrated = await _hydrate_recipes_with_steps(recipes, session)
    if pagination.paginate:
        return build_page(hydrated, total, pagination)
    return hydrated


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

    Concurrency: this endpoint is last-write-wins on the entire step
    list.  Two clients editing the same recipe in parallel will see
    the second writer's payload overwrite the first's; optimistic
    locking is intentionally not added because recipes are personal
    (single-user) and the conflict surface is therefore vanishingly
    small.
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


@router.post(
    "/{recipe_id}/apply-to/{user_practice_id}",
    response_model=UserPracticeDetail,
)
async def apply_recipe_to_user_practice(
    recipe_id: int,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_practice: Annotated[UserPractice, Depends(require_owned_user_practice)],
    embed: Annotated[EmbeddedSessionsParams, Depends()],
) -> UserPracticeDetail:
    """Materialise a recipe and store it as the UserPractice's override.

    Re-uses ``require_owned_user_practice`` (the same dependency the
    customise endpoint uses) so the ownership rule for overrides is
    enforced in exactly one place.  The materialised config runs through
    ``_validate_mode_config_against_catalog`` -- literally the same gate
    the customise route uses -- so a malformed config returns ``422`` with
    structured per-field errors and a mode mismatch returns ``400
    mode_mismatch``, identical to the customise endpoint's error shapes.
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
    _validate_mode_config_against_catalog(materialised, practice)

    user_practice.mode_config_override = materialised
    session.add(user_practice)
    await session.commit()
    await session.refresh(user_practice)
    # Load the capped recent session history so the response matches what GET
    # ``/user-practices/{id}`` and ``customize_user_practice`` return (the
    # frontend store merges it back, so it must stay present — but bounded,
    # issue #474). Older sessions remain reachable via ``list_sessions``.
    sessions_page = await load_recent_sessions(session, cast("int", user_practice.id), embed)
    logger.info(
        "practice_recipe_applied",
        extra={
            "recipe_id": recipe_id,
            "user_practice_id": user_practice.id,
            "user_id": user_id,
        },
    )
    return build_user_practice_detail(
        user_practice,
        effective_name=effective_name(practice, user_practice),
        effective_config=effective_config(practice, user_practice).model_dump(),
        sessions_page=sessions_page,
    )
