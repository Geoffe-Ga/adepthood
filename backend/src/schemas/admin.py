"""Admin-dashboard response schemas for LLM usage stats."""

from __future__ import annotations

from pydantic import BaseModel


class UserUsageBreakdown(BaseModel):
    """Per-user LLM usage aggregate."""

    user_id: int
    call_count: int
    total_tokens: int
    estimated_cost_usd: float


class ModelUsageBreakdown(BaseModel):
    """Per-model LLM usage aggregate.  Grouped by ``(provider, model)``."""

    provider: str
    model: str
    call_count: int
    total_tokens: int
    estimated_cost_usd: float


class UsageStatsResponse(BaseModel):
    """Aggregate LLM usage stats for the admin dashboard.

    Totals are precomputed so the client never has to sum the breakdown lists
    to render the headline number.
    """

    total_calls: int
    total_prompt_tokens: int
    total_completion_tokens: int
    total_tokens: int
    total_estimated_cost_usd: float
    per_user: list[UserUsageBreakdown]
    per_model: list[ModelUsageBreakdown]
