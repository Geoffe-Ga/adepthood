"""Submitted prose never reaches a repr, a log record, or an error-monitoring event.

Encryption at rest answers "what does a stolen disk yield". These tests answer
the other three questions, which are the ones that have historically leaked
first: what does a traceback render, what does the request's own log line carry,
and what does an outbound Sentry event hold.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from http import HTTPStatus
from typing import Any

import pytest
import sqlalchemy as sa
from httpx import AsyncClient

from models._prose_repr import REDACTED
from models.feedback import FeedbackReport
from schemas.feedback import FeedbackCreate
from sentry import scrub_event
from services.journal_encryption import EncryptedString

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
