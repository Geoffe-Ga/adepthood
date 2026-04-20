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


class StageProgressGap(BaseModel):
    """A ``stageprogress`` row whose completed set is non-contiguous from 1.

    ``missing_stages`` and ``extra_stages`` are the symmetric-difference halves
    so an operator can tell at a glance whether a row is under-credited (gaps
    in the middle) or over-credited (a completed_stages value past the current
    stage).
    """

    user_id: int
    current_stage: int
    completed_stages: list[int]
    missing_stages: list[int]
    extra_stages: list[int]


class StageProgressGapsResponse(BaseModel):
    """Report of every ``stageprogress`` row with a non-contiguous set."""

    rows: list[StageProgressGap]
    total: int


class StageProgressRepairResult(BaseModel):
    """Outcome of a single repair of a ``stageprogress`` row.

    ``completed_stages`` holds the canonical post-repair set.  The delta
    fields describe what the repair *did* — ``stages_added`` are values
    the invariant required but were missing, ``stages_removed`` are
    over-credited values the invariant forbade.  Separating this shape
    from :class:`StageProgressGap` keeps the pre-repair and post-repair
    semantics distinct for clients that render both.
    """

    user_id: int
    current_stage: int
    completed_stages: list[int]
    stages_added: list[int]
    stages_removed: list[int]
