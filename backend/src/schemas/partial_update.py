"""Shared base for a PATCH body: what "the caller did not send this" has to mean.

A partial update has to tell three states apart for every field -- omitted, set
to one value, set to the other -- and Pydantic offers exactly one mechanism for
it: ``model_fields_set``, which is what ``model_dump(exclude_unset=True)``
reads.  The tempting shortcut is to declare each field ``bool | None = None``
and read ``None`` as "omitted".  That conflates the two states that matter.  An
explicit JSON ``null`` validates against the annotation, is reported as *set*,
and is assigned straight into a NOT NULL column, so a body the published schema
accepted becomes a driver error inside the handler and reaches the caller as a
500 -- for a request the server itself agreed to.

Subclasses therefore declare plain, non-nullable fields whose default is the
value their own column starts at.  An explicit null then fails inside Pydantic
with a ``bool_type`` code and a ``loc`` naming the field, which is strictly
better than any check the handler could run: the defect stops being
representable rather than being caught later.  Omission goes on meaning "leave
this alone", because it is ``model_fields_set`` and never the value that
decides what gets written.

The emptiness rule lives here too, so a PATCH that sets nothing is refused
before it reaches the database.  It asks ``model_fields_set`` rather than
inspecting the values, which is what the two hand-copied validators it replaces
got wrong: they tested ``all(value is None ...)`` and so read an explicitly null
field as an absent one -- the same conflation, one layer up.

Non-nullable fields need defaults, and a default is published into OpenAPI
unless something takes it out.  On a partial update that publication is a lie of
exactly the species this module exists to stop: omitting a field means "leave it
unchanged", not "apply the default", so a generated client that read the
published default and sent it back would overwrite rings the user never touched.
:func:`_drop_published_defaults` strips it from the rendered contract while the
runtime default goes on doing its invisible job of making the field
non-nullable.
"""

from __future__ import annotations

from typing import Any, Self

from pydantic import BaseModel, ConfigDict, model_validator

# The refusal a body that names no field at all earns.  Named because both the
# schema tests and the endpoint contract match on the text.
EMPTY_PATCH_MESSAGE = "at least one field must be provided"

# The JSON Schema keys this module reads: the properties map of a rendered
# object schema, and the per-property default it removes from each entry.
_PROPERTIES_KEY = "properties"
_DEFAULT_KEY = "default"


def _drop_published_defaults(schema: dict[str, Any]) -> None:
    """Remove every per-property ``default`` from a rendered partial-update schema.

    Mutates in place and returns nothing because that is the contract Pydantic's
    callable form of ``json_schema_extra`` defines: it hands the finished schema
    over and keeps whatever is left behind.
    """
    for published_property in schema.get(_PROPERTIES_KEY, {}).values():
        published_property.pop(_DEFAULT_KEY, None)


class PartialUpdateModel(BaseModel):
    """A PATCH body whose fields are non-nullable and whose defaults stay unpublished.

    Subclasses add nothing but their fields: the emptiness rule and the schema
    adjustment are inherited, so a third partial update cannot become a third
    copy of either.
    """

    model_config = ConfigDict(json_schema_extra=_drop_published_defaults)

    @model_validator(mode="after")
    def _require_at_least_one_field(self) -> Self:
        """Refuse a body that named no field, so a no-op PATCH never reaches the row."""
        if not self.model_fields_set:
            raise ValueError(EMPTY_PATCH_MESSAGE)
        return self
