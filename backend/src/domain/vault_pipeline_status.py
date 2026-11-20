"""What a Creek Vault says about its own shape: the values of the 0.34 status read (#3775).

Creek publishes ``GET /v1/pipeline/status`` at contract 0.34 (Creek-Vault#2124):
every folder ``creek init`` scaffolds with how many notes it holds and which
subsystem fills it, the caller's most recent uploads with the stages each
whole-vault pass has run over them, and the caller's newest durable pipeline
jobs. This module holds the values one answer becomes once
:mod:`services.creek_vault_pipeline_status_wire` has parsed it strictly.

**Content-free by construction.** A folder is a path from the scaffold and a
count; a document is the upload's own external id, the filename the writer gave
it, where its fragment landed and a list of stage stamps; a job is an opaque id
and closed vocabulary. No body and no title crosses, and a document with any
fragment above the declared ceiling is never named -- it is counted in
``documents_withheld``.

A leaf: it imports nothing from the rest of the application, so both the client
protocol in :mod:`domain.creek_vault` and the wire parser can depend on it
without a cycle.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from datetime import datetime
from typing import Final

#: The contract minor that publishes the status read. Declared on that one call
#: only, and only to a vault whose handshake lists it; the base pin stays put.
PIPELINE_STATUS_SINCE_MINOR: Final = "0.34"

#: How many documents a status read asks for: Creek's own published default.
PIPELINE_STATUS_DEFAULT_LIMIT: Final = 50

#: The most documents Creek returns on one answer (the published clamp).
PIPELINE_STATUS_MAX_LIMIT: Final = 200

#: The fewest documents a request may ask for: the published query's ``minimum``.
PIPELINE_STATUS_MIN_LIMIT: Final = 1


class VaultFolderWriterlessReason(enum.StrEnum):
    """Why a scaffolded folder has no subsystem that fills it (Creek's closed set).

    Attributes:
        CONTAINER: The folder only holds other folders.
        OWNER_CURATED: The owner puts things here by hand; Creek never does.
        INDEXED_AT_PARENT: Its notes are counted on the parent folder's index.
        TEMPLATE_EXAMPLE: A scaffolded example, not a place writing lands.
    """

    CONTAINER = "container"
    OWNER_CURATED = "owner_curated"
    INDEXED_AT_PARENT = "indexed_at_parent"
    TEMPLATE_EXAMPLE = "template_example"


class VaultDocumentStage(enum.StrEnum):
    """One stage a whole-vault pass may have run over an uploaded document."""

    INGESTED = "ingested"
    CLASSIFIED = "classified"
    PRAXIS_SCANNED = "praxis_scanned"
    LINKED_EMBEDDINGS = "linked:embeddings"
    LINKED_TEMPORAL = "linked:temporal"
    LINKED_EDDIES = "linked:eddies"
    LINKED_THREADS = "linked:threads"


class VaultStageOutcome(enum.StrEnum):
    """How a stage went for one document.

    Attributes:
        OK: The stage covered the document cleanly.
        PARTIAL: It completed but left work for a retry.
        FAILED: It was attempted and refused, with no later success.
    """

    OK = "ok"
    PARTIAL = "partial"
    FAILED = "failed"


class VaultStatusJobKind(enum.StrEnum):
    """Which pass a durable pipeline job is."""

    CLASSIFICATION = "classification"
    LINK = "link"


class VaultStatusJobState(enum.StrEnum):
    """Where a durable pipeline job stands, as Creek reads it."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True)
class VaultFolderStatus:
    """One scaffolded ontology folder: how full it is, and who fills it.

    Exactly one of ``writer`` and ``writer_reason`` is set: a folder some
    subsystem fills names it, and one nothing fills says why, so an empty folder
    that is filling and one that never will read differently.
    """

    path: str
    count: int
    last_written_at: datetime | None
    writer: str | None
    writer_reason: VaultFolderWriterlessReason | None


@dataclass(frozen=True)
class VaultStageRecord:
    """One stage stamp on one document."""

    stage: VaultDocumentStage
    at: datetime
    outcome: VaultStageOutcome


@dataclass(frozen=True)
class VaultDocumentStatus:
    """One of the caller's uploads, where it landed and what has run over it.

    ``external_id`` is the upload's own id, the digest adepthood minted when it
    sent the document, which is how a receipt is matched to its stages.
    ``fragment_path`` is ``None`` when the vault cannot say where it landed.
    """

    external_id: str
    filename: str
    fragment_path: str | None
    fragment_count: int
    stages: tuple[VaultStageRecord, ...]


@dataclass(frozen=True)
class VaultStatusJob:
    """One of the caller's newest durable pipeline jobs.

    ``failure_code`` is a published symbolic token (``request_key_rejected``,
    ``busy``) on a failed job that named one, never vendor text.
    """

    job_id: str
    kind: VaultStatusJobKind
    method: str
    state: VaultStatusJobState
    failure_code: str | None
    updated_at: datetime


@dataclass(frozen=True)
class VaultPipelineStatus:
    """One whole status answer: folders, documents, the withheld count and jobs."""

    folders: tuple[VaultFolderStatus, ...]
    documents: tuple[VaultDocumentStatus, ...]
    documents_withheld: int
    jobs: tuple[VaultStatusJob, ...]
