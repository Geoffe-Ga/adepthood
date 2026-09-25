"""Submitted prose never reaches a repr, a log record, or an error-monitoring event.

Encryption at rest answers "what does a stolen disk yield". These tests answer
the other three questions, which are the ones that have historically leaked
first: what does a traceback render, what does the request's own log line carry,
and what does an outbound Sentry event hold.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator, Callable
from http import HTTPStatus
from typing import Any

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

import sentry as error_monitoring
from database import get_session
from main import app
from models._prose_repr import REDACTED
from models.feedback import FeedbackReport
from models.feedback_triage import FeedbackNote
from routers import feedback as feedback_router
from schemas.feedback import FeedbackCreate
from schemas.feedback_admin import AddNoteCommand, FeedbackIssueDraft, FeedbackReporterSaid
from sentry import scrub_event
from services import feedback_triage
from services.journal_encryption import EncryptedString
from tests.helpers.feedback_triage import DRAFT_BODY, make_account, seed_report
from tests.helpers.sentry_capture import CapturedEvent, capturing_sentry

_PROSE_SENTINEL = "SENTINEL_PROSE_XYZ"
_PUBLIC_ID = "FB-7K3M9Q2B"


def _report() -> FeedbackReport:
    """A report whose every prose slot holds the sentinel."""
    return FeedbackReport(
        user_id=1,
        public_id=_PUBLIC_ID,
        category="broken",
        impact="blocked",
        platform="ios",
        viewport_class="compact",
        summary=_PROSE_SENTINEL,
        intent=_PROSE_SENTINEL,
        expected=_PROSE_SENTINEL,
        actual=_PROSE_SENTINEL,
        screen="journal.shelf",
        app_build="1.4.2",
    )


def test_feedback_report_repr_hides_the_submitted_prose() -> None:
    """Stringifying the row -- in a traceback, a log call, a test failure -- says nothing."""
    assert _PROSE_SENTINEL not in repr(_report())


def test_feedback_report_repr_still_names_the_row_it_describes() -> None:
    """The honesty half: a repr that rendered nothing would pass the test above.

    Mirrors ``tests/security/test_credential_repr.py``: what makes a redaction
    test meaningful is the assertion that the useful part survived, because
    otherwise ``return ""`` is a passing implementation.
    """
    rendered = repr(_report())

    assert "FeedbackReport" in rendered
    assert _PUBLIC_ID in rendered
    assert "category='broken'" in rendered
    assert "impact='blocked'" in rendered


def test_the_redaction_set_is_derived_from_the_column_type_not_a_hand_list() -> None:
    """What is hidden equals what the schema encrypts -- derived, never listed.

    No field names are written here. This is the assertion that distinguishes
    the mixin from a hand-written ``__repr__``: it keeps holding when #2899 or
    #2900 adds a prose column to this table, which a hand list would not.
    """
    rendered = repr(_report())
    hidden = {
        attr.key
        for attr in sa.inspect(FeedbackReport).mapper.column_attrs
        if f"{attr.key}={REDACTED}" in rendered
    }

    derived = {
        attr.key
        for attr in sa.inspect(FeedbackReport).mapper.column_attrs
        if isinstance(attr.columns[0].type, EncryptedString)
    }
    assert hidden == derived
    assert derived, "the table declares no encrypted column; the test would be vacuous"


def test_the_request_schemas_prose_fields_are_kept_out_of_its_repr() -> None:
    """The parsed request model is stringified long before an ORM object exists."""
    payload = FeedbackCreate(
        category="broken",
        impact="blocked",
        summary=_PROSE_SENTINEL,
        intent=_PROSE_SENTINEL,
        expected=_PROSE_SENTINEL,
        actual=_PROSE_SENTINEL,
        context={
            "screen": "journal.shelf",
            "platform": "ios",
            "app_build": "1.4.2",
            "viewport_class": "compact",
        },
    )

    assert _PROSE_SENTINEL not in repr(payload)


def test_an_error_monitoring_event_carrying_the_prose_is_scrubbed() -> None:
    """The four channels a default-configured SDK ships user content through."""
    event: dict[str, Any] = {
        "request": {"data": {"summary": _PROSE_SENTINEL}},
        "extra": {"payload": _PROSE_SENTINEL},
        "breadcrumbs": [{"message": _PROSE_SENTINEL}],
    }

    assert _PROSE_SENTINEL not in json.dumps(scrub_event(event, {}))


async def _signup(client: AsyncClient) -> dict[str, str]:
    """Create an account and return its auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": "feedback_logs@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    return {"Authorization": f"Bearer {resp.json()['token']}"}


@pytest.mark.asyncio
async def test_the_submission_log_line_names_the_envelope_and_not_the_words(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """The one line this route emits carries exactly what triage needs.

    Report id, category, impact, screen and build -- which is the list the issue
    permits -- and none of the four prose slots. Asserted across *every* record
    the request emitted at the level this application ships, not just the one the
    router wrote, because the access log and any framework logger are on the same
    path.

    INFO rather than DEBUG deliberately, and the difference is worth naming: at
    DEBUG the ``aiosqlite`` driver echoes every INSERT's bound parameters, which
    is a property of the database driver rather than of this route, applies
    identically to journal entries and practice reflections, and carries
    ciphertext in any deployment that has ``JOURNAL_ENCRYPTION_KEYS`` set. What
    this route owes is that *it* names nothing it should not, at the level the
    application actually emits.
    """
    headers = await _signup(async_client)
    payload = {
        "category": "broken",
        "impact": "blocked",
        "summary": _PROSE_SENTINEL,
        "intent": _PROSE_SENTINEL,
        "context": {
            "screen": "journal.shelf",
            "platform": "ios",
            "app_build": "1.4.2",
            "viewport_class": "compact",
        },
    }

    with caplog.at_level(logging.INFO):
        resp = await async_client.post("/feedback/", json=payload, headers=headers)

    assert resp.status_code == HTTPStatus.CREATED
    emitted = "\n".join(f"{record.getMessage()} {record.__dict__}" for record in caplog.records)
    assert _PROSE_SENTINEL not in emitted

    submitted = next(record for record in caplog.records if record.message == "feedback_submitted")
    assert submitted.__dict__["category"] == "broken"
    assert submitted.__dict__["impact"] == "blocked"
    assert submitted.__dict__["screen"] == "journal.shelf"
    assert submitted.__dict__["app_build"] == "1.4.2"
    assert submitted.__dict__["report_id"] is not None


# Every channel that renders an object to text. ``repr`` is the one people think
# of; the others are the ones that actually carry a leak, because
# ``logger.debug("%s", row)`` and an f-string both go through ``__str__`` -- and
# on a SQLModel class Pydantic's ``__str__`` builds itself from
# ``__repr_args__`` rather than delegating to ``__repr__``, so a mixin that
# overrides only ``__repr__`` leaves all of them printing the plaintext.
_RENDERERS = (
    ("repr", repr),
    ("str", str),
    ("format", format),
    ("fstring", lambda value: f"{value}"),
)
_RENDERER_IDS = [name for name, _ in _RENDERERS]


@pytest.mark.parametrize(("name", "render"), _RENDERERS, ids=_RENDERER_IDS)
def test_no_rendering_channel_reproduces_the_submitted_prose(
    name: str, render: Callable[[object], str]
) -> None:
    """The privacy policy this feature ships promises this of every channel, not one."""
    assert _PROSE_SENTINEL not in render(_report()), name


@pytest.mark.parametrize(("name", "render"), _RENDERERS, ids=_RENDERER_IDS)
def test_every_rendering_channel_still_identifies_the_report(
    name: str, render: Callable[[object], str]
) -> None:
    """The honesty half, per channel: none of them may render nothing."""
    assert _PUBLIC_ID in render(_report()), name


def test_percent_s_logging_of_a_report_does_not_reproduce_the_prose(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The exact call the mixin's docstring names, driven through a real handler.

    ``logger.debug("%s", row)`` is the channel the module claims to close, and
    it is the one that renders through ``__str__``. Formatting the record is
    what makes this a test of the rendered line rather than of the arguments
    still held on it.
    """
    logger = logging.getLogger("tests.feedback_repr")

    with caplog.at_level(logging.DEBUG, logger=logger.name):
        logger.debug("%s", _report())

    assert caplog.records
    assert all(_PROSE_SENTINEL not in record.getMessage() for record in caplog.records)


def test_the_representation_hook_is_redacted_at_source() -> None:
    """``__repr_args__`` is what ``__str__``, ``__pretty__`` and ``__rich_repr__`` read."""
    rendered = {key: repr(value) for key, value in _report().__repr_args__()}

    for column in ("summary", "intent", "expected", "actual"):
        assert rendered[column] == REDACTED, column
    assert rendered["public_id"] == f"'{_PUBLIC_ID}'"


# ── Operator notes (#2900) ────────────────────────────────────────────────


def _note() -> FeedbackNote:
    """An operator note whose body is the sentinel."""
    return FeedbackNote(id=7, report_id=3, author_admin_id=1, body=_PROSE_SENTINEL)


@pytest.mark.parametrize(("name", "render"), _RENDERERS, ids=_RENDERER_IDS)
def test_no_rendering_channel_reproduces_an_operator_note(
    name: str, render: Callable[[object], str]
) -> None:
    """A note is prose about somebody's report; every rendering hides it."""
    assert _PROSE_SENTINEL not in render(_note()), name


def test_an_operator_note_repr_still_names_the_row() -> None:
    """The honesty half: the ids survive, only the body is redacted."""
    rendered = repr(_note())
    assert "FeedbackNote" in rendered
    assert "report_id=3" in rendered
    assert f"body={REDACTED}" in rendered


def test_the_triage_command_and_draft_responses_keep_prose_out_of_repr() -> None:
    """The parsed command and the draft/detail DTOs render no prose either."""
    rendered = " ".join(
        repr(value)
        for value in (
            AddNoteCommand(action="add_note", body=_PROSE_SENTINEL),
            FeedbackIssueDraft(
                title=_PROSE_SENTINEL, markdown=_PROSE_SENTINEL, source_public_ids=[]
            ),
            FeedbackReporterSaid(
                summary=_PROSE_SENTINEL,
                intent=_PROSE_SENTINEL,
                expected=_PROSE_SENTINEL,
                actual=_PROSE_SENTINEL,
            ),
        )
    )
    assert _PROSE_SENTINEL not in rendered


def test_an_error_monitoring_event_carrying_a_triage_command_is_scrubbed() -> None:
    """A note posted to the command route is request data like any other."""
    event: dict[str, Any] = {
        "request": {"data": {"action": "add_note", "body": _PROSE_SENTINEL}},
    }

    assert _PROSE_SENTINEL not in json.dumps(scrub_event(event, {}))


# ── A real Sentry client and every INFO+ record, on the real routes (#2899) ──
#
# The tests above prove the scrubber on a hand-built event and the log line on a
# happy path. These drive the production app into a forced failure on both
# feedback routes -- intake and the operator's draft -- through a real
# ``sentry_sdk`` client built by the production initialiser, with only the
# transport swapped for a list.
#
# What is asserted *present* is asserted on log records: ``SentryContext`` is a
# closed allowlist (request id, path, method) by design, so a report id on the
# Sentry event would be a new product decision rather than something this suite
# may assume. The event is asserted to carry the allowlisted request context and
# nothing the reporter or operator wrote.

# Defined far from any ``raise``: Sentry's frames carry the source lines around
# the raise, and a sentinel written beside one would be found as *source code*.
_SEND_SENTINEL = "SENTINEL_SEND_i_miss_my_father_every_morning"
_DRAFT_SENTINEL = "SENTINEL_DRAFT_operator_quoted_the_reporter"
_FEEDBACK_PATH = "/feedback/"


def _sentinel_payload() -> dict[str, object]:
    """A report whose four prose slots all hold the send sentinel."""
    return {
        "category": "confusing",
        "impact": "can_continue",
        "summary": _SEND_SENTINEL,
        "intent": _SEND_SENTINEL,
        "expected": _SEND_SENTINEL,
        "actual": _SEND_SENTINEL,
        "context": {
            "screen": "map.stages",
            "control": "shell.header.send_feedback",
            "platform": "web",
            "app_build": "1.4.2",
            "viewport_class": "expanded",
        },
    }


async def _explode(*_args: object, **_kwargs: object) -> None:
    """Stand in for a storage or rendering failure the route did not anticipate."""
    raise RuntimeError("feedback_path_failed")


@pytest_asyncio.fixture
async def failing_client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """The production app, answering an unhandled error with its 500 envelope.

    ``raise_app_exceptions=False`` lets the global handler's response reach the
    test instead of the exception it also re-raises to the server.
    """

    async def _override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _assert_one_clean_event(events: list[CapturedEvent], path: str, sentinel: str) -> None:
    """Exactly one event, naming the route through the allowlist and nothing written."""
    assert len(events) == 1
    event = events[0]
    assert sentinel not in json.dumps(event, default=str)
    context = event["contexts"]
    assert isinstance(context, dict)
    assert context[error_monitoring.REQUEST_CONTEXT_KEY]["request_path"] == path


def _emitted(records: list[logging.LogRecord]) -> str:
    """Every record's message and attributes, as one searchable string."""
    return "\n".join(f"{record.getMessage()} {record.__dict__}" for record in records)


@pytest.mark.asyncio
async def test_a_failed_submission_ships_no_prose_to_error_monitoring(
    failing_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Intake fails after validation: the 500 is reported, the words are not."""
    reporter = await make_account(db_session, "sentry_send@example.com")
    monkeypatch.setattr(feedback_router, "_insert_with_fresh_public_id", _explode)

    with capturing_sentry(monkeypatch) as events, caplog.at_level(logging.INFO):
        resp = await failing_client.post(
            _FEEDBACK_PATH, json=_sentinel_payload(), headers=reporter.headers
        )

    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    _assert_one_clean_event(events, _FEEDBACK_PATH, _SEND_SENTINEL)
    assert _SEND_SENTINEL not in _emitted(caplog.records)


@pytest.mark.asyncio
async def test_a_failed_draft_ships_no_prose_to_error_monitoring(
    failing_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The draft fails mid-render: neither the reporter's words nor the operator's leave."""
    admin = await make_account(db_session, "sentry_admin@example.com", admin=True)
    reporter = await make_account(db_session, "sentry_reporter@example.com")
    report = await seed_report(
        db_session,
        reporter.user_id,
        summary=_DRAFT_SENTINEL,
        intent=_DRAFT_SENTINEL,
        expected=_DRAFT_SENTINEL,
        actual=_DRAFT_SENTINEL,
    )
    monkeypatch.setattr(feedback_triage, "build_draft", _explode)
    path = f"/admin/feedback/{report.public_id}/draft"

    with capturing_sentry(monkeypatch) as events, caplog.at_level(logging.INFO):
        resp = await failing_client.post(
            path, json={**DRAFT_BODY, "summary": _DRAFT_SENTINEL}, headers=admin.headers
        )

    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    _assert_one_clean_event(events, path, _DRAFT_SENTINEL)
    assert _DRAFT_SENTINEL not in _emitted(caplog.records)


@pytest.mark.asyncio
async def test_a_submission_and_a_draft_log_ids_and_enums_and_no_words(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Across every INFO+ record of a real submit and a real draft: ids yes, words no."""
    reporter = await make_account(db_session, "logs_reporter@example.com")
    admin = await make_account(db_session, "logs_admin@example.com", admin=True)

    with caplog.at_level(logging.INFO):
        filed = await async_client.post(
            _FEEDBACK_PATH, json=_sentinel_payload(), headers=reporter.headers
        )
        public_id = filed.json()["public_id"]
        drafted = await async_client.post(
            f"/admin/feedback/{public_id}/draft",
            json={**DRAFT_BODY, "summary": _DRAFT_SENTINEL},
            headers=admin.headers,
        )

    assert filed.status_code == HTTPStatus.CREATED
    assert drafted.status_code == HTTPStatus.OK
    emitted = _emitted(caplog.records)
    assert _SEND_SENTINEL not in emitted
    assert _DRAFT_SENTINEL not in emitted
    submitted = next(r for r in caplog.records if r.message == "feedback_submitted")
    assert isinstance(submitted.__dict__["report_id"], int)
    assert submitted.__dict__["public_id"] == public_id
    assert submitted.__dict__["category"] == "confusing"
    assert submitted.__dict__["impact"] == "can_continue"
    assert submitted.__dict__["screen"] == "map.stages"
