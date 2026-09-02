"""The ladder gets a memory, so a vault is ontologized without being nagged.

Revision ID: c7e4b91a2d38
Revises: 4e1a9c72bd60
Create Date: 2026-09-01 00:00:00.000000

Adepthood drives a connected vault through Creek's batch pipeline -- one
classification pass, then three linker stages -- from two ordinary request
paths: a journal save and a document import. Both run on user activity, so what
keeps the pipeline from being asked for on every keystroke is an interval, and
an interval needs a stamp that outlives the request that wrote it. This table is
that stamp, one row per attempted stage.

One row per *attempt*, including the ones that failed, which is why it is not
modelled as a nullable "last succeeded at" column. A failure that left no stamp
would be retried by the next request that came along, turning a vault refusing
one stage into a request-rate loop against it; and because a failing stage's own
window closes behind it, the stages further down the ladder get their turn
instead of being starved by the one in front.

It is not a column on ``uservaultconfig``, and the reason is a whole population
rather than a preference: an account reaching a deployment-wide vault has no row
in that table at all, so a stamp kept there would silently exempt every one of
them from every interval it defines.

Content-free by construction. A stage name and an outcome from two closed sets,
three counts, and an instant -- which is the widest thing Creek's two pipeline
responses say about a pass in the first place: they publish counts and no id, no
path, no title, no excerpt and no error string, precisely so a pass over a whole
vault can be reported to a caller admitted to only part of it.

``downgrade`` drops the table, which loses every stamp. The cost is bounded and
worth stating: with no stamps, the next request from each account runs the
ladder once and writes new ones, so the effect of the loss is one extra pass per
account rather than anything unrecoverable.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c7e4b91a2d38"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "4e1a9c72bd60"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "vaultpipelinerun"
_INDEX = "ix_vaultpipelinerun_user_id_stage_id"

# The widths and the permitted sets are repeated here rather than imported from
# the model, so this migration keeps describing the schema it created even after
# the model moves on. That is the standing rule for every migration in this
# directory: a migration is a historical record, and one that read today's
# vocabulary would rewrite its own history every time the vocabulary changed.
_STAGE_WIDTH = 20
_OUTCOME_WIDTH = 20
_STAGE_CHECK = "stage IN ('classify', 'temporal', 'eddies', 'threads')"
_OUTCOME_CHECK = "outcome IN ('completed', 'incomplete', 'failed')"


def upgrade() -> None:
    """Create the pipeline-attempt log."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("stage", sqlmodel.sql.sqltypes.AutoString(length=_STAGE_WIDTH), nullable=False),
        sa.Column(
            "outcome", sqlmodel.sql.sqltypes.AutoString(length=_OUTCOME_WIDTH), nullable=False
        ),
        sa.Column("fragments_seen", sa.Integer(), nullable=False),
        sa.Column("fragments_touched", sa.Integer(), nullable=False),
        sa.Column("fragments_lost", sa.Integer(), nullable=False),
        sa.Column("ran_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(_STAGE_CHECK, name="ck_vaultpipelinerun_stage_valid"),
        sa.CheckConstraint(_OUTCOME_CHECK, name="ck_vaultpipelinerun_outcome_valid"),
        sa.CheckConstraint("fragments_seen >= 0", name="ck_vaultpipelinerun_fragments_seen_range"),
        sa.CheckConstraint(
            "fragments_touched >= 0", name="ck_vaultpipelinerun_fragments_touched_range"
        ),
        sa.CheckConstraint("fragments_lost >= 0", name="ck_vaultpipelinerun_fragments_lost_range"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(_INDEX, _TABLE, ["user_id", "stage", "id"])


def downgrade() -> None:
    """Drop the log, at the cost of one extra pipeline pass per account."""
    op.drop_index(_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
