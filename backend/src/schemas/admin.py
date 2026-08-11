"""Admin-dashboard schemas: LLM usage stats and manual entitlement overrides."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, StringConstraints, field_serializer

from models.entitlement import EntitlementKind

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
    # Populated only under ``?paginate=true``: ``per_user`` is then a bounded
    # page and these describe the full breakdown. ``None`` on the bare path so
    # the legacy response shape is unchanged.
    per_user_total: int | None = None
    per_user_has_more: bool | None = None

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


class StageProgressGapsPage(BaseModel):
    """A page of gaps found within a *bounded scan* of ``stageprogress`` rows.

    Deliberately NOT the shared ``Page`` envelope: the gap test runs in Python
    after the SELECT, so this endpoint pages over *scanned rows*, not gaps. The
    field names signal that so a caller can't mistake it for "page X of Y gaps":

    - ``items`` — the gaps found in the current window (``len(items) <= limit``,
      often far fewer, and may legitimately be ``0`` for a page of clean rows).
    - ``scanned_total`` — ``COUNT(*)`` of the base ``stageprogress`` table, i.e.
      total rows to scan, NOT the number of gaps.
    - ``has_more_rows`` — whether more rows remain to scan (not more gaps); a
      "load more" caller should drive off this and keep paging until it clears.
    """

    items: list[StageProgressGap]
    scanned_total: int
    limit: int
    offset: int
    has_more_rows: bool


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


class EnergyPlanCleanupResult(BaseModel):
    """Outcome of an energy-plan retention sweep: rows deleted + the window used."""

    deleted: int
    older_than_days: int


class EntitlementGrantRequest(BaseModel):
    """A manual entitlement grant, with the operator's reason.

    ``reason`` is the paper trail these endpoints exist to produce, so it is
    constrained rather than merely typed: ``min_length`` alone would accept
    ``"   "``, which records nothing while looking like a recorded decision.
    """

    kind: EntitlementKind = EntitlementKind.COURSE_ACCESS
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class EntitlementRevokeRequest(BaseModel):
    """A manual revocation, with the operator's reason. See the grant request."""

    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class EntitlementSummary(BaseModel):
    """One entitlement as the admin surface reports it.

    ``source_sale_id`` is included because NULL is what distinguishes a comp
    from a paid grant, and that distinction is the first thing an operator
    looking at a disputed account needs.
    """

    id: int
    kind: str
    product_id: str | None
    source_sale_id: int | None
    granted_at: datetime
    revoked_at: datetime | None
    metadata: dict[str, object]


class WalletAuditEntry(BaseModel):
    """One wallet ledger row, newest-first in the summary."""

    id: int
    bucket: str
    reason: str
    delta: Decimal
    balance_before: Decimal
    balance_after: Decimal
    actor_user_id: int | None
    created_at: datetime


class GumroadSaleSummary(BaseModel):
    """One Gumroad sale matched to the user by email.

    ``GumroadSale`` carries no user id, so email is the only link available;
    the summary reports what matched so a mismatch is visible rather than
    silently absent.

    No price field: :class:`models.gumroad_sale.GumroadSale` stores none. The
    amount lives only inside ``raw_payload``, which is the verbatim webhook
    form and is deliberately not surfaced here — it carries the whole Gumroad
    payload, more than an entitlement question needs.
    """

    id: int
    gumroad_sale_id: str
    product_id: str
    email: str
    resource_name: str
    is_recurring_charge: bool
    refunded: bool
    created_at: datetime


class AdminUserSummary(BaseModel):
    """Everything the operator needs about one account, in a single call.

    Deliberately a read-only aggregate: the point is to replace a SQL console
    session, so it gathers the entitlement, wallet and purchase pictures that
    would otherwise require three separate queries against three tables.
    """

    user_id: int
    email: str
    created_at: datetime
    is_admin: bool
    entitlements: list[EntitlementSummary]
    offering_balance: int
    monthly_messages_used: int
    wallet_audit: list[WalletAuditEntry]
    gumroad_sales: list[GumroadSaleSummary]
