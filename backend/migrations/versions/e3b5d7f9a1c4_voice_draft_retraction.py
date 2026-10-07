"""Add durable Voice Draft withdrawal obligations and journal destination binding (#3060).

Revision ID: e3b5d7f9a1c4
Revises: d7f9b1c3e5a2
Create Date: 2026-10-07 00:00:00.000000

Two additive, content-free changes:

* ``voicedraftretraction`` -- one row per (account, marginalia) recording that
  an essay was offered to a vault (``mirror_intent``), that its withdrawal is
  owed (``pending``), or that the destination confirmed it absent
  (``confirmed``). Ids, a closed state, a closed failure code, an attempt
  count, an opaque destination fingerprint and timestamps only.
* ``journalentry.vault_destination`` -- the opaque fingerprint of the vault an
  entry was offered to, so a withdrawal is trusted only from that vault.

The backfill is conservative because nothing local recorded which existing
essays reached a vault: every expanded note of an account that had a vault at
migration time -- a stored connection, or the deployment vault's bound owner
(read from the environment as the application reads it) -- is treated as
possibly mirrored. An account with neither could not have mirrored anything
and gets no row; a row there could never confirm, because the local fallback
confirms nothing, and would block deleting that writer's own pages. An account
that disconnected its vault before this revision is the one gap: its earlier
mirrors are not recorded (the pre-revision code would equally have treated
them as absent).
It reads ``essay_generated_at`` (paired with ``essay`` by a CHECK) so the
encrypted essay column is never touched. Rows land as ``confirmed`` for a
soft-deleted entry (deletion completes only after confirmed withdrawal),
``pending`` for an Intimate entry (its best-effort retraction may have failed
silently before this revision), and ``mirror_intent`` otherwise. The legacy
rows carry no destination, which means "unbound": they are retried against
whichever vault is connected, exactly as before this revision.

``downgrade`` drops the table and the column; no other row changes.
"""

import os
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e3b5d7f9a1c4"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d7f9b1c3e5a2"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "voicedraftretraction"
_ENTRY_TABLE = "journalentry"
_DESTINATION_COLUMN = "vault_destination"

# Widths and vocabularies frozen at this revision (mirrored by
# models.voice_draft_retraction and models.journal_entry).
_STATE_WIDTH = 16
_FAILURE_CODE_WIDTH = 32
_DESTINATION_WIDTH = 32
_STATES = ("mirror_intent", "pending", "confirmed")
_FAILURE_CODES = (
    "vault_unavailable",
    "capability_missing",
    "vault_error",
    "not_deleted",
    "destination_changed",
)
_INTIMATE = "intimate"


def _quoted(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _create_table() -> None:
    """Create the obligation table with its closed vocabularies and indexes."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("user.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "journal_entry_id",
            sa.Integer(),
            sa.ForeignKey("journalentry.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("marginalia_id", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=_STATE_WIDTH), nullable=False),
        sa.Column("destination", sa.String(length=_DESTINATION_WIDTH), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("safe_failure_code", sa.String(length=_FAILURE_CODE_WIDTH), nullable=True),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            f"state IN ({_quoted(_STATES)})",
            name="ck_voicedraftretraction_state_valid",
        ),
        sa.CheckConstraint(
            f"safe_failure_code IS NULL OR safe_failure_code IN ({_quoted(_FAILURE_CODES)})",
            name="ck_voicedraftretraction_failure_code_valid",
        ),
        sa.CheckConstraint(
            "attempt_count >= 0",
            name="ck_voicedraftretraction_attempt_count_range",
        ),
    )
    op.create_index(
        "ix_voicedraftretraction_user_marginalia_unique",
        _TABLE,
        ["user_id", "marginalia_id"],
        unique=True,
    )
    op.create_index(
        "ix_voicedraftretraction_state_next_attempt",
        _TABLE,
        ["state", "next_attempt_at"],
    )
    op.create_index(
        "ix_voicedraftretraction_journal_entry_id",
        _TABLE,
        ["journal_entry_id"],
    )


_BACKFILL_SQL = (
    "INSERT INTO voicedraftretraction "
    "(user_id, journal_entry_id, marginalia_id, state, attempt_count, "
    "created_at, updated_at, confirmed_at) "
    "SELECT m.user_id, m.journal_entry_id, m.id, "
    "CASE WHEN j.deleted_at IS NOT NULL THEN :confirmed "
    "WHEN j.classification = :intimate THEN :pending "
    "ELSE :mirror_intent END, "
    "0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, "
    "CASE WHEN j.deleted_at IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END "
    "FROM marginalia m JOIN journalentry j ON j.id = m.journal_entry_id "
    "WHERE m.essay_generated_at IS NOT NULL "
    "AND (m.user_id IN (SELECT user_id FROM uservaultconfig) OR m.user_id = :deployment_owner)"
)

# The deployment-wide vault's owner binding, read as the application reads it.
# Frozen here as names rather than imported from ``src`` so this revision means
# the same thing forever.
_VAULT_URL_ENV = "CREEK_VAULT_URL"
_OWNER_ENV = "CREEK_VAULT_OWNER_USER_ID"
#: Matches no account: ids are positive.
_NO_OWNER = -1


def _deployment_owner() -> int:
    """The account the deployment-wide vault belongs to at migration time, if any."""
    raw_owner = os.environ.get(_OWNER_ENV, "").strip()
    if not os.environ.get(_VAULT_URL_ENV, "").strip() or not raw_owner.isdigit():
        return _NO_OWNER
    return int(raw_owner)


def _backfill() -> None:
    """Record every existing expanded note as possibly mirrored, content-free."""
    op.get_bind().execute(
        sa.text(_BACKFILL_SQL),
        {
            "confirmed": "confirmed",
            "pending": "pending",
            "mirror_intent": "mirror_intent",
            "intimate": _INTIMATE,
            "deployment_owner": _deployment_owner(),
        },
    )


def upgrade() -> None:
    """Create the obligation table, backfill it, and add the destination column."""
    _create_table()
    _backfill()
    with op.batch_alter_table(_ENTRY_TABLE) as batch_op:
        batch_op.add_column(
            sa.Column(_DESTINATION_COLUMN, sa.String(length=_DESTINATION_WIDTH), nullable=True)
        )


def downgrade() -> None:
    """Drop the destination column and the obligation table."""
    with op.batch_alter_table(_ENTRY_TABLE) as batch_op:
        batch_op.drop_column(_DESTINATION_COLUMN)
    op.drop_index("ix_voicedraftretraction_journal_entry_id", table_name=_TABLE)
    op.drop_index("ix_voicedraftretraction_state_next_attempt", table_name=_TABLE)
    op.drop_index("ix_voicedraftretraction_user_marginalia_unique", table_name=_TABLE)
    op.drop_table(_TABLE)
