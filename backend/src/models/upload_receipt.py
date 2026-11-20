"""A receipt for each document an account sent to its vault: where it went, how it settled.

``POST /corpus/import`` answers a vault upload with ``destination``,
``vault_status`` and ``vault_ref``, and until #3775 nothing kept them: the
answer was rendered once and forgotten, so "did my files land?" had no answer
after the request that asked. One row here is written for every import that
reached the vault branch, whatever it settled as, and ``GET /vault/pipeline``
reads them back newest first.

**Names and refs, never content.** ``filename`` is the name the writer gave the
file and ``batch`` a digest of the folder import's namespace -- enough to
group one import's receipts together without keeping the folder's name, which
the import path treats as private and never logs; ``external_id``
is the digest adepthood addressed the upload by (:func:`
services.creek_vault_upload.upload_external_id`), which is how a receipt is
matched to the stages Creek reports for that upload; ``vault_ref`` is Creek's
opaque handle. No byte of the document is stored, and an Intimate document --
which never leaves adepthood -- earns no receipt at all.

The receipt is the account's own record of what it sent, so it is carried in the
data export and erased with the account (``domain.data_export`` and
``domain.account_deletion``).
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, SQLModel

from domain.corpus_import import ImportDestination
from domain.creek_vault import VaultUploadStatus

# Widths: the request schema's own bound for the filename, the batch digest's
# fixed length (``services.upload_receipts.BATCH_DIGEST_CHARS``), the digest id's
# prefix plus 32 hex characters with headroom, and Creek's published external id
# bound for the vault's opaque ref. The two vocabularies get the
# ``corpusconsentevent`` convention rather than today's longest member.
_FILENAME_WIDTH = 255
_BATCH_WIDTH = 16
_EXTERNAL_ID_WIDTH = 64
_VAULT_REF_WIDTH = 512
_VOCABULARY_WIDTH = 32


def _quoted(values: tuple[str, ...]) -> str:
    """Render enum values as the quoted SQL literal list a CHECK reads."""
    return ", ".join(f"'{value}'" for value in values)


class UploadReceipt(SQLModel, table=True):
    """One settled vault import: what was sent, how it settled, and its ref."""

    __tablename__ = "uploadreceipt"

    # The only read is "this account's receipts, newest first, before a cursor",
    # so the composite carries the filter and the ordering key; ``user_id`` gets
    # no index of its own because the composite serves it as a prefix.
    __table_args__ = (
        Index("ix_uploadreceipt_user_id_id", "user_id", "id"),
        CheckConstraint(
            f"destination IN ({_quoted(tuple(d.value for d in ImportDestination))})",
            name="ck_uploadreceipt_destination_valid",
        ),
        CheckConstraint(
            f"vault_status IN ({_quoted(tuple(s.value for s in VaultUploadStatus))})",
            name="ck_uploadreceipt_vault_status_valid",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    filename: str = Field(max_length=_FILENAME_WIDTH)
    batch: str | None = Field(default=None, max_length=_BATCH_WIDTH)
    external_id: str = Field(max_length=_EXTERNAL_ID_WIDTH)
    vault_ref: str | None = Field(default=None, max_length=_VAULT_REF_WIDTH)
    destination: str = Field(max_length=_VOCABULARY_WIDTH)
    vault_status: str = Field(max_length=_VOCABULARY_WIDTH)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
