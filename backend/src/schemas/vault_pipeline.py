"""What ``GET /vault/pipeline`` answers (#3775): did my files land, and what has run over them.

Three halves, read together by the "Your vault" dashboard (#3776):

* ``recent_uploads`` -- adepthood's own receipts for the documents this account
  sent to its vault, newest first, each with the folder Creek says it landed in
  when Creek could say;
* ``stage_runs`` -- adepthood's own record of the ontologization passes it
  drove on this account's vault, newest first, each with what occasioned it;
* ``vault`` -- Creek's own account of its folders, the account's recent uploads
  and the stages each went through, and its newest jobs, re-projected onto the
  types below.

``vault_status`` says why ``vault`` is ``null`` when it is: no vault connected,
a vault that could not be reached, or a vault on an image that predates the
status read and needs an update to show it. ``vault_unreachable`` is the
outage case alone, so a client can render the existing reachability copy for it
and a plainer "your vault needs an update to show this" for the other.

Every model forbids extra fields. No document body, title or excerpt has a
field here to be put in.
"""

from __future__ import annotations

import enum
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from domain.vault_pipeline_status import (
    VaultDocumentStage,
    VaultFolderWriterlessReason,
    VaultStageOutcome,
    VaultStatusJobKind,
    VaultStatusJobState,
)

_CLOSED = ConfigDict(extra="forbid", frozen=True)


class VaultStatusReach(enum.StrEnum):
    """Whether Creek's half of the answer could be read, and if not, why.

    Attributes:
        OK: ``vault`` carries Creek's answer.
        NOT_CONNECTED: The account has no vault; there is nothing to ask.
        UNREACHABLE: The vault is connected but could not be read right now.
        UPDATE_NEEDED: The vault answers, but on an image older than the
            status read (contract 0.34). It needs an update to show this.
    """

    OK = "ok"
    NOT_CONNECTED = "not_connected"
    UNREACHABLE = "unreachable"
    UPDATE_NEEDED = "update_needed"


class UploadReceiptResponse(BaseModel):
    """One document this account sent to its vault, and how it settled.

    ``destination`` and ``vault_status`` are the import's own answer, persisted
    (``vault``; ``accepted`` and the three ways it was not). ``batch`` is the
    same opaque value for every document of one folder import, and ``null`` for
    a single file; it groups an import without naming its folder. ``landed_in`` is the
    folder Creek reports the document's fragment in, or ``null`` when Creek did
    not say (an older vault, an outage, or an upload past its recent window).
    """

    model_config = _CLOSED

    id: int
    filename: str
    batch: str | None
    destination: str
    vault_status: str
    vault_ref: str | None
    landed_in: str | None
    landed_at: datetime


class StageRunResponse(BaseModel):
    """One ontologization pass adepthood drove on this account's vault.

    ``trigger`` is what occasioned it (``journal_write``, ``document_import``,
    or another trigger as they are added), ``null`` on a run recorded before
    triggers were. ``emitted`` is what the stage produced -- fragments
    classified, or links, eddies or threads -- and ``fragments_lost`` the
    fragments it dropped. ``failure_code`` is a published token on a failed run
    that named one.
    """

    model_config = _CLOSED

    trigger: str | None
    stage: str
    outcome: str
    failure_code: str | None
    fragments_seen: int
    emitted: int
    fragments_lost: int
    ran_at: datetime


class VaultFolderResponse(BaseModel):
    """One ontology folder in the vault: how many notes, and who fills it."""

    model_config = _CLOSED

    path: str
    count: int
    last_written_at: datetime | None
    writer: str | None
    writer_reason: VaultFolderWriterlessReason | None


class VaultStageResponse(BaseModel):
    """One stage stamp on one document."""

    model_config = _CLOSED

    stage: VaultDocumentStage
    at: datetime
    outcome: VaultStageOutcome


class VaultDocumentResponse(BaseModel):
    """One of the account's recent uploads, as Creek reports it."""

    model_config = _CLOSED

    filename: str
    landed_in: str | None
    fragment_count: int
    stages: list[VaultStageResponse]


class VaultJobResponse(BaseModel):
    """One of the vault's newest durable pipeline jobs."""

    model_config = _CLOSED

    kind: VaultStatusJobKind
    method: str
    state: VaultStatusJobState
    failure_code: str | None
    updated_at: datetime


class VaultSnapshotResponse(BaseModel):
    """Creek's half: folders, recent uploads, the withheld count and jobs."""

    model_config = _CLOSED

    folders: list[VaultFolderResponse]
    documents: list[VaultDocumentResponse]
    documents_withheld: int
    jobs: list[VaultJobResponse]


class VaultPipelineResponse(BaseModel):
    """The whole dashboard read.

    ``next_before`` is the cursor for the next page of ``recent_uploads``
    (pass it back as ``?before=``), or ``null`` on the last page.
    """

    model_config = _CLOSED

    recent_uploads: list[UploadReceiptResponse]
    next_before: int | None
    stage_runs: list[StageRunResponse]
    vault: VaultSnapshotResponse | None
    vault_status: VaultStatusReach
    vault_unreachable: bool
