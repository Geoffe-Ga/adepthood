"""The one writer of beta feedback triage state, and the reads the inbox needs.

Every mutation here goes through :func:`_record`, which appends exactly one
:class:`FeedbackTriageEvent` and emits exactly one log line, in the same
transaction as the change it describes. That is the audit property the feature
promises -- actor, time, action, old state, new state for every change -- and
funnelling it through one function is what makes "exactly one" checkable.

What the log line carries is fixed and content-free: the acting admin's id, the
report's id and public reference, the action, and the two states (a status, a
public reference or a note id). Never a note body, never a summary. A reporter's
words and an operator's note are prose; the log, Sentry and exception messages
are not places prose goes.

Refusals are raised as the ``errors`` helpers' ``HTTPException`` with static
codes, and every refusal is decided *before* anything is written, so a refused
request leaves the report, its links and its trail exactly as they were.

Reads never write. The fingerprint is computed, never stored; siblings are
suggested, never merged; a ``duplicate_of_id`` pointing at a report that no
longer exists is reported as ``None`` rather than repaired on the way past.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, cast

from sqlalchemy import CursorResult, delete, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import col, select

from domain.feedback_triage import (
    TRANSITION_NOT_ALLOWED,
    TRANSITIONS,
    DraftSource,
    IssueDraft,
    TransitionNotAllowedError,
    build_family,
    check_transition,
    creates_duplicate_cycle,
    fingerprint,
    render_issue_draft,
)
from errors import conflict, not_found, unprocessable
from models.feedback import FeedbackCategory, FeedbackImpact, FeedbackReport, FeedbackStatus
from models.feedback_triage import FeedbackNote, FeedbackTriageAction, FeedbackTriageEvent
from models.user import User
from schemas.pagination import PaginationParams, paginate_query
from services.advisory_lock_namespaces import FEEDBACK_DUPLICATE_LINK_LOCK_NAMESPACE

logger = logging.getLogger(__name__)

# The resource names ``errors.not_found`` suffixes with ``_not_found``.
REPORT_RESOURCE: Final = "feedback_report"
NOTE_RESOURCE: Final = "feedback_note"

DUPLICATE_SELF: Final = "feedback_duplicate_self"
DUPLICATE_CYCLE: Final = "feedback_duplicate_cycle"
DUPLICATE_UNCHANGED: Final = "feedback_duplicate_unchanged"
NOT_A_DUPLICATE: Final = "feedback_not_a_duplicate"

# How many fingerprint siblings the detail view suggests, and how many rows the
# SQL prefilter may hand to the Python build-family match. The first is a
# display bound; the second keeps one detail read from scanning a whole beta.
SIBLING_LIMIT: Final = 10
SIBLING_SCAN_LIMIT: Final = 500

_LOG_EVENT: Final = "feedback_triage_mutation"

# What an audit state that named a since-deleted report reads as afterwards.
# Not a ``FB-`` reference, so it can never be mistaken for a live one.
DELETED_REPORT_STATE: Final = "deleted"

_POSTGRESQL: Final = "postgresql"
# The second key of the link lock. There is one lock for all links, because a
# cycle can join any two reports.
_ALL_LINKS_KEY: Final = 0


@dataclass(frozen=True)
class InboxFilters:
    """The inbox's filters. Every one supplied narrows the list; they AND together."""

    status: FeedbackStatus | None = None
    category: FeedbackCategory | None = None
    impact: FeedbackImpact | None = None
    screen: str | None = None
    app_build: str | None = None
    created_from: datetime | None = None
    created_before: datetime | None = None

    def clauses(self) -> list[ColumnElement[bool]]:
        """One WHERE clause per supplied filter."""
        return self._equalities() + self._window()

    def _equalities(self) -> list[ColumnElement[bool]]:
        """The exact-match filters that were supplied."""
        pairs: list[tuple[Any, object]] = [
            (FeedbackReport.status, self.status),
            (FeedbackReport.category, self.category),
            (FeedbackReport.impact, self.impact),
            (FeedbackReport.screen, self.screen),
            (FeedbackReport.app_build, self.app_build),
        ]
        return [col(column) == value for column, value in pairs if value is not None]

    def _window(self) -> list[ColumnElement[bool]]:
        """The creation-time bounds that were supplied: from inclusive, before exclusive."""
        bounds: list[ColumnElement[bool]] = []
        if self.created_from is not None:
            bounds.append(col(FeedbackReport.created_at) >= self.created_from)
        if self.created_before is not None:
            bounds.append(col(FeedbackReport.created_at) < self.created_before)
        return bounds


@dataclass(frozen=True)
class Actor:
    """Who is acting, and the request they are acting through, for the audit line."""

    admin: User
    request_id: str | None


# ── Reads ─────────────────────────────────────────────────────────────────


async def list_reports(
    session: AsyncSession, filters: InboxFilters, params: PaginationParams
) -> tuple[list[FeedbackReport], int]:
    """One page of the inbox, newest first, with the filtered total.

    ``created_at DESC, id DESC`` is spelled out so the order is monotone: the
    pagination helper appends an ascending primary-key tiebreak, which after an
    explicit ``id DESC`` is never consulted.
    """
    query = (
        select(FeedbackReport)
        .where(*filters.clauses())
        .order_by(col(FeedbackReport.created_at).desc(), col(FeedbackReport.id).desc())
    )
    items, total = await paginate_query(session, query, params)
    return cast("list[FeedbackReport]", items), total


async def load_report(session: AsyncSession, public_id: str) -> FeedbackReport:
    """The report behind ``public_id``, or 404."""
    result = await session.execute(
        select(FeedbackReport).where(col(FeedbackReport.public_id) == public_id)
    )
    report = result.scalars().first()
    if report is None:
        raise not_found(REPORT_RESOURCE)
    return report


async def load_report_for_update(session: AsyncSession, public_id: str) -> FeedbackReport:
    """The report behind ``public_id``, row-locked until this transaction ends; or 404.

    Every mutation reads a report, checks its state and writes it back. Without
    the lock, two operators acting at once both check against the same stale
    state under READ COMMITTED -- both transitions pass the table, both write,
    and the trail records an ``old_state`` the row no longer had. With it, the
    second waits for the first to commit and then reads what the first wrote.
    ``populate_existing`` makes that fresh read win over a copy already in the
    session. (SQLite ignores the clause; its writer queue already serialises.)

    ``FOR NO KEY UPDATE`` rather than ``FOR UPDATE``: linking ``X -> Y`` makes
    PostgreSQL take a ``KEY SHARE`` lock on ``Y`` for the foreign-key check,
    which ``FOR UPDATE`` on ``Y`` would block -- so two crossed links, each
    holding its own row, would deadlock. ``NO KEY UPDATE`` still excludes every
    other triage mutation of the row, and lets the key-share check through.
    """
    result = await session.execute(
        select(FeedbackReport)
        .where(col(FeedbackReport.public_id) == public_id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    report = result.scalars().first()
    if report is None:
        raise not_found(REPORT_RESOURCE)
    return report


async def public_ids_for(session: AsyncSession, report_ids: set[int]) -> dict[int, str]:
    """Map report ids to public references, silently skipping ids that are gone.

    Skipping is the point: a ``duplicate_of_id`` whose target was deleted on
    SQLite (where ``SET NULL`` never fires) resolves to *no entry*, which the
    callers render as ``None``, rather than to a stale reference or a 500.
    """
    if not report_ids:
        return {}
    result = await session.execute(
        select(FeedbackReport.id, FeedbackReport.public_id).where(
            col(FeedbackReport.id).in_(report_ids)
        )
    )
    return {int(row[0]): str(row[1]) for row in result.all()}


async def duplicates_of(session: AsyncSession, report_id: int) -> list[str]:
    """Public references of the reports marked as duplicates of ``report_id``."""
    result = await session.execute(
        select(FeedbackReport.public_id)
        .where(col(FeedbackReport.duplicate_of_id) == report_id)
        .order_by(col(FeedbackReport.created_at), col(FeedbackReport.id))
    )
    return [str(value) for value in result.scalars().all()]


async def notes_for(session: AsyncSession, report_id: int) -> list[FeedbackNote]:
    """The report's notes, oldest first."""
    result = await session.execute(
        select(FeedbackNote)
        .where(col(FeedbackNote.report_id) == report_id)
        .order_by(col(FeedbackNote.created_at), col(FeedbackNote.id))
    )
    return list(result.scalars().all())


async def events_for(session: AsyncSession, report_id: int) -> list[FeedbackTriageEvent]:
    """The report's triage trail, oldest first."""
    result = await session.execute(
        select(FeedbackTriageEvent)
        .where(col(FeedbackTriageEvent.report_id) == report_id)
        .order_by(col(FeedbackTriageEvent.created_at), col(FeedbackTriageEvent.id))
    )
    return list(result.scalars().all())


def report_fingerprint(report: FeedbackReport) -> str:
    """The read-time fingerprint of one report."""
    return fingerprint(
        category=report.category,
        screen=report.screen,
        control=report.control,
        app_build=report.app_build,
    )


async def suggest_siblings(session: AsyncSession, report: FeedbackReport) -> list[FeedbackReport]:
    """Other reports with the same fingerprint, newest first. Suggests; never merges.

    SQL narrows on the three fingerprint inputs it can compare directly --
    ``control`` with ``IS NOT DISTINCT FROM`` so two reports with no control
    match each other -- and the build-family comparison, which is a rule rather
    than a column, happens here.
    """
    result = await session.execute(
        select(FeedbackReport)
        .where(
            col(FeedbackReport.id) != report.id,
            col(FeedbackReport.category) == report.category,
            col(FeedbackReport.screen) == report.screen,
            col(FeedbackReport.control).is_not_distinct_from(report.control),
        )
        .order_by(col(FeedbackReport.created_at).desc(), col(FeedbackReport.id).desc())
        .limit(SIBLING_SCAN_LIMIT)
    )
    family = build_family(report.app_build)
    matches = [row for row in result.scalars().all() if build_family(row.app_build) == family]
    return matches[:SIBLING_LIMIT]


def allowed_transitions(report: FeedbackReport) -> list[FeedbackStatus]:
    """The statuses ``report`` may move to next, in a stable order."""
    return sorted(TRANSITIONS.get(FeedbackStatus(report.status), frozenset()))


# ── Mutations ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TriageChange:
    """One mutation's audit facts: what was done, and the state either side of it."""

    action: FeedbackTriageAction
    old_state: str | None
    new_state: str | None


async def _record(
    session: AsyncSession,
    report: FeedbackReport,
    actor: Actor,
    change: TriageChange,
) -> None:
    """Append the one event and emit the one log line a mutation owes, then commit."""
    if report.id is None:  # pragma: no cover - a loaded report always has its key
        msg = "feedback report id missing"
        raise ValueError(msg)
    session.add(
        FeedbackTriageEvent(
            report_id=report.id,
            actor_admin_id=actor.admin.id,
            action=change.action.value,
            old_state=change.old_state,
            new_state=change.new_state,
        )
    )
    await session.commit()
    logger.info(
        _LOG_EVENT,
        extra={
            "admin_id": actor.admin.id,
            "report_id": report.id,
            "public_id": report.public_id,
            "action": change.action.value,
            "old_state": change.old_state,
            "new_state": change.new_state,
            "request_id": actor.request_id,
        },
    )


async def transition(
    session: AsyncSession, report: FeedbackReport, target: FeedbackStatus, actor: Actor
) -> None:
    """Move ``report`` to ``target`` if the table allows it; 409 otherwise."""
    current = FeedbackStatus(report.status)
    try:
        check_transition(current, target)
    except TransitionNotAllowedError as exc:
        raise conflict(TRANSITION_NOT_ALLOWED) from exc
    report.status = target.value
    session.add(report)
    await _record(
        session,
        report,
        actor,
        TriageChange(FeedbackTriageAction.STATUS_CHANGED, current.value, target.value),
    )


async def _duplicate_parents(session: AsyncSession) -> dict[int, int | None]:
    """Every current ``duplicate_of`` link, as ``{report_id: canonical_id}``."""
    result = await session.execute(
        select(FeedbackReport.id, FeedbackReport.duplicate_of_id).where(
            col(FeedbackReport.duplicate_of_id).is_not(None)
        )
    )
    return {int(row[0]): row[1] for row in result.all()}


async def linked_public_id(session: AsyncSession, report: FeedbackReport) -> str | None:
    """The public reference ``report`` is currently linked to, or ``None``.

    ``None`` both when there is no link and when the link dangles (its target
    was deleted on SQLite, where ``SET NULL`` never fires).
    """
    if report.duplicate_of_id is None:
        return None
    found = await public_ids_for(session, {report.duplicate_of_id})
    return found.get(report.duplicate_of_id)


async def _lock_duplicate_links(session: AsyncSession) -> None:
    """Serialise every duplicate-link change on PostgreSQL, until this transaction ends.

    Two links whose union is a loop -- ``X -> Y`` and ``Y -> X`` -- write
    different rows, so no row lock stands between them: each cycle check reads
    a table without the other's link and both commit. One transaction-scoped
    lock over the link table makes the second check run after the first commit,
    and READ COMMITTED gives it a fresh snapshot that includes it.
    """
    if session.get_bind().dialect.name != _POSTGRESQL:
        return
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:namespace, :key)"),
        {"namespace": FEEDBACK_DUPLICATE_LINK_LOCK_NAMESPACE, "key": _ALL_LINKS_KEY},
    )


async def _refuse_bad_link(
    session: AsyncSession, report: FeedbackReport, target: FeedbackReport
) -> None:
    """409 when the link would change nothing, or would close a loop of any length."""
    if report.duplicate_of_id == target.id:
        raise conflict(DUPLICATE_UNCHANGED)
    await _lock_duplicate_links(session)
    parents = await _duplicate_parents(session)
    if creates_duplicate_cycle(report.id or 0, target.id or 0, parents):
        raise conflict(DUPLICATE_CYCLE)


async def link_duplicate(
    session: AsyncSession, report: FeedbackReport, target_public_id: str, actor: Actor
) -> FeedbackReport:
    """Mark ``report`` a duplicate of the report behind ``target_public_id``.

    Refused -- before anything is written -- when the target is the report
    itself (422), does not exist (404), is already the link (409), or would
    close a loop of any length (409). Linking never changes status.
    """
    if target_public_id == report.public_id:
        raise unprocessable(DUPLICATE_SELF)
    target = await load_report(session, target_public_id)
    await _refuse_bad_link(session, report, target)
    old_state = await linked_public_id(session, report)
    report.duplicate_of_id = target.id
    session.add(report)
    await _record(
        session,
        report,
        actor,
        TriageChange(FeedbackTriageAction.DUPLICATE_LINKED, old_state, target.public_id),
    )
    return target


async def unlink_duplicate(session: AsyncSession, report: FeedbackReport, actor: Actor) -> None:
    """Clear ``report``'s duplicate link; 409 when it has none."""
    if report.duplicate_of_id is None:
        raise conflict(NOT_A_DUPLICATE)
    old_state = await linked_public_id(session, report)
    report.duplicate_of_id = None
    session.add(report)
    await _record(
        session,
        report,
        actor,
        TriageChange(FeedbackTriageAction.DUPLICATE_UNLINKED, old_state, None),
    )


async def add_note(
    session: AsyncSession, report: FeedbackReport, body: str, actor: Actor
) -> FeedbackNote:
    """Attach one private note to ``report``."""
    if report.id is None:  # pragma: no cover - a loaded report always has its key
        raise not_found(REPORT_RESOURCE)
    note = FeedbackNote(report_id=report.id, author_admin_id=actor.admin.id, body=body)
    session.add(note)
    await session.flush()
    await _record(
        session,
        report,
        actor,
        TriageChange(FeedbackTriageAction.NOTE_ADDED, None, str(note.id)),
    )
    await session.refresh(note)
    return note


# ── Draft ─────────────────────────────────────────────────────────────────


async def _selected_notes(
    session: AsyncSession, report_id: int, note_ids: Sequence[int]
) -> tuple[str, ...]:
    """The bodies of the named notes, in the order named; 404 for any not on this report."""
    by_id = {note.id: note for note in await notes_for(session, report_id)}
    wanted = list(dict.fromkeys(note_ids))
    if any(note_id not in by_id for note_id in wanted):
        raise not_found(NOTE_RESOURCE)
    return tuple(by_id[note_id].body for note_id in wanted)


async def build_draft(
    session: AsyncSession, report: FeedbackReport, note_ids: Sequence[int]
) -> IssueDraft:
    """Render the report as a GitHub issue draft. Reads only; writes and sends nothing.

    Only the notes named in ``note_ids`` are quoted, and each must belong to
    THIS report: an id that is missing, or that belongs to a different report,
    is a 404 rather than a silently shorter draft, so an operator never pastes
    a draft believing it carries a note it does not.
    """
    report_id = report.id or 0
    selected = await _selected_notes(session, report_id, note_ids)
    related = tuple(await duplicates_of(session, report_id))
    source = DraftSource.from_report(report, notes=selected, related_public_ids=related)
    return render_issue_draft(source)


# ── Retention ─────────────────────────────────────────────────────────────


async def detach_from_doomed_reports(session: AsyncSession, doomed: Select[Any]) -> None:
    """Unlink every surviving report from the reports ``doomed`` selects, on the record.

    Called before those reports are deleted -- by the retention sweep and by
    account deletion -- so the survivors' trails stay true and stop naming
    them:

    * each survivor that was a duplicate of a doomed report gets a system
      ``duplicate_unlinked`` event (no actor: nobody chose it) and its link
      cleared -- explicitly, because SQLite never fires ``SET NULL``;
    * every event state that holds a doomed report's public reference is
      rewritten to :data:`DELETED_REPORT_STATE`, so the reference does not
      outlive the report it names.

    ``doomed`` is a ``SELECT`` of report ids. Does not commit.
    """
    fetch = {"synchronize_session": "fetch"}
    survivors = (
        await session.execute(
            select(FeedbackReport.id).where(
                col(FeedbackReport.duplicate_of_id).in_(doomed),
                col(FeedbackReport.id).not_in(doomed),
            )
        )
    ).scalars()
    session.add_all(
        FeedbackTriageEvent(
            report_id=survivor_id,
            actor_admin_id=None,
            action=FeedbackTriageAction.DUPLICATE_UNLINKED.value,
            old_state=DELETED_REPORT_STATE,
            new_state=None,
        )
        for survivor_id in survivors
    )
    await session.flush()
    doomed_refs = select(FeedbackReport.public_id).where(col(FeedbackReport.id).in_(doomed))
    for state in (FeedbackTriageEvent.old_state, FeedbackTriageEvent.new_state):
        await session.execute(
            update(FeedbackTriageEvent)
            .where(col(state).in_(doomed_refs))
            .values({col(state): DELETED_REPORT_STATE}),
            execution_options=fetch,
        )
    await session.execute(
        update(FeedbackReport)
        .where(col(FeedbackReport.duplicate_of_id).in_(doomed))
        .values(duplicate_of_id=None),
        execution_options=fetch,
    )


async def purge_feedback_reports(
    session: AsyncSession, predicate: Callable[[], ColumnElement[bool]]
) -> int:
    """Delete the reports matching ``predicate`` and everything hanging off them.

    Explicit, child first, because the suite runs on SQLite where neither the
    ``CASCADE`` on the children nor the ``SET NULL`` on ``duplicate_of_id``
    fires: notes and events of the doomed reports go first, surviving reports
    that pointed at a doomed one are detached on the record
    (:func:`detach_from_doomed_reports`), and only then do the reports
    go. Does not commit; the caller owns the transaction. Returns the number of
    reports removed, or ``-1`` when the driver does not report a row count.
    """
    doomed = select(FeedbackReport.id).where(predicate())
    # ``fetch`` rather than the default in-Python evaluation: the predicate is
    # a timestamp comparison, and SQLite hands back naive datetimes that Python
    # refuses to compare with the aware cutoff.
    fetch = {"synchronize_session": "fetch"}
    await session.execute(
        delete(FeedbackNote).where(col(FeedbackNote.report_id).in_(doomed)),
        execution_options=fetch,
    )
    await session.execute(
        delete(FeedbackTriageEvent).where(col(FeedbackTriageEvent.report_id).in_(doomed)),
        execution_options=fetch,
    )
    await detach_from_doomed_reports(session, doomed)
    result = cast(
        "CursorResult[Any]",
        await session.execute(delete(FeedbackReport).where(predicate()), execution_options=fetch),
    )
    return int(result.rowcount)
