"""What actually occasions a vault ontologization pass, driven through the routes.

The seam itself is covered in ``test_creek_vault_pipeline.py``. This module
answers the two questions that a test of the seam cannot: whether the two write
paths reach it at all, and whether a person's writing survives it not working.

Both matter more than they look. The user story is "journal *and* documents",
and a trigger hung off the journal path alone leaves exactly the corpus somebody
deliberately imported sitting inert -- which is the defect the pass exists to
fix. And the pass runs after a commit on both paths, so nothing it does may cost
the writer their entry or the uploader their document.
"""

from __future__ import annotations

import base64
from collections.abc import AsyncGenerator
from http import HTTPStatus

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultClassificationPass,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultLinkPass,
    VaultLinkStage,
    VaultReflection,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelBalance,
)
from main import app
from models.journal_entry import JournalEntry
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services.creek_vault_telemetry import VaultCallTimedOutError

_SIGNUP_PASSWORD = "correct-horse-battery-staple-42"  # pragma: allowlist secret
_IMPORT_PATH = "/corpus/import"
_JOURNAL_PATH = "/journal/"
_FILENAME = "field-notes.pdf"
_CONTENT_B64 = base64.b64encode(b"%PDF-1.7 a page of field notes").decode("ascii")
_ENTRY_BODY = "I sat with the thing I have been avoiding."

_PIPELINE_CAPABILITIES = frozenset(
    {CreekCapability.JOURNAL, CreekCapability.UPLOAD, CreekCapability.PIPELINE}
)


class _PipelineVaultDouble:
    """A vault that takes writing and advertises the batch pipeline.

    Written out in full rather than inheriting the shared no-pipeline base,
    because this is the one double in the suite whose pipeline half is the thing
    under test.
    """

    def __init__(self, *, pipeline_error: Exception | None = None) -> None:
        """Bind the failure, if any, that both pipeline calls should raise."""
        self.classification_calls = 0
        self.link_stages: list[VaultLinkStage] = []
        self._pipeline_error = pipeline_error

    async def handshake(self) -> HandshakeResult:
        """Report available, advertising journal, upload and pipeline."""
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=_PIPELINE_CAPABILITIES,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Always report available."""
        return True

    def supports(self, capability: CreekCapability, /) -> bool:
        """Report whether this double advertises ``capability``."""
        return capability in _PIPELINE_CAPABILITIES

    async def ingest(self, _request: VaultIngestRequest, /) -> VaultIngestResult:
        """Store the entry and hand back a ref."""
        return VaultIngestResult(stored=True, vault_ref="vault-ref-1")

    async def upload(self, _request: VaultUploadRequest, /) -> VaultUploadResult:
        """Store the document and hand back a ref."""
        return VaultUploadResult(
            stored=True,
            vault_ref="vault-fragment-1",
            action=VaultIngestAction.CREATED,
            tags=(),
        )

    async def classify(self, _body: str, _tier: VaultTierCeiling, /) -> VaultClassification:
        """Return no per-entry tags; this path does not exercise them."""
        return VaultClassification(tags=())

    async def reflect(self, _body: str, _tier: VaultTierCeiling, /) -> VaultReflection:
        """Return an empty reflection; this path does not exercise it."""
        return VaultReflection(
            status=VaultReflectionStatus.EMPTY,
            notes=(),
            essay=None,
            essay_grounded=False,
            routed_tier=VaultTierCeiling.OPEN,
        )

    async def wheel(self) -> VaultWheelBalance:
        """Return an empty balance; this path does not exercise it."""
        return VaultWheelBalance(aspects=())

    async def classify_corpus(self) -> VaultClassificationPass:
        """Count the call, then fail or report a clean pass."""
        self.classification_calls += 1
        if self._pipeline_error is not None:
            raise self._pipeline_error
        return VaultClassificationPass(
            total=3,
            classified=3,
            preserved_manual=0,
            preserved_llm=0,
            privacy_tiers_assigned=0,
            retiered=0,
            praxis_marked=0,
            tags_extracted=0,
            complete=True,
        )

    async def link_corpus(self, stage: VaultLinkStage, /) -> VaultLinkPass:
        """Record the stage, then fail or report a clean pass."""
        self.link_stages.append(stage)
        if self._pipeline_error is not None:
            raise self._pipeline_error
        return VaultLinkPass(
            stage=stage,
            fragment_count=3,
            link_count=2,
            largest_cluster_fragments=2,
            clusters_split=0,
            oversized_discarded=0,
        )


@pytest_asyncio.fixture
async def vault(request: pytest.FixtureRequest) -> AsyncGenerator[_PipelineVaultDouble, None]:
    """Install a pipeline-capable vault as the routes' dependency for one test."""
    double = _PipelineVaultDouble(**getattr(request, "param", {}))
    app.dependency_overrides[get_creek_vault_client] = lambda: double
    yield double
    app.dependency_overrides.pop(get_creek_vault_client, None)


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Sign up a fresh user and return an Authorization header for it."""
    response = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _runs(session: AsyncSession) -> list[VaultPipelineRun]:
    """Every recorded pipeline attempt, in the order it was written."""
    result = await session.execute(select(VaultPipelineRun).order_by(col(VaultPipelineRun.id)))
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_an_imported_document_alone_schedules_a_run(
    async_client: AsyncClient, db_session: AsyncSession, vault: _PipelineVaultDouble
) -> None:
    """A document import is enough on its own -- no journal entry required."""
    headers = await _signup(async_client, "pipeline-importer")

    response = await async_client.post(
        _IMPORT_PATH,
        json={
            "filename": _FILENAME,
            "content_base64": _CONTENT_B64,
            "classification": "personal",
        },
        headers=headers,
    )

    assert response.status_code == HTTPStatus.ACCEPTED
    assert vault.classification_calls == 1
    assert vault.link_stages == [
        VaultLinkStage.TEMPORAL,
        VaultLinkStage.EDDIES,
        VaultLinkStage.THREADS,
    ]
    assert len(await _runs(db_session)) == len(vault.link_stages) + 1


@pytest.mark.asyncio
async def test_a_journal_save_schedules_only_the_cheap_half(
    async_client: AsyncClient, vault: _PipelineVaultDouble
) -> None:
    """The write path reaches the pipeline, and reaches no embedding stage."""
    headers = await _signup(async_client, "pipeline-writer")

    response = await async_client.post(
        _JOURNAL_PATH, json={"message": _ENTRY_BODY}, headers=headers
    )

    assert response.status_code == HTTPStatus.CREATED
    assert vault.classification_calls == 1
    assert vault.link_stages == [VaultLinkStage.TEMPORAL]


@pytest.mark.parametrize(
    "vault",
    [
        {"pipeline_error": CreekVaultUnavailableError("vault call failed")},
        {"pipeline_error": VaultCallTimedOutError("creek vault call failed")},
    ],
    indirect=True,
)
@pytest.mark.asyncio
async def test_the_entry_persists_across_every_pipeline_failure_mode(
    async_client: AsyncClient, db_session: AsyncSession, vault: _PipelineVaultDouble
) -> None:
    """A pipeline that refuses, or never answers, still costs nobody their writing."""
    headers = await _signup(async_client, "pipeline-degrader")

    response = await async_client.post(
        _JOURNAL_PATH, json={"message": _ENTRY_BODY}, headers=headers
    )

    assert response.status_code == HTTPStatus.CREATED
    assert vault.classification_calls == 1
    stored = await db_session.execute(
        select(JournalEntry).where(col(JournalEntry.message) == _ENTRY_BODY)
    )
    assert stored.scalars().first() is not None


@pytest.mark.parametrize(
    "vault", [{"pipeline_error": CreekVaultUnavailableError("vault call failed")}], indirect=True
)
@pytest.mark.asyncio
async def test_a_failed_pipeline_still_returns_the_document_import_result(
    async_client: AsyncClient, db_session: AsyncSession, vault: _PipelineVaultDouble
) -> None:
    """The uploader is told what became of their document, whatever the pass did."""
    headers = await _signup(async_client, "pipeline-import-degrader")

    response = await async_client.post(
        _IMPORT_PATH,
        json={
            "filename": _FILENAME,
            "content_base64": _CONTENT_B64,
            "classification": "personal",
        },
        headers=headers,
    )

    assert response.status_code == HTTPStatus.ACCEPTED
    assert response.json()["stored"] is True
    assert vault.classification_calls == 1
    runs = await _runs(db_session)
    assert [run.outcome for run in runs] == [VaultPipelineOutcome.FAILED]
