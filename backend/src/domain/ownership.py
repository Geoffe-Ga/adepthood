"""How to find the rows in a table that belong to one account, stated once.

Two features ask the same question of the schema and must never get different
answers. Deletion asks "which rows are this account's, so I can erase them";
export asks "which rows are this account's, so I can hand them back". A second
implementation of that predicate is how the two drift — an account whose
recipe steps are erased but not exported, or exported but not erased, is a
promise broken in one direction or the other.

So the predicate lives here, and both callers pass in their own answer for
"what does this table's parent look like". The module is pure SQLAlchemy Core:
it knows nothing about sessions, models, FastAPI, or either policy.
"""

from __future__ import annotations

import enum
from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import Table, select
from sqlalchemy.sql.elements import ColumnElement


class OwnerKey(enum.StrEnum):
    """Which attribute of the account a table's ownership column carries.

    Almost everything carries the surrogate ``user.id``. ``login_attempt`` is
    the exception: it is written before any account is resolved, so it can only
    key off the address that was typed.
    """

    ID = "id"
    EMAIL = "email"


@dataclass(frozen=True)
class OwnedBy:
    """How to find the rows in a table that belong to one account.

    ``through`` names a parent table when a table has no reference to the
    account and is reached via its owner instead (``goal`` through ``habit``).
    Resolution recurses, so the parent's own rule decides how the parent's rows
    are found.
    """

    column: str
    key: OwnerKey = OwnerKey.ID
    through: str | None = None


# Given a parent table's name, its table object and how *it* is owned. Supplied
# by the caller because the parent's ownership is a fact about that caller's
# policy, not about this module.
ParentLookup = Callable[[str], tuple[Table, OwnedBy]]


def owner_predicate(
    table: Table,
    owned_by: OwnedBy,
    *,
    user_id: int,
    email: str,
    parent_lookup: ParentLookup,
) -> ColumnElement[bool]:
    """Build the WHERE clause selecting exactly one account's rows in ``table``.

    Recurses through :attr:`OwnedBy.through` so a table with no reference to
    the account (``goal``) is reached by way of the one that has (``habit``).
    The recursion is expressed as an ``IN (SELECT id ...)`` rather than a join
    so the same expression composes into a ``DELETE`` and into a ``SELECT``.
    """
    column = table.c[owned_by.column]
    if owned_by.through is not None:
        parent_table, parent_owned_by = parent_lookup(owned_by.through)
        parent_rows = select(parent_table.c.id).where(
            owner_predicate(
                parent_table,
                parent_owned_by,
                user_id=user_id,
                email=email,
                parent_lookup=parent_lookup,
            ),
        )
        return column.in_(parent_rows)
    if owned_by.key is OwnerKey.EMAIL:
        return column == email
    return column == user_id
