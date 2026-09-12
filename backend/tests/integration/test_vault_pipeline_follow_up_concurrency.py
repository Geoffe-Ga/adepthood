"""PostgreSQL proof that finish-vs-join cannot erase a vault write."""

from __future__ import annotations

import asyncio
from typing import cast

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlmodel import col, select

from domain.creek_vault import (
    CreekCapability,
    CreekVaultClient,
    VaultClassificationPass,
    VaultLinkPass,
    VaultLinkStage,
    VaultPipelineJob,
    VaultPipelineStage,
)
from models.user import User
from models.vault_pipeline_follow_up import VaultPipelineFollowUp
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services import creek_vault_pipeline as pipeline
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline
from services.creek_vault_pipeline import _commit_finished_run as commit_finished_run
from services.creek_vault_pipeline import (
    _lock_classification_scheduler as lock_classification_scheduler,
)
from services.creek_vault_pipeline import _pending_follow_up as pending_follow_up
from services.creek_vault_pipeline import (
    _persist_follow_up_intent as persist_follow_up_intent,
)
from services.creek_vault_pipeline import _StageCounts as StageCounts

pytestmark = pytest.mark.integration


class _SynchronousPipeline:
    """Counts-only pipeline double used after the database race is released."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.active_classifications = 0
        self.maximum_active_classifications = 0

    def supports(self, capability: CreekCapability, /) -> bool:
        """Advertise only the capability exercised by the scheduler."""
        return capability is CreekCapability.PIPELINE

    async def classify_corpus(self) -> VaultClassificationPass:
        """Record one synchronous, successful classification pass."""
        self.active_classifications += 1
        self.maximum_active_classifications = max(
            self.maximum_active_classifications,
            self.active_classifications,
        )
        try:
            self.calls.append("classify")
            return VaultClassificationPass(
                total=2,
                classified=2,
                preserved_manual=0,
                preserved_llm=0,
                privacy_tiers_assigned=0,
                retiered=0,
                praxis_marked=0,
                tags_extracted=0,
                complete=True,
            )
        finally:
            self.active_classifications -= 1

    async def link_corpus(self, stage: VaultLinkStage, /) -> VaultLinkPass:
        """Record each linker in its production order."""
        self.calls.append(stage.value)
        return VaultLinkPass(
            stage=stage,
            fragment_count=2,
            link_count=1,
            largest_cluster_fragments=1,
            clusters_split=0,
            oversized_discarded=0,
        )

    async def pipeline_job(
        self,
        _job: VaultPipelineJob,
        /,
    ) -> VaultClassificationPass | VaultLinkPass | VaultPipelineJob:
        """No call in this regression admits an asynchronous Creek job."""
        raise AssertionError("the synchronous pipeline returned no job id")


async def _pipeline_rows(engine: AsyncEngine, user_id: int) -> list[VaultPipelineRun]:
    """Read this regression's ordered scheduling ledger."""
    async with AsyncSession(engine) as session:
        result = await session.execute(
            select(VaultPipelineRun)
            .where(col(VaultPipelineRun.user_id) == user_id)
            .order_by(col(VaultPipelineRun.id))
        )
        return list(result.scalars().all())


async def _seed_active_import(engine: AsyncEngine) -> tuple[int, int]:
    """Persist one account and its already-admitted document classification."""
    async with AsyncSession(engine, expire_on_commit=False) as seed:
        user = User(
            email="vault-finish-join-race@example.test",
            password_hash="not-a-login-credential",  # pragma: allowlist secret
        )
        seed.add(user)
        await seed.flush()
        assert user.id is not None
        active = VaultPipelineRun(
            user_id=user.id,
            stage=VaultPipelineStage.CLASSIFY.value,
            trigger=VaultPipelineTrigger.DOCUMENT_IMPORT.value,
            outcome=VaultPipelineOutcome.ATTEMPTED.value,
            fragments_seen=0,
            fragments_touched=0,
            fragments_lost=0,
        )
        seed.add(active)
        await seed.commit()
        assert active.id is not None
        return user.id, active.id


async def _assert_result_and_cleanup(
    engine: AsyncEngine,
    client: _SynchronousPipeline,
    user_id: int,
) -> None:
    """Assert exact convergence and remove the committed integration fixture."""
    rows = await _pipeline_rows(engine, user_id)
    assert [(row.stage, row.outcome) for row in rows] == [
        (VaultPipelineStage.CLASSIFY, VaultPipelineOutcome.COMPLETED),
        (VaultPipelineStage.CLASSIFY, VaultPipelineOutcome.COMPLETED),
        (VaultPipelineStage.TEMPORAL, VaultPipelineOutcome.COMPLETED),
        (VaultPipelineStage.EMBEDDINGS, VaultPipelineOutcome.COMPLETED),
        (VaultPipelineStage.EDDIES, VaultPipelineOutcome.COMPLETED),
        (VaultPipelineStage.THREADS, VaultPipelineOutcome.COMPLETED),
    ]
    assert rows[0].trigger == VaultPipelineTrigger.DOCUMENT_IMPORT.value
    assert rows[0].follow_up_trigger is None
    assert {row.trigger for row in rows[1:]} == {VaultPipelineTrigger.DOCUMENT_IMPORT.value}
    assert client.calls == ["classify", "temporal", "embeddings", "eddies", "threads"]
    assert client.maximum_active_classifications == 1

    async with AsyncSession(engine) as checking:
        pending = await checking.scalar(
            select(VaultPipelineFollowUp).where(col(VaultPipelineFollowUp.user_id) == user_id)
        )
        assert pending is None
        await checking.execute(delete(User).where(col(User.id) == user_id))
        await checking.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "terminal_reads_marker_first",
    [False, True],
    ids=("intent-wins", "terminalizer-wins"),
)
async def test_terminal_row_lock_cannot_erase_a_joining_write(
    pg_engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    *,
    terminal_reads_marker_first: bool,
) -> None:
    """A committed intent queues once even when terminalization owns the run."""
    client = _SynchronousPipeline()
    marker_persisted = asyncio.Event()
    release_terminalizer = asyncio.Event()
    original_persist = persist_follow_up_intent
    original_pending = pending_follow_up
    terminal_session: AsyncSession | None = None

    async def _observe_persisted_marker(
        session: AsyncSession,
        user_id: int,
        trigger: VaultPipelineTrigger,
    ) -> None:
        await original_persist(session, user_id, trigger)
        marker_persisted.set()

    monkeypatch.setattr(pipeline, "_persist_follow_up_intent", _observe_persisted_marker)

    async def _hold_a_terminalizer_that_read_no_marker(
        session: AsyncSession,
        user_id: int,
        *,
        for_update: bool = False,
    ) -> VaultPipelineFollowUp | None:
        pending = await original_pending(
            session,
            user_id,
            for_update=for_update,
        )
        if terminal_reads_marker_first and session is terminal_session:
            assert pending is None
            await marker_persisted.wait()
        return pending

    monkeypatch.setattr(pipeline, "_pending_follow_up", _hold_a_terminalizer_that_read_no_marker)

    user_id, run_id = await _seed_active_import(pg_engine)

    async def _terminalize_after_the_marker_is_visible() -> None:
        nonlocal terminal_session
        async with AsyncSession(pg_engine, expire_on_commit=False) as terminal:
            terminal_session = terminal
            await lock_classification_scheduler(terminal, user_id)
            result = await terminal.execute(
                select(VaultPipelineRun).where(col(VaultPipelineRun.id) == run_id).with_for_update()
            )
            locked = result.scalars().one()
            release_terminalizer.set()
            if not terminal_reads_marker_first:
                await marker_persisted.wait()
            await commit_finished_run(
                terminal,
                locked,
                VaultPipelineOutcome.COMPLETED,
                StageCounts(seen=1, touched=1),
            )

    terminalizer = asyncio.create_task(_terminalize_after_the_marker_is_visible())
    await release_terminalizer.wait()
    async with AsyncSession(pg_engine, expire_on_commit=False) as writer:
        await drive_vault_pipeline(
            writer,
            cast("CreekVaultClient", client),
            user_id=user_id,
            trigger=VaultPipelineTrigger.JOURNAL_WRITE,
        )
    await terminalizer
    await pipeline.wait_for_vault_pipeline_tasks()

    await _assert_result_and_cleanup(pg_engine, client, user_id)
    await pipeline.close_vault_pipeline_tasks()
