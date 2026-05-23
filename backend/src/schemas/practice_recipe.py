"""Wire DTOs for the recipe library + apply endpoints.

Six routes around :class:`models.practice_recipe.PracticeRecipe`:

* ``GET /practice-recipes`` -- list system + caller's personal recipes,
  optionally filtered by mode.
* ``POST /practice-recipes`` -- create a personal recipe (optionally
  forked from a system one client-side; the server treats both paths
  identically).
* ``GET /practice-recipes/{recipe_id}`` -- read one with its steps.
* ``PATCH /practice-recipes/{recipe_id}`` -- replace name / description
  / rounds / steps in a single call.  Steps are wholesale-replaced (not
  diffed) -- much simpler than reconciling positional moves and the
  client always sends the full list anyway.
* ``DELETE /practice-recipes/{recipe_id}`` -- delete a personal recipe.
* ``POST /practice-recipes/{recipe_id}/apply-to/{user_practice_id}`` --
  materialise the recipe into ``UserPractice.mode_config_override``.

System recipes (``owner_user_id IS NULL``) are read-only and the
router rejects mutation with ``403 cannot_modify_system_recipe``.  The
client's "edit a system recipe" flow forks a personal copy via POST
before opening the editor.

The ``materialise_mode_config`` helper turns a recipe into the
``mode_config`` JSON the existing override mechanism expects.  Keeping
that conversion at the schema layer (not the router) means the seed
script can call it too -- the test suite asserts the seeded system
recipes round-trip through ``ModeConfigAdapter`` cleanly.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from domain.practice_modes import PracticeMode
from models.practice_recipe import RECIPE_MODES
from schemas.practice_mode_config import (
    TALLIED_CATEGORIES_MAX,
    TALLIED_ROUNDS_MAX,
    TALLIED_TARGET_MAX,
)
from schemas.practice_tag import TAG_LABEL_MAX, TAG_SLUG_MAX, TAG_SLUG_PATTERN

# Bounds mirror schemas.practice_mode_config so a recipe that validates
# here always serialises into a mode_config that validates against
# ``ModeConfigAdapter`` downstream.
_RECIPE_SLUG_MAX = 64
_RECIPE_SLUG_PATTERN = r"^[a-z][a-z0-9_]*$"
_RECIPE_NAME_MAX = 255
_RECIPE_DESCRIPTION_MAX = 2_000
_PROMPT_LABEL_MAX = 255
_STEPS_MIN = 1
_STEPS_MAX = TALLIED_CATEGORIES_MAX
_ROUNDS_MIN = 1
_ROUNDS_MAX = TALLIED_ROUNDS_MAX
_TARGET_COUNT_MIN = 1
_TARGET_COUNT_MAX = TALLIED_TARGET_MAX
# ``sense_grounding`` mode has no concept of rounds-by-categories: the
# user walks the prompt list once.  Recipes built for that mode are
# pinned to a single round to keep the materialised payload valid.
SENSE_GROUNDING_ROUNDS = 1

RecipeMode = Annotated[str, Field(pattern="|".join(RECIPE_MODES))]


class PracticeRecipeStepOut(BaseModel):
    """One step row in a recipe read response."""

    model_config = ConfigDict(from_attributes=True)

    position: int
    tag_slug: str
    tag_label: str
    prompt_label: str
    target_count: int


class PracticeRecipeOut(BaseModel):
    """List / read response for one recipe row."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    name: str
    description: str
    owner_user_id: int | None
    mode: str
    rounds: int
    created_at: datetime
    steps: list[PracticeRecipeStepOut] = Field(default_factory=list)


class PracticeRecipeStepInput(BaseModel):
    """One step row in a create / update request body.

    ``position`` is intentionally absent -- the router assigns
    positions from the list index so the client never has to keep two
    representations of order in sync.
    """

    tag_slug: str = Field(min_length=1, max_length=TAG_SLUG_MAX, pattern=TAG_SLUG_PATTERN)
    tag_label: str = Field(min_length=1, max_length=TAG_LABEL_MAX)
    prompt_label: str = Field(min_length=1, max_length=_PROMPT_LABEL_MAX)
    target_count: int = Field(ge=_TARGET_COUNT_MIN, le=_TARGET_COUNT_MAX)


def _check_steps_invariants(steps: list[PracticeRecipeStepInput], mode: str) -> None:
    """Reject duplicate slugs within one recipe; analytics keys must be unique.

    Extracted as a free function so the create + update validators stay
    at xenon rank A and share one rule rather than drifting.
    """
    if mode == PracticeMode.TALLIED_GROUNDING.value:
        seen: set[str] = set()
        for step in steps:
            if step.tag_slug in seen:
                msg = f"duplicate tag_slug within recipe: {step.tag_slug!r}"
                raise ValueError(msg)
            seen.add(step.tag_slug)


def _check_rounds_for_mode(rounds: int, mode: str) -> None:
    """Sense-grounding recipes are walked once; pin rounds to 1 for that mode."""
    if mode == PracticeMode.SENSE_GROUNDING.value and rounds != SENSE_GROUNDING_ROUNDS:
        msg = f"sense_grounding recipes require rounds == {SENSE_GROUNDING_ROUNDS}"
        raise ValueError(msg)


class PracticeRecipeCreate(BaseModel):
    """Body accepted by ``POST /practice-recipes``.

    The router stamps ``owner_user_id`` from the JWT subject.  Clients
    cannot create a system recipe.
    """

    slug: str = Field(min_length=1, max_length=_RECIPE_SLUG_MAX, pattern=_RECIPE_SLUG_PATTERN)
    name: str = Field(min_length=1, max_length=_RECIPE_NAME_MAX)
    description: str = Field(min_length=0, max_length=_RECIPE_DESCRIPTION_MAX, default="")
    mode: RecipeMode
    rounds: int = Field(ge=_ROUNDS_MIN, le=_ROUNDS_MAX, default=SENSE_GROUNDING_ROUNDS)
    steps: list[PracticeRecipeStepInput] = Field(min_length=_STEPS_MIN, max_length=_STEPS_MAX)

    @model_validator(mode="after")
    def _check_invariants(self) -> Self:
        _check_rounds_for_mode(self.rounds, self.mode)
        _check_steps_invariants(self.steps, self.mode)
        return self


class PracticeRecipeUpdate(BaseModel):
    """Body accepted by ``PATCH /practice-recipes/{recipe_id}``.

    Replaces the editable fields wholesale.  ``slug`` and ``mode`` are
    immutable post-create -- renaming the slug would break any
    UserPractice that captured the recipe by id, and switching mode
    would invalidate every step's tag mapping.
    """

    name: str = Field(min_length=1, max_length=_RECIPE_NAME_MAX)
    description: str = Field(min_length=0, max_length=_RECIPE_DESCRIPTION_MAX, default="")
    rounds: int = Field(ge=_ROUNDS_MIN, le=_ROUNDS_MAX, default=SENSE_GROUNDING_ROUNDS)
    steps: list[PracticeRecipeStepInput] = Field(min_length=_STEPS_MIN, max_length=_STEPS_MAX)


def _materialise_sense_grounding(steps: list[PracticeRecipeStepOut]) -> dict[str, Any]:
    """Build a ``sense_grounding`` ``mode_config`` from a recipe's steps.

    Each step contributes ``target_count`` consecutive prompts with the
    same label so a 5-4-3-2-1 step ("sight, count=5, label='Name 5
    things you can see'") produces one prompt -- the count is encoded
    in the label.  Repetition only happens for tallied recipes.
    """
    return {
        "mode": PracticeMode.SENSE_GROUNDING.value,
        "prompts": [{"sense": step.tag_slug, "label": step.prompt_label} for step in steps],
    }


def _materialise_tallied_grounding(
    steps: list[PracticeRecipeStepOut], rounds: int
) -> dict[str, Any]:
    """Build a ``tallied_grounding`` ``mode_config`` from a recipe's steps."""
    return {
        "mode": PracticeMode.TALLIED_GROUNDING.value,
        "rounds": rounds,
        "categories": [
            {
                "key": step.tag_slug,
                "label": step.tag_label,
                "target_count": step.target_count,
            }
            for step in steps
        ],
    }


def materialise_mode_config(recipe: PracticeRecipeOut) -> dict[str, Any]:
    """Turn a recipe into the ``mode_config`` JSON the override mechanism expects.

    Dispatch on ``recipe.mode``.  The result is intended to be passed
    straight to :class:`schemas.practice.UserPracticeCustomize` as the
    ``mode_config_override`` field, where the existing validator runs
    it through :data:`schemas.practice_mode_config.ModeConfigAdapter`
    against the catalog mode.
    """
    if recipe.mode == PracticeMode.SENSE_GROUNDING.value:
        return _materialise_sense_grounding(recipe.steps)
    if recipe.mode == PracticeMode.TALLIED_GROUNDING.value:
        return _materialise_tallied_grounding(recipe.steps, recipe.rounds)
    # Unreachable: ``mode`` is constrained by RECIPE_MODES at the
    # schema and DB layers.  Defensive raise keeps mypy happy and
    # surfaces a clear error if a new mode is added to RECIPE_MODES
    # without updating this dispatcher.
    msg = f"unsupported recipe mode: {recipe.mode!r}"
    raise ValueError(msg)
