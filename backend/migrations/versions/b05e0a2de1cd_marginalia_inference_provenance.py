"""Add inference provenance columns to marginalia (#3062).

Revision ID: b05e0a2de1cd
Revises: e3b5d7f9a1c4
Create Date: 2026-10-07 00:00:00.000000

Records which side answered each margin note and, separately, its letter:

* ``source`` / ``essay_source`` -- ``creek_vault``, ``app_provider`` or
  ``demo`` (the stub provider's canned text);
* ``source_provider`` -- ``anthropic``, ``openai``, ``stub`` or ``creek``;
* ``source_model`` -- the answering side's own report of its model;
* ``receipt_version`` -- the receipt's shape version.

Purely additive and every column nullable, with **no backfill**: ``NULL`` means
"source not recorded", which is the only honest value for a note written before
receipts existed. Nothing here infers a historical row's source from the
account's current vault connection. Each vocabulary column carries a
NULL-tolerant CHECK whose value list is frozen at this revision (never imported
from ``src``, so this revision means the same thing forever; the model derives
the same constraints from its enums). ``downgrade`` drops the CHECKs, then the
columns, and keeps every row. Wrapped in ``batch_alter_table`` so the SQLite
round trip rebuilds the table while Postgres emits plain ``ALTER TABLE``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b05e0a2de1cd"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "e3b5d7f9a1c4"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "marginalia"

# Widths and vocabularies, frozen at this revision (mirrored by models.marginalia).
_SOURCE_LENGTH = 20
_MODEL_LENGTH = 64
FROZEN_SOURCES = ("creek_vault", "app_provider", "demo")
FROZEN_PROVIDERS = ("anthropic", "openai", "stub", "creek")

_VOCABULARY_COLUMNS = (
    ("source", FROZEN_SOURCES),
    ("source_provider", FROZEN_PROVIDERS),
    ("essay_source", FROZEN_SOURCES),
)
_COLUMNS = (
    ("source", sa.String(length=_SOURCE_LENGTH)),
    ("source_provider", sa.String(length=_SOURCE_LENGTH)),
    ("source_model", sa.String(length=_MODEL_LENGTH)),
    ("essay_source", sa.String(length=_SOURCE_LENGTH)),
    ("receipt_version", sa.SmallInteger()),
)


def _check_name(column: str) -> str:
    """Return the CHECK's name, matching the model's ``ck_marginalia_<column>_valid``."""
    return f"ck_marginalia_{column}_valid"


def _check_condition(column: str, values: Sequence[str]) -> str:
    """Return the NULL-tolerant membership condition for ``column``."""
    quoted = ", ".join(f"'{value}'" for value in values)
    return f"{column} IS NULL OR {column} IN ({quoted})"


def upgrade() -> None:
    """Add the five nullable provenance columns and their vocabulary CHECKs."""
    with op.batch_alter_table(_TABLE) as batch_op:
        for name, column_type in _COLUMNS:
            batch_op.add_column(sa.Column(name, column_type, nullable=True))
        for column, values in _VOCABULARY_COLUMNS:
            batch_op.create_check_constraint(_check_name(column), _check_condition(column, values))


def downgrade() -> None:
    """Drop the CHECKs, then the columns; every note survives."""
    with op.batch_alter_table(_TABLE) as batch_op:
        for column, _values in reversed(_VOCABULARY_COLUMNS):
            batch_op.drop_constraint(_check_name(column), type_="check")
        for name, _column_type in reversed(_COLUMNS):
            batch_op.drop_column(name)
