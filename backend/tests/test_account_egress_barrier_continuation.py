"""Order the *detached* ontologization ladder against this account's erasure.

The boundary this file pins is the one a request-scoped guard cannot see.
:func:`services.creek_vault_pipeline._schedule_continuation` fires an
``asyncio.create_task`` whose body opens its **own** session and dials Creek
after the request that scheduled it has already returned. A handler-scoped
``async with`` and a route-level dependency have both exited by then, so a test
shaped around either passes while the account's corpus is still being handed
outward under a deletion receipt.

So this test waits on :func:`services.creek_vault_pipeline.
wait_for_vault_pipeline_tasks` *after* the deletion response and asserts that
no vault dial is recorded past it.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from http import HTTPStatus
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import AsyncClient

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CreekCapability,
    VaultClassificationPass,
    VaultLinkPass,
    VaultLinkStage,
    VaultPipelineJob,
    VaultPipelineJobState,
    VaultPipelineStage,
)
from main import app
from services import creek_vault_pipeline as pipeline
from tests.test_account_egress_barrier import (
    DELETION_RESPONSE,
    delete_account_recording_order,
    signup,
)
from tests.test_journal_vault_write import SequencedVaultClient

#: The foreground rung is deliberately starved so the ladder hands its
#: classification job to a background continuation instead of finishing inline.
#: That handoff is the object under test, so it is forced rather than waited out
#: at the production clock's ten seconds.
_STARVED_FOREGROUND_BUDGET_SECONDS = 2.0
#: Longer than the starved budget, so the foreground's single status poll is
#: still waiting to be repeated when its clock runs out.
_POLL_LONGER_THAN_THE_BUDGET_SECONDS = 5.0
#: Production refuses to begin a rung with less than five seconds left, which
#: would refuse the starved budget above outright.
_WORTH_STARTING_UNDER_A_STARVED_BUDGET_SECONDS = 0.01

#: The window the deletion is given to overtake a paused continuation. See
#: ``tests.test_account_egress_barrier`` for why it is a probe and not a join.
_OVERTAKE_PROBE_SECONDS = 1.0
_SETTLE_TIMEOUT_SECONDS = 20.0

#: The poll that the *continuation* makes, as opposed to the foreground rung's
#: single starved one. Counted rather than flagged so the pause lands on the
#: detached dial specifically.
_CONTINUATION_POLL_ORDINAL = 2

#: Markers for the three dials this ladder makes, named once.
CLASSIFY_SUBMISSION = "classify-corpus"
FOREGROUND_POLL = "pipeline-job-foreground"
CONTINUATION_POLL = "pipeline-job-continuation"

_EMPTY_PASS = VaultClassificationPass(
    total=0,
    classified=0,
    preserved_manual=0,
    preserved_llm=0,
    privacy_tiers_assigned=0,
    retiered=0,
    praxis_marked=0,
    tags_extracted=0,
    complete=True,
)


def _empty_link(stage: VaultLinkStage) -> VaultLinkPass:
    """A linker stage that ran over an empty corpus and lost nothing."""
    return VaultLinkPass(
        stage=stage,
        fragment_count=0,
        link_count=0,
        largest_cluster_fragments=0,
        clusters_split=0,
        oversized_discarded=0,
    )


class PausedContinuationVaultClient(SequencedVaultClient):
    """A pipeline-capable double that holds the detached ladder's first dial.

    Every pipeline call is appended to ``order``, which the test also stamps the
    deletion response onto, so the assertion is a single read of one list.
    """

    def __init__(self) -> None:
        """Advertise the pipeline capability and arm the continuation's pause."""
        super().__init__(
            capabilities=frozenset(
                {
                    CreekCapability.JOURNAL,
                    CreekCapability.JOURNAL_WITHDRAW,
                    CreekCapability.CLASSIFY,
                    CreekCapability.PIPELINE,
                }
            )
        )
        self.order: list[str] = []
        self.continuation_dialled = asyncio.Event()
        self.release = asyncio.Event()
        self.job_polls = 0

    async def classify_corpus(self) -> VaultClassificationPass | VaultPipelineJob:
        """Accept a durable job rather than answering counts inline."""
        self.order.append(CLASSIFY_SUBMISSION)
        return VaultPipelineJob(
            job_id=uuid4(),
            stage=VaultPipelineStage.CLASSIFY,
            state=VaultPipelineJobState.RUNNING,
        )

    async def pipeline_job(
        self, job: VaultPipelineJob, /
    ) -> VaultClassificationPass | VaultPipelineJob:
        """Stay running for the foreground rung; pause, then land, for the ladder.

        The continuation's poll is recorded **after** its pause, exactly as
        ``PausedFirstIngest`` records ``ingest-sent`` after its own: what the
        assertion is about is the instant content crosses the seam, not the
        instant the coroutine was entered.
        """
        self.job_polls += 1
        if self.job_polls < _CONTINUATION_POLL_ORDINAL:
            self.order.append(FOREGROUND_POLL)
            return job
        if not self.continuation_dialled.is_set():
            self.continuation_dialled.set()
            await self.release.wait()
        self.order.append(CONTINUATION_POLL)
        return _EMPTY_PASS

    async def link_corpus(self, stage: VaultLinkStage, /) -> VaultLinkPass:
        """Record the linker rung this continuation climbed."""
        self.order.append(f"link-corpus-{stage.value}")
        return _empty_link(stage)


@pytest.fixture(autouse=True)
def _starve_the_foreground_rung(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force the handoff this file exists to test, instead of waiting for it."""
    monkeypatch.setattr(pipeline, "_JOURNAL_RUN_BUDGET_SECONDS", _STARVED_FOREGROUND_BUDGET_SECONDS)
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", _POLL_LONGER_THAN_THE_BUDGET_SECONDS)
    monkeypatch.setattr(
        pipeline,
        "_LEAST_WORTH_STARTING_SECONDS",
        _WORTH_STARTING_UNDER_A_STARVED_BUDGET_SECONDS,
    )


@pytest_asyncio.fixture(autouse=True)
async def _isolate_background_pipeline_tasks() -> AsyncGenerator[None, None]:
    """Give this test an empty in-process continuation registry, before and after.

    The registry is process-global by design and pytest reuses the process
    across independent databases, so a task still unwinding from another file
    would otherwise suppress this test's own continuation.
    """
    await pipeline.close_vault_pipeline_tasks()
    try:
        yield
    finally:
        await pipeline.close_vault_pipeline_tasks()


@pytest.mark.asyncio
async def test_no_pipeline_rung_is_climbed_after_the_deletion_response(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The detached ladder does not dial Creek for an account already erased."""
    fake = PausedContinuationVaultClient()
    monkeypatch.setitem(app.dependency_overrides, get_creek_vault_client, lambda: fake)
    headers, email = await signup(concurrent_async_client, "continuation_race")

    written = await concurrent_async_client.post(
        "/journal/",
        json={"message": "Ontologize me, then forget me.", "classification": "personal"},
        headers=headers,
    )
    assert written.status_code == HTTPStatus.CREATED
    await asyncio.wait_for(fake.continuation_dialled.wait(), timeout=_SETTLE_TIMEOUT_SECONDS)
    assert fake.order == [CLASSIFY_SUBMISSION, FOREGROUND_POLL], (
        "the foreground rung did not hand exactly one classification job to a "
        f"detached continuation: {fake.order}"
    )

    deleting = asyncio.create_task(
        delete_account_recording_order(concurrent_async_client, headers, email, fake.order)
    )
    await asyncio.wait({deleting}, timeout=_OVERTAKE_PROBE_SECONDS)
    fake.release.set()
    deleted = await asyncio.wait_for(deleting, timeout=_SETTLE_TIMEOUT_SECONDS)
    try:
        # Raw rather than exception-tolerant: a continuation that climbs an
        # erased account does not merely dial late, it also crashes writing the
        # run row it can no longer find, and both are this defect.
        await asyncio.wait_for(
            pipeline.wait_for_vault_pipeline_tasks(), timeout=_SETTLE_TIMEOUT_SECONDS
        )
    finally:
        # In ``finally`` so the ordering verdict is what the test reports even
        # when the drain itself blew up: the dial list is the primary fact, and
        # a crash inside the drain would otherwise hide it.
        after = fake.order[fake.order.index(DELETION_RESPONSE) :]
        assert after == [DELETION_RESPONSE], (
            f"a pipeline rung was climbed after the account-deletion response: {fake.order}"
        )

    assert deleted.status_code == HTTPStatus.OK
