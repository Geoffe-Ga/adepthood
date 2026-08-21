"""Seed one row into every table of the live schema, driven by the schema itself.

The account-deletion tests need a database where the account under test owns a
row *everywhere* it can. Writing that by hand produces the exact failure the
deletion policy exists to prevent: a list that was complete the day it was
written and silently stopped being complete when the next model landed.

So this seeder reads :class:`sqlalchemy.MetaData` instead. Every column that
must be filled is filled — foreign keys from rows already inserted, everything
else synthesised from the column's type. A new model is picked up with no edit
here, and a new model the synthesiser cannot satisfy fails loudly rather than
being skipped.

It deliberately knows nothing about the deletion policy: it fills references
because the *schema* says they exist, so the assertions it enables are a check
on the policy rather than a restatement of it.

``_CONSTRAINED_VALUES`` is the one hand-maintained part, and only because some
columns are governed by a CHECK constraint whose permitted values live in SQL
text the type system cannot see.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, cast

import sqlalchemy as sa
from sqlalchemy import CursorResult, Table
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

# Tables the seeder never writes to, and why.
#
# ``user`` is created through the real signup endpoint, so the seeder inherits a
# genuine account rather than a synthetic one. ``accountdeletionaudit`` is the
# deletion's own output — pre-seeding it would make the receipt assertions
# meaningless. ``revokedtoken`` carries no reference to any account, so a row in
# it proves nothing either way.
UNSEEDED_TABLES = frozenset({"user", "accountdeletionaudit", "revokedtoken"})

# Tables seeded once and shared by every account: the curriculum. Seeding them
# per-account would trip their own uniqueness constraints, which is the schema
# telling us they are not per-account data.
SHARED_TABLES = ("coursestage", "stagecontent")

# Columns whose value a CHECK constraint pins to something the type system
# cannot infer AND that :func:`_enumerated_values` cannot read off the
# constraint itself. Relational checks are the residue — they constrain one
# column against another rather than against a literal set.
_CONSTRAINED_VALUES: dict[str, Any] = {
    # Every anchored-span model in this schema (marginalia, promoted quotes,
    # completion suggestions) carries a ``anchor_end > anchor_start`` check.
    # Keyed on the column name rather than on the table so a fourth one needs
    # no edit here.
    "anchor_end": 2,
}

# Nullable columns the seeder must leave NULL. ``ck_completion_suggestion_target_fk_matches``
# permits exactly one target reference per row, so filling both would be a row
# the application itself could never write.
_OMITTED_COLUMNS = frozenset({"completionsuggestion.user_practice_id"})

# ``<column> IN ('a', 'b', ...)`` — the shape every "valid value set" check in
# this schema is written in. Reading the permitted values straight off the
# constraint is what keeps the seeder honest: a model that adds a new
# enumerated column needs no edit here, and one that changes its permitted set
# cannot leave a stale literal behind.
_IN_CLAUSE = re.compile(r"(\w+)\s+IN\s*\(([^)]*)\)", re.IGNORECASE)
_QUOTED_LITERAL = re.compile(r"'([^']*)'")

_enumerated_cache: dict[str, dict[str, str]] = {}


def _enumerated_values(table: Table) -> dict[str, str]:
    """Map each column the table's CHECK constraints enumerate to a permitted value."""
    cached = _enumerated_cache.get(table.name)
    if cached is not None:
        return cached
    permitted: dict[str, str] = {}
    for constraint in table.constraints:
        if not isinstance(constraint, sa.CheckConstraint):
            continue
        for column_name, values in _IN_CLAUSE.findall(str(constraint.sqltext)):
            literals = _QUOTED_LITERAL.findall(values)
            if literals:
                permitted[column_name] = literals[0]
    _enumerated_cache[table.name] = permitted
    return permitted


_DEFAULT_INT = 1

# A column literally called ``email`` holds an address, whoever wrote it. The
# seeder fills those with the account's real address so a table keyed on the
# email rather than on ``user.id`` (``loginattempt``) is genuinely reachable —
# and so the "the address appears nowhere afterwards" assertion has something
# to find if the sweep misses it.
_EMAIL_COLUMN_NAME = "email"

_USER_TABLE = "user"


@dataclass(frozen=True)
class SeedAccount:
    """The account rows are seeded against."""

    user_id: int
    email: str


def _python_type(column: sa.Column[Any]) -> type | None:
    """The Python type the column round-trips, or ``None`` when it declines to say.

    SQLModel's ``AutoString`` is the common decliner, and it is always a string,
    so ``None`` is read as "text" by the caller.
    """
    try:
        return column.type.python_type
    except NotImplementedError:
        return None


# One value factory per Python type the schema uses. Text is the fallback
# rather than an entry, because ``AutoString`` never names its type.
_SYNTHESISERS: dict[type, Callable[[], Any]] = {
    bool: lambda: False,
    int: lambda: _DEFAULT_INT,
    float: lambda: float(_DEFAULT_INT),
    Decimal: lambda: Decimal(_DEFAULT_INT),
    datetime: lambda: datetime.now(UTC),
    date: lambda: datetime.now(UTC).date(),
    bytes: lambda: b"seed",
}


def _synthesise(column: sa.Column[Any], salt: str) -> Any:  # noqa: ANN401 - column values are Any
    """Produce a value of the column's own type, salted for per-account uniqueness."""
    if isinstance(column.type, sa.JSON):
        return {}
    factory = _SYNTHESISERS.get(_python_type(column) or str)
    return factory() if factory is not None else f"seed-{salt}"


def _foreign_target(column: sa.Column[Any]) -> str | None:
    """The table name this column points at, or ``None`` if it points nowhere."""
    for foreign_key in column.foreign_keys:
        return str(foreign_key.column.table.name)
    return None


def _is_generated_key(column: sa.Column[Any]) -> bool:
    """Whether the database will supply this column's value itself."""
    return bool(column.primary_key and column.autoincrement is not False)


def _reference_value(
    table: Table,
    column: sa.Column[Any],
    account: SeedAccount,
    parent_ids: dict[str, int],
) -> tuple[bool, Any]:
    """Resolve a foreign-key column against rows already inserted."""
    target = _foreign_target(column)
    if target == _USER_TABLE:
        # Written even when nullable: these are exactly the references the
        # deletion policy must clear, so a NULL would make the anonymisation
        # assertions vacuous.
        return True, account.user_id
    parent = parent_ids.get(str(target))
    if parent is None:
        if column.nullable:
            return False, None
        msg = f"{table.name}.{column.name} needs a {target} row the seeder has not made"
        raise LookupError(msg)
    return True, parent


def _scalar_value(
    table: Table,
    column: sa.Column[Any],
    account: SeedAccount,
) -> tuple[bool, Any]:
    """Resolve a column that references nothing, as ``(write?, value)``."""
    if column.name == _EMAIL_COLUMN_NAME:
        return True, account.email
    if column.nullable:
        return False, None
    pinned = _CONSTRAINED_VALUES.get(column.name)
    if pinned is None:
        pinned = _enumerated_values(table).get(column.name)
    if pinned is not None:
        return True, pinned
    return True, _synthesise(column, f"{table.name}-{account.user_id}")


def _column_value(
    table: Table,
    column: sa.Column[Any],
    account: SeedAccount,
    parent_ids: dict[str, int],
) -> tuple[bool, Any]:
    """Decide what (if anything) to write into one column, as ``(write?, value)``."""
    if _is_generated_key(column) or f"{table.name}.{column.name}" in _OMITTED_COLUMNS:
        return False, None
    if column.foreign_keys:
        return _reference_value(table, column, account, parent_ids)
    return _scalar_value(table, column, account)


def _row_values(table: Table, account: SeedAccount, parent_ids: dict[str, int]) -> dict[str, Any]:
    """Build the full INSERT payload for one row of ``table``."""
    values: dict[str, Any] = {}
    for column in table.columns:
        should_write, value = _column_value(table, column, account, parent_ids)
        if should_write:
            values[column.name] = value
    return values


def _user_columns(table: Table) -> tuple[sa.Column[Any], ...]:
    """Columns of ``table`` that point at ``user.id``."""
    return tuple(
        column
        for column in table.columns
        if any(fk.column.table.name == _USER_TABLE for fk in column.foreign_keys)
    )


async def _existing_row_id(
    session: AsyncSession,
    table: Table,
    account: SeedAccount,
) -> int | None:
    """The id of a row this account already owns here, if signup made one.

    Signing up already writes some of these rows (a course entitlement, for
    one), and their uniqueness constraints are per-account. Reusing what is
    there keeps the seeder additive rather than fighting the real signup path.
    """
    user_columns = _user_columns(table)
    if not user_columns or len(table.primary_key.columns) != 1:
        return None
    primary_key = next(iter(table.primary_key.columns))
    clause = sa.or_(*[column == account.user_id for column in user_columns])
    found = await session.execute(sa.select(primary_key).where(clause).limit(1))
    row = found.scalar_one_or_none()
    return int(row) if isinstance(row, int) else None


async def _insert_row(
    session: AsyncSession,
    table: Table,
    account: SeedAccount,
    parent_ids: dict[str, int],
) -> None:
    """Ensure the account owns a row here, remembering its key for dependants."""
    existing = await _existing_row_id(session, table, account)
    if existing is not None:
        parent_ids[table.name] = existing
        return
    payload = _row_values(table, account, parent_ids)
    # ``execute`` is typed as returning a generic ``Result``; an INSERT always
    # produces a ``CursorResult``, which is the only kind that carries the
    # generated key. The cast names that rather than reaching for the attribute
    # and hoping.
    result = cast(
        "CursorResult[Any]",
        await session.execute(sa.insert(table).values(**payload)),
    )
    key = result.inserted_primary_key
    if key is not None and len(key) == 1 and isinstance(key[0], int):
        parent_ids[table.name] = key[0]


def seedable_tables() -> tuple[Table, ...]:
    """Per-account tables, parents before children."""
    return tuple(
        table
        for table in SQLModel.metadata.sorted_tables
        if table.name not in UNSEEDED_TABLES and table.name not in SHARED_TABLES
    )


async def seed_shared_tables(session: AsyncSession) -> dict[str, int]:
    """Insert the account-independent curriculum rows other tables depend on."""
    shared_ids: dict[str, int] = {}
    placeholder = SeedAccount(user_id=_DEFAULT_INT, email="curriculum@example.invalid")
    for name in SHARED_TABLES:
        await _insert_row(session, SQLModel.metadata.tables[name], placeholder, shared_ids)
    await session.commit()
    return shared_ids


async def seed_one_row_everywhere(
    session: AsyncSession,
    account: SeedAccount,
    shared_ids: dict[str, int],
) -> tuple[str, ...]:
    """Give ``account`` a row in every per-account table; return the table names."""
    parent_ids = dict(shared_ids)
    seeded = []
    for table in seedable_tables():
        await _insert_row(session, table, account, parent_ids)
        seeded.append(table.name)
    await session.commit()
    return tuple(seeded)
