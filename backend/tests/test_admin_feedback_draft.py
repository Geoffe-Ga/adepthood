"""The GitHub issue draft: what it says, what it must never say, and what it never does.

A draft is written to be pasted into a public tracker, so it is the one place in
the triage surface where a leak is a publication. The report behind these tests
is seeded with a sentinel in every identity-bearing column the table has -- the
account's address and id, the client correlation id, the idempotency digest --
plus an operator note that is *not* selected, plus prose stuffed with the
credential shapes a tester might paste. None of it may reach the draft.

And it is a draft, not a publication: the route is exercised with the network
torn out from under it and must still answer, having written nothing.
"""

from __future__ import annotations

import socket
from http import HTTPStatus

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.feedback_triage import DRAFT_SECTIONS
from models.feedback_triage import FeedbackNote, FeedbackTriageEvent
from models.user import User
from schemas.feedback_admin import (
    MAX_DRAFT_NOTES,
    OPERATOR_SUMMARY_MAX_LENGTH,
    OPERATOR_TITLE_MAX_LENGTH,
)
from tests.helpers.feedback_triage import (
    DRAFT_BODY,
    OPERATOR_SUMMARY,
    OPERATOR_TITLE,
    make_account,
    report_state,
    row_count,
    seed_report,
)

_REPORTER_ID = 987_654
_REPORTER_EMAIL = "sentinel-reporter@example.com"
_CORRELATION = "5e5e5e5e-7777-4888-9999-000011112222"
_IDEM_KEY = "IDEMKEY-SENTINEL-DIGEST-0001"  # pragma: allowlist secret
_UNSELECTED_NOTE = "UNSELECTED-NOTE-SENTINEL"
_SELECTED_NOTE = "Reproduced on a second device."

_JWT = (
    "eyJhbGciOiJIUzI1NiJ9"  # pragma: allowlist secret
    ".eyJzdWIiOiI5ODc2NTQifQ"  # pragma: allowlist secret
    ".c2VudGluZWwtc2lnbmF0dXJl"  # pragma: allowlist secret
)
_BEARER_TOKEN = "tok_ABCdef123456.sentinel"  # pragma: allowlist secret
_API_KEY = "sk-sentinel0123456789abcdef"  # pragma: allowlist secret
_URL_QUERY = "https://app.example.com/reset?token=SENTINELRESET"
_PROSE_EMAIL = "tester-in-prose@example.com"

# Plain words, no secret shape at all: nothing but the allowlist keeps these out.
_REPORTER_WORDS = "SENTINEL-REPORTER-OWN-WORDS-5E1A"

_SECRET_SHAPES = (
    f"I pasted {_JWT} and then Bearer {_BEARER_TOKEN} and my key {_API_KEY}; "
    f"the link was {_URL_QUERY} -- write to {_PROSE_EMAIL}."
)
# What the reporter typed: credential shapes AND plain words of their own.
_SECRET_PROSE = f"{_SECRET_SHAPES} {_REPORTER_WORDS}"

_NEVER_IN_DRAFT = (
    _REPORTER_WORDS,
    _REPORTER_EMAIL,
    str(_REPORTER_ID),
    _CORRELATION,
    _IDEM_KEY,
    _UNSELECTED_NOTE,
    _JWT,
    _BEARER_TOKEN,
    _API_KEY,
    "SENTINELRESET",
    _PROSE_EMAIL,
)


async def _seed(session: AsyncSession) -> tuple[str, int, int, int]:
    """The poisoned report; returns ``(public_id, report_id, selected_id, unselected_id)``."""
    session.add(User(id=_REPORTER_ID, email=_REPORTER_EMAIL, password_hash="x"))
    await session.commit()
    report = await seed_report(
        session,
        _REPORTER_ID,
        summary=_SECRET_PROSE,
        intent=_SECRET_PROSE,
        expected=_SECRET_PROSE,
        actual=_SECRET_PROSE,
        correlation_id=_CORRELATION,
        idem_key=_IDEM_KEY,
    )
    report_id = report.id or 0
    selected = FeedbackNote(report_id=report_id, body=f"{_SELECTED_NOTE} {_SECRET_SHAPES}")
    unselected = FeedbackNote(report_id=report_id, body=_UNSELECTED_NOTE)
    session.add_all([selected, unselected])
    await session.commit()
    return report.public_id, report_id, selected.id or 0, unselected.id or 0


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every real outbound connection an error for the duration of the test.

    The in-process ASGI transport the test client rides on is untouched; the
    real-network transports and the socket layer beneath them are not.
    """

    def _refuse(*_args: object, **_kwargs: object) -> None:
        msg = "network egress attempted during draft generation"
        raise AssertionError(msg)

    monkeypatch.setattr(socket.socket, "connect", _refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", _refuse)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", _refuse)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _refuse)


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_network")
async def test_the_draft_carries_the_report_and_none_of_the_sentinels(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Sections present, selected note present; identity, secrets, unselected note absent."""
    admin = await make_account(db_session, "operator@example.com", admin=True)
    public_id, report_id, selected_id, _ = await _seed(db_session)
    before = (
        await report_state(db_session, report_id),
        await row_count(db_session, FeedbackNote),
        await row_count(db_session, FeedbackTriageEvent),
    )

    response = await async_client.post(
        f"/admin/feedback/{public_id}/draft",
        json={**DRAFT_BODY, "note_ids": [selected_id]},
        headers=admin.headers,
    )

    assert response.status_code == HTTPStatus.OK, response.text
    draft = response.json()
    everything = response.text
    for sentinel in _NEVER_IN_DRAFT:
        assert sentinel not in everything, sentinel
    for heading in DRAFT_SECTIONS:
        assert f"## {heading}" in draft["markdown"]
    assert "## Operator notes" in draft["markdown"]
    assert _SELECTED_NOTE in draft["markdown"]
    assert draft["title"] == f"[broken] {OPERATOR_TITLE}"
    assert OPERATOR_SUMMARY in draft["markdown"]
    assert draft["source_public_ids"] == [public_id]
    assert public_id in draft["markdown"]
    assert (
        await report_state(db_session, report_id),
        await row_count(db_session, FeedbackNote),
        await row_count(db_session, FeedbackTriageEvent),
    ) == before


@pytest.mark.asyncio
async def test_no_note_is_quoted_unless_selected(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An empty selection renders no operator section at all."""
    admin = await make_account(db_session, "operator@example.com", admin=True)
    public_id, _, _, _ = await _seed(db_session)

    response = await async_client.post(
        f"/admin/feedback/{public_id}/draft", json=DRAFT_BODY, headers=admin.headers
    )

    assert response.status_code == HTTPStatus.OK
    assert "Operator notes" not in response.text
    assert _SELECTED_NOTE not in response.text
    assert _UNSELECTED_NOTE not in response.text


@pytest.mark.asyncio
async def test_duplicates_folded_into_the_report_are_cited(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Reports marked as this one's duplicates appear as source references."""
    admin = await make_account(db_session, "operator@example.com", admin=True)
    reporter = await make_account(db_session, "reporter@example.com")
    canonical = await seed_report(db_session, reporter.user_id)
    duplicate = await seed_report(db_session, reporter.user_id)
    duplicate.duplicate_of_id = canonical.id
    db_session.add(duplicate)
    await db_session.commit()
    canonical_ref, duplicate_ref = canonical.public_id, duplicate.public_id

    draft = (
        await async_client.post(
            f"/admin/feedback/{canonical_ref}/draft", json=DRAFT_BODY, headers=admin.headers
        )
    ).json()

    assert draft["source_public_ids"] == [canonical_ref, duplicate_ref]


@pytest.mark.asyncio
@pytest.mark.parametrize("which", ["foreign", "missing"])
async def test_a_note_id_outside_the_report_is_404(
    async_client: AsyncClient, db_session: AsyncSession, which: str
) -> None:
    """Another report's note, or no note at all: 404, and nothing of it rendered."""
    admin = await make_account(db_session, "operator@example.com", admin=True)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id)
    other = await seed_report(db_session, reporter.user_id)
    foreign = FeedbackNote(report_id=other.id or 0, body="FOREIGN-NOTE-SENTINEL")
    db_session.add(foreign)
    await db_session.commit()
    note_id = foreign.id if which == "foreign" else 999_999

    response = await async_client.post(
        f"/admin/feedback/{report.public_id}/draft",
        json={**DRAFT_BODY, "note_ids": [note_id]},
        headers=admin.headers,
    )

    assert response.status_code == HTTPStatus.NOT_FOUND
    assert response.json()["detail"] == "feedback_note_not_found"
    assert "FOREIGN-NOTE-SENTINEL" not in response.text


@pytest.mark.asyncio
async def test_the_note_selection_is_bounded(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """More note ids than the bound is a 422, not a very long draft."""
    admin = await make_account(db_session, "operator@example.com", admin=True)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id)

    response = await async_client.post(
        f"/admin/feedback/{report.public_id}/draft",
        json={**DRAFT_BODY, "note_ids": list(range(1, MAX_DRAFT_NOTES + 2))},
        headers=admin.headers,
    )

    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {},
        {"title": OPERATOR_TITLE},
        {"summary": OPERATOR_SUMMARY},
        {"title": "", "summary": OPERATOR_SUMMARY},
        {"title": OPERATOR_TITLE, "summary": ""},
        {"title": "   ", "summary": "\u200b  "},
        {"title": OPERATOR_TITLE, "summary": "x" * (OPERATOR_SUMMARY_MAX_LENGTH + 1)},
        {"title": "x" * (OPERATOR_TITLE_MAX_LENGTH + 1), "summary": OPERATOR_SUMMARY},
    ],
)
async def test_a_draft_without_the_operators_own_words_is_refused(
    async_client: AsyncClient, db_session: AsyncSession, body: dict[str, str]
) -> None:
    """No operator title or summary is a 422 -- never a draft in the reporter's words."""
    admin = await make_account(db_session, "operator@example.com", admin=True)
    public_id, _, _, _ = await _seed(db_session)

    response = await async_client.post(
        f"/admin/feedback/{public_id}/draft", json=body, headers=admin.headers
    )

    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert _REPORTER_WORDS not in response.text


@pytest.mark.asyncio
async def test_the_operator_text_bounds_are_inclusive(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Exactly at both bounds is a draft."""
    admin = await make_account(db_session, "operator@example.com", admin=True)
    public_id, _, _, _ = await _seed(db_session)

    response = await async_client.post(
        f"/admin/feedback/{public_id}/draft",
        json={
            "title": "t" * OPERATOR_TITLE_MAX_LENGTH,
            "summary": "s" * OPERATOR_SUMMARY_MAX_LENGTH,
        },
        headers=admin.headers,
    )

    assert response.status_code == HTTPStatus.OK
    assert _REPORTER_WORDS not in response.text


# The decided bounds, written as literals so that a changed constant is a
# disagreement with this file rather than a bound that moves with its own test.
_DECIDED_TITLE_BOUND = 100
_DECIDED_SUMMARY_BOUND = 2000


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("title_length", "summary_length", "status"),
    [
        (_DECIDED_TITLE_BOUND, _DECIDED_SUMMARY_BOUND, HTTPStatus.OK),
        (_DECIDED_TITLE_BOUND + 1, _DECIDED_SUMMARY_BOUND, HTTPStatus.UNPROCESSABLE_ENTITY),
        (_DECIDED_TITLE_BOUND, _DECIDED_SUMMARY_BOUND + 1, HTTPStatus.UNPROCESSABLE_ENTITY),
    ],
)
async def test_the_operator_text_bounds_are_the_decided_numbers(
    async_client: AsyncClient,
    db_session: AsyncSession,
    title_length: int,
    summary_length: int,
    status: HTTPStatus,
) -> None:
    """100 characters of title and 2000 of summary, inclusive."""
    admin = await make_account(db_session, "operator@example.com", admin=True)
    public_id, _, _, _ = await _seed(db_session)

    response = await async_client.post(
        f"/admin/feedback/{public_id}/draft",
        json={"title": "t" * title_length, "summary": "s" * summary_length},
        headers=admin.headers,
    )

    assert response.status_code == status
