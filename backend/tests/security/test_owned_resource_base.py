"""``OwnedResourcePublic`` refuses a ``user_id`` field at class-definition time.

The base class used to document an invariant it did not enforce: its module
docstring claimed ``tests/security/test_idor.py`` asserted that no DTO body
carries ``user_id``, when that scan is a hand-maintained ``probes`` list which
names a fixed handful of endpoints. A DTO nobody thought to probe could declare
``user_id`` and every gate stayed green.

So the interpreter holds it now. ``__pydantic_init_subclass__`` runs once per
subclass definition, at import, and raises before the class object escapes.
The honest scope is stated here rather than implied: this covers the DTOs that
*inherit* the base, not every owned-resource response in the repository. The
census test below is what keeps that number visible.
"""

from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path

import pytest
from pydantic import BaseModel

import schemas
from schemas._base import OwnedResourcePublic

_FORBIDDEN_FIELD = "user_id"


def _import_every_schema_module() -> None:
    """Import every module under ``backend/src/schemas`` so subclasses exist."""
    package_dir = Path(schemas.__file__).parent
    for module in pkgutil.iter_modules([str(package_dir)]):
        importlib.import_module(f"schemas.{module.name}")


def _all_subclasses(root: type[BaseModel]) -> set[type[BaseModel]]:
    """Every class reachable by walking ``__subclasses__`` from ``root``."""
    found: set[type[BaseModel]] = set()
    pending: list[type[BaseModel]] = list(root.__subclasses__())
    while pending:
        candidate = pending.pop()
        if candidate in found:
            continue
        found.add(candidate)
        pending.extend(candidate.__subclasses__())
    return found


def test_declaring_user_id_on_an_owned_response_dto_fails_at_import() -> None:
    """Defining the forbidden field raises, so the class never reaches a router."""
    with pytest.raises(TypeError, match=_FORBIDDEN_FIELD):

        class LeakyReceipt(OwnedResourcePublic):
            """A DTO that would echo the caller's surrogate id back at them."""

            user_id: int


def test_a_subclass_without_the_forbidden_field_still_constructs() -> None:
    """The gate refuses one field and leaves every ordinary DTO alone."""

    class CleanReceipt(OwnedResourcePublic):
        """An ordinary owned-resource response."""

        public_id: str

    assert CleanReceipt(public_id="FB-2345678").public_id == "FB-2345678"


def test_no_owned_resource_dto_in_the_repository_declares_user_id() -> None:
    """Every DTO that inherits the base is clean, and the census says how many.

    Scoped to classes defined under ``schemas.`` deliberately. A class whose
    definition raised is still reachable through ``__subclasses__`` -- CPython
    registers a subclass before Pydantic's hook runs -- so the refused class
    the test above defines would otherwise appear here as a repository
    violation, and this census would be reporting on its own sibling test
    instead of on the repository.

    The gate binds only the classes that inherit ``OwnedResourcePublic``.
    Counting them here keeps that scope legible: this is a real floor, not a
    claim about every response DTO in the repository.
    """
    _import_every_schema_module()
    subclasses = {
        cls for cls in _all_subclasses(OwnedResourcePublic) if cls.__module__.startswith("schemas.")
    }

    assert subclasses, "no DTO inherits the base; the gate would bind nothing"
    violators = sorted(cls.__name__ for cls in subclasses if _FORBIDDEN_FIELD in cls.model_fields)
    assert violators == []
