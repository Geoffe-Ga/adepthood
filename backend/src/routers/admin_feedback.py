"""The administrator's private beta feedback inbox.

Every route here is gated on :func:`dependencies.auth.require_admin` -- directly,
or through :func:`dependencies.admin.admin_context`, which cannot be resolved
without passing it. An anonymous caller gets 401 and a signed-in non-admin gets
403 ``admin_required``, including on a report they filed themselves: filing a
report entitles its author to the receipt (``GET /feedback/{id}/receipt``), not
to its triage.

**Ownership is not the axis here, by design.** An operator acts on everybody's
reports; that is the job. So ids in a path or a body are resolved within their
*scope* instead: a duplicate target that does not exist is 404
``feedback_report_not_found``, and a note id in a draft request that does not
exist or belongs to a different report is 404 ``feedback_note_not_found`` --
the same 404 convention :mod:`dependencies.ownership` uses, applied to the
report rather than to the account.

Mutations are rate limited at :data:`_TRIAGE_RATE_LIMIT`: comfortably above an
operator working a queue by hand, far below a looping script or a stolen token
rewriting the inbox. Reads are not limited beyond the ambient floor.

Nothing here publishes anything. ``POST …/draft`` renders Markdown and returns
it; the client offers copy and download, and the route makes no outbound call.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Final, assert_never

from fastapi import Body, Depends, Path, Query, Request
from pydantic import AwareDatetime
from sqlalchemy.ext.asyncio import AsyncSession

from bounds import MAX_PAGE_OFFSET
from database import get_session
from dependencies.admin import AdminContext, admin_context
from dependencies.auth import require_admin
from domain.feedback_triage import OperatorWriting
from error_responses import build_router
from models.feedback import (
    FEEDBACK_BUILD_MAX_LENGTH,
    FEEDBACK_SCREEN_MAX_LENGTH,
    PUBLIC_ID_MAX_LENGTH,
    PUBLIC_ID_PATTERN,
    FeedbackCategory,
    FeedbackImpact,
    FeedbackReport,
    FeedbackStatus,
)
from models.user import User
from rate_limit import limiter
from schemas.feedback import BUILD_PATTERN, SCREEN_PATTERN
from schemas.feedback_admin import (
    AddNoteCommand,
    AdminCapabilities,
    FeedbackAppAttached,
    FeedbackDraftRequest,
    FeedbackIssueDraft,
    FeedbackOperatorAdded,
    FeedbackOperatorNote,
    FeedbackReporterSaid,
    FeedbackTriageCommand,
    FeedbackTriageDetail,
    FeedbackTriageEventPublic,
    FeedbackTriageSummary,
    LinkDuplicateCommand,
    TransitionCommand,
    UnlinkDuplicateCommand,
)
from schemas.pagination import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, Page, PaginationParams, build_page
from services import feedback_triage
from services.feedback_triage import Actor, InboxFilters

router = build_router(prefix="/admin", tags=["admin"])

# One operator triaging by hand makes a few mutations a minute; sixty is a
# ceiling they never meet and a runaway script meets in a second.
_TRIAGE_RATE_LIMIT: Final = "60/minute"

_PublicIdPath = Annotated[
    str,
    Path(pattern=PUBLIC_ID_PATTERN, max_length=PUBLIC_ID_MAX_LENGTH),
]


@dataclass
class _InboxQuery:
    """The inbox's filter and window query parameters, as one dependency."""

    status: Annotated[FeedbackStatus | None, Query()] = None
    category: Annotated[FeedbackCategory | None, Query()] = None
    impact: Annotated[FeedbackImpact | None, Query()] = None
    screen: Annotated[
        str | None, Query(pattern=SCREEN_PATTERN, max_length=FEEDBACK_SCREEN_MAX_LENGTH)
    ] = None
    app_build: Annotated[
        str | None, Query(pattern=BUILD_PATTERN, max_length=FEEDBACK_BUILD_MAX_LENGTH)
    ] = None
    created_from: Annotated[
        AwareDatetime | None, Query(description="Inclusive lower bound on created_at.")
    ] = None
    created_before: Annotated[
        AwareDatetime | None, Query(description="Exclusive upper bound on created_at.")
    ] = None
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE
    offset: Annotated[int, Query(ge=0, le=MAX_PAGE_OFFSET)] = 0

    def filters(self) -> InboxFilters:
        """The filter half."""
        return InboxFilters(
            status=self.status,
            category=self.category,
            impact=self.impact,
            screen=self.screen,
            app_build=self.app_build,
            created_from=self.created_from,
            created_before=self.created_before,
        )

    def window(self) -> PaginationParams:
        """The paging half. Always the envelope: this route has no bare-list past."""
        return PaginationParams(limit=self.limit, offset=self.offset, paginate=True)


def _actor(request: Request, context: AdminContext) -> Actor:
    """The audit actor: the admin, plus the request id their log line joins on."""
    request_id = getattr(request.state, "request_id", None)
    return Actor(
        admin=context.admin, request_id=request_id if isinstance(request_id, str) else None
    )


def _summary(report: FeedbackReport, duplicate_of: str | None) -> FeedbackTriageSummary:
    """Project a report onto its inbox row. No prose, no identity."""
    return FeedbackTriageSummary(
        public_id=report.public_id,
        status=FeedbackStatus(report.status),
        category=FeedbackCategory(report.category),
        impact=FeedbackImpact(report.impact),
        screen=report.screen,
        app_build=report.app_build,
        created_at=report.created_at,
        duplicate_of=duplicate_of,
    )


async def _summaries(
    session: AsyncSession, reports: list[FeedbackReport]
) -> list[FeedbackTriageSummary]:
    """Project a page of reports, resolving every duplicate link in one query."""
    links = await feedback_triage.public_ids_for(
        session, {r.duplicate_of_id for r in reports if r.duplicate_of_id is not None}
    )
    return [
        _summary(r, links.get(r.duplicate_of_id) if r.duplicate_of_id is not None else None)
        for r in reports
    ]


async def _operator_added(session: AsyncSession, report: FeedbackReport) -> FeedbackOperatorAdded:
    """Everything operators added to ``report``, with its duplicate link resolved."""
    report_id = report.id or 0
    notes = await feedback_triage.notes_for(session, report_id)
    events = await feedback_triage.events_for(session, report_id)
    return FeedbackOperatorAdded(
        status=FeedbackStatus(report.status),
        duplicate_of=await feedback_triage.linked_public_id(session, report),
        duplicates=await feedback_triage.duplicates_of(session, report_id),
        notes=[
            FeedbackOperatorNote(id=note.id or 0, body=note.body, created_at=note.created_at)
            for note in notes
        ],
        events=[
            FeedbackTriageEventPublic(
                action=event.action,
                old_state=event.old_state,
                new_state=event.new_state,
                created_at=event.created_at,
            )
            for event in events
        ],
    )


def _app_attached(report: FeedbackReport) -> FeedbackAppAttached:
    """The allowlisted envelope, the one place the correlation id is shown."""
    return FeedbackAppAttached(
        screen=report.screen,
        control=report.control,
        platform=report.platform,
        app_build=report.app_build,
        viewport_class=report.viewport_class,
        locale=report.locale,
        correlation_id=report.correlation_id,
        created_at=report.created_at,
    )


async def _detail(session: AsyncSession, report: FeedbackReport) -> FeedbackTriageDetail:
    """Assemble the three-section detail view. Reads only."""
    siblings = await feedback_triage.suggest_siblings(session, report)
    return FeedbackTriageDetail(
        public_id=report.public_id,
        category=FeedbackCategory(report.category),
        impact=FeedbackImpact(report.impact),
        reporter_said=FeedbackReporterSaid(
            summary=report.summary,
            intent=report.intent,
            expected=report.expected,
            actual=report.actual,
        ),
        app_attached=_app_attached(report),
        operator_added=await _operator_added(session, report),
        fingerprint=feedback_triage.report_fingerprint(report),
        siblings=await _summaries(session, siblings),
        allowed_transitions=feedback_triage.allowed_transitions(report),
    )


@router.get("/capabilities", response_model=AdminCapabilities)
async def read_admin_capabilities(
    _admin: Annotated[User, Depends(require_admin)],
) -> AdminCapabilities:
    """Confirm the caller is an administrator, and say what they may use.

    The client's only source of admin knowledge: a 200 here reveals the inbox,
    and a 401 or 403 hides it. No client ever infers the role from a token.
    """
    return AdminCapabilities(feedback_triage=True)


@router.get("/feedback", response_model=Page[FeedbackTriageSummary])
async def list_feedback_reports(
    query: Annotated[_InboxQuery, Depends()],
    session: Annotated[AsyncSession, Depends(get_session)],
    _admin: Annotated[User, Depends(require_admin)],
) -> Page[FeedbackTriageSummary]:
    """The inbox: filtered, newest first, paged over a total order."""
    window = query.window()
    reports, total = await feedback_triage.list_reports(session, query.filters(), window)
    return build_page(await _summaries(session, reports), total, window)


@router.get("/feedback/{public_id}", response_model=FeedbackTriageDetail)
async def read_feedback_report(
    public_id: _PublicIdPath,
    context: Annotated[AdminContext, Depends(admin_context)],
) -> FeedbackTriageDetail:
    """One report, its three sources kept apart, its fingerprint and siblings."""
    report = await feedback_triage.load_report(context.session, public_id)
    return await _detail(context.session, report)


async def apply_triage_command(
    command: FeedbackTriageCommand, report: FeedbackReport, context: AdminContext, actor: Actor
) -> None:
    """Dispatch one command to the single triage writer, and fail closed.

    Every variant of the union has its own arm, ``add_note`` included; there is
    no catch-all that a new variant could fall into. ``assert_never`` makes a
    variant added to :data:`FeedbackTriageCommand` without an arm here a mypy
    error, and -- should one arrive anyway -- an ``AssertionError`` (a 500 that
    writes nothing) rather than a note or a status change nobody asked for.
    """
    session = context.session
    match command:
        case TransitionCommand():
            await feedback_triage.transition(session, report, command.status, actor)
        case LinkDuplicateCommand():
            await feedback_triage.link_duplicate(session, report, command.target_public_id, actor)
        case UnlinkDuplicateCommand():
            await feedback_triage.unlink_duplicate(session, report, actor)
        case AddNoteCommand():
            await feedback_triage.add_note(session, report, command.body, actor)
        case _:
            assert_never(command)


@router.post("/feedback/{public_id}/actions", response_model=FeedbackTriageDetail)
@limiter.limit(_TRIAGE_RATE_LIMIT)
async def act_on_feedback_report(
    request: Request,
    public_id: _PublicIdPath,
    command: Annotated[FeedbackTriageCommand, Body()],
    context: Annotated[AdminContext, Depends(admin_context)],
) -> FeedbackTriageDetail:
    """Apply one triage command and return the report as it now stands.

    One route, four commands -- ``transition``, ``link_duplicate``,
    ``unlink_duplicate``, ``add_note`` -- each of which appends exactly one
    audit event. Refusals: 409 ``feedback_transition_not_allowed`` for a pair
    outside the table; 422 ``feedback_duplicate_self``; 404
    ``feedback_report_not_found`` for a duplicate target that does not exist
    (any report is a valid target -- administrators link across accounts); 409
    ``feedback_duplicate_cycle`` / ``feedback_duplicate_unchanged`` /
    ``feedback_not_a_duplicate``. Every refusal is decided before anything is
    written. Linking never changes status.
    """
    report = await feedback_triage.load_report_for_update(context.session, public_id)
    await apply_triage_command(command, report, context, _actor(request, context))
    return await _detail(context.session, report)


@router.post("/feedback/{public_id}/draft", response_model=FeedbackIssueDraft)
async def draft_feedback_issue(
    public_id: _PublicIdPath,
    payload: FeedbackDraftRequest,
    context: Annotated[AdminContext, Depends(admin_context)],
) -> FeedbackIssueDraft:
    """Render a GitHub issue draft from the operator's own words. Writes and calls nothing.

    ``title`` and ``summary`` are required (422 without them); the reporter's
    words are never in a draft. ``note_ids`` names notes on THIS report; any
    other id is 404 ``feedback_note_not_found``. Unnamed notes never appear.
    """
    report = await feedback_triage.load_report(context.session, public_id)
    draft = await feedback_triage.build_draft(
        context.session,
        report,
        OperatorWriting(title=payload.title, summary=payload.summary),
        payload.note_ids,
    )
    return FeedbackIssueDraft(
        title=draft.title,
        markdown=draft.markdown,
        source_public_ids=list(draft.source_public_ids),
    )
