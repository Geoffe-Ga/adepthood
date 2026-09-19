"""Rewrite stored reflection scope keys into the Weekly/Stage/Section/Course vocabulary.

Revision ID: e3a9d1c4b6f2
Revises: b4d2e7a9c1f3
Create Date: 2026-09-19 00:00:00.000000

Issue #2866 retires the ``component`` / ``tier`` / ``program`` review levels in
favour of ``section`` (three stages) and ``course`` (all ten). Stored keys and
levels written under the old vocabulary have to move with it, or the grammar
the application now enforces rejects them and their reviews fall out of every
sources feed.

The mapping is INJECTIVE, and each retired key becomes the key that closes on
the SAME PROGRAM DAY the old review was written on::

    p1 -> s2      weeks 1-6    -> 4-6     closing day 42  = 42
    p2 -> s4      weeks 7-12   -> 10-12   closing day 84  = 84
    p3 -> s6      weeks 13-18  -> 16-18   closing day 126 = 126
    p4 -> s8      weeks 19-24  -> 22-24   closing day 168 = 168
    p5 -> s10     weeks 25-36  -> 31-36   closing day 252 = 252
    t1 -> x2      weeks 1-18   -> 10-18   closing day 126 = 126
    t2 -> x3      weeks 19-36  -> 19-30   closing day 252 -> 210
    prog -> course  weeks 1-36 -> 1-36    closing day 252 = 252
    w<n>, s<n>      unchanged, byte for byte

This DEPARTS from the table in the issue body (``{p2,p3,t1} -> x2`` and
``{p5,t2,prog} -> course``), for two reasons:

* That table is non-injective, and the partial UNIQUE index
  ``ix_journalentry_user_reflection_scope`` is live. ``p2`` (program day 84)
  and ``t1`` (day 126) are both calendar-reachable for ONE user, so the rewrite
  would abort on them. The issue's three constraints -- a total mapping, one
  live review per scope, and never deleting an entry -- cannot all hold under
  it.
* It fabricates coverage by WIDENING. ``p1 -> x1`` turns a six-week review
  (weeks 1-6) into a nine-week claim (weeks 1-9), and because source resolution
  short-circuits on a node's own review, that widened review would then stand
  in for weeks 7-9 forever -- dailies the writer never reflected on, silently
  represented as reflected. Narrowing cannot do this; widening always can.

``t2 -> x3`` is the single departure from same-closing-day, because ``course``
is claimed by ``prog``. ``x3`` opens on exactly the week ``t2`` opens on (week
19) and ends earlier, so it still only narrows. ``t2`` is not reachable from
the calendar at all -- only a hand-written key could produce one -- and the
same is true of ``p3`` and ``p5``.

``s6`` and ``s10`` are grammar-valid and span-correct targets, but the NEW
calendar never makes them due: stage 6 closes as ``x2`` and stage 10 as
``course``. A migrated ``c1:s6`` row therefore still stands in for weeks 16-18
inside ``x2``'s decomposition (and ``c1:s10`` for weeks 31-36 inside
``course``'s), which is the behaviour that matters -- but the invitation band
will not re-offer those scopes. That is intended.

RESIDUAL COLLISIONS. Under this table no two retired tokens share a target, so
a collision needs a pre-existing LIVE row already holding the target key for
that user -- reachable only by a hand-written ``POST /journal``. When it
happens the pre-existing row keeps the key and the row being rewritten is
DEMOTED: ``reflection_level`` and ``reflection_scope_key`` both set to NULL, in
one UPDATE. **No JournalEntry is ever deleted or soft-deleted here.** A demoted
row reopens as an ordinary journal page (the client sees no level, so it never
calls the sources endpoint with a key the grammar would reject) and re-enters
the raw-material pool for any NARROWER scope its writer has not yet reviewed.
It does NOT feed the review that took its key: source resolution returns that
review alone for the node and never descends past it.

Self-containment: a migration is a frozen historical snapshot and cannot import
live application code (``domain.reflection_hierarchy``), so the mapping table,
the level list, the CHECK SQL and the index predicate below are all inlined
literals -- the rule ``c4f7a2b8d9e1``'s own docstring states.

Order matters. The partial unique index is dropped first and recreated LAST, so
the index itself is the migration's collision proof: a rewrite that is not
collision-free fails loudly at ``create_index`` instead of persisting a
duplicate.

The downgrade is deliberately asymmetric and LOSSY. It restores the old level
names and the old CHECK so the previous release can run, but it does NOT
un-map the keys: once new reviews exist, a genuine post-#2866 ``s4`` is
indistinguishable from a migrated ``p2``, so the inverse is ambiguous.
Demotions are not reversed either -- nothing retains which token a NULL-ed row
held. Same register as ``b4d2e7a9c1f3``'s refusal: say what is lost rather than
pretend at symmetry.
"""

import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e3a9d1c4b6f2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b4d2e7a9c1f3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_logger = logging.getLogger("alembic.runtime.migration")

_JOURNAL_TABLE = "journalentry"
_LEVEL_CHECK = "ck_journalentry_reflection_level_valid"
_SCOPE_INDEX = "ix_journalentry_user_reflection_scope"

# Byte-identical to ``models.journal_entry._reflection_level_check()`` rendered
# over the new ReflectionLevel, and to ``c4f7a2b8d9e1``'s literal rendered over
# the old one, so ``alembic check`` sees no drift in either direction.
_LEVEL_CONDITION = (
    "reflection_level IS NULL "
    "OR reflection_level IN ('week', 'stage', 'section', 'course')"
)
_OLD_LEVEL_CONDITION = (
    "reflection_level IS NULL "
    "OR reflection_level IN ('week', 'stage', 'component', 'tier', 'program')"
)

# Copied verbatim from ``c4f7a2b8d9e1``: the partial index's WHERE clause,
# identical for both dialects.
_SCOPE_PREDICATE = "reflection_scope_key IS NOT NULL AND deleted_at IS NULL"

# The mapping table from the docstring, as a literal. TOTAL over every token
# the grammar at ``c4f7a2b8d9e1`` admitted: ``prog``, ``p1``..``p5``,
# ``t1``..``t2`` are listed here; ``w1``..``w36`` and ``s1``..``s10`` are absent
# because they are unchanged, and no other token could ever be written (the
# write path validated every key against that grammar AND its per-level index
# bounds).
_RETIRED_TOKENS = {
    "p1": "s2",
    "p2": "s4",
    "p3": "s6",
    "p4": "s8",
    "p5": "s10",
    "t1": "x2",
    "t2": "x3",
    "prog": "course",
}

# The level each surviving token spells, so the rewritten level is DERIVED from
# the rewritten key rather than carried alongside it. That is what makes the
# pass idempotent and self-healing: re-running it over already-migrated rows
# computes the level they already hold and skips them, and running it after a
# downgrade repairs the levels the downgrade coarsened.
_COURSE_TOKEN = "course"
_LETTER_TO_LEVEL = {"w": "week", "s": "stage", "x": "section"}

# The downgrade's level coarsening: the new wide levels back to the old names
# the previous release's CHECK and enum accept.
_LEVEL_DOWNGRADES = (("section", "component"), ("course", "program"))


def _level_for_token(token: str) -> str:
    """The reflection level a post-migration token spells.

    Total over the image of :data:`_RETIRED_TOKENS` together with the untouched
    ``w``/``s`` tokens, which between them cover every key that can exist.
    """
    if token == _COURSE_TOKEN:
        return _COURSE_TOKEN
    return _LETTER_TO_LEVEL[token[0]]


def _rewrite(connection: sa.Connection, entry_id: int, key: str | None, level: str | None) -> None:
    """Set a row's scope key and level TOGETHER, in one statement.

    Both columns move in a single UPDATE because
    ``ck_journalentry_reflection_scope_paired`` requires them to be set or unset
    together -- two statements would violate it in between.
    """
    connection.execute(
        sa.text(
            "UPDATE journalentry"
            " SET reflection_scope_key = :key, reflection_level = :level"
            " WHERE id = :id"
        ),
        {"key": key, "level": level, "id": entry_id},
    )


def _migrate_scope_keys(connection: sa.Connection) -> None:
    """Rewrite every stored scope key into the new vocabulary, demoting collisions.

    Soft-deleted rows are rewritten too -- the replacement CHECK applies to them
    as well -- but they never collide and are never demoted, because the unique
    index they would collide under excludes them.
    """
    rows = connection.execute(
        sa.text(
            "SELECT id, user_id, reflection_scope_key, reflection_level, deleted_at"
            " FROM journalentry"
            " WHERE reflection_scope_key IS NOT NULL"
            " ORDER BY id"
        )
    ).all()
    live_scopes = {(row.user_id, row.reflection_scope_key) for row in rows if row.deleted_at is None}

    for row in rows:
        prefix, _, token = str(row.reflection_scope_key).partition(":")
        new_token = _RETIRED_TOKENS.get(token, token)
        new_level = _level_for_token(new_token)
        if new_token == token and new_level == row.reflection_level:
            continue
        new_key = f"{prefix}:{new_token}"
        holder = (row.user_id, new_key)
        live = row.deleted_at is None
        # Release this row's OWN claim before testing the target: a row whose
        # key is unchanged and whose level is merely being repaired (the state a
        # downgrade leaves behind) would otherwise collide with itself and be
        # demoted on the re-upgrade.
        live_scopes.discard((row.user_id, row.reflection_scope_key))
        if live and holder in live_scopes:
            _rewrite(connection, row.id, None, None)
            _logger.info(
                "reflection_scope_demoted",
                extra={"entry_id": row.id, "old_key": row.reflection_scope_key, "new_key": new_key},
            )
            continue
        _rewrite(connection, row.id, new_key, new_level)
        if live:
            live_scopes.add(holder)
        _logger.info(
            "reflection_scope_key_migrated",
            extra={
                "entry_id": row.id,
                "old_key": row.reflection_scope_key,
                "new_key": new_key,
                "new_level": new_level,
            },
        )


def upgrade() -> None:
    """Drop the index and CHECK, rewrite the keys, then reinstate both."""
    op.drop_index(_SCOPE_INDEX, table_name=_JOURNAL_TABLE)
    with op.batch_alter_table(_JOURNAL_TABLE) as batch_op:
        batch_op.drop_constraint(_LEVEL_CHECK, type_="check")

    _migrate_scope_keys(op.get_bind())

    with op.batch_alter_table(_JOURNAL_TABLE) as batch_op:
        batch_op.create_check_constraint(_LEVEL_CHECK, _LEVEL_CONDITION)
    op.create_index(
        _SCOPE_INDEX,
        _JOURNAL_TABLE,
        ["user_id", "reflection_scope_key"],
        unique=True,
        postgresql_where=sa.text(_SCOPE_PREDICATE),
        sqlite_where=sa.text(_SCOPE_PREDICATE),
    )


def downgrade() -> None:
    """Coarsen the new level names back to the old ones and restore the old CHECK.

    Keys are NOT un-mapped and demotions are NOT reversed -- see the module
    docstring for why neither inverse exists.
    """
    op.drop_index(_SCOPE_INDEX, table_name=_JOURNAL_TABLE)
    with op.batch_alter_table(_JOURNAL_TABLE) as batch_op:
        batch_op.drop_constraint(_LEVEL_CHECK, type_="check")

    connection = op.get_bind()
    for new_level, old_level in _LEVEL_DOWNGRADES:
        connection.execute(
            sa.text(
                "UPDATE journalentry SET reflection_level = :old WHERE reflection_level = :new"
            ),
            {"old": old_level, "new": new_level},
        )

    with op.batch_alter_table(_JOURNAL_TABLE) as batch_op:
        batch_op.create_check_constraint(_LEVEL_CHECK, _OLD_LEVEL_CONDITION)
    op.create_index(
        _SCOPE_INDEX,
        _JOURNAL_TABLE,
        ["user_id", "reflection_scope_key"],
        unique=True,
        postgresql_where=sa.text(_SCOPE_PREDICATE),
        sqlite_where=sa.text(_SCOPE_PREDICATE),
    )
