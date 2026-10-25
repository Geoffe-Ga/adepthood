"""Read Creek's counts and opaque job answers into the durable pipeline vocabulary.

These projections contain no network, scheduling or credential state. Keeping
result interpretation apart from orchestration makes partial classification,
real link loss and recoverable job identity explicit at their wire boundary.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from uuid import UUID

from domain.creek_vault import (
    VaultClassificationPass,
    VaultLinkPass,
    VaultLinkStage,
    VaultPipelineJob,
    VaultPipelineJobState,
    VaultPipelineStage,
)
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun

_LOGGER = logging.getLogger(__name__)


def classification_outcome(result: VaultClassificationPass) -> VaultPipelineOutcome:
    """Read a classification pass as the outcome it is.

    ``complete: false`` is not a failure. The pass is resumable and short-circuits
    on what it already stamped, so an incomplete run means the honest next step is
    to call again — and the labels it did write are real, which is why the stages
    that read them are still allowed to run in the same pass.
    """
    return VaultPipelineOutcome.COMPLETED if result.complete else VaultPipelineOutcome.INCOMPLETE


@dataclass(frozen=True)
class StageCounts:
    """What one rung reached, in the one vocabulary both routes are read through.

    Creek answers a classification pass and a linker stage in different fields,
    and the scheduler that records them does not care which route answered: what
    it needs is how much was looked at, how much was acted on, and how much was
    lost. Defaulting all three to zero is what lets a failed attempt be recorded
    with the same call as a successful one -- a stage that did not land reached
    nothing, and saying so is more honest than leaving the row's counts to a
    sentinel.

    Attributes:
        seen: Fragments the stage loaded or visited.
        touched: Fragments it rewrote, or links it emitted.
        lost: Fragments it dropped to noise. Only a clustering stage can lose
            any; the classification pass loses nothing.
    """

    seen: int = 0
    touched: int = 0
    lost: int = 0


def note_link_loss(stage: VaultLinkStage, result: VaultLinkPass) -> None:
    """Log real partial data loss, in enum values and integers alone.

    Fragments dropped to noise carry no link at all, and Creek publishes the
    count rather than folding it away precisely so a caller cannot read a lossy
    pass as a clean one. The record is content-free by construction: a stage
    name from a closed set of our own, and two numbers.
    """
    if result.oversized_discarded:
        _LOGGER.warning(
            "creek vault link stage dropped fragments to noise",
            extra={
                "stage": stage.value,
                "fragments_lost": result.oversized_discarded,
                "fragments_seen": result.fragment_count,
            },
        )


def counts_from_result(
    result: VaultClassificationPass | VaultLinkPass,
) -> tuple[VaultPipelineOutcome, StageCounts]:
    """Read either published counts-only result into the persisted vocabulary."""
    if isinstance(result, VaultClassificationPass):
        return classification_outcome(result), StageCounts(
            seen=result.total,
            touched=result.classified,
        )
    note_link_loss(result.stage, result)
    return VaultPipelineOutcome.COMPLETED, StageCounts(
        seen=result.fragment_count,
        touched=result.link_count,
        lost=result.oversized_discarded,
    )


def persisted_counts(run: VaultPipelineRun) -> tuple[VaultPipelineOutcome, StageCounts]:
    """Reuse a terminal answer another admitted worker has already published."""
    return VaultPipelineOutcome(run.outcome), StageCounts(
        seen=run.fragments_seen,
        touched=run.fragments_touched,
        lost=run.fragments_lost,
    )


def poll_needs_reconciliation(run: VaultPipelineRun, outcome: VaultPipelineOutcome) -> bool:
    """A failed status can retry; an already-persisted admission refusal is final."""
    return (
        outcome is VaultPipelineOutcome.FAILED
        and run.outcome == VaultPipelineOutcome.ATTEMPTED.value
    )


def job_from_run(run: VaultPipelineRun, stage: VaultPipelineStage) -> VaultPipelineJob | None:
    """Rebuild a validated opaque handle from one persisted in-flight row."""
    if run.job_id is None:
        return None
    try:
        job_id = UUID(run.job_id)
    except ValueError:
        return None
    return VaultPipelineJob(
        job_id=job_id,
        stage=stage,
        state=VaultPipelineJobState.QUEUED,
    )


def pending_admission_event(run: VaultPipelineRun, stage: VaultPipelineStage) -> str:
    """An accepted durable handle is distinct from an unanswered admission."""
    if job_from_run(run, stage) is not None:
        return "creek vault pipeline job admitted; polling deferred"
    return "creek vault pipeline admission unconfirmed"


def failed_job(job: VaultPipelineJob) -> VaultPipelineJob:
    """Return the content-free terminal handle used for definitive status faults."""
    return VaultPipelineJob(
        job_id=job.job_id,
        stage=job.stage,
        state=VaultPipelineJobState.FAILED,
    )


def pending_job(
    result: VaultClassificationPass | VaultLinkPass | VaultPipelineJob,
) -> VaultPipelineJob | None:
    """Return the next pending handle, or ``None`` for a terminal answer."""
    if isinstance(result, VaultPipelineJob) and (result.state is not VaultPipelineJobState.FAILED):
        return result
    return None


def classification_allows_progress(
    stage: VaultPipelineStage,
    outcome: VaultPipelineOutcome,
) -> bool:
    """Whether this outcome leaves classification's downstream labels usable."""
    return stage is not VaultPipelineStage.CLASSIFY or outcome in {
        VaultPipelineOutcome.COMPLETED,
        VaultPipelineOutcome.INCOMPLETE,
    }
