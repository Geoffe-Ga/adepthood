"""What the account's vault classification last said that the writer should know.

Read by ``GET /vault/connection``. The pipeline records each pass on a
content-free :class:`~models.vault_pipeline_run.VaultPipelineRun` row; this
module answers two questions from those rows, in one round trip, and they are
about two different rows on purpose.

**Was the writer's key refused?** (#3595) Read from the latest *settled* pass.
"Settled" excludes ``queued`` and ``attempted`` rows: a pass still in flight has
not answered, so it neither raises nor clears the notice. Any later pass that
lands -- completed, incomplete, failed for another reason, or ambiguous --
supersedes the refusal, because it is newer evidence about the key in use now.

**Has the writing had its full sort?** (#3577) Read from the latest pass that
*landed labels*: ``completed`` or ``incomplete``. A failed or ambiguous pass
wrote nothing, so it must not mask the sort the writing really has -- a rough
rules sort followed by a refused key is still a rough sort. A managed rules
fallback is persisted ``incomplete`` by
:func:`~services.creek_vault_pipeline_results.classification_outcome`, so it can
only ever read ``incomplete`` here.

The two can both be true at once and never contradict: one describes the work
already done, the other why the latest attempt at more of it stopped. Each is
one indexed lookup on ``(user_id, stage, id)``, sent as a single statement;
nothing here reads writing or calls out.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from sqlalchemy import ColumnElement
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.creek_vault import VaultJobFailureCode, VaultPipelineStage
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from schemas.vault_config import VaultClassificationState

#: Outcomes whose pass wrote labels the writing now carries.
_LANDED: Final = frozenset(
    {VaultPipelineOutcome.COMPLETED.value, VaultPipelineOutcome.INCOMPLETE.value}
)

#: The outcomes a pass has answered with. Queued and attempted rows are not here.
_SETTLED: Final = _LANDED | {
    VaultPipelineOutcome.FAILED.value,
    VaultPipelineOutcome.AMBIGUOUS.value,
}


@dataclass(frozen=True)
class VaultClassificationStatus:
    """The two facts, each read from its own row.

    Attributes:
        key_rejected: The latest settled pass failed because the writer's own
            provider key was refused (Creek contract 0.26).
        landed_outcome: The outcome of the latest pass that landed labels, or
            ``None`` when none has.
    """

    key_rejected: bool
    landed_outcome: VaultPipelineOutcome | None

    def state(self, *, has_vault: bool) -> VaultClassificationState | None:
        """The sort state for an account that does, or does not, have a vault.

        No vault, no state: rows left from a vault since removed say nothing
        about one that is not there.
        """
        if not has_vault:
            return None
        if self.landed_outcome is None:
            return VaultClassificationState.NOT_RUN
        if self.landed_outcome is VaultPipelineOutcome.COMPLETED:
            return VaultClassificationState.COMPLETE
        return VaultClassificationState.INCOMPLETE


def _classify_rows_in(user_id: int, outcomes: frozenset[str]) -> tuple[ColumnElement[bool], ...]:
    """The filter selecting ``user_id``'s own classify rows whose outcome is in ``outcomes``."""
    return (
        col(VaultPipelineRun.user_id) == user_id,
        col(VaultPipelineRun.stage) == VaultPipelineStage.CLASSIFY.value,
        col(VaultPipelineRun.outcome).in_(outcomes),
    )


async def classification_status(session: AsyncSession, user_id: int) -> VaultClassificationStatus:
    """Read both facts about ``user_id``'s own classification rows in one statement."""
    newest_first = col(VaultPipelineRun.id).desc()
    settled_code = (
        select(col(VaultPipelineRun.failure_code))
        .where(*_classify_rows_in(user_id, _SETTLED))
        .order_by(newest_first)
        .limit(1)
        .scalar_subquery()
    )
    landed_outcome = (
        select(col(VaultPipelineRun.outcome))
        .where(*_classify_rows_in(user_id, _LANDED))
        .order_by(newest_first)
        .limit(1)
        .scalar_subquery()
    )
    statement = select(settled_code, landed_outcome)
    code, landed = (await session.execute(statement)).one()
    return VaultClassificationStatus(
        key_rejected=code == VaultJobFailureCode.REQUEST_KEY_REJECTED.value,
        landed_outcome=None if landed is None else VaultPipelineOutcome(landed),
    )
