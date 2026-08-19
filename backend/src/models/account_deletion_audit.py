"""Content-free receipt for a completed account deletion.

Deletion is an auditable *event*, not an implicit state: after the user row and
everything hanging off it is gone, something has to be able to answer "did this
account's erasure actually run, when, and how much did it reach?" — for a
support request, for a regulator, and for the operator debugging a half-applied
policy.

The receipt is deliberately as thin as that question allows. It stores the
surrogate ``user_id`` (which now names nobody, because the row it pointed at is
gone), the wall-clock instant, per-table row counts, and the vault disposition
string. It stores **no** column values from the erased rows — journal bodies are
encrypted at rest and copying any of them, or the account's email, into an
un-encrypted side table would recreate exactly the data the erasure removed.

There is no foreign key to ``user``: the row this receipt is about no longer
exists, and a constraint pointing at it would either block the deletion or
delete the receipt with it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Column, DateTime, String, func
from sqlmodel import Field, SQLModel

# Width for the vault-disposition token. It is a short symbolic value
# (``not_purged``), not prose, so a small fixed width keeps a future value from
# growing into a free-text field nobody can query.
_DISPOSITION_COLUMN_WIDTH = 32


class AccountDeletionAudit(SQLModel, table=True):
    """One row per completed account deletion; content-free by construction.

    ``row_counts`` maps table name to the number of rows the erasure removed
    from it. Counts are the strongest evidence that can be kept without keeping
    content: they prove the sweep reached each table, and they say nothing about
    what any of those rows contained.
    """

    __tablename__ = "accountdeletionaudit"

    id: int | None = Field(default=None, primary_key=True)
    # Plain integer, not a foreign key -- see the module docstring.
    user_id: int = Field(index=True, nullable=False)
    deleted_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(
            DateTime(timezone=True),
            server_default=func.now(),
            nullable=False,
            index=True,
        ),
    )
    rows_erased: int = Field(default=0, nullable=False)
    row_counts: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSON, nullable=False, server_default="{}"),
    )
    vault_disposition: str = Field(
        sa_column=Column(String(_DISPOSITION_COLUMN_WIDTH), nullable=False),
    )
