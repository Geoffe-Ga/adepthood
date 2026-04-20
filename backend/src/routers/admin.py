"""Admin-only endpoints — gated by the per-user ``User.is_admin`` flag.

Gate every admin route on :func:`dependencies.auth.require_admin` so admin
identity is a first-class per-user flag rather than a shared header secret.
"""

from __future__ import annotations

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
    UsageStatsResponse,
    UserUsageBreakdown,
)

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
                func.coalesce(func.sum(col(LLMUsageLog.estimated_cost_usd)), 0.0),
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
                func.coalesce(func.sum(col(LLMUsageLog.estimated_cost_usd)), 0.0),
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
                func.coalesce(func.sum(col(LLMUsageLog.estimated_cost_usd)), 0.0),
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
        total_estimated_cost_usd=float(total_cost),
        per_user=[
            UserUsageBreakdown(
                user_id=int(user_id),
                call_count=int(calls),
                total_tokens=int(tokens),
                estimated_cost_usd=float(cost),
            )
            for user_id, calls, tokens, cost in per_user_rows
        ],
        per_model=[
            ModelUsageBreakdown(
                provider=str(provider),
                model=str(model),
                call_count=int(calls),
                total_tokens=int(tokens),
                estimated_cost_usd=float(cost),
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


@router.post("/stage-progress/{user_id}/repair", response_model=StageProgressGap)
async def repair_stage_progress(
    user_id: int,
    session: Annotated[AsyncSession, Depends(get_session)],
    _admin: Annotated[User, Depends(require_admin)],
) -> StageProgressGap:
    """Rewrite one user's ``completed_stages`` to ``{1..current_stage-1}``.

    Explicit admin action: running this is a decision to forfeit whatever
    intermediate-stage credit the gap encoded in favour of the canonical
    chain-validation invariant.  Returns the old/new delta so the caller has
    a record of what changed.
    """
    result = await session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    progress = result.scalars().first()
    if progress is None:
        raise not_found("stage_progress")

    before = set(progress.completed_stages or [])
    expected = set(range(1, progress.current_stage))
    progress.completed_stages = sorted(expected)
    session.add(progress)
    await session.commit()
    await session.refresh(progress)

    return StageProgressGap(
        user_id=user_id,
        current_stage=progress.current_stage,
        completed_stages=sorted(expected),
        missing_stages=sorted(expected - before),
        extra_stages=sorted(before - expected),
    )
