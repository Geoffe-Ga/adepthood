"""Admin-dashboard response schemas for LLM usage stats."""

from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, field_serializer

# Six decimal places match the storage scale on
# :class:`models.llm_usage_log.LLMUsageLog.estimated_cost_usd` so the
# wire format and the database row reconcile without re-quantising on
# either side.  Pydantic v2 dropped ``json_encoders`` in favour of
# :func:`field_serializer`; the serializer below emits a fixed-point
# string (no scientific notation) so JS consumers do not silently
# truncate ``1e-7`` style values.
_COST_QUANTUM = Decimal("0.000001")


def _format_cost(value: Decimal | None) -> str | None:
    """Serialize a cost value as a fixed-point string, preserving ``None``.

    ``None`` is preserved verbatim because :mod:`services.llm_pricing`
    uses it for "unknown model — no rate" (BUG-BM-008); collapsing it to
    ``"0"`` or ``"0.000000"`` would re-introduce the silent-zero bug
    that motivated this change.
    """
    if value is None:
        return None
    return format(value.quantize(_COST_QUANTUM), "f")


class UserUsageBreakdown(BaseModel):
    """Per-user LLM usage aggregate."""

    user_id: int
    call_count: int
    total_tokens: int
    estimated_cost_usd: Decimal

    @field_serializer("estimated_cost_usd")
    def _serialize_cost(self, value: Decimal) -> str:
        # Aggregates cannot be ``None`` — SUM returns 0 for an empty
        # group — so the helper's narrowing is safe to discard here.
        return _format_cost(value) or "0.000000"


class ModelUsageBreakdown(BaseModel):
    """Per-model LLM usage aggregate.  Grouped by ``(provider, model)``."""

    provider: str
    model: str
    call_count: int
    total_tokens: int
    estimated_cost_usd: Decimal

    @field_serializer("estimated_cost_usd")
    def _serialize_cost(self, value: Decimal) -> str:
        return _format_cost(value) or "0.000000"


class UsageStatsResponse(BaseModel):
    """Aggregate LLM usage stats for the admin dashboard.

    Totals are precomputed so the client never has to sum the breakdown lists
    to render the headline number.  Monetary fields are :class:`Decimal`
    serialized as fixed-point strings (BUG-ADMIN-004 / BUG-BM-008) so
    a JS client that does ``parseFloat(...)`` still sees the same value
    bit-for-bit, while a Python client that does ``Decimal(...)`` keeps
    full precision for further arithmetic.
    """

    total_calls: int
    total_prompt_tokens: int
    total_completion_tokens: int
    total_tokens: int
    total_estimated_cost_usd: Decimal
    per_user: list[UserUsageBreakdown]
    per_model: list[ModelUsageBreakdown]

    @field_serializer("total_estimated_cost_usd")
    def _serialize_total(self, value: Decimal) -> str:
        return _format_cost(value) or "0.000000"


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
