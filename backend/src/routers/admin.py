"""Admin-only endpoints — gated by ``ADMIN_API_KEY`` shared-secret header.

The admin surface is intentionally minimal: enough to observe LLM cost and
token consumption without introducing a whole role-based-access-control layer
up front.  Once the app grows an admin user role, swap the header gate for a
user-role check and the endpoints here can stay unchanged.
"""

from __future__ import annotations

import hmac
import os

from fastapi import APIRouter, Depends, Header
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from database import get_session
from errors import forbidden
from models.llm_usage_log import LLMUsageLog
from schemas.admin import (
    ModelUsageBreakdown,
    UsageStatsResponse,
    UserUsageBreakdown,
)

router = APIRouter(prefix="/admin", tags=["admin"])


# Header used by the admin to authenticate.  The value is compared to the
# ``ADMIN_API_KEY`` env var using a constant-time comparison so attackers
# cannot recover the key via timing side-channels.
ADMIN_API_KEY_HEADER = "X-Admin-API-Key"  # pragma: allowlist secret


def _require_admin(
    x_admin_api_key: str | None = Header(default=None, alias=ADMIN_API_KEY_HEADER),
) -> None:
    """FastAPI dependency: reject requests without a valid admin key.

    ``ADMIN_API_KEY`` must be set to a non-empty value for the endpoint to be
    reachable at all.  An unset env var fails closed — we never treat "no
    password configured" as "anyone may enter".
    """
    expected = os.getenv("ADMIN_API_KEY", "")
    if not expected:
        raise forbidden("admin_api_disabled")
    if not x_admin_api_key or not hmac.compare_digest(x_admin_api_key, expected):
        raise forbidden("admin_auth_required")


@router.get("/usage-stats", response_model=UsageStatsResponse)
async def get_usage_stats(
    session: AsyncSession = Depends(get_session),  # noqa: B008
    _: None = Depends(_require_admin),
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
