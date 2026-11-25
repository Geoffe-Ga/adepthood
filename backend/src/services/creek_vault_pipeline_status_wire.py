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

**Two minors, one read (#3795).** Contract 0.37 (Creek-Vault#2147) adds
whole-corpus ``totals`` to the same answer, for a caller declaring 0.37; a
caller declaring 0.34 to 0.36 is served the body its minor published, with no
``totals`` key. :func:`pipeline_status_minor` picks the newest of the two the
handshake lists, the adapter declares that one, and the answer is parsed
against that minor's own closed shape: ``totals`` is required at 0.37 and
refused at 0.34.

**Strict.** The models mirror the published ``PipelineStatusResponse`` schema
field for field and forbid anything else, so a field Creek never published --
a title, a body -- or a value outside a closed vocabulary refuses the *whole*
answer as a :class:`~domain.creek_vault.CreekVaultPayloadError`. Totals that
contradict themselves are refused the same way: a stage missing, repeated or
out of pipeline order, or a stage counting more documents than the corpus has.

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
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    model_validator,
)

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
    PIPELINE_STAGE_ORDER,
    PIPELINE_STATUS_MAX_LIMIT,
    PIPELINE_STATUS_MIN_LIMIT,
    PIPELINE_STATUS_SINCE_MINOR,
    PIPELINE_TOTALS_SINCE_MINOR,
    VaultDocumentStage,
    VaultDocumentStatus,
    VaultFolderStatus,
    VaultFolderWriterlessReason,
    VaultPipelineStatus,
    VaultStageOutcome,
    VaultStageRecord,
    VaultStageTotal,
    VaultStageTotals,
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

#: The minors that serve the read, newest first: the first one a vault's
#: handshake lists is the one declared to it.
PIPELINE_STATUS_MINORS: Final = (PIPELINE_TOTALS_SINCE_MINOR, PIPELINE_STATUS_SINCE_MINOR)

#: Where the read is asked for, relative to the configured base URL.
PIPELINE_STATUS_PATH: Final = "/v1/pipeline/status"

#: The ceiling the read is declared at: the widest the wire can spell.
PIPELINE_STATUS_CEILING: Final = WireTierCeiling.PERSONAL

#: The published ``PipelineFolderStatus.path`` pattern: a scaffolded folder.
FOLDER_PATH_PATTERN: Final = "^(?:0[1-9]|1[01])-[A-Za-z-]+(?:/[A-Za-z0-9-]+)*$"

#: The published ``PipelineFolderStatus.writer`` pattern: a subsystem token.
WRITER_PATTERN: Final = "^[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+)*$"

#: Where an upload's fragment may be listed: a vault-relative ``.md`` path under
#: ``01-Fragments`` (the 0.34 pin) or ``11-Other-Authors``, which Creek-Vault#2141
#: adds for borrowed-author uploads. Accepting both now means the widening is not
#: an off-schema answer the day it ships.
FRAGMENT_PATH_PATTERN: Final = (
    "^(?:01-Fragments|11-Other-Authors)/(?:[^/\\x00-\\x1f]+/)*[^/\\x00-\\x1f]+\\.md$"
)

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

# Why totals were refused. Never surfaced: a refused answer is ``None``.
_STAGE_ORDER_MESSAGE: Final = "totals must list every stage once, in pipeline order"
_STAGE_OVERCOUNT_MESSAGE: Final = "a stage counted more documents than the corpus holds"

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


class _WireStageTotal(BaseModel):
    """``PipelineStageTotal``: a stage and three disjoint counts."""

    model_config = _CLOSED

    stage: VaultDocumentStage
    covered: Annotated[int, Field(ge=0)]
    partial: Annotated[int, Field(ge=0)]
    failed: Annotated[int, Field(ge=0)]


def _in_pipeline_order(stages: list[_WireStageTotal]) -> bool:
    """Whether the rows are every published stage once, in pipeline order."""
    return tuple(row.stage for row in stages) == PIPELINE_STAGE_ORDER


def _within(stages: list[_WireStageTotal], documents: int) -> bool:
    """Whether no stage counts more documents than the corpus holds."""
    return all(row.covered + row.partial + row.failed <= documents for row in stages)


class _WireTotals(BaseModel):
    """``PipelineTotals``: the corpus's document count and one row per stage.

    Beyond the published bounds, the rows must be the published stages in
    pipeline order (so none is missing or repeated), and no stage may count
    more documents than ``documents``: its three counts are disjoint.
    """

    model_config = _CLOSED

    documents: Annotated[int, Field(ge=0)]
    stages: Annotated[
        list[_WireStageTotal],
        Field(min_length=len(PIPELINE_STAGE_ORDER), max_length=len(PIPELINE_STAGE_ORDER)),
    ]

    @model_validator(mode="after")
    def _ordered(self) -> _WireTotals:
        """Refuse a stage missing, repeated or out of order."""
        if not _in_pipeline_order(self.stages):
            raise ValueError(_STAGE_ORDER_MESSAGE)
        return self

    @model_validator(mode="after")
    def _counted_within_the_corpus(self) -> _WireTotals:
        """Refuse a stage counting past the corpus."""
        if not _within(self.stages, self.documents):
            raise ValueError(_STAGE_OVERCOUNT_MESSAGE)
        return self


class _WireTotalledResponse(_WireResponse):
    """``PipelineStatusResponse`` at 0.37: the same envelope, and always ``totals``."""

    totals: _WireTotals


def _validated(body: bytes, *, totalled: bool) -> _WireResponse | None:
    """Validate one answer's raw bytes, or ``None`` when they are not the published shape.

    ``totalled`` says which minor's shape the answer must be: with it,
    ``totals`` is required; without it, the key is one 0.34 never published.

    ``None`` rather than a raise, so the caller's refusal is raised *outside*
    this ``except`` and no :class:`~pydantic.ValidationError` -- which quotes
    the input it refused -- rides along as its ``__context__``.
    """
    model = _WireTotalledResponse if totalled else _WireResponse
    try:
        return model.model_validate_json(body)
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


def _totals(response: _WireResponse) -> VaultStageTotals | None:
    """Project a 0.37 answer's totals; an earlier minor's answer has none."""
    if not isinstance(response, _WireTotalledResponse):
        return None
    return VaultStageTotals(
        documents=response.totals.documents,
        stages=tuple(
            VaultStageTotal(
                stage=row.stage, covered=row.covered, partial=row.partial, failed=row.failed
            )
            for row in response.totals.stages
        ),
    )


def pipeline_status_from(body: bytes, *, totalled: bool = False) -> VaultPipelineStatus | None:
    """Parse one successful answer, or ``None`` if it is not the published shape.

    ``totalled`` is whether the read declared 0.37: its answer must carry
    ``totals``, and an earlier minor's must not.
    """
    response = _validated(body, totalled=totalled)
    if response is None:
        return None
    return VaultPipelineStatus(
        folders=tuple(map(_folder, response.folders)),
        documents=tuple(map(_document, response.documents)),
        documents_withheld=response.documents_withheld,
        jobs=tuple(map(_job, response.jobs)),
        totals=_totals(response),
    )


def pipeline_status_minor(handshake: HandshakeResult) -> str | None:
    """The minor to declare on the status read to this vault, or ``None`` to not ask.

    The newest of :data:`PIPELINE_STATUS_MINORS` the handshake lists: 0.37,
    whose answer carries totals, or else 0.34. Creek refuses any minor its
    ``supported_contract_minors`` does not list, so a vault on an image before
    0.34 -- the deployed managed vaults among them -- is never asked.
    """
    return next((minor for minor in PIPELINE_STATUS_MINORS if handshake.serves_minor(minor)), None)


def pipeline_status_offered(handshake: HandshakeResult) -> bool:
    """Whether a vault's handshake lists a minor that serves the status read.

    A vault that lists none is never asked, and the caller learns it needs an
    update instead.
    """
    return pipeline_status_minor(handshake) is not None


def pipeline_status_path(limit: int) -> str:
    """The request path and query for ``limit`` documents, refusing a limit Creek would.

    Raises:
        ValueError: When ``limit`` is outside the published ``1..200``.
    """
    if not PIPELINE_STATUS_MIN_LIMIT <= limit <= PIPELINE_STATUS_MAX_LIMIT:
        raise ValueError(_LIMIT_MESSAGE)
    return f"{PIPELINE_STATUS_PATH}?{urlencode({_LIMIT_PARAM: limit})}"


class StatusTransport(Protocol):
    """The adapter's one authorized, deadlined way onto the wire, bound to the read's minor."""

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
    minor: str | None,
    read_failure: ReadFailure,
) -> VaultPipelineStatus:
    """Read ``GET /v1/pipeline/status`` and report how the exchange ended.

    ``minor`` is :func:`pipeline_status_minor`'s answer, the one ``send``
    declares. ``limit`` is checked first, then the minor: a vault that listed
    none gets no request at all. The answer is parsed as that minor's shape.
    A success is counted here; every failure is raised, for the caller's
    counting wrapper.

    Raises:
        ValueError: When ``limit`` is outside the published bounds.
        CreekCapabilityUnsupportedError: When the vault serves no minor of the read.
        CreekVaultPayloadError: When a 2xx answer is off-schema.
        CreekVaultError: The classified failure of any non-2xx answer.
    """
    path = pipeline_status_path(limit)
    if minor is None:
        raise CreekCapabilityUnsupportedError(PIPELINE_STATUS_UNSUPPORTED_MESSAGE)
    response = await _get(send, f"{base_url}{path}")
    if not response.is_success:
        raise read_failure(CreekCapability.PIPELINE, response) from None
    status = pipeline_status_from(response.content, totalled=minor == PIPELINE_TOTALS_SINCE_MINOR)
    if status is None:
        raise CreekVaultPayloadError(PIPELINE_STATUS_UNREADABLE_MESSAGE)
    record_vault_outcome(VaultTelemetryOutcome.SUCCESS, CreekCapability.PIPELINE)
    return status
