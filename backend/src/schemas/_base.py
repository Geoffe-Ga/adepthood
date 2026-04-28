"""Shared response-schema base classes.

:class:`OwnedResourcePublic` is the base every user-scoped response DTO
inherits from.  Its sole job is to lock in the no-``user_id`` invariant
(per the BUG-T7 remediation): the client already knows its own identity
(via the JWT it presented), and exposing surrogate ``user_id`` values aids
enumeration-style attacks (BUG-HABIT-001, BUG-JOURNAL-004,
BUG-SCHEMA-010, BUG-PRACTICE-001).

The base is empty by design -- enforcement is by convention and by the
``tests/security/test_idor.py`` matrix, which asserts no DTO body contains
a ``user_id`` field.  Inheriting from this class is the documentation
hook future contributors will see when adding a new owned-resource DTO.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class OwnedResourcePublic(BaseModel):
    """Base for response schemas of user-scoped resources — never adds ``user_id``."""

    model_config = ConfigDict(from_attributes=True)
