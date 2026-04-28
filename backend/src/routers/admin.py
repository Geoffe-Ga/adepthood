"""Admin-only endpoints — gated by the per-user ``User.is_admin`` flag.

Gate every admin route on :func:`dependencies.auth.require_admin` so admin
identity is a first-class per-user flag rather than a shared header secret.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from database import get_session
from dependencies.auth import require_admin
from errors import not_found
from models.llm_usage_log import LLMUsageLog
from models.stage_progress import StageProgress
from models.user import User
from schemas.admin import (
    ModelUsageBreakdown,
    StageProgressGap,
    StageProgressGapsResponse,
    StageProgressRepairResult,
    UsageStatsResponse,
    UserUsageBreakdown,
)

# SQL ``SUM(NUMERIC)`` returns ``Decimal`` on Postgres but ``int`` (or
# ``float``) on SQLite for an empty group.  Coerce defensively to keep
# the response shape stable across both engines (BUG-ADMIN-004).
_ZERO_COST = Decimal(0)


def _to_decimal(value: object) -> Decimal:
    """Coerce a SUM result to ``Decimal``, treating ``None`` as zero.

    SUM returns ``None`` for an empty group on Postgres unless wrapped
    in ``COALESCE``; SQLite returns ``0`` either way.  Routing both
    through this helper means the response shape is identical on both
    engines and on either branch of the COALESCE.
    """
    if value is None:
        return _ZERO_COST
    if isinstance(value, Decimal):
        return value
    # ``str(value)`` -- never ``Decimal(float)`` -- so float-precision
    # noise does not slip into a value that will be displayed to USD.
    return Decimal(str(value))


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/usage-stats", response_model=UsageStatsResponse)
async def get_usage_stats(
    session: Annotated[AsyncSession, Depends(get_session)],
    _admin: Annotated[User, Depends(require_admin)],
) -> UsageStatsResponse:
    """Return aggregate LLM usage stats across all users.

    Three views are returned in a single response so a dashboard can render
    total spend, top users by cost, and model-mix breakdown without making
    three round trips:

    * ``total_*`` — all-time totals
    * ``per_user`` — one row per user who has consumed any tokens
    * ``per_model`` — one row per distinct ``(provider, model)`` pair
    """
    totals_row = (
        await session.execute(
            select(
                func.count(col(LLMUsageLog.id)),
                func.coalesce(func.sum(col(LLMUsageLog.prompt_tokens)), 0),
                func.coalesce(func.sum(col(LLMUsageLog.completion_tokens)), 0),
                func.coalesce(func.sum(col(LLMUsageLog.total_tokens)), 0),
                func.coalesce(func.sum(col(LLMUsageLog.estimated_cost_usd)), _ZERO_COST),
            )
        )
    ).one()
    total_calls, total_prompt, total_completion, total_tokens, total_cost = totals_row

    per_user_rows = (
        await session.execute(
            select(
                col(LLMUsageLog.user_id),
                func.count(col(LLMUsageLog.id)),
                func.coalesce(func.sum(col(LLMUsageLog.total_tokens)), 0),
                func.coalesce(func.sum(col(LLMUsageLog.estimated_cost_usd)), _ZERO_COST),
            )
            .group_by(col(LLMUsageLog.user_id))
            .order_by(func.sum(col(LLMUsageLog.estimated_cost_usd)).desc())
        )
    ).all()

    per_model_rows = (
        await session.execute(
            select(
                col(LLMUsageLog.provider),
                col(LLMUsageLog.model),
                func.count(col(LLMUsageLog.id)),
                func.coalesce(func.sum(col(LLMUsageLog.total_tokens)), 0),
                func.coalesce(func.sum(col(LLMUsageLog.estimated_cost_usd)), _ZERO_COST),
            )
            .group_by(col(LLMUsageLog.provider), col(LLMUsageLog.model))
            .order_by(func.sum(col(LLMUsageLog.estimated_cost_usd)).desc())
        )
    ).all()

    return UsageStatsResponse(
        total_calls=int(total_calls),
        total_prompt_tokens=int(total_prompt),
        total_completion_tokens=int(total_completion),
        total_tokens=int(total_tokens),
        total_estimated_cost_usd=_to_decimal(total_cost),
        per_user=[
            UserUsageBreakdown(
                user_id=int(user_id),
                call_count=int(calls),
                total_tokens=int(tokens),
                estimated_cost_usd=_to_decimal(cost),
            )
            for user_id, calls, tokens, cost in per_user_rows
        ],
        per_model=[
            ModelUsageBreakdown(
                provider=str(provider),
                model=str(model),
                call_count=int(calls),
                total_tokens=int(tokens),
                estimated_cost_usd=_to_decimal(cost),
            )
            for provider, model, calls, tokens, cost in per_model_rows
        ],
    )


def _detect_gap(progress: StageProgress) -> StageProgressGap | None:
    """Return a :class:`StageProgressGap` when ``completed_stages`` is non-contiguous.

    The invariant every stage mutation must preserve is
    ``set(completed_stages) == {1..current_stage-1}``.  Anything else — a
    missing entry in the middle, an over-credited future stage, a duplicate
    value that rounds the same way when set-reduced — is a gap the chain
    validation in :func:`domain.stage_progress.is_stage_unlocked` must be
    blind to.  Returning ``None`` for contiguous rows keeps the listing
    endpoint's loop trivial.
    """
    completed = set(progress.completed_stages or [])
    expected = set(range(1, progress.current_stage))
    if completed == expected:
        return None
    return StageProgressGap(
        user_id=progress.user_id,
        current_stage=progress.current_stage,
        completed_stages=sorted(completed),
        missing_stages=sorted(expected - completed),
        extra_stages=sorted(completed - expected),
    )


@router.get("/stage-progress/gaps", response_model=StageProgressGapsResponse)
async def list_stage_progress_gaps(
    session: Annotated[AsyncSession, Depends(get_session)],
    _admin: Annotated[User, Depends(require_admin)],
) -> StageProgressGapsResponse:
    """Return every ``stageprogress`` row whose completed set is non-contiguous.

    Read-only: mirrors the audit migration's logging so operators can inspect
    flagged rows on a live database without trawling alembic logs.  Pair with
    :func:`repair_stage_progress` to rewrite a single row explicitly.
    """
    result = await session.execute(select(StageProgress))
    gaps = [gap for row in result.scalars().all() if (gap := _detect_gap(row)) is not None]
    return StageProgressGapsResponse(rows=gaps, total=len(gaps))


@router.post("/stage-progress/{user_id}/repair", response_model=StageProgressRepairResult)
async def repair_stage_progress(
    user_id: int,
    session: Annotated[AsyncSession, Depends(get_session)],
    admin: Annotated[User, Depends(require_admin)],
) -> StageProgressRepairResult:
    """Rewrite one user's ``completed_stages`` to ``{1..current_stage-1}``.

    Explicit admin action: running this is a decision to forfeit whatever
    intermediate-stage credit the gap encoded in favour of the canonical
    chain-validation invariant.  Returns the delta so the caller has a
    record of what changed.

    Emits a structured ``stage_progress_repaired`` log entry with the
    admin, target, and delta so the action is traceable — repair mutates
    user progression irreversibly, so leaving no audit trail would let a
    mistaken or malicious write vanish silently.
    """
    result = await session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    progress = result.scalars().first()
    if progress is None:
        raise not_found("stage_progress")

    before = set(progress.completed_stages or [])
    expected = set(range(1, progress.current_stage))
    stages_added = sorted(expected - before)
    stages_removed = sorted(before - expected)
    progress.completed_stages = sorted(expected)
    await session.commit()
    await session.refresh(progress)

    logger.warning(
        "stage_progress_repaired",
        extra={
            "admin_id": admin.id,
            "user_id": user_id,
            "current_stage": progress.current_stage,
            "stages_added": stages_added,
            "stages_removed": stages_removed,
        },
    )

    return StageProgressRepairResult(
        user_id=user_id,
        current_stage=progress.current_stage,
        completed_stages=sorted(expected),
        stages_added=stages_added,
        stages_removed=stages_removed,
    )
