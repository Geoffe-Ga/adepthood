"""Tests for the closed recipe-mode discriminator.

``mode`` names a member of a fixed, small set that the DB stores in a
``varchar(32)`` column guarded by a CHECK constraint.  A validator that
merely *searches* the request value for a known mode admits every string
that contains one, so these tests pin the field to the set itself.
"""

from __future__ import annotations

from typing import Any, Final

import pytest
from pydantic import ValidationError

from domain.practice_modes import PracticeMode
from models.practice_recipe import RECIPE_MODES
from schemas.practice_recipe import PracticeRecipeCreate

_AFFIX_LENGTH: Final = 40
# Declaration order, not membership: see the drift-pin test below.
_EXPECTED_MODE_ORDER: Final = (
    PracticeMode.SENSE_GROUNDING.value,
    PracticeMode.TALLIED_GROUNDING.value,
)
_TALLIED_ROUNDS: Final = 2
# Longer than the varchar(32) the mode column declares, so an accepted
# value reaches Postgres as a truncation error rather than a rejection.
_OVERLONG_MODE: Final = ("X" * _AFFIX_LENGTH) + "sense_grounding" + ("Y" * _AFFIX_LENGTH)


def _steps() -> list[dict[str, Any]]:
    """Minimal single-step list satisfying the step-count bounds."""
    return [
        {
            "tag_slug": "sight",
            "tag_label": "Sight",
            "prompt_label": "Name 5 things you can see",
            "target_count": 5,
        },
    ]


def _recipe_payload(mode: str, rounds: int) -> dict[str, Any]:
    """Smallest body ``PracticeRecipeCreate`` accepts, varying only mode and rounds."""
    return {
        "slug": "my_recipe",
        "name": "My Recipe",
        "description": "",
        "mode": mode,
        "rounds": rounds,
        "steps": _steps(),
    }


@pytest.mark.parametrize(
    ("mode", "rounds"),
    [
        ("xsense_grounding", 1),
        ("sense_groundingx", 1),
        (_OVERLONG_MODE, 3),
    ],
    ids=["prefixed", "suffixed", "overlong"],
)
def test_mode_containing_a_known_value_is_rejected_at_the_field(mode: str, rounds: int) -> None:
    """A string that merely contains a declared mode is not a declared mode.

    The ``loc`` assertion proves the rejection happens on ``mode`` itself:
    the overlong case pairs an invalid mode with ``rounds=3``, which a
    sense-grounding recipe forbids, and a closed set rejects the mode
    before that whole-model rule is ever consulted.
    """
    with pytest.raises(ValidationError) as excinfo:
        PracticeRecipeCreate.model_validate(_recipe_payload(mode, rounds))

    assert [error["loc"] for error in excinfo.value.errors()] == [("mode",)]


@pytest.mark.parametrize(
    ("mode", "rounds"),
    [
        (PracticeMode.SENSE_GROUNDING.value, 1),
        (PracticeMode.TALLIED_GROUNDING.value, _TALLIED_ROUNDS),
    ],
)
def test_declared_mode_is_accepted_and_round_trips_as_str(mode: str, rounds: int) -> None:
    """Closing the set must not close the door on the real modes.

    ``mode`` stays a plain ``str`` so serialisation to the wire and to the
    ``varchar`` column is unchanged by how the field is validated.
    """
    recipe = PracticeRecipeCreate.model_validate(_recipe_payload(mode, rounds))

    assert recipe.mode == mode
    assert type(recipe.mode) is str


def test_recipe_modes_are_declared_in_check_constraint_order() -> None:
    """``RECIPE_MODES`` order is load-bearing, so this pins a tuple and not a set.

    ``_recipe_mode_check`` renders the ``ck_practicerecipe_mode_valid``
    SQL by joining these values in order, so a reordering rewrites the
    constraint the applied migration already created.
    """
    assert RECIPE_MODES == _EXPECTED_MODE_ORDER


def test_published_mode_schema_enumerates_instead_of_matching() -> None:
    """The published contract lists the modes and advertises no pattern.

    An unanchored pattern in the document is what lets a contract fuzzer
    generate the padded near-misses above; an enum narrows generation to
    values the column and the CHECK constraint can actually hold.
    """
    mode_schema = PracticeRecipeCreate.model_json_schema()["properties"]["mode"]

    assert mode_schema["enum"] == ["sense_grounding", "tallied_grounding"]
    assert "pattern" not in mode_schema
