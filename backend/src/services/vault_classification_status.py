"""What the account's vault classification last said that the writer can act on.

Read by ``GET /vault/connection`` (#3595). The pipeline records each pass on a
content-free :class:`~models.vault_pipeline_run.VaultPipelineRun` row; this
module answers one question from those rows: did the latest *settled*
classification fail because the writer's own provider key was refused (Creek
contract 0.26, ``request_key_rejected``)?

"Settled" excludes ``queued`` and ``attempted`` rows: a pass still in flight has
not answered, so it neither raises nor clears the notice. Any later pass that
lands -- completed, incomplete, failed for another reason, or ambiguous --
supersedes the refusal, because it is newer evidence about the key that is in
use now. One indexed lookup on ``(user_id, stage, id)``; nothing here reads
writing or calls out.
"""

from __future__ import annotations

from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.creek_vault import VaultJobFailureCode, VaultPipelineStage
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun

#: The outcomes a pass has answered with. Queued and attempted rows are not here.
_SETTLED: Final = frozenset(
    {
        VaultPipelineOutcome.COMPLETED.value,
        VaultPipelineOutcome.INCOMPLETE.value,
        VaultPipelineOutcome.FAILED.value,
        VaultPipelineOutcome.AMBIGUOUS.value,
    }
)


async def classification_key_rejected(session: AsyncSession, user_id: int) -> bool:
    """Whether ``user_id``'s latest settled classification was refused for their key."""
    statement = (
        select(VaultPipelineRun.failure_code)
        .where(
            col(VaultPipelineRun.user_id) == user_id,
            col(VaultPipelineRun.stage) == VaultPipelineStage.CLASSIFY.value,
            col(VaultPipelineRun.outcome).in_(_SETTLED),
        )
        .order_by(col(VaultPipelineRun.id).desc())
        .limit(1)
    )
    latest = (await session.execute(statement)).scalar_one_or_none()
    return latest == VaultJobFailureCode.REQUEST_KEY_REJECTED.value
