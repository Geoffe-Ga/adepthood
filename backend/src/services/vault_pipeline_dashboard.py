"""The "Your vault" read: receipts, stage runs, and Creek's own status, in one answer (#3775).

``GET /vault/pipeline`` answers three questions an owner asks of their vault:
did my files land, what has Creek run over them, and which parts of the
ontology hold something. The first two are adepthood's own records --
:class:`~models.upload_receipt.UploadReceipt` and
:class:`~models.vault_pipeline_run.VaultPipelineRun` -- read for the caller's
account alone. The third is Creek's ``GET /v1/pipeline/status`` (contract
0.34), read through the caller's own resolved vault client and re-projected
onto :mod:`schemas.vault_pipeline`.

**Declared per call, never by moving the pin.** The deployed managed vaults may
not serve 0.34 yet, so adepthood keeps declaring its 0.22 pin everywhere and
declares 0.34 on this one read only, to a vault whose handshake lists it. A
vault that does not -- or that lists it and then answers ``409
incompatible_version`` or ``404 not_found`` anyway -- is reported as
``update_needed``: a plain "your vault needs an update to show this", not an
error and not an outage.

**Degrading.** Every other failure the adapter can raise is ``unreachable``,
logged through :func:`services.creek_vault_read.log_read_degraded` with
content-free fields only. The receipts and runs are still answered, because
they are adepthood's own and do not depend on the vault being up.

**Read-only.** Nothing here starts a stage or writes a row.
"""

from __future__ import annotations

from dataclasses import dataclass
from posixpath import dirname
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.creek_vault import (
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultPipelineStatusClient,
    VaultErrorCode,
)
from domain.vault_pipeline_status import (
    PIPELINE_STATUS_MAX_LIMIT,
    VaultDocumentStatus,
    VaultFolderStatus,
    VaultPipelineStatus,
    VaultStatusJob,
)
from models.upload_receipt import UploadReceipt
from models.vault_pipeline_run import VaultPipelineRun
from schemas.vault_pipeline import (
    StageRunResponse,
    UploadReceiptResponse,
    VaultDocumentResponse,
    VaultFolderResponse,
    VaultJobResponse,
    VaultPipelineResponse,
    VaultSnapshotResponse,
    VaultStageResponse,
    VaultStatusReach,
)
from services.corpus_import import reaches_a_vault
from services.creek_vault_pipeline_status_wire import pipeline_status_offered
from services.creek_vault_read import log_read_degraded

#: How many receipts one page carries when the request names no ``limit``,
#: and the most it may name: the last hundred (#3775's design default).
RECEIPT_PAGE_MAX: Final = 100

#: The fewest receipts a page may ask for.
RECEIPT_PAGE_MIN: Final = 1

#: How many of the account's most recent stage runs are shown.
STAGE_RUN_CAP: Final = 50

#: How many of Creek's recent documents are asked for: the published clamp, so
#: as many receipts as possible can be matched to the folder they landed in.
VAULT_DOCUMENT_LIMIT: Final = PIPELINE_STATUS_MAX_LIMIT

#: A vault answering with one of these refuses the 0.34 read itself -- an image
#: that predates it -- rather than being out, so the account is told it needs
#: an update instead of that its vault is unreachable.
_UPDATE_NEEDED_CODES: Final = frozenset(
    {VaultErrorCode.INCOMPATIBLE_VERSION, VaultErrorCode.NOT_FOUND}
)


@dataclass(frozen=True)
class ReceiptPage:
    """Which receipts a request asks for: at most ``limit``, older than ``before``."""

    limit: int = RECEIPT_PAGE_MAX
    before: int | None = None


@dataclass(frozen=True)
class _VaultHalf:
    """Creek's answer, or why there is none."""

    reach: VaultStatusReach
    status: VaultPipelineStatus | None = None


async def _receipts(session: AsyncSession, user_id: int, page: ReceiptPage) -> list[UploadReceipt]:
    """This account's receipts, newest first, one more than a page to see if more remain."""
    query = select(UploadReceipt).where(col(UploadReceipt.user_id) == user_id)
    if page.before is not None:
        query = query.where(col(UploadReceipt.id) < page.before)
    result = await session.execute(
        query.order_by(col(UploadReceipt.id).desc()).limit(page.limit + 1)
    )
    return list(result.scalars().all())


async def _stage_runs(session: AsyncSession, user_id: int) -> list[VaultPipelineRun]:
    """This account's :data:`STAGE_RUN_CAP` most recent stage runs, newest first."""
    result = await session.execute(
        select(VaultPipelineRun)
        .where(col(VaultPipelineRun.user_id) == user_id)
        .order_by(col(VaultPipelineRun.id).desc())
        .limit(STAGE_RUN_CAP)
    )
    return list(result.scalars().all())


def _degraded_reach(error: CreekVaultError) -> VaultStatusReach:
    """Name a failed status read: a refused minor or route needs an update; else unreachable."""
    if isinstance(error, CreekCapabilityUnsupportedError):
        return VaultStatusReach.UPDATE_NEEDED
    if isinstance(error, CreekVaultContractError) and error.code in _UPDATE_NEEDED_CODES:
        return VaultStatusReach.UPDATE_NEEDED
    log_read_degraded(CreekCapability.PIPELINE, error)
    return VaultStatusReach.UNREACHABLE


async def _vault_half(client: CreekVaultPipelineStatusClient) -> _VaultHalf:
    """Ask the caller's own vault, gated as every vault read is: a handshake first.

    A connected vault that cannot be reached at all is ``unreachable``; one
    whose handshake does not list 0.34 is ``update_needed`` and is asked
    nothing more.
    """
    if not reaches_a_vault(client):
        return _VaultHalf(VaultStatusReach.NOT_CONNECTED)
    handshake = await client.handshake()
    if not client.is_available():
        return _VaultHalf(VaultStatusReach.UNREACHABLE)
    if not pipeline_status_offered(handshake):
        return _VaultHalf(VaultStatusReach.UPDATE_NEEDED)
    try:
        status = await client.pipeline_status(VAULT_DOCUMENT_LIMIT)
    except CreekVaultError as error:
        return _VaultHalf(_degraded_reach(error))
    return _VaultHalf(VaultStatusReach.OK, status)


def _folder_of(fragment_path: str | None) -> str | None:
    """The folder a fragment sits in, never the fragment's own (title-derived) name."""
    return None if fragment_path is None else dirname(fragment_path)


def _landed_in(status: VaultPipelineStatus | None) -> dict[str, str | None]:
    """Each of Creek's documents' folder, by the external id adepthood addressed it by."""
    if status is None:
        return {}
    return {doc.external_id: _folder_of(doc.fragment_path) for doc in status.documents}


def _receipt(
    receipt_id: int, receipt: UploadReceipt, landed: dict[str, str | None]
) -> UploadReceiptResponse:
    """Project one receipt, with the folder Creek says it landed in when it said."""
    return UploadReceiptResponse(
        id=receipt_id,
        filename=receipt.filename,
        batch=receipt.batch,
        destination=receipt.destination,
        vault_status=receipt.vault_status,
        vault_ref=receipt.vault_ref,
        landed_in=landed.get(receipt.external_id),
        landed_at=receipt.created_at,
    )


def _receipt_page(
    receipts: list[UploadReceipt], page: ReceiptPage, landed: dict[str, str | None]
) -> tuple[list[UploadReceiptResponse], int | None]:
    """One page of receipts, and the cursor to the next page when more remain.

    ``receipts`` holds one row more than the page when another page follows.
    """
    shown = [(row.id, row) for row in receipts[: page.limit] if row.id is not None]
    more = len(receipts) > page.limit
    return (
        [_receipt(row_id, row, landed) for row_id, row in shown],
        shown[-1][0] if more else None,
    )


def _stage_run(run: VaultPipelineRun) -> StageRunResponse:
    """Project one stage run onto the dashboard's vocabulary."""
    return StageRunResponse(
        trigger=run.trigger,
        stage=run.stage,
        outcome=run.outcome,
        failure_code=run.failure_code,
        fragments_seen=run.fragments_seen,
        emitted=run.fragments_touched,
        fragments_lost=run.fragments_lost,
        ran_at=run.ran_at,
    )


def _folder(folder: VaultFolderStatus) -> VaultFolderResponse:
    """Project one of Creek's folders."""
    return VaultFolderResponse(
        path=folder.path,
        count=folder.count,
        last_written_at=folder.last_written_at,
        writer=folder.writer,
        writer_reason=folder.writer_reason,
    )


def _document(document: VaultDocumentStatus) -> VaultDocumentResponse:
    """Project one of Creek's documents: its folder, never its fragment's name or id."""
    return VaultDocumentResponse(
        filename=document.filename,
        landed_in=_folder_of(document.fragment_path),
        fragment_count=document.fragment_count,
        stages=[
            VaultStageResponse(stage=stage.stage, at=stage.at, outcome=stage.outcome)
            for stage in document.stages
        ],
    )


def _job(job: VaultStatusJob) -> VaultJobResponse:
    """Project one of Creek's jobs, without its opaque id."""
    return VaultJobResponse(
        kind=job.kind,
        method=job.method,
        state=job.state,
        failure_code=job.failure_code,
        updated_at=job.updated_at,
    )


def _snapshot(status: VaultPipelineStatus | None) -> VaultSnapshotResponse | None:
    """Project Creek's whole answer, or ``None`` when there is none."""
    if status is None:
        return None
    return VaultSnapshotResponse(
        folders=[_folder(folder) for folder in status.folders],
        documents=[_document(document) for document in status.documents],
        documents_withheld=status.documents_withheld,
        jobs=[_job(job) for job in status.jobs],
    )


async def read_vault_pipeline(
    session: AsyncSession,
    user_id: int,
    client: CreekVaultPipelineStatusClient,
    page: ReceiptPage,
) -> VaultPipelineResponse:
    """The account's receipts, stage runs and vault status, in one answer.

    The account's own rows are read and the transaction closed before the vault
    is dialled, so the pooled connection is not held across that round trip.
    """
    receipts = await _receipts(session, user_id, page)
    runs = await _stage_runs(session, user_id)
    await session.commit()
    vault = await _vault_half(client)
    uploads, next_before = _receipt_page(receipts, page, _landed_in(vault.status))
    return VaultPipelineResponse(
        recent_uploads=uploads,
        next_before=next_before,
        stage_runs=[_stage_run(run) for run in runs],
        vault=_snapshot(vault.status),
        vault_status=vault.reach,
        vault_unreachable=vault.reach is VaultStatusReach.UNREACHABLE,
    )
