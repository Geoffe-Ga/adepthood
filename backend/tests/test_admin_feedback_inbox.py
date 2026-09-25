"""Reading the beta feedback inbox: filters, order, paging, detail, siblings.

The paging property is the one most easily got almost right. Reports filed in
the same instant tie on ``created_at``, and ``OFFSET``/``LIMIT`` over a tie is
free to repeat one row and drop another. So the paging tests seed deliberate
ties, walk every page at a small page size under several filter combinations,
and assert the union of pages is exactly the filtered set -- no repeats, no
gaps, the right ``total`` and ``has_more`` on every page.

The detail view keeps the reporter's words, the app's envelope and the
operator's additions in three separate sections, and reading it -- siblings and
fingerprint included -- never changes any report.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.feedback_triage import fingerprint
from models.feedback import FeedbackReport
from models.feedback_triage import FeedbackNote
from services.feedback_triage import SIBLING_LIMIT
from tests.helpers.feedback_triage import (
    SEED_ACTUAL,
    SEED_EXPECTED,
    SEED_INTENT,
    SEED_SUMMARY,
    Account,
    force_status,
    make_account,
    report_state,
    seed_report,
)

_T0 = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
_PAGE_SIZE = 2


async def _admin(session: AsyncSession) -> Account:
    return await make_account(session, "operator@example.com", admin=True)


async def _walk(
    client: AsyncClient, headers: dict[str, str], params: dict[str, str]
) -> tuple[list[str], list[dict[str, Any]]]:
    """Every page of the inbox under ``params``; returns the ids and the page bodies."""
    ids: list[str] = []
    pages: list[dict[str, Any]] = []
    offset = 0
    while True:
        response = await client.get(
            "/admin/feedback",
            params={**params, "limit": str(_PAGE_SIZE), "offset": str(offset)},
            headers=headers,
        )
        assert response.status_code == HTTPStatus.OK, response.text
        body = response.json()
        pages.append(body)
        ids.extend(item["public_id"] for item in body["items"])
        if not body["has_more"]:
            return ids, pages
        offset += _PAGE_SIZE


async def _seed_grid(session: AsyncSession, user_id: int) -> list[FeedbackReport]:
    """Twelve reports across categories, impacts, screens and builds, in tie groups of three."""
    reports = []
    combos = [
        ("broken", "blocked", "journal.shelf", "1.4.2"),
        ("broken", "cosmetic", "journal.shelf", "1.4.2"),
        ("idea", "not_applicable", "habits.detail", "1.5.0"),
        ("broken", "blocked", "habits.detail", "1.4.2"),
        ("confusing", "can_continue", "journal.shelf", "1.5.0"),
        ("broken", "blocked", "journal.shelf", "1.5.0"),
    ]
    for index in range(12):
        category, impact, screen, build = combos[index % len(combos)]
        reports.append(
            await seed_report(
                session,
                user_id,
                category=category,
                impact=impact,
                screen=screen,
                app_build=build,
                created_at=_T0 + timedelta(minutes=index // 3),
            )
        )
    await force_status(session, reports[0].id or 0, "triaged")
    await force_status(session, reports[5].id or 0, "triaged")
    await force_status(session, reports[7].id or 0, "closed")
    return reports


def _expected(reports: list[FeedbackReport], **filters: object) -> list[str]:
    """The filtered set in the declared order, computed independently in Python."""
    lower = filters.pop("created_from", None)
    upper = filters.pop("created_before", None)
    assert lower is None or isinstance(lower, datetime)
    assert upper is None or isinstance(upper, datetime)
    kept = [
        r
        for r in reports
        if all(getattr(r, key) == value for key, value in filters.items())
        and (lower is None or r.created_at >= lower)
        and (upper is None or r.created_at < upper)
    ]
    kept.sort(key=lambda r: (r.created_at, r.id or 0), reverse=True)
    return [r.public_id for r in kept]


_FILTER_CASES: list[dict[str, object]] = [
    {},
    {"category": "broken"},
    {"category": "broken", "impact": "blocked"},
    {"category": "broken", "impact": "blocked", "screen": "journal.shelf"},
    {"screen": "journal.shelf", "app_build": "1.5.0"},
    {"status": "triaged"},
    {"status": "new", "category": "broken"},
    {"created_from": _T0 + timedelta(minutes=1), "created_before": _T0 + timedelta(minutes=3)},
    {"category": "broken", "created_from": _T0 + timedelta(minutes=2)},
]


@pytest.mark.asyncio
@pytest.mark.parametrize("filters", _FILTER_CASES)
async def test_filtered_paging_is_exact_under_tied_timestamps(
    async_client: AsyncClient, db_session: AsyncSession, filters: dict[str, object]
) -> None:
    """Union of pages == the filtered set, in order, with correct total and has_more."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    reports = await _seed_grid(db_session, reporter.user_id)
    for report in reports:
        await db_session.refresh(report)
    # SQLite hands back naive datetimes; compare in UTC throughout.
    for report in reports:
        report.created_at = report.created_at.replace(tzinfo=UTC)

    params = {
        key: value.isoformat() if isinstance(value, datetime) else str(value)
        for key, value in filters.items()
    }
    ids, pages = await _walk(async_client, admin.headers, params)
    expected = _expected(reports, **dict(filters))

    assert ids == expected
    assert len(set(ids)) == len(ids)
    assert expected, "every case must select something, or it proves nothing"
    for index, page in enumerate(pages):
        assert page["total"] == len(expected)
        assert page["has_more"] is (index < len(pages) - 1)


@pytest.mark.asyncio
async def test_the_default_order_is_newest_first_then_highest_id(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Within one timestamp, the later-inserted report comes first."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    first = await seed_report(db_session, reporter.user_id, created_at=_T0)
    second = await seed_report(db_session, reporter.user_id, created_at=_T0)
    newest = await seed_report(db_session, reporter.user_id, created_at=_T0 + timedelta(hours=1))

    body = (await async_client.get("/admin/feedback", headers=admin.headers)).json()

    assert [item["public_id"] for item in body["items"]] == [
        newest.public_id,
        second.public_id,
        first.public_id,
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [
        {"status": "wontfix"},
        {"screen": "https://evil.example.com/?x=1"},
        {"app_build": "1.4 2"},
        {"created_from": "2026-09-01T12:00:00"},
        {"limit": "0"},
    ],
)
async def test_malformed_filters_are_refused(
    async_client: AsyncClient, db_session: AsyncSession, params: dict[str, str]
) -> None:
    """Every filter is validated, and a naive timestamp is not guessed at."""
    admin = await _admin(db_session)
    response = await async_client.get("/admin/feedback", params=params, headers=admin.headers)
    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_capabilities_confirm_the_inbox_for_an_admin(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The client's only source of admin knowledge answers plainly."""
    admin = await _admin(db_session)
    response = await async_client.get("/admin/capabilities", headers=admin.headers)
    assert response.status_code == HTTPStatus.OK
    assert response.json() == {"feedback_triage": True}


@pytest.mark.asyncio
async def test_detail_keeps_the_three_sources_apart(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Reporter prose, the envelope and operator additions each live in their own section."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    correlation = "0f0f0f0f-1111-4222-8333-444455556666"
    report = await seed_report(db_session, reporter.user_id, correlation_id=correlation)
    db_session.add(FeedbackNote(report_id=report.id or 0, body="Operator reading."))
    await db_session.commit()

    response = await async_client.get(f"/admin/feedback/{report.public_id}", headers=admin.headers)

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert body["reporter_said"] == {
        "summary": SEED_SUMMARY,
        "intent": SEED_INTENT,
        "expected": SEED_EXPECTED,
        "actual": SEED_ACTUAL,
    }
    attached = body["app_attached"]
    assert attached["screen"] == "journal.shelf"
    assert attached["correlation_id"] == correlation
    assert SEED_SUMMARY not in str(attached)
    operator = body["operator_added"]
    assert operator["status"] == "new"
    assert [note["body"] for note in operator["notes"]] == ["Operator reading."]
    assert SEED_SUMMARY not in str(operator)
    assert "Operator reading." not in str(body["reporter_said"])
    assert body["allowed_transitions"] == ["closed", "triaged"]
    for forbidden in ("user_id", "email", "idem_key", reporter.email):
        assert forbidden not in response.text


@pytest.mark.asyncio
async def test_an_unknown_reference_is_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A well-formed reference that was never issued."""
    admin = await _admin(db_session)
    response = await async_client.get("/admin/feedback/FB-22222222", headers=admin.headers)
    assert response.status_code == HTTPStatus.NOT_FOUND
    assert response.json()["detail"] == "feedback_report_not_found"


@pytest.mark.asyncio
@pytest.mark.parametrize("stored_build", ["3f9c2e1", "1.4.2-hotfix"])
async def test_a_build_stored_before_intake_narrowed_can_still_be_filtered_on(
    async_client: AsyncClient, db_session: AsyncSession, stored_build: str
) -> None:
    """The filter reads stored rows, so it keeps the grammar they were stored under.

    Intake once accepted any build matching the wider pre-#2899 grammar -- a commit
    hash, a free-suffix release -- and those rows are still shown in the inbox. A
    filter narrowed along with intake would answer 422 for the very value the
    operator is looking at.
    """
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    stored = await seed_report(db_session, reporter.user_id, app_build=stored_build)
    await seed_report(db_session, reporter.user_id, app_build="1.4.2")

    response = await async_client.get(
        "/admin/feedback", params={"app_build": stored_build}, headers=admin.headers
    )

    assert response.status_code == HTTPStatus.OK
    assert [item["public_id"] for item in response.json()["items"]] == [stored.public_id]


@pytest.mark.asyncio
async def test_siblings_share_the_fingerprint_and_nothing_else(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Same category, screen, control and build family: suggested. Anything else: not."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id, app_build="1.4.2+318")
    same_family = await seed_report(db_session, reporter.user_id, app_build="1.4.9")
    other_family = await seed_report(db_session, reporter.user_id, app_build="1.5.0")
    other_control = await seed_report(db_session, reporter.user_id, control="habit_offer.decline")
    no_control = await seed_report(db_session, reporter.user_id, control=None)
    other_screen = await seed_report(db_session, reporter.user_id, screen="habits.detail")

    body = (
        await async_client.get(f"/admin/feedback/{report.public_id}", headers=admin.headers)
    ).json()

    siblings = {item["public_id"] for item in body["siblings"]}
    assert siblings == {same_family.public_id}
    for excluded in (other_family, other_control, no_control, other_screen, report):
        assert excluded.public_id not in siblings
    assert body["fingerprint"] == fingerprint(
        category="broken", screen="journal.shelf", control="habit_offer.accept", app_build="1.4"
    )


@pytest.mark.asyncio
async def test_reports_without_a_control_are_siblings_of_each_other(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """NULL controls match each other (IS NOT DISTINCT FROM), not everything."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id, control=None)
    twin = await seed_report(db_session, reporter.user_id, control=None)
    await seed_report(db_session, reporter.user_id)

    body = (
        await async_client.get(f"/admin/feedback/{report.public_id}", headers=admin.headers)
    ).json()

    assert [item["public_id"] for item in body["siblings"]] == [twin.public_id]


@pytest.mark.asyncio
async def test_siblings_are_capped(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """At most ``SIBLING_LIMIT`` suggestions, newest first."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id, created_at=_T0)
    for index in range(SIBLING_LIMIT + 2):
        await seed_report(db_session, reporter.user_id, created_at=_T0 + timedelta(minutes=index))

    body = (
        await async_client.get(f"/admin/feedback/{report.public_id}", headers=admin.headers)
    ).json()

    assert len(body["siblings"]) == SIBLING_LIMIT


@pytest.mark.asyncio
async def test_reading_detail_and_siblings_changes_no_report(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Clusters are suggestions: status and duplicate links are identical after reads."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    reports = [await seed_report(db_session, reporter.user_id) for _ in range(4)]
    await force_status(db_session, reports[1].id or 0, "planned")
    reports[2].duplicate_of_id = reports[3].id
    db_session.add(reports[2])
    await db_session.commit()
    keys = [(r.id or 0, r.public_id) for r in reports]
    before = [await report_state(db_session, report_id) for report_id, _ in keys]

    for _, public_id in keys:
        response = await async_client.get(f"/admin/feedback/{public_id}", headers=admin.headers)
        assert response.status_code == HTTPStatus.OK
    await async_client.get("/admin/feedback", headers=admin.headers)

    assert [await report_state(db_session, report_id) for report_id, _ in keys] == before


@pytest.mark.asyncio
async def test_a_dangling_duplicate_link_reads_as_null(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A canonical report deleted underneath the link (SQLite never SET NULLs) reads null."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    canonical = await seed_report(db_session, reporter.user_id)
    duplicate = await seed_report(db_session, reporter.user_id)
    duplicate.duplicate_of_id = canonical.id
    db_session.add(duplicate)
    await db_session.commit()
    await db_session.execute(delete(FeedbackReport).where(col(FeedbackReport.id) == canonical.id))
    await db_session.commit()

    detail = await async_client.get(f"/admin/feedback/{duplicate.public_id}", headers=admin.headers)
    page = await async_client.get("/admin/feedback", headers=admin.headers)

    assert detail.status_code == HTTPStatus.OK
    assert detail.json()["operator_added"]["duplicate_of"] is None
    assert page.json()["items"][0]["duplicate_of"] is None


@pytest.mark.asyncio
async def test_a_live_duplicate_link_reads_as_the_canonical_reference(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Both directions of the link are shown by reference."""
    admin = await _admin(db_session)
    reporter = await make_account(db_session, "reporter@example.com")
    canonical = await seed_report(db_session, reporter.user_id)
    duplicate = await seed_report(db_session, reporter.user_id)
    duplicate.duplicate_of_id = canonical.id
    db_session.add(duplicate)
    await db_session.commit()

    dup_body = (
        await async_client.get(f"/admin/feedback/{duplicate.public_id}", headers=admin.headers)
    ).json()
    canon_body = (
        await async_client.get(f"/admin/feedback/{canonical.public_id}", headers=admin.headers)
    ).json()

    assert dup_body["operator_added"]["duplicate_of"] == canonical.public_id
    assert canon_body["operator_added"]["duplicates"] == [duplicate.public_id]
