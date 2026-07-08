"""Seed system :class:`PracticeTag` + :class:`PracticeRecipe` rows.

Mirrors :mod:`seed_practices` -- defines the preset list, validates
each materialised ``mode_config`` payload at import time so a typo
crashes the seeder (not the runtime), and inserts only what is missing
on a per-call basis.

System recipes are owner_user_id IS NULL so they share one namespace
and are read-only via the API.  Tags are seeded alongside so the
recipe-editor's tag picker has a useful starting library even before
the user creates any of their own.

The five recipes mirror the mindfulness practices a user might pick
for their tier-one habit:

* ``5-4-3-2-1 Grounding`` -- the canonical five-senses descending count.
* ``Find the Rainbow`` -- seven colors x N rounds.
* ``Find Shapes`` -- square / circle / triangle x N rounds.
* ``Four Elements`` -- Buddhist body scan: earth, water, fire, air.
* ``Embodied Mindfulness`` -- pressure-direction body awareness x N rounds.

The match key is ``(slug,)`` scoped to ``owner_user_id IS NULL`` so a
user-created recipe with the same slug under a different owner does
not block a system preset from being inserted.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from domain.practice_modes import PracticeMode
from models.practice_recipe import PracticeRecipe, PracticeRecipeStep
from models.practice_tag import PracticeTag
from schemas.practice_mode_config import ModeConfigAdapter
from schemas.practice_recipe import (
    PracticeRecipeOut,
    PracticeRecipeStepOut,
    materialise_mode_config,
)
from seed_helpers import commit_or_yield_to_race_winner, existing_system_keys

# Default repeat counts for rounds-by-categories recipes.  Three is the
# defacto "enough to settle, not so many you check out" round count the
# user described in the original spec.
_DEFAULT_ROUNDS = 3
# The "Four Elements" recipe is walked once at three observations per
# element -- four elements x three observations matches the rhythm of
# the Buddhist body scan it's based on.
_FOUR_ELEMENTS_PER_ELEMENT = 3


def _system_tag(slug: str, label: str) -> dict[str, str]:
    """Build one system-tag definition (owner_user_id stays NULL at insert)."""
    return {"slug": slug, "label": label}


#: Tag library seeded alongside the recipes.  These are the building
#: blocks every recipe step references; the recipe steps copy the slug
#: + label by value, so removing a tag here later does not break the
#: already-seeded recipes (but does remove it from the picker).
SYSTEM_TAGS: tuple[dict[str, str], ...] = (
    # 5-4-3-2-1
    _system_tag("sight", "Sight"),
    _system_tag("touch", "Touch"),
    _system_tag("hearing", "Hearing"),
    _system_tag("smell", "Smell"),
    _system_tag("taste", "Taste"),
    # Find the Rainbow
    _system_tag("red", "Red"),
    _system_tag("orange", "Orange"),
    _system_tag("yellow", "Yellow"),
    _system_tag("green", "Green"),
    _system_tag("blue", "Blue"),
    _system_tag("indigo", "Indigo"),
    _system_tag("violet", "Violet"),
    # Find Shapes
    _system_tag("square", "Square"),
    _system_tag("circle", "Circle"),
    _system_tag("triangle", "Triangle"),
    # Four Elements
    _system_tag("earth", "Earth"),
    _system_tag("water", "Water"),
    _system_tag("fire", "Fire"),
    _system_tag("air", "Air"),
    # Embodied
    _system_tag("pressing_on_me", "Pressing on me"),
    _system_tag("i_press_on", "I press on"),
    _system_tag("felt_inside", "Felt inside"),
)


def _step(
    tag_slug: str, tag_label: str, prompt_label: str, target_count: int = 1
) -> dict[str, Any]:
    """Build one recipe-step definition."""
    return {
        "tag_slug": tag_slug,
        "tag_label": tag_label,
        "prompt_label": prompt_label,
        "target_count": target_count,
    }


def _build_recipe(meta: dict[str, Any], steps: list[dict[str, Any]]) -> dict[str, Any]:
    """Compose one system recipe definition.

    ``meta`` carries the per-recipe header fields (slug, name,
    description, mode, rounds); ``steps`` is the ordered list of step
    definitions.  Owner is always ``None`` here -- only the seeder
    inserts system recipes.
    """
    return {**meta, "owner_user_id": None, "steps": steps}


def _five_four_three_two_one_steps() -> list[dict[str, Any]]:
    """5-4-3-2-1 canonical step list, one prompt per sense."""
    return [
        _step("sight", "Sight", "Name 5 things you can see", target_count=5),
        _step("touch", "Touch", "Name 4 things you can touch", target_count=4),
        _step("hearing", "Hearing", "Name 3 things you can hear", target_count=3),
        _step("smell", "Smell", "Name 2 things you can smell", target_count=2),
        _step("taste", "Taste", "Name 1 thing you can taste", target_count=1),
    ]


def _find_rainbow_steps() -> list[dict[str, Any]]:
    """Seven rainbow colors; one observation per color per round."""
    return [
        _step("red", "Red", "Find something red"),
        _step("orange", "Orange", "Find something orange"),
        _step("yellow", "Yellow", "Find something yellow"),
        _step("green", "Green", "Find something green"),
        _step("blue", "Blue", "Find something blue"),
        _step("indigo", "Indigo", "Find something indigo"),
        _step("violet", "Violet", "Find something violet"),
    ]


def _find_shapes_steps() -> list[dict[str, Any]]:
    """Three basic shapes; one observation per shape per round."""
    return [
        _step("square", "Square", "Find a square"),
        _step("circle", "Circle", "Find a circle"),
        _step("triangle", "Triangle", "Find a triangle"),
    ]


def _four_elements_steps() -> list[dict[str, Any]]:
    """Buddhist body-element scan: earth, water, fire, air."""
    return [
        _step(
            "earth",
            "Earth",
            "Notice the earth element: solidity, weight, density",
            target_count=_FOUR_ELEMENTS_PER_ELEMENT,
        ),
        _step(
            "water",
            "Water",
            "Notice the water element: fluidity, cohesion, moisture",
            target_count=_FOUR_ELEMENTS_PER_ELEMENT,
        ),
        _step(
            "fire",
            "Fire",
            "Notice the fire element: warmth, heat, temperature",
            target_count=_FOUR_ELEMENTS_PER_ELEMENT,
        ),
        _step(
            "air",
            "Air",
            "Notice the air element: movement, breath, vibration",
            target_count=_FOUR_ELEMENTS_PER_ELEMENT,
        ),
    ]


def _embodied_mindfulness_steps() -> list[dict[str, Any]]:
    """Pressure-direction body awareness: three observations per direction."""
    return [
        _step(
            "pressing_on_me",
            "Pressing on me",
            "Notice something pressing on your body",
        ),
        _step(
            "i_press_on",
            "I press on",
            "Notice something your body is pressing on",
        ),
        _step(
            "felt_inside",
            "Felt inside",
            "Notice a sensation inside your body",
        ),
    ]


#: All system recipes seeded into the recipe library.  Tuple (not list)
#: so callers cannot mutate the seed plan after import.
SYSTEM_RECIPES: tuple[dict[str, Any], ...] = (
    _build_recipe(
        {
            "slug": "five_four_three_two_one",
            "name": "5-4-3-2-1 Grounding",
            "description": (
                "Walk the five senses in descending count.  Anchor attention "
                "by naming five sights, four textures, three sounds, two "
                "smells, one taste."
            ),
            "mode": PracticeMode.SENSE_GROUNDING.value,
            "rounds": 1,
        },
        _five_four_three_two_one_steps(),
    ),
    _build_recipe(
        {
            "slug": "find_the_rainbow",
            "name": "Find the Rainbow",
            "description": (
                "Hunt the seven rainbow colors around you.  Repeat for "
                "several rounds to deepen the noticing."
            ),
            "mode": PracticeMode.TALLIED_GROUNDING.value,
            "rounds": _DEFAULT_ROUNDS,
        },
        _find_rainbow_steps(),
    ),
    _build_recipe(
        {
            "slug": "find_shapes",
            "name": "Find Shapes",
            "description": (
                "Spot the three primitive shapes -- square, circle, triangle "
                "-- in the room you're sitting in.  Repeat for several rounds."
            ),
            "mode": PracticeMode.TALLIED_GROUNDING.value,
            "rounds": _DEFAULT_ROUNDS,
        },
        _find_shapes_steps(),
    ),
    _build_recipe(
        {
            "slug": "four_elements",
            "name": "Four Elements",
            "description": (
                "Buddhist embodied mindfulness: notice earth, water, fire, "
                "and air sensations in your body.  Three observations per "
                "element."
            ),
            "mode": PracticeMode.TALLIED_GROUNDING.value,
            "rounds": 1,
        },
        _four_elements_steps(),
    ),
    _build_recipe(
        {
            "slug": "embodied_mindfulness",
            "name": "Embodied Mindfulness",
            "description": (
                "Three pressures, three counter-pressures, three felt-inside "
                "sensations.  Repeat to settle into the body."
            ),
            "mode": PracticeMode.TALLIED_GROUNDING.value,
            "rounds": _DEFAULT_ROUNDS,
        },
        _embodied_mindfulness_steps(),
    ),
)


def _validate_recipe_materialises(definition: dict[str, Any]) -> None:
    """Build the recipe out shape and round-trip it through ``ModeConfigAdapter``.

    Catches typos in seeded recipes at import time -- a step whose tag
    slug fails the schema pattern, or a recipe whose materialised
    payload does not parse as the declared mode, fails the import
    instead of poisoning the DB on first startup.
    """
    step_outs = [
        PracticeRecipeStepOut(
            position=i,
            tag_slug=step["tag_slug"],
            tag_label=step["tag_label"],
            prompt_label=step["prompt_label"],
            target_count=step["target_count"],
        )
        for i, step in enumerate(definition["steps"])
    ]
    out = PracticeRecipeOut(
        id=0,
        slug=definition["slug"],
        name=definition["name"],
        description=definition["description"],
        owner_user_id=None,
        mode=definition["mode"],
        rounds=definition["rounds"],
        created_at=datetime.now(UTC),
        steps=step_outs,
    )
    materialised = materialise_mode_config(out)
    ModeConfigAdapter.validate_python(materialised)


for _definition in SYSTEM_RECIPES:
    _validate_recipe_materialises(_definition)

# Reject duplicate slugs in the seed plan -- a collision would block
# every later seeder run on the partial-unique index.
_recipe_slugs = [r["slug"] for r in SYSTEM_RECIPES]
if len(set(_recipe_slugs)) != len(_recipe_slugs):
    _dupes = sorted(s for s in _recipe_slugs if _recipe_slugs.count(s) > 1)
    msg = f"Duplicate system recipe slug: {_dupes}"
    raise ValueError(msg)
_tag_slugs = [t["slug"] for t in SYSTEM_TAGS]
if len(set(_tag_slugs)) != len(_tag_slugs):
    _tag_dupes = sorted(s for s in _tag_slugs if _tag_slugs.count(s) > 1)
    msg = f"Duplicate system tag slug: {_tag_dupes}"
    raise ValueError(msg)


async def _seed_system_tags(session: AsyncSession) -> int:
    """Insert system tags not yet present.  Returns inserted row count."""
    existing = await existing_system_keys(
        session, PracticeTag.slug, owner_col=PracticeTag.owner_user_id
    )
    inserted = 0
    for definition in SYSTEM_TAGS:
        if definition["slug"] in existing:
            continue
        session.add(PracticeTag(slug=definition["slug"], label=definition["label"]))
        inserted += 1
    return inserted


async def _insert_recipe_with_steps(session: AsyncSession, definition: dict[str, Any]) -> None:
    """Insert one recipe + its steps, flushing to obtain the recipe PK."""
    recipe = PracticeRecipe(
        slug=definition["slug"],
        name=definition["name"],
        description=definition["description"],
        owner_user_id=None,
        mode=definition["mode"],
        rounds=definition["rounds"],
    )
    session.add(recipe)
    await session.flush()
    recipe_id = recipe.id
    if recipe_id is None:  # pragma: no cover - flush always populates the PK
        msg = "recipe insert failed to populate primary key"
        raise RuntimeError(msg)
    for index, step in enumerate(definition["steps"]):
        session.add(
            PracticeRecipeStep(
                recipe_id=recipe_id,
                position=index,
                tag_slug=step["tag_slug"],
                tag_label=step["tag_label"],
                prompt_label=step["prompt_label"],
                target_count=step["target_count"],
            )
        )


async def _seed_system_recipes(session: AsyncSession) -> int:
    """Insert system recipes not yet present.  Returns inserted row count."""
    existing = await existing_system_keys(
        session, PracticeRecipe.slug, owner_col=PracticeRecipe.owner_user_id
    )
    inserted = 0
    for definition in SYSTEM_RECIPES:
        if definition["slug"] in existing:
            continue
        await _insert_recipe_with_steps(session, definition)
        inserted += 1
    return inserted


async def seed_practice_recipes(session: AsyncSession) -> int:
    """Insert system tags + recipes that don't already exist.

    Returns the total rows inserted (tags + recipes).  Idempotent:
    re-running on a populated DB returns 0.  An :class:`IntegrityError`
    from a peer process winning the race is converted to a no-op so
    concurrent worker startup does not crash.
    """
    tags_inserted = await _seed_system_tags(session)
    recipes_inserted = await _seed_system_recipes(session)
    total = tags_inserted + recipes_inserted
    if not total:
        return 0
    return await commit_or_yield_to_race_winner(session, total)
