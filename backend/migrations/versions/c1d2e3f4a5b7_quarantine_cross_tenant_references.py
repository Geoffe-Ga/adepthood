"""quarantine and detach forged cross-tenant references

Revision ID: c1d2e3f4a5b7
Revises: b0c1d2e3f4a5
Create Date: 2026-08-08 00:00:00.000000

Issue #2121: remediate the data that issues #2064 and #2065 made possible.

**What a planted row is.** Two body-parameter authorization holes let a caller
name another tenant's object in a field the server never authorized:
``PUT /goals/{id}`` accepted any ``goal_group_id`` (#2064), and
``POST /journal/`` accepted any ``user_practice_id`` /
``practice_session_id`` (#2065). Both write paths are guarded now --
``src/routers/goals.py`` resolves the target group through
``resolve_owned_goal_group`` before assigning it -- but every reference forged
before those guards landed is still sitting in the database, silently exposing
one user's object to another user's screen.

**Why the invariant holds.** A non-NULL ``goal.goal_group_id`` may only ever
name a group owned by the same user who owns the goal's habit. The only writer
that *sets* a non-NULL value is ``PUT /goals/{id}``, which now authorizes the
target; ``_build_default_goals`` in ``src/routers/habits.py`` creates every
default goal ungrouped, group deletion only ever writes ``NULL``, and no
seeder touches the column at all. There is therefore no legitimate producer of
a cross-owner value, and the same reasoning applies to the two journal columns,
whose only writer is the (now-guarded) journal create path.

**Why remediation is DETACH and never DELETE.** A goal and a journal entry are
things a person sat down and wrote. The forgery is in the *link*, not in the
content, so the fix is to null the link and leave the row exactly where its
author put it. Nothing in this migration deletes a user row.

**Why the quarantine table stores ids and reasons only.** It records what was
detached (table, row id, column, the value that was planted, both owner ids,
and the classification) and never any row content. Journal bodies are
encrypted at rest; copying ciphertext into an unmodeled side table would
create a second, less-guarded copy of exactly the data the encryption exists
to protect.

**The ``shared_template`` false positive.** Before the fix a user could
innocently park their OWN goal in an ownerless community template -- that is
not an attack, just a state the UI once allowed. It is unreachable through the
API today. Detaching costs that user a grouping they can recreate in one tap;
leaving it keeps their private goal title visible to every user in the app.
Detach is the privacy-safe default, and the quarantine row is the receipt an
operator uses to put such a goal back by hand.

**Why an ownerless group is always a template.** ``goalgroup.user_id`` is
``ON DELETE SET NULL``, so the obvious worry is that deleting a user turns
their group ownerless and frames an innocent bystander's still-valid goal as
``shared_template``. It cannot happen: nulling ``user_id`` while
``shared_template`` stays false violates
``ck_goalgroup_shared_template_user_id``, so such a delete aborts atomically
rather than committing an ownerless private group. (There is no hard-delete
path for a user today in any case.) ``user_id IS NULL`` therefore means
"shared template" and nothing else.
"""

import logging
from collections.abc import Sequence
from typing import NamedTuple

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c1d2e3f4a5b7"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b0c1d2e3f4a5"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Opt-out marker for the migration round-trip-pattern test: the downgrade is
# deliberately empty, for the reasons spelled out in its docstring.
ALEMBIC_INTENTIONAL_EMPTY_DOWNGRADE = True


_logger = logging.getLogger("alembic.runtime.migration")

_QUARANTINE_TABLE = "_quarantine_cross_tenant_reference"

# Classification of why a reference failed the same-owner invariant.
_REASON_DANGLING = "dangling"  # the referenced row does not exist
_REASON_SHARED_TEMPLATE = "shared_template"  # it exists but is ownerless
_REASON_FOREIGN_OWNER = "foreign_owner"  # it exists and belongs to someone else


class _ReferenceShape(NamedTuple):
    """One (source table, source column) reference that must stay same-owner.

    ``owner_expr`` is the SQL expression that yields the *referencing* row's
    owner, and ``owner_join`` is whatever join that expression needs. A goal
    has no ``user_id`` of its own, so its owner comes from its habit; a
    journal entry carries its owner directly and needs no join.
    """

    source_table: str
    source_column: str
    referenced_table: str
    owner_expr: str
    owner_join: str


_SHAPES: tuple[_ReferenceShape, ...] = (
    _ReferenceShape(
        source_table="goal",
        source_column="goal_group_id",
        referenced_table="goalgroup",
        owner_expr="h.user_id",
        owner_join="JOIN habit h ON h.id = s.habit_id",
    ),
    _ReferenceShape(
        source_table="journalentry",
        source_column="user_practice_id",
        referenced_table="userpractice",
        owner_expr="s.user_id",
        owner_join="",
    ),
    _ReferenceShape(
        source_table="journalentry",
        source_column="practice_session_id",
        referenced_table="practicesession",
        owner_expr="s.user_id",
        owner_join="",
    ),
)

# Column order here is the table's declaration order; ``detected_at`` is
# defaulted rather than inserted.
_QUARANTINE_INSERT_COLUMNS = (
    "source_table",
    "source_row_id",
    "source_column",
    "planted_value",
    "owner_user_id",
    "referenced_owner_user_id",
    "reason",
)


def _create_quarantine_table() -> None:
    """Create the forensic side table if this database does not have it yet.

    Only portable types are used, and the table deliberately has NO surrogate
    primary key: without one, ``INSERT ... SELECT`` needs no dialect-specific
    sequence handling and renders identically on SQLite and Postgres. The
    table is unmodeled on purpose -- ``migrations/env.py`` excludes the
    ``_quarantine_`` prefix from autogenerate so it never registers as drift.

    ``detected_at`` is ``TIMESTAMP WITH TIME ZONE`` to match the conversion
    revision ``78b1620cafde`` applied to every other datetime column in this
    schema: a forensic stamp that cannot say which zone it was taken in is
    worth much less to the operator reading it. SQLite accepts the multi-word
    type name and applies its usual affinity rules.
    """
    op.execute(
        f"CREATE TABLE IF NOT EXISTS {_QUARANTINE_TABLE} ("
        " source_table VARCHAR(64) NOT NULL,"
        " source_row_id INTEGER NOT NULL,"
        " source_column VARCHAR(64) NOT NULL,"
        " planted_value INTEGER NOT NULL,"
        " owner_user_id INTEGER,"
        " referenced_owner_user_id INTEGER,"
        " reason VARCHAR(32) NOT NULL,"
        " detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )


def _detection_tail(shape: _ReferenceShape) -> str:
    """Build the FROM/JOIN/WHERE clause that selects every violating row.

    A reference violates the invariant when its target is missing, ownerless,
    or owned by anyone other than the referencing row's owner. Ownerlessness
    is detected as ``user_id IS NULL`` rather than via a ``shared_template``
    boolean, because boolean literals do not render the same way on SQLite and
    Postgres and the ``goalgroup`` CHECK constraint makes the two conditions
    exactly equivalent anyway.
    """
    clauses = (
        f"FROM {shape.source_table} s",
        shape.owner_join,
        f"LEFT JOIN {shape.referenced_table} r ON r.id = s.{shape.source_column}",
        f"WHERE s.{shape.source_column} IS NOT NULL",
        f"AND (r.id IS NULL OR r.user_id IS NULL OR r.user_id <> {shape.owner_expr})",
    )
    return " ".join(clause for clause in clauses if clause)


def _violation_count(shape: _ReferenceShape) -> int:
    """Count the rows this shape is about to quarantine."""
    count = op.get_bind().scalar(sa.text(f"SELECT count(*) {_detection_tail(shape)}"))
    return int(count or 0)


def _record_violations(shape: _ReferenceShape) -> None:
    """Copy every violating reference into the quarantine table."""
    columns = ", ".join(_QUARANTINE_INSERT_COLUMNS)
    op.execute(
        f"INSERT INTO {_QUARANTINE_TABLE} ({columns})"
        f" SELECT '{shape.source_table}', s.id, '{shape.source_column}',"
        f" s.{shape.source_column}, {shape.owner_expr}, r.user_id,"
        f" CASE WHEN r.id IS NULL THEN '{_REASON_DANGLING}'"
        f" WHEN r.user_id IS NULL THEN '{_REASON_SHARED_TEMPLATE}'"
        f" ELSE '{_REASON_FOREIGN_OWNER}' END"
        f" {_detection_tail(shape)}"
    )


def _detach_violations(shape: _ReferenceShape) -> None:
    """Null every violating reference, leaving the row itself untouched.

    The ``WHERE id IN (...)`` re-runs the DETECTION predicate rather than
    selecting from the quarantine table. Selecting from the quarantine would
    re-null a row that an operator had deliberately restored to a legitimate
    group after reviewing a false positive; re-running the predicate only ever
    touches references that violate the invariant *right now*.

    ``UPDATE ... FROM`` is avoided for the same reason the whole file sticks to
    plain SQL: it is Postgres-only, and this migration also runs on SQLite.
    """
    op.execute(
        f"UPDATE {shape.source_table} SET {shape.source_column} = NULL"
        f" WHERE id IN (SELECT s.id {_detection_tail(shape)})"
    )


def _quarantine_shape(shape: _ReferenceShape) -> int:
    """Record, then detach, every violating reference for one shape.

    Returns the number of references detached so the caller can log a total.
    """
    count = _violation_count(shape)
    if count:
        _record_violations(shape)
        _detach_violations(shape)
        # A non-zero count means the authorization hole was actually
        # exploited on this database -- that operational finding is the whole
        # reason this migration logs rather than working silently.
        _logger.warning(
            "cross_tenant_reference_quarantined: %s.%s -> %d reference(s) detached",
            shape.source_table,
            shape.source_column,
            count,
        )
    else:
        _logger.info(
            "cross_tenant_reference_quarantined: %s.%s -> none found",
            shape.source_table,
            shape.source_column,
        )
    return count


def upgrade() -> None:
    """Record and detach every cross-tenant reference, deleting nothing."""
    _create_quarantine_table()
    total = sum(_quarantine_shape(shape) for shape in _SHAPES)
    if total:
        _logger.warning(
            "cross_tenant_reference_audit: %d forged reference(s) detached; "
            "review %s before restoring any of them.",
            total,
            _QUARANTINE_TABLE,
        )
    else:
        _logger.info("cross_tenant_reference_audit: no forged references found")


def downgrade() -> None:
    """Deliberately a no-op: neither the evidence nor the exposure comes back.

    The quarantine table is kept, not dropped. It is the forensic record of
    what was detached and the only path back for a reference an operator
    later judges legitimate.

    The detached references are deliberately NOT re-planted. Re-planting them
    would recreate a live cross-tenant disclosure -- one user's private goal
    or practice showing up under another user's object -- which is precisely
    the state the upgrade existed to end.

    An operator who has confirmed a specific quarantine row was a false
    positive restores that one reference by hand, sourcing both values from
    ``_quarantine_cross_tenant_reference``::

        UPDATE goal SET goal_group_id = <planted_value> WHERE id = <source_row_id>
    """
