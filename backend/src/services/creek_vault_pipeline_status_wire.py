"""The wire half of Creek's pipeline status read (contract 0.34, Creek-Vault#2124, #3775).

``GET /v1/pipeline/status?limit=`` answers what the vault has done with the
caller's uploads: every scaffolded ontology ``folder`` with its count and the
subsystem that fills it (or the closed reason nothing does), the caller's most
recent ``documents`` with the stages each whole-vault pass ran over them, the
count of documents withheld above the declared ceiling, and the caller's newest
durable ``jobs``. This module holds the request path, the static messages, and
the one parser that turns an answer into
:class:`~domain.vault_pipeline_status.VaultPipelineStatus`.

**Not a new capability name.** Creek serves the route to any caller declaring
0.34 and answers an earlier minor with ``409 incompatible_version``, so the gate
is the minor alone: :func:`pipeline_status_offered` asks whether the handshake
listed 0.34, and the adapter declares 0.34 on this read only. Telemetry and
messages are keyed by :attr:`~domain.creek_vault.CreekCapability.PIPELINE`, the
capability this read reports on.

**Strict.** The models mirror the published ``PipelineStatusResponse`` schema
field for field and forbid anything else, so a field Creek never published --
a title, a body -- or a value outside a closed vocabulary refuses the *whole*
answer as a :class:`~domain.creek_vault.CreekVaultPayloadError`.

**Declared at ``personal``.** The read is ceiling-governed: a document with any
fragment above the declared ceiling is withheld and only counted. ``personal``
is the widest ceiling the wire can spell, and the pipeline's own; it never
names an intimate document.

**Nothing here logs, and nothing a vault sent reaches an exception.**
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC
from typing import Annotated, Final, Literal, Protocol
from urllib.parse import urlencode
from uuid import UUID

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

from domain.creek_vault import (
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    HandshakeResult,
    WireTierCeiling,
)
from domain.vault_pipeline_status import (
    PIPELINE_STATUS_MAX_LIMIT,
    PIPELINE_STATUS_MIN_LIMIT,
    PIPELINE_STATUS_SINCE_MINOR,
    VaultDocumentStage,
    VaultDocumentStatus,
    VaultFolderStatus,
    VaultFolderWriterlessReason,
    VaultPipelineStatus,
    VaultStageOutcome,
    VaultStageRecord,
    VaultStatusJob,
    VaultStatusJobKind,
    VaultStatusJobState,
)
from services.creek_vault_call_errors import HTTP_CALL_FAILED_ERRORS, HTTP_CALL_TIMED_OUT_ERRORS
from services.creek_vault_telemetry import (
    VaultCallTimedOutError,
    VaultTelemetryOutcome,
    record_vault_outcome,
)

#: Where the read is asked for, relative to the configured base URL.
PIPELINE_STATUS_PATH: Final = "/v1/pipeline/status"

#: The ceiling the read is declared at: the widest the wire can spell.
PIPELINE_STATUS_CEILING: Final = WireTierCeiling.PERSONAL

#: The published ``PipelineFolderStatus.path`` pattern: a scaffolded folder.
FOLDER_PATH_PATTERN: Final = "^(?:0[1-9]|1[01])-[A-Za-z-]+(?:/[A-Za-z0-9-]+)*$"

#: The published ``PipelineFolderStatus.writer`` pattern: a subsystem token.
WRITER_PATTERN: Final = "^[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+)*$"

#: The published ``PipelineDocumentStatus.fragment_path`` pattern: under 01-Fragments.
FRAGMENT_PATH_PATTERN: Final = "^01-Fragments/(?:[^/\\x00-\\x1f]+/)*[^/\\x00-\\x1f]+\\.md$"

#: Every published job method: the classification methods, then the link methods.
JOB_METHODS: Final = ("rules", "llm", "temporal", "eddies", "threads", "embeddings")

#: Every published job failure code.
JOB_FAILURE_CODES: Final = ("request_key_rejected", "busy")

# The published bounds (``PipelineStatusResponse.schema.json``).
_FOLDER_PATH_MAX_LENGTH: Final = 128
_FOLDERS_MAX_ITEMS: Final = 256
_JOBS_MAX_ITEMS: Final = 10
_EXTERNAL_ID_MAX_LENGTH: Final = 512
_FILENAME_MAX_LENGTH: Final = 255
_FRAGMENT_PATH_MAX_LENGTH: Final = 1024
_STAGES_MAX_ITEMS: Final = len(VaultDocumentStage)
_MIN_ONE: Final = 1

_LIMIT_PARAM: Final = "limit"

# The static messages, built the way every other capability's are.
PIPELINE_STATUS_FAILED_MESSAGE: Final = f"creek vault call failed: {CreekCapability.PIPELINE.value}"
PIPELINE_STATUS_UNSUPPORTED_MESSAGE: Final = (
    f"creek vault capability unsupported: {CreekCapability.PIPELINE.value}"
)
PIPELINE_STATUS_UNREADABLE_MESSAGE: Final = (
    f"creek vault returned an unreadable response: {CreekCapability.PIPELINE.value}"
)
_LIMIT_MESSAGE: Final = (
    f"pipeline status limit must be between {PIPELINE_STATUS_MIN_LIMIT} "
    f"and {PIPELINE_STATUS_MAX_LIMIT}"
)

_CLOSED: Final = ConfigDict(extra="forbid", strict=True, frozen=True)

_JobMethod = Literal["rules", "llm", "temporal", "eddies", "threads", "embeddings"]
_JobFailureCode = Literal["request_key_rejected", "busy"]


class _WireFolder(BaseModel):
    """``PipelineFolderStatus``: five fields, and never a sixth."""

    model_config = _CLOSED

    path: Annotated[str, Field(max_length=_FOLDER_PATH_MAX_LENGTH, pattern=FOLDER_PATH_PATTERN)]
    count: Annotated[int, Field(ge=0)]
    last_written_at: AwareDatetime | None
    writer: Annotated[str, Field(pattern=WRITER_PATTERN)] | None
    writer_reason: VaultFolderWriterlessReason | None


class _WireStage(BaseModel):
    """``PipelineStageRecord``: three fields."""

    model_config = _CLOSED

    stage: VaultDocumentStage
    at: AwareDatetime
    outcome: VaultStageOutcome


class _WireDocument(BaseModel):
    """``PipelineDocumentStatus``: five fields, and never a body or a title."""

    model_config = _CLOSED

    external_id: Annotated[str, Field(min_length=_MIN_ONE, max_length=_EXTERNAL_ID_MAX_LENGTH)]
    filename: Annotated[str, Field(min_length=_MIN_ONE, max_length=_FILENAME_MAX_LENGTH)]
    fragment_path: (
        Annotated[str, Field(max_length=_FRAGMENT_PATH_MAX_LENGTH, pattern=FRAGMENT_PATH_PATTERN)]
        | None
    )
    fragment_count: Annotated[int, Field(ge=_MIN_ONE)]
    stages: Annotated[list[_WireStage], Field(min_length=_MIN_ONE, max_length=_STAGES_MAX_ITEMS)]


class _WireJob(BaseModel):
    """``PipelineJobSummary``: six fields of opaque id and closed vocabulary."""

    model_config = _CLOSED

    job_id: UUID
    kind: VaultStatusJobKind
    method: _JobMethod
    state: VaultStatusJobState
    failure_code: _JobFailureCode | None
    updated_at: AwareDatetime


class _WireResponse(BaseModel):
    """``PipelineStatusResponse``: the envelope, closed like every wire model."""

    model_config = _CLOSED

    status: Literal["ok"]
    tier_ceiling: Literal["open", "personal"]
    folders: Annotated[list[_WireFolder], Field(max_length=_FOLDERS_MAX_ITEMS)]
    documents: Annotated[list[_WireDocument], Field(max_length=PIPELINE_STATUS_MAX_LIMIT)]
    documents_withheld: Annotated[int, Field(ge=0)]
    jobs: Annotated[list[_WireJob], Field(max_length=_JOBS_MAX_ITEMS)]


def _validated(body: bytes) -> _WireResponse | None:
    """Validate one answer's raw bytes, or ``None`` when they are not the published shape.

    ``None`` rather than a raise, so the caller's refusal is raised *outside*
    this ``except`` and no :class:`~pydantic.ValidationError` -- which quotes
    the input it refused -- rides along as its ``__context__``.
    """
    try:
        return _WireResponse.model_validate_json(body)
    except ValidationError:
        return None


def _folder(folder: _WireFolder) -> VaultFolderStatus:
    """Project one wire folder onto the domain value."""
    written = folder.last_written_at
    return VaultFolderStatus(
        path=folder.path,
        count=folder.count,
        last_written_at=None if written is None else written.astimezone(UTC),
        writer=folder.writer,
        writer_reason=folder.writer_reason,
    )


def _stage(stage: _WireStage) -> VaultStageRecord:
    """Project one wire stage stamp onto the domain value."""
    return VaultStageRecord(stage=stage.stage, at=stage.at.astimezone(UTC), outcome=stage.outcome)


def _document(document: _WireDocument) -> VaultDocumentStatus:
    """Project one wire document onto the domain value."""
    return VaultDocumentStatus(
        external_id=document.external_id,
        filename=document.filename,
        fragment_path=document.fragment_path,
        fragment_count=document.fragment_count,
        stages=tuple(map(_stage, document.stages)),
    )


def _job(job: _WireJob) -> VaultStatusJob:
    """Project one wire job onto the domain value."""
    return VaultStatusJob(
        job_id=str(job.job_id),
        kind=job.kind,
        method=job.method,
        state=job.state,
        failure_code=job.failure_code,
        updated_at=job.updated_at.astimezone(UTC),
    )


def pipeline_status_from(body: bytes) -> VaultPipelineStatus | None:
    """Parse one successful answer, or ``None`` if it is not the published shape."""
    response = _validated(body)
    if response is None:
        return None
    return VaultPipelineStatus(
        folders=tuple(map(_folder, response.folders)),
        documents=tuple(map(_document, response.documents)),
        documents_withheld=response.documents_withheld,
        jobs=tuple(map(_job, response.jobs)),
    )


def pipeline_status_offered(handshake: HandshakeResult) -> bool:
    """Whether a vault's handshake lists the minor that serves the status read.

    Creek refuses any minor its ``supported_contract_minors`` does not list, so
    a vault on an image before 0.34 -- the deployed managed vaults among them --
    is never asked, and the caller learns it needs an update instead.
    """
    return handshake.serves_minor(PIPELINE_STATUS_SINCE_MINOR)


def pipeline_status_path(limit: int) -> str:
    """The request path and query for ``limit`` documents, refusing a limit Creek would.

    Raises:
        ValueError: When ``limit`` is outside the published ``1..200``.
    """
    if not PIPELINE_STATUS_MIN_LIMIT <= limit <= PIPELINE_STATUS_MAX_LIMIT:
        raise ValueError(_LIMIT_MESSAGE)
    return f"{PIPELINE_STATUS_PATH}?{urlencode({_LIMIT_PARAM: limit})}"


class StatusTransport(Protocol):
    """The adapter's one authorized, deadlined way onto the wire, bound to 0.34."""

    def __call__(
        self, method: str, url: str, /, *, ceiling: WireTierCeiling
    ) -> Awaitable[httpx.Response]:
        """Send one request at ``ceiling`` and return the vault's answer."""


#: The adapter's read classifier for a non-2xx answer.
ReadFailure = Callable[[CreekCapability, httpx.Response], CreekVaultError]


async def _get(send: StatusTransport, url: str) -> httpx.Response:
    """``GET`` ``url`` at :data:`PIPELINE_STATUS_CEILING`, normalizing any transport failure.

    A call that ran out of time is :class:`VaultCallTimedOutError`; any other
    that did not land is :class:`CreekVaultUnavailableError`. Both carry only
    the static message and are raised ``from None``.
    """
    try:
        return await send("GET", url, ceiling=PIPELINE_STATUS_CEILING)
    except HTTP_CALL_TIMED_OUT_ERRORS:
        raise VaultCallTimedOutError(PIPELINE_STATUS_FAILED_MESSAGE) from None
    except HTTP_CALL_FAILED_ERRORS:
        raise CreekVaultUnavailableError(PIPELINE_STATUS_FAILED_MESSAGE) from None


async def read_pipeline_status(
    send: StatusTransport,
    base_url: str,
    limit: int,
    *,
    supported: bool,
    read_failure: ReadFailure,
) -> VaultPipelineStatus:
    """Read ``GET /v1/pipeline/status`` and report how the exchange ended.

    ``limit`` is checked first, then the minor: a vault that did not list 0.34
    gets no request at all. A success is counted here; every failure is raised,
    for the caller's counting wrapper.

    Raises:
        ValueError: When ``limit`` is outside the published bounds.
        CreekCapabilityUnsupportedError: When the vault does not serve 0.34.
        CreekVaultPayloadError: When a 2xx answer is off-schema.
        CreekVaultError: The classified failure of any non-2xx answer.
    """
    path = pipeline_status_path(limit)
    if not supported:
        raise CreekCapabilityUnsupportedError(PIPELINE_STATUS_UNSUPPORTED_MESSAGE)
    response = await _get(send, f"{base_url}{path}")
    if not response.is_success:
        raise read_failure(CreekCapability.PIPELINE, response) from None
    status = pipeline_status_from(response.content)
    if status is None:
        raise CreekVaultPayloadError(PIPELINE_STATUS_UNREADABLE_MESSAGE)
    record_vault_outcome(VaultTelemetryOutcome.SUCCESS, CreekCapability.PIPELINE)
    return status
