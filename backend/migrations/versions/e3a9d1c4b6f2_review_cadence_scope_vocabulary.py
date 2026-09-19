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
    w<n>, s<n>      unchanged, byte for byte (when already canonical)

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

KEYS WITH NO IMAGE. The pass is TOTAL over every byte sequence the column can
hold, and that is a stronger claim than "total over the tokens the grammar
admitted". The previous release spelled indices with a Unicode-aware digit
class and anchored on ``$``, so ``c1:p<FULLWIDTH ONE>``, ``c1:w05`` and
``c1:w5<NEWLINE>`` were all accepted by an ordinary authenticated
``POST /journal`` -- 201, stored verbatim -- and an ``alembic upgrade`` that
aborted on one of them would abort the whole release for every user.
:func:`_mapped_scope` therefore CANONICALISES before mapping: every spelling of
an index resolves to its single ASCII form, and canonical keys come back
byte-identical. A key that is outside both grammars, or whose index is past the
curriculum, has no scope in the new vocabulary at all; such a row can only have
been hand-edited, and it is DEMOTED (below) rather than allowed to stop the
deploy.

RESIDUAL COLLISIONS. Under this table no two retired tokens share a target --
asserted by ``test_review_cadence_mapping_is_injective``, which reads
:data:`_RETIRED_TOKENS` itself -- so a collision needs a pre-existing LIVE row
already holding the target key for that user. That is NOT the exotic case an
earlier draft of this docstring claimed: ``schemas.journal._validate_reflection_scope``
validates a submitted key against the GRAMMAR only, never against the scope
currently due, so any ordinary authenticated client can write ``c1:s2`` before
its ``c1:p1`` predecessor is rewritten. The likeliest route is operational
rather than adversarial: upgrade, roll back (keys are deliberately not
un-mapped), let the previous release re-offer the now-free ``c1:p1``, then roll
forward.

When it happens the pre-existing row keeps the key and the row being rewritten
is DEMOTED: ``reflection_level`` and ``reflection_scope_key`` both set to NULL,
in one UPDATE. **No JournalEntry is ever deleted or soft-deleted here.** A
demoted row reopens as an ordinary journal page (the client sees no level, so it
never calls the sources endpoint with a key the grammar would reject) and
re-enters the raw-material pool for any NARROWER scope its writer has not yet
reviewed. It does NOT feed the review that took its key: source resolution
returns that review alone for the node and never descends past it.

Demotion is the one irreversible act here, so it is also the loudest: the row's
id, owner, old key, old level, the key it lost to and the reason are ARCHIVED in
``_quarantine_reflection_scope_demotion`` and interpolated into a WARNING the
configured ``alembic.ini`` formatter actually renders. ``extra={...}`` would not
have been: that formatter is ``%(levelname)-5.5s [%(name)s] %(message)s``.

Self-containment: a migration is a frozen historical snapshot and cannot import
live application code (``domain.reflection_hierarchy``), so the mapping table,
the level list, the CHECK SQL and the index predicate below are all inlined
literals -- the rule ``c4f7a2b8d9e1``'s own docstring states.

Order matters, but NOT because the index proves anything. The index is dropped
first and recreated last because the rewrite moves keys THROUGH states that
would violate it in flight (``c1:p1`` -> ``c1:s2`` while another row still holds
``c1:s2``). It is not the collision proof, and an earlier draft of this
docstring claimed it was: ``_migrate_scope_keys`` tracks live claims itself and
NULLs the loser, so the row set handed to ``create_index`` is duplicate-free by
construction whatever :data:`_RETIRED_TOKENS` says. Swap in a non-injective
table and the upgrade exits 0 with reviews silently emptied -- it does not
abort. The properties that table actually has are asserted where assertions
belong, over the table itself:
``test_review_cadence_mapping_is_injective`` and
``test_review_cadence_mapping_keeps_each_review_on_its_own_closing_day``, the
second deriving both closing days from the shipped schedule rather than
restating the map.

The downgrade is deliberately asymmetric and LOSSY. It restores the old level
names and the old CHECK so the previous release can run, but it does NOT
un-map the keys: once new reviews exist, a genuine post-#2866 ``s4`` is
indistinguishable from a migrated ``p2``, so the inverse is ambiguous.
Demotions are not reversed either -- nothing ON THE ROW retains which token a
NULL-ed row held, which is precisely why
``_quarantine_reflection_scope_demotion`` exists and why ``downgrade`` keeps it.
Restoring one is a deliberate operator act sourced from that table::

    UPDATE journalentry SET reflection_scope_key = <old_key>,
                            reflection_level = <old_level>
     WHERE id = <entry_id>

Same register as ``b4d2e7a9c1f3``'s refusal: say what is lost, and leave the
receipts, rather than pretend at symmetry.
"""

import logging
import re
from collections.abc import Sequence
from typing import Any

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

# The forensic archive for rows this pass strips. ``migrations/env.py`` excludes
# the ``_quarantine_`` prefix from autogenerate, so the table never registers as
# drift; the convention and its rationale are documented there.
_QUARANTINE_TABLE = "_quarantine_reflection_scope_demotion"

# Why a row lost its scope, as stored in the archive and printed to the console.
_REASON_TARGET_TAKEN = "target_taken"  # another live row already holds the target key
_REASON_UNMAPPABLE = "unmappable_key"  # no key in the new vocabulary spells this scope

# Byte-identical to ``models.journal_entry._reflection_level_check()`` rendered
# over the new ReflectionLevel, and to ``c4f7a2b8d9e1``'s literal rendered over
# the old one, so ``alembic check`` sees no drift in either direction.
_LEVEL_CONDITION = (
    "reflection_level IS NULL OR reflection_level IN ('week', 'stage', 'section', 'course')"
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

# Every key shape this pass can MEET: the grammar
# ``domain.reflection_hierarchy`` enforced at ``c4f7a2b8d9e1`` (inlined
# verbatim -- a migration cannot import live code), UNIONED with this
# migration's own image, because a re-upgrade after a downgrade re-reads rows
# already carrying ``x``/``course`` keys. Anything outside it is a hand-edited
# row and is demoted rather than allowed to abort the deploy.
#
# It keeps the old pattern's LAXITY deliberately -- Unicode-aware ``\d`` and a
# trailing-newline-tolerant ``$`` -- because that laxity is exactly what the
# previous release stored. The live grammar has since been tightened to ASCII
# digits and ``\Z``; this pass is what makes that tightening safe, by
# canonicalising the rows it would otherwise orphan.
_KEY_PATTERN = re.compile(r"^c(\d+):(prog|course|w\d+|s\d+|p\d+|t\d+|x\d+)$")

# Tokens that carry no index, and the 1-based bound on the ones that do --
# the previous release's per-level ``max_index`` plus ``x``'s three sections.
_INDEXLESS_TOKENS = frozenset({"prog", "course"})
_TOKEN_MAX_INDEX = {"w": 36, "s": 10, "p": 5, "t": 2, "x": 3}

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
    ``w``/``s`` tokens, which between them cover every key :func:`_mapped_scope`
    can hand it.

    Raises ``ValueError`` -- never ``KeyError``, and never ``IndexError`` for an
    empty token -- naming the token, the same rule
    ``domain.reflection_hierarchy._token_to_level_index`` follows. This runs
    inside ``alembic upgrade``: a bare ``KeyError: 'p'`` aborts the release for
    every user while naming neither the row nor the key.
    """
    if token == _COURSE_TOKEN:
        return _COURSE_TOKEN
    level = _LETTER_TO_LEVEL.get(token[:1])
    if level is None:
        raise ValueError(f"no reflection level spells token {token!r}")
    return level


def _mapped_scope(key: str) -> tuple[str, str] | None:
    """The ``(key, level)`` a stored scope key becomes, or ``None`` if it has none.

    The spelling is CANONICALISED on the way through, which is what makes the
    pass total over everything the previous release could persist. Its grammar
    spelled indices with a Unicode-aware digit class and ended in a dollar,
    which admits a trailing newline -- so a fullwidth or Arabic-Indic digit, a
    leading zero and a trailing newline were all accepted by an ordinary
    ``POST /journal`` and stored verbatim. ``int()`` reads every one of those
    spellings as the same index, so each resolves to the single ASCII spelling
    of the scope it always meant. A key already
    canonical comes back byte-identical -- ``c{cycle}:w{n}`` rows in particular,
    which ``a1f7c2b9d604``'s anchor reconstruction reads back.

    ``None`` means no scope in the new vocabulary says what this row claims: a
    key outside both grammars, or an index past the curriculum. Neither is
    reachable through the API -- only a hand-edited row -- and the caller
    demotes rather than aborting the deploy over one.
    """
    match = _KEY_PATTERN.match(key)
    if match is None:
        return None
    cycle, token = match.group(1), match.group(2)
    if token not in _INDEXLESS_TOKENS:
        index = int(token[1:])
        if not 1 <= index <= _TOKEN_MAX_INDEX[token[0]]:
            return None
        token = f"{token[0]}{index}"
    new_token = _RETIRED_TOKENS.get(token, token)
    return (f"c{int(cycle)}:{new_token}", _level_for_token(new_token))


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


def _create_quarantine_table() -> None:
    """Create the demotion archive if this database does not have it yet.

    A demotion is the one irreversible thing this migration does, and
    ``downgrade()`` cannot undo it -- nothing on the row retains the token it
    held once both columns are NULL. The archive is therefore the record, and
    the log line its console echo. Portable types only, no surrogate key, and
    ``IF NOT EXISTS`` so a re-run is a no-op; the ``_quarantine_`` prefix keeps
    it out of autogenerate (``migrations/env.py``). Kept across ``downgrade``
    for the same reason ``c1d2e3f4a5b7`` keeps its own: it is the only path
    back for a row an operator later decides was demoted wrongly.
    """
    op.execute(
        f"CREATE TABLE IF NOT EXISTS {_QUARANTINE_TABLE} ("
        " entry_id INTEGER NOT NULL,"
        " user_id INTEGER NOT NULL,"
        " old_key VARCHAR(30) NOT NULL,"
        " old_level VARCHAR(20),"
        " attempted_key VARCHAR(30),"
        " reason VARCHAR(32) NOT NULL,"
        " detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )


def _demote(
    connection: sa.Connection, row: sa.Row[Any], attempted_key: str | None, reason: str
) -> None:
    """Strip a row's scope, archiving and ANNOUNCING what it held first.

    Order matters: the archive row is written before the columns are cleared,
    so a failure between the two leaves an extra forensic row rather than a
    silently emptied review.

    Every identifying field is interpolated into the MESSAGE, not passed
    through ``extra={...}``. ``alembic.ini``'s ``formatter_generic`` renders
    ``%(levelname)-5.5s [%(name)s] %(message)s`` and nothing else, and
    ``migrations/env.py`` loads it, so an ``extra`` field is dropped before the
    operator ever sees it -- five demotions would print five identical bare
    lines while the old keys ceased to exist anywhere. ``c0d1e2f3a4b5`` sets
    the precedent that survives that formatter.
    """
    connection.execute(
        sa.text(
            f"INSERT INTO {_QUARANTINE_TABLE}"  # noqa: S608
            " (entry_id, user_id, old_key, old_level, attempted_key, reason)"
            " VALUES (:entry_id, :user_id, :old_key, :old_level, :attempted_key, :reason)"
        ),
        {
            "entry_id": row.id,
            "user_id": row.user_id,
            "old_key": row.reflection_scope_key,
            "old_level": row.reflection_level,
            "attempted_key": attempted_key,
            "reason": reason,
        },
    )
    _rewrite(connection, row.id, None, None)
    _logger.warning(
        "reflection_scope_demoted: entry_id=%s user_id=%s old_key=%s old_level=%s"
        " attempted_key=%s reason=%s archived_in=%s",
        row.id,
        row.user_id,
        row.reflection_scope_key,
        row.reflection_level,
        attempted_key,
        reason,
        _QUARANTINE_TABLE,
    )


_OUTCOME_REWRITTEN = "rewritten"
_OUTCOME_DEMOTED = "demoted"
_OUTCOME_UNCHANGED = "unchanged"


def _migrate_row(
    connection: sa.Connection, row: sa.Row[Any], live_scopes: set[tuple[int, str]]
) -> str:
    """Move ONE row into the new vocabulary, returning which outcome it took.

    ``live_scopes`` is the set of ``(user_id, key)`` claims still standing, and
    this function is the only thing that edits it. The row's OWN claim is
    released before the target is tested: a row whose key is unchanged and whose
    level is merely being repaired -- the state a downgrade leaves behind --
    would otherwise collide with itself and be demoted on the re-upgrade.
    """
    old_key = str(row.reflection_scope_key)
    live = row.deleted_at is None
    live_scopes.discard((row.user_id, old_key))

    mapped = _mapped_scope(old_key)
    if mapped is None:
        _demote(connection, row, None, _REASON_UNMAPPABLE)
        return _OUTCOME_DEMOTED

    new_key, new_level = mapped
    holder = (row.user_id, new_key)
    if new_key == old_key and new_level == row.reflection_level:
        if live:
            live_scopes.add(holder)  # re-assert the claim released above
        return _OUTCOME_UNCHANGED
    if live and holder in live_scopes:
        _demote(connection, row, new_key, _REASON_TARGET_TAKEN)
        return _OUTCOME_DEMOTED

    _rewrite(connection, row.id, new_key, new_level)
    if live:
        live_scopes.add(holder)
    _logger.info(
        "reflection_scope_key_migrated: entry_id=%s user_id=%s old_key=%s new_key=%s new_level=%s",
        row.id,
        row.user_id,
        old_key,
        new_key,
        new_level,
    )
    return _OUTCOME_REWRITTEN


def _migrate_scope_keys(connection: sa.Connection) -> None:
    """Rewrite every stored scope key into the new vocabulary, demoting collisions.

    Soft-deleted rows are rewritten too -- the replacement CHECK applies to them
    as well -- but they never collide and are never demoted, because the unique
    index they would collide under excludes them.

    The closing summary is the line an operator greps for after a production
    run: a ten-thousand-row pass prints ten thousand per-row lines, and this one
    says whether any of them lost a scope.
    """
    rows = connection.execute(
        sa.text(
            "SELECT id, user_id, reflection_scope_key, reflection_level, deleted_at"
            " FROM journalentry"
            " WHERE reflection_scope_key IS NOT NULL"
            " ORDER BY id"
        )
    ).all()
    live_scopes = {
        (row.user_id, row.reflection_scope_key) for row in rows if row.deleted_at is None
    }

    tally = {_OUTCOME_REWRITTEN: 0, _OUTCOME_DEMOTED: 0, _OUTCOME_UNCHANGED: 0}
    for row in rows:
        tally[_migrate_row(connection, row, live_scopes)] += 1
    _logger.info(
        "reflection_scope_migration: read=%s rewritten=%s demoted=%s unchanged=%s",
        len(rows),
        tally[_OUTCOME_REWRITTEN],
        tally[_OUTCOME_DEMOTED],
        tally[_OUTCOME_UNCHANGED],
    )


def upgrade() -> None:
    """Drop the index and CHECK, rewrite the keys, then reinstate both."""
    op.drop_index(_SCOPE_INDEX, table_name=_JOURNAL_TABLE)
    with op.batch_alter_table(_JOURNAL_TABLE) as batch_op:
        batch_op.drop_constraint(_LEVEL_CHECK, type_="check")

    _create_quarantine_table()
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
