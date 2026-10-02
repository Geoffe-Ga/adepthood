"""Add coursestage.stage_key and stage-correspondence provenance (#2665).

Revision ID: d7f9b1c3e5a2
Revises: d6f1a8c4e2b9
Create Date: 2026-10-02 00:00:00.000000

``CourseStage`` becomes the canonical stage-correspondence table (epic #2663)
instead of gaining a parallel mirror. It gets:

* ``stage_key`` -- the Stage's stable colour slug (``beige`` .. ``clearlight``),
  the identity the seeder reconciles by. Added nullable, backfilled from
  ``stage_number`` with a frozen literal list (never imported from ``src``, so
  this revision means the same thing forever), then made NOT NULL and given
  the unique index ``ix_coursestage_stage_key_unique``. A row outside 1..10
  gets the placeholder ``stage-<n>`` rather than failing the deploy; the
  seeder logs it as an orphan and leaves it in place.
* six nullable provenance columns -- ``source_repo``, ``source_sha``,
  ``source_path``, ``source_sha256``, ``artifact_schema_version`` and
  ``reconciled_at`` -- which stay ``NULL`` until the seeder reconciles the row
  from the generated artifact.

No row is inserted, deleted or renumbered, and ids are untouched, so
``stagecontent.course_stage_id`` and every other foreign key still resolve.
``downgrade`` drops the index and the seven columns and keeps the rows.
Wrapped in ``batch_alter_table`` so the SQLite round trip rebuilds the table
while Postgres emits plain ``ALTER TABLE`` statements.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d7f9b1c3e5a2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d6f1a8c4e2b9"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "coursestage"
_STAGE_KEY = "stage_key"
_KEY_INDEX = "ix_coursestage_stage_key_unique"
_LEGACY_KEY_PREFIX = "stage-"

#: The ten Stage keys in program order, frozen at this revision.
FROZEN_STAGE_KEYS = (
    "beige",
    "purple",
    "red",
    "blue",
    "orange",
    "green",
    "yellow",
    "teal",
    "ultraviolet",
    "clearlight",
)

# Column widths, frozen at this revision (mirrored by models.course_stage).
_STAGE_KEY_LENGTH = 32
_SOURCE_REPO_LENGTH = 255
_SOURCE_SHA_LENGTH = 40
_SOURCE_PATH_LENGTH = 512
_SOURCE_SHA256_LENGTH = 64
_SCHEMA_VERSION_LENGTH = 32

_PROVENANCE_COLUMNS = (
    ("source_repo", sa.String(length=_SOURCE_REPO_LENGTH)),
    ("source_sha", sa.String(length=_SOURCE_SHA_LENGTH)),
    ("source_path", sa.String(length=_SOURCE_PATH_LENGTH)),
    ("source_sha256", sa.String(length=_SOURCE_SHA256_LENGTH)),
    ("artifact_schema_version", sa.String(length=_SCHEMA_VERSION_LENGTH)),
    ("reconciled_at", sa.DateTime(timezone=True)),
)


def _backfill_stage_keys() -> None:
    """Set every row's key from its ``stage_number``, placeholder outside 1..10."""
    coursestage = sa.table(
        _TABLE,
        sa.column("stage_number", sa.Integer),
        sa.column(_STAGE_KEY, sa.String),
    )
    stage_number = coursestage.c.stage_number
    key_by_number = {number: key for number, key in enumerate(FROZEN_STAGE_KEYS, start=1)}
    op.execute(
        coursestage.update().values(
            stage_key=sa.case(
                key_by_number,
                value=stage_number,
                else_=sa.literal(_LEGACY_KEY_PREFIX) + sa.cast(stage_number, sa.String),
            )
        )
    )


def upgrade() -> None:
    """Add the key and provenance columns, backfill the key, then constrain it."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(
            sa.Column(_STAGE_KEY, sa.String(length=_STAGE_KEY_LENGTH), nullable=True)
        )
        for name, column_type in _PROVENANCE_COLUMNS:
            batch_op.add_column(sa.Column(name, column_type, nullable=True))
    _backfill_stage_keys()
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.alter_column(
            _STAGE_KEY,
            existing_type=sa.String(length=_STAGE_KEY_LENGTH),
            nullable=False,
        )
        batch_op.create_index(_KEY_INDEX, [_STAGE_KEY], unique=True)


def downgrade() -> None:
    """Drop the key's index and all seven columns; every stage row survives."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_index(_KEY_INDEX)
        for name, _column_type in reversed(_PROVENANCE_COLUMNS):
            batch_op.drop_column(name)
        batch_op.drop_column(_STAGE_KEY)
