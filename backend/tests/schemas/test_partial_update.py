"""A PATCH schema must refuse an explicit null instead of forwarding it.

Both partial-update schemas in this application declare their fields as
optional booleans so that an omitted field means "leave it alone".  That
annotation also makes an explicit ``null`` a *valid* value, and
``model_dump(exclude_unset=True)`` cannot tell the two apart: a field the
caller set to null is set.  The router therefore assigns ``None`` into a NOT
NULL Boolean column and the caller gets a 500 for a body the schema accepted.

The remedy is one shared base rather than two fixed schemas.  The defect exists
twice today because the second schema is a copy of the first, so a fix applied
twice would be copied a third time the next time somebody needs a PATCH body.
The base carries both halves: the emptiness check that keeps a no-op PATCH away
from the database, and the OpenAPI adjustment that keeps a non-nullable field
with a default from publishing that default as though the server would supply
it.  Every field then declares a plain ``bool`` whose default is the column's
own, and an explicit null fails in Pydantic with a per-field ``loc`` -- which
is what the endpoint tests in ``tests/security`` assert against.

Two things are pinned here that a status code cannot reach.

``type == "bool_type"`` at a ``loc`` naming the field proves the *annotation*
did the rejecting.  The emptiness validator already answers 422 for a body of
all-nulls today, so a test that only asserted "a ValidationError was raised"
would pass against the unfixed schema.

The published contract is read from the live ``app.openapi()`` render, never
from the committed ``openapi.json``.  That file is a derived artifact whose
freshness has its own gate; reading it here would make each of the two gates
depend on the other's health.  A field published as ``anyOf: [boolean, null]``
is a field the contract still promises to accept a null for, whatever the
runtime does -- and a published ``default`` on a partial update tells a client
the server will supply a value it will not.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from main import app
from schemas.depth_preferences import DepthPreferencesUpdate
from schemas.partial_update import PartialUpdateModel
from schemas.ui_flags import UiFlagsUpdate

# Pydantic's code for "this is not a boolean".  Only the declared annotation
# can produce it, which is what separates this rejection from the emptiness
# validator's ``value_error``.
_NOT_A_BOOLEAN = "bool_type"

_EMPTY_BODY_MESSAGE = "at least one field must be provided"

# Every partial-update field, with the default its column carries: the rings
# default enabled, the UI flags default disabled.  Pairing the two here is what
# lets the tests below assert that a schema default did not drift away from the
# column it stands in for.
_TOGGLES: tuple[tuple[type[PartialUpdateModel], str, bool], ...] = (
    (DepthPreferencesUpdate, "enable_habits", True),
    (DepthPreferencesUpdate, "enable_practices", True),
    (DepthPreferencesUpdate, "enable_course", True),
    (DepthPreferencesUpdate, "enable_sangha", True),
    (UiFlagsUpdate, "has_seen_welcome", False),
    (UiFlagsUpdate, "energy_scaffolding_archived", False),
)

_MODEL_FIELDS = [(model, field) for model, field, _ in _TOGGLES]

_MODELS = [DepthPreferencesUpdate, UiFlagsUpdate]


@pytest.mark.parametrize(("model", "field"), _MODEL_FIELDS)
def test_an_explicit_null_is_refused_field_by_field(
    model: type[PartialUpdateModel], field: str
) -> None:
    """A null for any single field must fail as a type error naming that field.

    Driven through ``model_validate`` on a plain dict rather than through the
    constructor, because that is how the value actually arrives -- and because
    once the annotation stops being nullable, a keyword argument of ``None``
    would be a static type error in this file rather than a runtime rejection
    in the schema.
    """
    with pytest.raises(ValidationError) as caught:
        model.model_validate({field: None})

    entries = caught.value.errors()
    assert any(
        entry["type"] == _NOT_A_BOOLEAN and list(entry["loc"]) == [field] for entry in entries
    ), f"a null for {field!r} was not refused as a non-boolean: {entries!r}"


@pytest.mark.parametrize("model", _MODELS)
def test_an_empty_body_is_refused_by_the_shared_validator(
    model: type[PartialUpdateModel],
) -> None:
    """A PATCH that sets nothing must be refused before it reaches the database."""
    with pytest.raises(ValidationError) as caught:
        model.model_validate({})

    assert _EMPTY_BODY_MESSAGE in str(caught.value)


@pytest.mark.parametrize(("model", "field", "default"), _TOGGLES)
def test_a_field_set_to_its_own_default_is_still_dumped(
    model: type[PartialUpdateModel], field: str, *, default: bool
) -> None:
    """Setting a field to the value it already has is a set field, not an omission.

    The router applies exactly what ``exclude_unset=True`` yields, so this is
    the whole of "only the fields the caller sent are written".  Both halves
    matter: a field the caller named appears even when its value equals the
    default, and no field the caller left out appears at all.
    """
    dumped = model.model_validate({field: default}).model_dump(exclude_unset=True)

    assert dumped == {field: default}


@pytest.mark.parametrize(("model", "field", "default"), _TOGGLES)
def test_each_field_defaults_to_the_value_its_column_carries(
    model: type[PartialUpdateModel], field: str, *, default: bool
) -> None:
    """A non-nullable partial-update field must default to its column's default.

    Making the fields non-nullable means each one needs a default, and the only
    defensible one is the value the column itself starts at -- anything else
    would be a second, quieter source of truth for what a fresh row looks like.
    """
    assert model.model_fields[field].default is default


@pytest.mark.parametrize(("model", "field"), _MODEL_FIELDS)
def test_the_published_schema_declares_a_plain_boolean(
    model: type[PartialUpdateModel], field: str
) -> None:
    """The contract must promise a boolean, with no null branch and no default."""
    published = app.openapi()["components"]["schemas"][model.__name__]["properties"][field]

    assert published.get("type") == "boolean", (
        f"{model.__name__}.{field} is not published as a boolean: {published!r}"
    )
    assert "anyOf" not in published, (
        f"{model.__name__}.{field} still publishes a null branch, so the contract "
        f"goes on accepting the value that breaks the column: {published!r}"
    )
    assert "default" not in published, (
        f"{model.__name__}.{field} publishes a default, telling a client the server "
        f"supplies a value on a partial update that it does not: {published!r}"
    )


@pytest.mark.parametrize("model", _MODELS)
def test_both_partial_updates_share_one_base(model: type[PartialUpdateModel]) -> None:
    """Both schemas must inherit the shared base, so the twin cannot silently return.

    The emptiness rule and the schema adjustment are identical in both places
    today.  Asserting the inheritance rather than the behaviour is what stops a
    third partial-update schema from being written as a third copy.
    """
    assert issubclass(model, PartialUpdateModel)
    assert model is not PartialUpdateModel
