"""The press that ends a bulk upload, and the run it starts (#3773).

``batch_id`` is the ``upload_run`` id the client minted for the queue run and
sent with every document of it, so it carries the same pattern and bounds as
:data:`schemas.journal_upload.UPLOAD_RUN_PATTERN`. It names no database row:
runs are looked up by the caller's own account *and* this id, so another
account's batch id reads as a batch never pressed, never as theirs.

``landed`` is how many of the run's documents the client saw land. It decides
nothing about the pass -- the vault classifies whatever it holds -- and is kept
on the run as the client's own account of the batch. A press that landed
nothing is refused: there is nothing new for a pass to weave in.
"""

from __future__ import annotations

from datetime import datetime
from typing import Final

from pydantic import BaseModel, Field

from models.vault_bulk_import_run import BulkImportRunState, BulkImportStopReason
from schemas.journal_upload import (
    MAX_UPLOAD_RUN_LENGTH,
    MIN_UPLOAD_RUN_LENGTH,
    UPLOAD_RUN_PATTERN,
)

#: The fewest documents a press may report: one, or there is nothing to settle.
MIN_BULK_IMPORT_LANDED: Final[int] = 1
#: A ceiling on the client's count, so the stored integer stays a count of
#: documents somebody could have uploaded rather than whatever a caller sends.
MAX_BULK_IMPORT_LANDED: Final[int] = 100_000


class BulkImportCompleteRequest(BaseModel):
    """One drained upload run: its id, and how many of its documents landed."""

    batch_id: str = Field(
        min_length=MIN_UPLOAD_RUN_LENGTH,
        max_length=MAX_UPLOAD_RUN_LENGTH,
        pattern=UPLOAD_RUN_PATTERN,
        description="The upload_run id every document of the drained run was sent with.",
    )
    landed: int = Field(
        ge=MIN_BULK_IMPORT_LANDED,
        le=MAX_BULK_IMPORT_LANDED,
        description="How many of the run's documents landed in the vault.",
    )


class BulkImportRunResponse(BaseModel):
    """One batch's vault pass, as the client follows it (``models.vault_bulk_import_run``).

    ``stop_reason`` is set only on a ``stopped`` run, and ``finished_at`` on
    every run that is neither ``queued`` nor ``running``. Per-stage outcomes
    live on the pipeline's own rows, which the vault dashboard reads.
    """

    batch_id: str
    state: BulkImportRunState
    stop_reason: BulkImportStopReason | None = None
    landed: int = Field(ge=0)
    started_at: datetime
    finished_at: datetime | None = None


class BulkImportCompleteResponse(BaseModel):
    """The batch's run, or ``null`` for a batch this account never pressed."""

    run: BulkImportRunResponse | None = None
