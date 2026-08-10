"""Admin-only endpoints — gated by the per-user ``User.is_admin`` flag.

Gate every admin route on :func:`dependencies.auth.require_admin` so admin
identity is a first-class per-user flag rather than a shared header secret.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal
from http import HTTPStatus
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from database import get_session
from dependencies.auth import require_admin
from domain.entitlements import grant_manual_course_access, revoke_entitlement_by_id
from domain.stage_progress import completed_stage_gap, expected_completed_stages
from errors import bad_request, not_found
from models.entitlement import Entitlement
from models.gumroad_sale import GumroadSale
from models.llm_usage_log import LLMUsageLog
from models.stage_progress import StageProgress
from models.user import User
from models.wallet_audit import WalletAudit
from rate_limit import limiter
from schemas import PaginationParams
from schemas.admin import (
    AdminUserSummary,
    EnergyPlanCleanupResult,
    EntitlementGrantRequest,
    EntitlementRevokeRequest,
    EntitlementSummary,
    GumroadSaleSummary,
    ModelUsageBreakdown,
    StageProgressGap,
    StageProgressGapsPage,
    StageProgressGapsResponse,
    StageProgressRepairResult,
    UsageStatsResponse,
    UserUsageBreakdown,
    WalletAuditEntry,
)
from schemas.pagination import count_query_total, page_has_more, paginate_query
from services.energy import ENERGY_PLAN_RETENTION_DAYS, delete_expired_energy_plans

# SQL ``SUM(NUMERIC)`` returns ``Decimal`` on Postgres but ``int`` (or
# ``float``) on SQLite for an empty group.  Coerce defensively to keep
# the response shape stable across both engines (BUG-ADMIN-004).
_ZERO_COST = Decimal(0)

# How much history the user summary carries. Enough to see the recent shape of
# an account without turning one operator lookup into an unbounded scan of a
# heavy customer's ledger.
_WALLET_AUDIT_LIMIT = 20
_GUMROAD_SALE_LIMIT = 10

# Manual overrides are rare, deliberate, and irreversible-ish (a revoke cuts
# off access immediately). A tight limit bounds the blast radius of a stolen
# admin token or a looping script without ever inconveniencing a human.
_OVERRIDE_RATE_LIMIT = "10/minute"


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


async def _fetch_per_user(
    session: AsyncSession, pagination: PaginationParams
) -> tuple[list[UserUsageBreakdown], int | None, bool | None]:
    """Aggregate token usage per user, bounded to a page under ``?paginate=true``.

    Ordering is highest-cost-first. The SUM is wrapped in ``COALESCE`` inside the
    ``ORDER BY`` because PostgreSQL sorts ``DESC`` ``NULLS FIRST`` — an
    unrated-model group (all-``NULL`` cost) would otherwise sort above every
    real-cost row and invert the dashboard's "highest spender first" view.

    Returns ``(breakdown, total, has_more)``; ``total`` / ``has_more`` are
    ``None`` on the unbounded bare path.
    """
    cost_sum = func.coalesce(func.sum(col(LLMUsageLog.estimated_cost_usd)), _ZERO_COST)
    query = (
        select(
            col(LLMUsageLog.user_id),
            func.count(col(LLMUsageLog.id)),
            func.coalesce(func.sum(col(LLMUsageLog.total_tokens)), 0),
            cost_sum,
        )
        .group_by(col(LLMUsageLog.user_id))
        .order_by(cost_sum.desc())
    )
    total: int | None = None
    has_more: bool | None = None
    if pagination.paginate:
        total = await count_query_total(session, query)
        has_more = page_has_more(pagination.offset, pagination.limit, total)
        query = query.offset(pagination.offset).limit(pagination.limit)
    rows = (await session.execute(query)).all()
    breakdown = [
        UserUsageBreakdown(
            user_id=int(user_id),
            call_count=int(calls),
            total_tokens=int(tokens),
            estimated_cost_usd=_to_decimal(cost),
        )
        for user_id, calls, tokens, cost in rows
    ]
    return breakdown, total, has_more


@router.get("/usage-stats", response_model=UsageStatsResponse)
async def get_usage_stats(
    session: Annotated[AsyncSession, Depends(get_session)],
    _admin: Annotated[User, Depends(require_admin)],
    pagination: Annotated[PaginationParams, Depends()],
) -> UsageStatsResponse:
    """Return aggregate LLM usage stats across all users.

    Three views are returned in a single response so a dashboard can render
    total spend, top users by cost, and model-mix breakdown without making
    three round trips:

    * ``total_*`` — all-time totals
    * ``per_user`` — one row per user who has consumed any tokens
    * ``per_model`` — one row per distinct ``(provider, model)`` pair

    ``per_user`` grows one row per token-using user (unbounded). Pass
    ``?paginate=true`` to bound it to a page (highest-cost-first preserved);
    ``per_user_total`` / ``per_user_has_more`` then describe the full set.
    ``totals`` and ``per_model`` (bounded by distinct-model count) are unchanged.
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

    per_user, per_user_total, per_user_has_more = await _fetch_per_user(session, pagination)

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
            # See the per-user query above — same NULLS-FIRST guard.
            .order_by(
                func.coalesce(func.sum(col(LLMUsageLog.estimated_cost_usd)), _ZERO_COST).desc()
            )
        )
    ).all()

    return UsageStatsResponse(
        total_calls=int(total_calls),
        total_prompt_tokens=int(total_prompt),
        total_completion_tokens=int(total_completion),
        total_tokens=int(total_tokens),
        total_estimated_cost_usd=_to_decimal(total_cost),
        per_user=per_user,
        per_user_total=per_user_total,
        per_user_has_more=per_user_has_more,
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
    missing, extra = completed_stage_gap(completed, progress.current_stage)
    if not missing and not extra:
        return None
    return StageProgressGap(
        user_id=progress.user_id,
        current_stage=progress.current_stage,
        completed_stages=sorted(completed),
        missing_stages=sorted(missing),
        extra_stages=sorted(extra),
    )


def _gaps_from_rows(rows: list[StageProgress]) -> list[StageProgressGap]:
    """Filter a batch of ``StageProgress`` rows down to the non-contiguous ones."""
    return [gap for row in rows if (gap := _detect_gap(row)) is not None]


@router.get(
    "/stage-progress/gaps",
    response_model=StageProgressGapsPage | StageProgressGapsResponse,
)
async def list_stage_progress_gaps(
    session: Annotated[AsyncSession, Depends(get_session)],
    _admin: Annotated[User, Depends(require_admin)],
    pagination: Annotated[PaginationParams, Depends()],
) -> StageProgressGapsPage | StageProgressGapsResponse:
    """Return ``stageprogress`` rows whose completed set is non-contiguous.

    Read-only: mirrors the audit migration's logging so operators can inspect
    flagged rows on a live database without trawling alembic logs.  Pair with
    :func:`repair_stage_progress` to rewrite a single row explicitly.

    The gap filter is applied per row *after* the SELECT, so under
    ``?paginate=true`` only ``limit`` ``StageProgress`` rows are materialised —
    not the whole table. That path returns a :class:`StageProgressGapsPage`
    whose fields (``scanned_total`` / ``has_more_rows``) name the row-scan
    semantics explicitly, so a caller never mistakes them for a gap count. The
    bare path keeps the full-scan :class:`StageProgressGapsResponse` shape
    (``total`` = gaps found) for backward compatibility.
    """
    # Order by user_id so OFFSET/LIMIT paging is stable across requests.
    base_query = select(StageProgress).order_by(col(StageProgress.user_id))
    if pagination.paginate:
        # ``paginate_query``'s total is the COUNT(*) of the base table — exactly
        # the scanned-row count this page reports (no second COUNT needed).
        rows, scanned_total = await paginate_query(session, base_query, pagination)
        return StageProgressGapsPage(
            items=_gaps_from_rows(rows),
            scanned_total=scanned_total,
            limit=pagination.limit,
            offset=pagination.offset,
            has_more_rows=page_has_more(pagination.offset, pagination.limit, scanned_total),
        )
    all_rows = list((await session.execute(base_query)).scalars().all())
    gaps = _gaps_from_rows(all_rows)
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
    missing, extra = completed_stage_gap(before, progress.current_stage)
    stages_added = sorted(missing)
    stages_removed = sorted(extra)
    progress.completed_stages = sorted(expected_completed_stages(progress.current_stage))
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
        completed_stages=progress.completed_stages,
        stages_added=stages_added,
        stages_removed=stages_removed,
    )


@router.post("/maintenance/energy-plans", response_model=EnergyPlanCleanupResult)
async def cleanup_energy_plans(
    session: Annotated[AsyncSession, Depends(get_session)],
    admin: Annotated[User, Depends(require_admin)],
    older_than_days: int = ENERGY_PLAN_RETENTION_DAYS,
) -> EnergyPlanCleanupResult:
    """Delete persisted energy plans older than ``older_than_days``.

    The integration point for the retention sweep: durable ``energyplan`` rows
    have no TTL, and unkeyed requests are not deduplicated, so the table grows
    unbounded without this. Safe to call from a cron via an admin token.
    """
    try:
        deleted = await delete_expired_energy_plans(session, older_than_days=older_than_days)
    except ValueError as exc:
        raise bad_request(str(exc)) from exc
    logger.info(
        "energyplan_cleanup",
        extra={"admin_id": admin.id, "deleted": deleted, "older_than_days": older_than_days},
    )
    return EnergyPlanCleanupResult(deleted=deleted, older_than_days=older_than_days)


@dataclass(frozen=True)
class _AdminContext:
    """The session and the acting admin, which always travel together here.

    Bundled into one dependency so the override routes stay under ruff's
    ``PLR0913`` argument cap without dropping either the audit actor or the
    rate-limiter's ``request`` — the same restructure-don't-suppress move as
    :class:`services.wallet._AuditEntry` and the ``domain.streaks`` kwarg
    bundle.
    """

    session: AsyncSession
    admin: User


async def admin_context(
    session: Annotated[AsyncSession, Depends(get_session)],
    admin: Annotated[User, Depends(require_admin)],
) -> _AdminContext:
    """Resolve the admin gate and the session as a single dependency."""
    return _AdminContext(session=session, admin=admin)


async def _require_user(session: AsyncSession, user_id: int) -> User:
    """Load a target user or 404.

    Every route below addresses a user by a path id an operator typed, so an
    unknown id is a mistake worth reporting rather than an empty-but-plausible
    result.
    """
    user = await session.get(User, user_id)
    if user is None:
        raise not_found("user")
    return user


def _entitlement_summary(entitlement: Entitlement) -> EntitlementSummary:
    """Project one entitlement row onto its wire shape."""
    if entitlement.id is None:
        msg = "entitlement id missing after persistence"
        raise ValueError(msg)
    return EntitlementSummary(
        id=entitlement.id,
        kind=entitlement.kind,
        product_id=entitlement.product_id,
        source_sale_id=entitlement.source_sale_id,
        granted_at=entitlement.granted_at,
        revoked_at=entitlement.revoked_at,
        metadata=entitlement.entitlement_metadata,
    )


@router.post(
    "/users/{user_id}/entitlements",
    response_model=EntitlementSummary,
    status_code=HTTPStatus.CREATED,
)
@limiter.limit(_OVERRIDE_RATE_LIMIT)
async def grant_entitlement(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    user_id: int,
    payload: EntitlementGrantRequest,
    context: Annotated[_AdminContext, Depends(admin_context)],
) -> EntitlementSummary:
    """Comp a user's course access, recording who did it and why.

    The manual counterpart to the Gumroad webhook grant: no sale funds it, so
    ``source_sale_id`` stays NULL and the operator's ``reason`` is written into
    the entitlement's metadata bag. That pairing is what later distinguishes a
    deliberate comp from a payment that was never reconciled.

    Idempotent, inheriting the domain layer's single-active-row behaviour — a
    repeated click refreshes the existing grant rather than colliding with the
    partial unique index.
    """
    session, admin = context.session, context.admin
    target = await _require_user(session, user_id)
    entitlement = await grant_manual_course_access(
        session,
        target,
        reason=payload.reason,
        actor_admin_id=admin.id,
        kind=payload.kind,
    )
    # Two log lines per mutation, on purpose. The domain layer's
    # `entitlement_granted` / `entitlement_revoked` records the state
    # transition with a fixed reason_code and is emitted for every path,
    # webhook included, so it can be counted and grepped by reason. This one is
    # the operator audit: who acted, on whom, and in their own words. Do not
    # merge them — a reader looking for "did access change?" and one asking
    # "who did this?" want different queries.
    logger.warning(
        "admin_entitlement_granted",
        extra={
            "actor": admin.id,
            "action": "entitlement_grant",
            "target_user_id": user_id,
            "entitlement_id": entitlement.id,
            "reason": payload.reason,
        },
    )
    return _entitlement_summary(entitlement)


@router.delete("/users/{user_id}/entitlements/{entitlement_id}", response_model=EntitlementSummary)
@limiter.limit(_OVERRIDE_RATE_LIMIT)
async def revoke_entitlement(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    user_id: int,
    entitlement_id: int,
    payload: EntitlementRevokeRequest,
    context: Annotated[_AdminContext, Depends(admin_context)],
) -> EntitlementSummary:
    """Revoke one named entitlement, recording who did it and why.

    404s when the row is missing, already revoked, or owned by another user.
    An operator who reads a 200 as "access removed" when nothing changed is
    exactly the failure this endpoint exists to prevent, so the by-id lookup
    reports rather than no-ops.
    """
    session, admin = context.session, context.admin
    await _require_user(session, user_id)
    entitlement = await revoke_entitlement_by_id(
        session,
        user_id,
        entitlement_id,
        reason=payload.reason,
        actor_admin_id=admin.id,
    )
    if entitlement is None:
        raise not_found("entitlement")
    logger.warning(
        "admin_entitlement_revoked",
        extra={
            "actor": admin.id,
            "action": "entitlement_revoke",
            "target_user_id": user_id,
            "entitlement_id": entitlement_id,
            "reason": payload.reason,
        },
    )
    return _entitlement_summary(entitlement)


@router.get("/users/{user_id}/summary", response_model=AdminUserSummary)
async def get_user_summary(
    user_id: int,
    session: Annotated[AsyncSession, Depends(get_session)],
    admin: Annotated[User, Depends(require_admin)],
) -> AdminUserSummary:
    """One account's entitlement, wallet and purchase picture in a single call.

    Read-only, and deliberately an aggregate: answering "why does this person
    say they paid but have no access?" otherwise means three queries against
    three tables, which is the SQL-console habit these endpoints replace.

    The wallet ledger and sale history are capped at the newest
    ``_WALLET_AUDIT_LIMIT`` / ``_GUMROAD_SALE_LIMIT`` rows. Sales match on
    email because :class:`models.gumroad_sale.GumroadSale` carries no user id —
    a purchase made under a different address will not appear here, which is
    itself usually the answer.
    """
    target = await _require_user(session, user_id)

    entitlement_rows = (
        (
            await session.execute(
                select(Entitlement)
                .where(col(Entitlement.user_id) == user_id)
                .order_by(col(Entitlement.granted_at).desc())
            )
        )
        .scalars()
        .all()
    )
    audit_rows = (
        (
            await session.execute(
                select(WalletAudit)
                .where(col(WalletAudit.user_id) == user_id)
                .order_by(col(WalletAudit.created_at).desc(), col(WalletAudit.id).desc())
                .limit(_WALLET_AUDIT_LIMIT)
            )
        )
        .scalars()
        .all()
    )
    sale_rows = (
        (
            await session.execute(
                select(GumroadSale)
                .where(col(GumroadSale.email) == target.email)
                .order_by(col(GumroadSale.created_at).desc(), col(GumroadSale.id).desc())
                .limit(_GUMROAD_SALE_LIMIT)
            )
        )
        .scalars()
        .all()
    )

    logger.info(
        "admin_user_summary_read",
        extra={"actor": admin.id, "action": "user_summary", "target_user_id": user_id},
    )

    return AdminUserSummary(
        user_id=user_id,
        email=target.email,
        created_at=target.created_at,
        is_admin=target.is_admin,
        entitlements=[_entitlement_summary(row) for row in entitlement_rows],
        offering_balance=target.offering_balance,
        monthly_messages_used=target.monthly_messages_used,
        wallet_audit=[
            WalletAuditEntry.model_validate(row, from_attributes=True) for row in audit_rows
        ],
        gumroad_sales=[
            GumroadSaleSummary.model_validate(row, from_attributes=True) for row in sale_rows
        ],
    )
