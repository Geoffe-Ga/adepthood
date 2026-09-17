"""Shared response-schema base classes.

:class:`OwnedResourcePublic` is the base every user-scoped response DTO
inherits from.  Its sole job is to lock in the no-``user_id`` invariant
(per the BUG-T7 remediation): the client already knows its own identity
(via the JWT it presented), and exposing surrogate ``user_id`` values aids
enumeration-style attacks (BUG-HABIT-001, BUG-JOURNAL-004,
BUG-SCHEMA-010, BUG-PRACTICE-001).

The class enforces the invariant itself, at class-definition time. It did
not always: this docstring used to say enforcement was "by convention and by
the ``tests/security/test_idor.py`` matrix, which asserts no DTO body contains
a ``user_id`` field". That matrix's scan is a hand-maintained ``probes`` list
naming a fixed handful of endpoints, so the sentence promised a total check
that never existed and a DTO nobody thought to probe could declare the field
with every gate green. :meth:`OwnedResourcePublic.__pydantic_init_subclass__`
now refuses such a subclass at import; the matrix corroborates it on the
responses it does probe, which is a different and weaker thing.

The scope is exactly the DTOs that *inherit* this base -- not every
owned-resource response in the repository, of which there are more.
``tests/security/test_owned_resource_base.py`` takes that census so the
difference stays visible rather than being rounded up to "enforced".
"""

from __future__ import annotations

from typing import Any, Final

from pydantic import BaseModel, ConfigDict

# The one field name an owned-resource response may never carry.
_FORBIDDEN_FIELD: Final = "user_id"


class OwnedResourcePublic(BaseModel):
    """Base for response schemas of user-scoped resources — never adds ``user_id``."""

    model_config = ConfigDict(from_attributes=True)

    def __init_subclass__(cls, **kwargs: Any) -> None:  # noqa: ANN401 - Pydantic's own kwargs
        """Keep cooperative subclass initialisation working under Pydantic."""
        super().__init_subclass__(**kwargs)

    @classmethod
    def __pydantic_init_subclass__(cls, **_kwargs: Any) -> None:  # noqa: ANN401 - as above
        """Refuse a subclass that declares ``user_id``, before it can be returned.

        Pydantic calls this hook once the subclass's fields are built, which is
        the earliest moment ``model_fields`` can be read. Raising here means the
        class object never escapes its own module: an import of the offending
        schema fails, so the failure lands on whoever added the field rather
        than on whoever later noticed a surrogate id in a response body.
        """
        if _FORBIDDEN_FIELD in cls.model_fields:
            msg = (
                f"{cls.__name__} declares {_FORBIDDEN_FIELD!r}: an owned-resource "
                "response never echoes the caller's surrogate id back at them "
                "(BUG-T7). Drop the field — the client already knows who it is."
            )
            raise TypeError(msg)
