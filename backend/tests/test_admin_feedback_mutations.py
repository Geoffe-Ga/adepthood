"""Changing a report's triage: the state machine, duplicate links, notes, the trail.

Three properties run through every test here.

**Refusals change nothing.** A disallowed transition, a self-link, a cycle, a
missing target: each is refused *before* anything is written, so the report's
status, its link and its event count are asserted equal before and after.

**Every mutation is one event.** Exactly one ``feedbacktriageevent`` row per
successful change, carrying the acting admin, a UTC timestamp, the action and
the states either side -- asserted as a delta, so a mutation that wrote two rows
or none fails.

**Prose goes nowhere but the database.** A sentinel is planted in the report
and in a note, and then looked for in every log record's full attribute dict,
the 422 body, ``repr`` and ``str`` of the rows, and every exception message.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import UTC, datetime
from http import HTTPStatus
from itertools import product
from typing import get_args

import pytest
from fastapi.routing import APIRoute
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.feedback import FeedbackReport, FeedbackStatus
from models.feedback_triage import FEEDBACK_NOTE_MAX_LENGTH, FeedbackNote, FeedbackTriageEvent
from schemas.feedback_admin import AddNoteCommand, FeedbackTriageCommand
from tests.helpers.feedback_triage import (
    Account,
    force_status,
    make_account,
    report_state,
    row_count,
    seed_report,
)
from tests.helpers.openapi_errors import route_index

# The decided edges (#2900 decision c), written independently of the domain
# table so the route matrix disagrees with an edited table rather than echoing it.
_ALLOWED = frozenset(
    {
        ("new", "triaged"),
        ("new", "closed"),
        ("triaged", "planned"),
        ("triaged", "closed"),
        ("planned", "closed"),
        ("closed", "triaged"),
    }
)
_STATUSES = [status.value for status in FeedbackStatus]

_REPORT_SENTINEL = "SENTINEL-REPORT-PROSE-7F3A"
_NOTE_SENTINEL = "SENTINEL-OPERATOR-NOTE-9C1E"

_AUDIT_EVENT = "feedback_triage_mutation"
_AUDIT_FIELDS = frozenset(
    {"admin_id", "report_id", "public_id", "action", "old_state", "new_state", "request_id"}
)


_UNLINK = {"action": "unlink_duplicate"}


async def _act(
    client: AsyncClient, headers: dict[str, str], public_id: str, command: Mapping[str, object]
) -> Response:
    """Send one triage command."""
    return await client.post(f"/admin/feedback/{public_id}/actions", json=command, headers=headers)


async def _admin(session: AsyncSession) -> Account:
    return await make_account(session, "operator@example.com", admin=True)


async def _events(session: AsyncSession, report_id: int) -> list[FeedbackTriageEvent]:
    session.expire_all()
    result = await session.execute(
        select(FeedbackTriageEvent)
        .where(col(FeedbackTriageEvent.report_id) == report_id)
        .order_by(col(FeedbackTriageEvent.id))
    )
    return list(result.scalars().all())


# ── The transition matrix, over HTTP ──────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(("source", "target"), list(product(_STATUSES, _STATUSES)))
async def test_every_transition_pair_over_the_route(
    async_client: AsyncClient, db_session: AsyncSession, source: str, target: str
) -> None:
    """Allowed pairs move and log one event; every other pair is 409 and changes nothing."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id)
    report_id, public_id = report.id or 0, report.public_id
    await force_status(db_session, report_id, source)

    response = await _act(
        async_client, admin.headers, public_id, {"action": "transition", "status": target}
    )

    trail = [
        (e.action, e.old_state, e.new_state, e.actor_admin_id)
        for e in await _events(db_session, report_id)
    ]
    if (source, target) in _ALLOWED:
        assert response.status_code == HTTPStatus.OK, response.text
        assert response.json()["operator_added"]["status"] == target
        assert await report_state(db_session, report_id) == (target, None)
        assert trail == [("status_changed", source, target, admin.user_id)]
    else:
        assert response.status_code == HTTPStatus.CONFLICT
        assert response.json()["detail"] == "feedback_transition_not_allowed"
        assert await report_state(db_session, report_id) == (source, None)
        assert trail == []


@pytest.mark.asyncio
async def test_an_unknown_status_is_422_not_409(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A value outside the vocabulary is a malformed request, not a disallowed edge."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id)
    response = await _act(
        async_client,
        admin.headers,
        report.public_id,
        {"action": "transition", "status": "wontfix"},
    )
    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_the_full_forward_path_and_reopen(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """New -> triaged -> planned -> closed -> triaged, one event per step, in order."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id)
    report_id, public_id = report.id or 0, report.public_id

    for target in ("triaged", "planned", "closed", "triaged"):
        response = await _act(
            async_client, admin.headers, public_id, {"action": "transition", "status": target}
        )
        assert response.status_code == HTTPStatus.OK

    trail = [(e.old_state, e.new_state) for e in await _events(db_session, report_id)]
    assert trail == [
        ("new", "triaged"),
        ("triaged", "planned"),
        ("planned", "closed"),
        ("closed", "triaged"),
    ]


# ── Duplicate links ───────────────────────────────────────────────────────


async def _link(
    client: AsyncClient, headers: dict[str, str], source: str, target: str
) -> tuple[int, str]:
    response = await _act(
        client, headers, source, {"action": "link_duplicate", "target_public_id": target}
    )
    return response.status_code, response.json().get("detail", "")


async def _chain(session: AsyncSession, user_id: int, length: int) -> list[tuple[int, str]]:
    """``length`` reports, each already a duplicate of the one before it."""
    made: list[tuple[int, str]] = []
    for _ in range(length):
        report = await seed_report(session, user_id)
        if made:
            report.duplicate_of_id = made[-1][0]
            session.add(report)
            await session.commit()
        made.append((report.id or 0, report.public_id))
    return made


@pytest.mark.asyncio
async def test_linking_a_duplicate_records_one_event_and_leaves_status_alone(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The link lands, status stays ``new``, and the trail names the target."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    [(canonical_id, canonical), (report_id, public_id)] = [
        ((r.id or 0), r.public_id)
        for r in [await seed_report(db_session, reporter.user_id) for _ in range(2)]
    ]

    status_code, _ = await _link(async_client, admin.headers, public_id, canonical)

    assert status_code == HTTPStatus.OK
    assert await report_state(db_session, report_id) == ("new", canonical_id)
    events = await _events(db_session, report_id)
    assert [(e.action, e.old_state, e.new_state) for e in events] == [
        ("duplicate_linked", None, canonical)
    ]


@pytest.mark.asyncio
async def test_relinking_records_the_previous_target(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Moving a link from one canonical report to another is one event, old -> new."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    first, second, report = [await seed_report(db_session, reporter.user_id) for _ in range(3)]
    report_id, public_id = report.id or 0, report.public_id
    first_ref, second_ref = first.public_id, second.public_id

    assert (await _link(async_client, admin.headers, public_id, first_ref))[0] == HTTPStatus.OK
    assert (await _link(async_client, admin.headers, public_id, second_ref))[0] == HTTPStatus.OK

    events = await _events(db_session, report_id)
    assert [(e.old_state, e.new_state) for e in events] == [
        (None, first_ref),
        (first_ref, second_ref),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("case", "status", "detail"),
    [
        ("self", HTTPStatus.UNPROCESSABLE_ENTITY, "feedback_duplicate_self"),
        ("missing", HTTPStatus.NOT_FOUND, "feedback_report_not_found"),
        ("unchanged", HTTPStatus.CONFLICT, "feedback_duplicate_unchanged"),
        ("two_cycle", HTTPStatus.CONFLICT, "feedback_duplicate_cycle"),
        ("three_cycle", HTTPStatus.CONFLICT, "feedback_duplicate_cycle"),
        ("four_cycle", HTTPStatus.CONFLICT, "feedback_duplicate_cycle"),
    ],
)
async def test_a_refused_link_changes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    case: str,
    status: HTTPStatus,
    detail: str,
) -> None:
    """Self, missing, unchanged and cycles of every length: refused, links and trail intact."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    chain = await _chain(db_session, reporter.user_id, 4)
    head_id, head = chain[0]
    source_id, source = chain[1]
    target = {
        "self": source,
        "missing": "FB-22222222",
        "unchanged": head,
        "two_cycle": chain[1][1],
        "three_cycle": chain[2][1],
        "four_cycle": chain[3][1],
    }[case]
    if case in {"two_cycle", "three_cycle", "four_cycle"}:
        source_id, source = head_id, head
    ids = [report_id for report_id, _ in chain]
    before = [await report_state(db_session, report_id) for report_id in ids]
    events_before = await row_count(db_session, FeedbackTriageEvent)

    status_code, got = await _link(async_client, admin.headers, source, target)

    assert (status_code, got) == (status, detail)
    assert [await report_state(db_session, report_id) for report_id in ids] == before
    assert await row_count(db_session, FeedbackTriageEvent) == events_before
    assert source_id in ids


@pytest.mark.asyncio
async def test_unlinking_clears_the_link_and_records_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """DELETE removes the link; the event names what it pointed at."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    [(_, canonical), (report_id, public_id)] = await _chain(db_session, reporter.user_id, 2)

    response = await _act(async_client, admin.headers, public_id, _UNLINK)

    assert response.status_code == HTTPStatus.OK
    assert await report_state(db_session, report_id) == ("new", None)
    events = await _events(db_session, report_id)
    assert [(e.action, e.old_state, e.new_state) for e in events] == [
        ("duplicate_unlinked", canonical, None)
    ]


@pytest.mark.asyncio
async def test_unlinking_a_report_that_is_not_a_duplicate_is_409(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Nothing to clear is a conflict, and writes nothing."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id)

    response = await _act(async_client, admin.headers, report.public_id, _UNLINK)

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json()["detail"] == "feedback_not_a_duplicate"
    assert await row_count(db_session, FeedbackTriageEvent) == 0


# ── Notes ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_note_is_stored_and_recorded(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """201, the note back, one note row, one event naming the note's id."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id)
    report_id = report.id or 0

    response = await _act(
        async_client,
        admin.headers,
        report.public_id,
        {"action": "add_note", "body": "  Seen on Android too.\x07  "},
    )

    assert response.status_code == HTTPStatus.OK
    [note] = response.json()["operator_added"]["notes"]
    assert note["body"] == "Seen on Android too."
    stored = (await db_session.execute(select(FeedbackNote))).scalars().one()
    assert stored.author_admin_id == admin.user_id
    events = await _events(db_session, report_id)
    assert [(e.action, e.old_state, e.new_state) for e in events] == [
        ("note_added", None, str(note["id"]))
    ]


@pytest.mark.asyncio
async def test_the_note_bound_is_inclusive(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Exactly the bound is accepted; one more is refused and writes nothing."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id)

    at_bound = await _act(
        async_client,
        admin.headers,
        report.public_id,
        {"action": "add_note", "body": "n" * FEEDBACK_NOTE_MAX_LENGTH},
    )
    past_bound = await _act(
        async_client,
        admin.headers,
        report.public_id,
        {"action": "add_note", "body": "n" * (FEEDBACK_NOTE_MAX_LENGTH + 1)},
    )

    assert at_bound.status_code == HTTPStatus.OK
    assert past_bound.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert await row_count(db_session, FeedbackNote) == 1
    assert await row_count(db_session, FeedbackTriageEvent) == 1


@pytest.mark.parametrize("body", ["", "   ", "\x00\x07"])
def test_an_empty_note_is_refused(body: str) -> None:
    """Blank, or blank once control characters are stripped, is not a note."""
    with pytest.raises(ValueError, match="body"):
        AddNoteCommand(action="add_note", body=body)


# ── The trail ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_each_mutation_appends_exactly_one_event_with_a_utc_time(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Transition, link, unlink, note: four commands, four events, each fully attributed."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    canonical, report = [await seed_report(db_session, reporter.user_id) for _ in range(2)]
    report_id, public_id, canonical_ref = report.id or 0, report.public_id, canonical.public_id
    started = datetime.now(UTC)
    calls = [
        {"action": "transition", "status": "triaged"},
        {"action": "link_duplicate", "target_public_id": canonical_ref},
        _UNLINK,
        {"action": "add_note", "body": "A note."},
    ]
    for count, command in enumerate(calls, start=1):
        response = await _act(async_client, admin.headers, public_id, command)
        assert response.status_code < HTTPStatus.BAD_REQUEST, response.text
        assert await row_count(db_session, FeedbackTriageEvent) == count

    events = await _events(db_session, report_id)
    assert [e.action for e in events] == [
        "status_changed",
        "duplicate_linked",
        "duplicate_unlinked",
        "note_added",
    ]
    for event in events:
        assert event.actor_admin_id == admin.user_id
        stamped = event.created_at.replace(tzinfo=event.created_at.tzinfo or UTC)
        assert stamped.utcoffset() is not None
        assert stamped >= started.replace(microsecond=0)


@pytest.mark.asyncio
async def test_reads_and_drafts_append_no_event(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Only mutations write the trail."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id)
    await async_client.get("/admin/feedback", headers=admin.headers)
    await async_client.get(f"/admin/feedback/{report.public_id}", headers=admin.headers)
    await async_client.post(
        f"/admin/feedback/{report.public_id}/draft", json={}, headers=admin.headers
    )
    assert await row_count(db_session, FeedbackTriageEvent) == 0


def test_no_route_can_edit_or_delete_the_trail_or_a_note() -> None:
    """The trail is append-only because nothing mounted can rewrite it.

    No mounted PUT, PATCH or DELETE touches the triage surface at all, and the
    command route's vocabulary has no verb that edits or removes an event.
    """
    rewriting = sorted(
        f"{method} {path}"
        for (method, path), route in route_index().items()
        if isinstance(route, APIRoute)
        and method in {"PUT", "PATCH", "DELETE"}
        and ("event" in path or "note" in path or "trail" in path or "feedback" in path)
    )
    assert rewriting == []
    union, _discriminator = get_args(FeedbackTriageCommand)
    vocabulary = {
        get_args(member.model_fields["action"].annotation)[0] for member in get_args(union)
    }
    assert vocabulary == {
        "transition",
        "link_duplicate",
        "unlink_duplicate",
        "add_note",
    }


# ── Where prose must never go ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sentinel_prose_reaches_no_log_no_422_no_repr_no_exception(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Every mutation runs with sentinels planted; none of them escapes."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    canonical = await seed_report(db_session, reporter.user_id, summary=_REPORT_SENTINEL)
    report = await seed_report(
        db_session,
        reporter.user_id,
        summary=_REPORT_SENTINEL,
        actual=_REPORT_SENTINEL,
        intent=_REPORT_SENTINEL,
        expected=_REPORT_SENTINEL,
    )
    public_id, canonical_ref, report_id = report.public_id, canonical.public_id, report.id
    actions = f"/admin/feedback/{public_id}/actions"

    # Everything the application itself logs, at every level; third-party
    # drivers at the level production runs them. (aiosqlite's DEBUG echo of
    # bound parameters is a test-driver artefact: production runs asyncpg.)
    caplog.set_level(logging.INFO)
    for application_logger in ("services", "routers", "domain", "dependencies", "main"):
        caplog.set_level(logging.DEBUG, logger=application_logger)
    bodies = []
    for method, path, body in [
        ("POST", actions, {"action": "add_note", "body": _NOTE_SENTINEL}),
        ("POST", actions, {"action": "transition", "status": "triaged"}),
        ("POST", actions, {"action": "transition", "status": "new"}),
        ("POST", actions, {"action": "link_duplicate", "target_public_id": canonical_ref}),
        ("POST", actions, {"action": "link_duplicate", "target_public_id": public_id}),
        ("POST", actions, _UNLINK),
        (
            "POST",
            actions,
            {"action": "add_note", "body": _NOTE_SENTINEL + "x" * FEEDBACK_NOTE_MAX_LENGTH},
        ),
        ("POST", actions, {"action": "add_note", "body": _NOTE_SENTINEL, "extra": 1}),
        ("POST", actions, {"action": "add_note_sneakily", "body": _NOTE_SENTINEL}),
        ("POST", f"/admin/feedback/{public_id}/draft", {"note_ids": [999_999]}),
    ]:
        response = await async_client.request(method, path, json=body, headers=admin.headers)
        if response.status_code >= HTTPStatus.BAD_REQUEST:
            bodies.append(response.text)

    assert len(bodies) >= 4, "the refusals are part of what is being checked"
    for text in bodies:
        assert _REPORT_SENTINEL not in text
        assert _NOTE_SENTINEL not in text

    audit = [record for record in caplog.records if record.getMessage() == _AUDIT_EVENT]
    assert len(audit) == 4, "note, transition, link and unlink each log one line"
    for record in audit:
        assert set(record.__dict__) >= _AUDIT_FIELDS
        assert record.__dict__["admin_id"] == admin.user_id
    for record in caplog.records:
        rendered = f"{record.getMessage()} {record.__dict__!r}"
        assert _REPORT_SENTINEL not in rendered
        assert _NOTE_SENTINEL not in rendered
        if record.exc_info and record.exc_info[1] is not None:
            assert _NOTE_SENTINEL not in str(record.exc_info[1])

    db_session.expire_all()
    note = (await db_session.execute(select(FeedbackNote))).scalars().first()
    assert note is not None
    stored = await db_session.get(FeedbackReport, report_id)
    for row in (note, stored):
        for rendering in (repr(row), str(row), f"{row}"):
            assert _NOTE_SENTINEL not in rendering
            assert _REPORT_SENTINEL not in rendering
    assert _NOTE_SENTINEL not in repr(AddNoteCommand(action="add_note", body=_NOTE_SENTINEL))
