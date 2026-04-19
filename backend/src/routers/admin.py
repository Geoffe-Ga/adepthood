"""Admin-only endpoints — gated by the per-user ``User.is_admin`` flag.

BUG-ADMIN-001: The previous implementation trusted a shared ``ADMIN_API_KEY``
header, so any leak revoked the entire admin surface and nothing tied an
action back to a specific operator.  Admin identity is now a first-class
per-user flag (:attr:`User.is_admin`), so gate every admin route on
:func:`dependencies.auth.require_admin` — never on an env-var header.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from database import get_session
from dependencies.auth import require_admin
from models.llm_usage_log import LLMUsageLog
from models.user import User
from schemas.admin import (
    ModelUsageBreakdown,
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
