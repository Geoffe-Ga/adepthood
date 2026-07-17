"""Shared building blocks for the idempotent startup seeders.

Two patterns recur across the ``seed_*`` modules that populate system
(owner-less) rows on FastAPI startup:

* a natural-key existence lookup, used to skip rows already present, and
* a race-safe commit that treats a concurrent peer's winning insert as a
  no-op.

Collapsing both into one home keeps the individual seeders declarative
and stops the two idioms from drifting apart as new seeders are added.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

#: Column count that selects a two-part composite natural key. One column
#: yields a set of scalars; this many yields a set of ``(a, b)`` tuples.
_COMPOSITE_KEY_WIDTH = 2


async def existing_system_keys(
    session: AsyncSession, *columns: object, owner_col: object | None = None
) -> set[Any]:
    """Return the natural keys of the system rows already in the table.

    ``columns`` is the natural key to read back: pass one column for a
    scalar key (returns a set of values) or two columns for a composite key
    (returns a set of ``(a, b)`` tuples). When ``owner_col`` is supplied the
    query is scoped to ``owner_col IS NULL`` so user-owned rows can't shadow
    a system preset that collides on the same key; omit it to read every row
    (for tables with no owner concept).

    Seeders call this before staging inserts and skip any definition whose
    key is already present, which is what makes re-running the seeder on a
    populated database a no-op.
    """
    # The columns are opaque SQL expressions here, so widen before handing
    # them to the arity-typed ``select`` rather than re-deriving a concrete
    # select overload for every key shape.
    key_columns: Any = columns
    statement = select(*key_columns)
    if owner_col is not None:
        statement = statement.where(col(owner_col).is_(None))
    rows = (await session.execute(statement)).all()
    if len(columns) == _COMPOSITE_KEY_WIDTH:
        return {(row[0], row[1]) for row in rows}
    return {row[0] for row in rows}


async def try_commit_yielding_to_race_winner(session: AsyncSession) -> bool:
    """Commit, reporting whether THIS process won the idempotent-seed race.

    Returns ``True`` when the commit persisted — this process is the race
    winner — and ``False`` when a concurrent peer already committed the same
    unique-keyed rows, tripping the arbitrating index; the loser rolls back
    and reports no win. Exposing the win/loss verdict lets callers suppress
    side effects — log lines, metrics — that would otherwise claim work this
    process rolled back rather than persisted.
    """
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return False
    return True


async def commit_or_yield_to_race_winner(session: AsyncSession, inserted: int) -> int:
    """Commit ``inserted`` new rows, treating a unique-index collision as a no-op.

    This is the one canonical race-safe commit for the idempotent seeders.
    Race-loser path: a peer process committed the same row(s) between our
    existence SELECT and our COMMIT. Roll back and return 0 — the work has
    already been done by the peer — otherwise return ``inserted``.

    It is only meaningful where a database unique index arbitrates
    concurrent startup seeding; without such an index both peers would
    commit and ship the duplicate the guard exists to prevent. The backing
    indexes live in two migrations: ``d2e3f4a5b6c7`` for
    ``Practice(stage_number, name)`` and ``07b8c9d0e1f2`` for the
    ``PracticeTag.slug`` / ``PracticeRecipe.slug`` partial-unique indexes.
    """
    return inserted if await try_commit_yielding_to_race_winner(session) else 0
