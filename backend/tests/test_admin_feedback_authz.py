"""Who may reach the beta feedback inbox: an administrator, and nobody else.

Every triage route reads or rewrites somebody else's report by design -- that
is what an operator surface is -- so ownership is the wrong axis for it and the
admin role is the whole control. The properties pinned here are therefore about
the gate, route by route:

- an anonymous caller is refused with 401 before anything is looked up;
- a signed-in non-admin is refused with 403 ``admin_required`` -- including on
  a report they filed themselves, because owning a report grants the right to
  its receipt, not to its triage -- and the refusal names nothing about it;
- a refused mutation writes nothing: no status change, no link change, no
  note, no event.

The route list is checked against the application's own routing table, so a
triage route added later without a row here fails the inventory test rather
than slipping past every gate test.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from http import HTTPStatus

import pytest
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.auth import require_admin
from models.feedback_triage import FeedbackNote, FeedbackTriageEvent
from schemas.feedback_admin import FeedbackTriageSummary
from tests.helpers.feedback_triage import (
    SEED_ACTUAL,
    SEED_SUMMARY,
    Account,
    make_account,
    report_state,
    row_count,
    seed_report,
)
from tests.helpers.openapi_errors import route_index

# Everything the inbox summary must never carry: the reporter's identity, the
# client's session correlation, the idempotency digest, and the prose.
_FORBIDDEN_SUMMARY_KEYS = frozenset(
    {
        "user_id",
        "email",
        "correlation_id",
        "idem_key",
        "summary",
        "intent",
        "expected",
        "actual",
    }
)

_NOTE_SENTINEL = "SENTINEL-NOTE-FROM-A-NON-ADMIN"


@dataclass(frozen=True)
class _Route:
    """One triage route: how to call it, given the two seeded references."""

    method: str
    template: str
    body: Callable[[str], dict[str, object] | None]

    def path(self, public_id: str) -> str:
        return self.template.format(public_id=public_id)


def _no_body(_other: str) -> None:
    return None


_ACTIONS = "/admin/feedback/{public_id}/actions"

# Every route, and every command the command route accepts: a gate that held
# for ``transition`` but not for ``add_note`` would otherwise pass unseen.
_ROUTES: tuple[_Route, ...] = (
    _Route("GET", "/admin/capabilities", _no_body),
    _Route("GET", "/admin/feedback", _no_body),
    _Route("GET", "/admin/feedback/{public_id}", _no_body),
    _Route("POST", _ACTIONS, lambda _o: {"action": "transition", "status": "triaged"}),
    _Route("POST", _ACTIONS, lambda o: {"action": "link_duplicate", "target_public_id": o}),
    _Route("POST", _ACTIONS, lambda _o: {"action": "unlink_duplicate"}),
    _Route("POST", _ACTIONS, lambda _o: {"action": "add_note", "body": _NOTE_SENTINEL}),
    _Route("POST", "/admin/feedback/{public_id}/draft", lambda _o: {"note_ids": []}),
)

_ROUTE_IDS = [
    f"{route.method} {route.template} {(route.body('FB-x') or {}).get('action', '')}".rstrip()
    for route in _ROUTES
]


@dataclass(frozen=True)
class _Seeded:
    reporter: Account
    report_id: int
    public_id: str
    other_id: int
    other_public_id: str


async def _seed(session: AsyncSession) -> _Seeded:
    """A reporter with two reports, the first already marked a duplicate of the second.

    Pre-linking is what gives a refused unlink something to wrongly remove.
    """
    reporter = await make_account(session, "reporter@example.com")
    other = await seed_report(session, reporter.user_id)
    report = await seed_report(session, reporter.user_id)
    report.duplicate_of_id = other.id
    session.add(report)
    await session.commit()
    assert report.id is not None
    assert other.id is not None
    return _Seeded(reporter, report.id, report.public_id, other.id, other.public_id)


async def _call(
    client: AsyncClient, route: _Route, seeded: _Seeded, headers: dict[str, str] | None
) -> tuple[int, str]:
    response = await client.request(
        route.method,
        route.path(seeded.public_id),
        json=route.body(seeded.other_public_id),
        headers=headers,
    )
    return response.status_code, response.text


async def _snapshot(session: AsyncSession, seeded: _Seeded) -> tuple[object, ...]:
    return (
        await report_state(session, seeded.report_id),
        await report_state(session, seeded.other_id),
        await row_count(session, FeedbackNote),
        await row_count(session, FeedbackTriageEvent),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("route", _ROUTES, ids=_ROUTE_IDS)
async def test_an_anonymous_caller_is_refused_with_401(
    async_client: AsyncClient, db_session: AsyncSession, route: _Route
) -> None:
    """No token, no triage -- and nothing written."""
    seeded = await _seed(db_session)
    before = await _snapshot(db_session, seeded)

    status_code, _ = await _call(async_client, route, seeded, None)

    assert status_code == HTTPStatus.UNAUTHORIZED
    assert await _snapshot(db_session, seeded) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("route", _ROUTES, ids=_ROUTE_IDS)
async def test_the_reporter_is_refused_with_403_and_learns_nothing(
    async_client: AsyncClient, db_session: AsyncSession, route: _Route
) -> None:
    """Owning the report is not admin; the refusal carries no reference or prose."""
    seeded = await _seed(db_session)
    before = await _snapshot(db_session, seeded)

    status_code, text = await _call(async_client, route, seeded, seeded.reporter.headers)

    assert status_code == HTTPStatus.FORBIDDEN
    assert '"admin_required"' in text
    for leaked in (seeded.public_id, seeded.other_public_id, SEED_SUMMARY, SEED_ACTUAL):
        assert leaked not in text
    assert await _snapshot(db_session, seeded) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("route", _ROUTES, ids=_ROUTE_IDS)
async def test_an_unrelated_non_admin_is_refused_with_403(
    async_client: AsyncClient, db_session: AsyncSession, route: _Route
) -> None:
    """A signed-in stranger fares no better than the reporter."""
    seeded = await _seed(db_session)
    stranger = await make_account(db_session, "stranger@example.com")
    before = await _snapshot(db_session, seeded)

    status_code, text = await _call(async_client, route, seeded, stranger.headers)

    assert status_code == HTTPStatus.FORBIDDEN
    assert '"admin_required"' in text
    assert await _snapshot(db_session, seeded) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("route", _ROUTES, ids=_ROUTE_IDS)
async def test_an_administrator_is_let_through(
    async_client: AsyncClient, db_session: AsyncSession, route: _Route
) -> None:
    """The positive control: the same call as an admin is not refused by the gate."""
    seeded = await _seed(db_session)
    admin = await make_account(db_session, "operator@example.com", admin=True)

    status_code, _ = await _call(async_client, route, seeded, admin.headers)

    assert status_code not in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}
    assert status_code < HTTPStatus.INTERNAL_SERVER_ERROR


def _depends_on(dependant: Dependant, target: object) -> bool:
    """Whether ``target`` appears anywhere in ``dependant``'s dependency tree."""
    stack = [dependant]
    while stack:
        current = stack.pop()
        if current.call is target:
            return True
        stack.extend(current.dependencies)
    return False


def _admin_routes() -> dict[tuple[str, str], APIRoute]:
    """Every mounted ``(method, path)`` under ``/admin``, from the app's own table."""
    return {key: route for key, route in route_index().items() if key[1].startswith("/admin")}


def test_the_route_table_is_the_whole_triage_surface() -> None:
    """Every triage route the app serves has a row in ``_ROUTES``, and vice versa."""
    served = {
        key
        for key in _admin_routes()
        if key[1].startswith(("/admin/feedback", "/admin/capabilities"))
    }
    assert served == {(route.method, route.template) for route in _ROUTES}


def test_every_admin_route_depends_on_require_admin() -> None:
    """Swept over every ``/admin`` route, not only the triage ones."""
    routes = _admin_routes()
    ungated = sorted(
        f"{method} {path}"
        for (method, path), route in routes.items()
        if not _depends_on(route.dependant, require_admin)
    )
    assert ungated == []
    assert len(routes) > len(_ROUTES)


def test_the_inbox_page_never_carries_identity_or_prose_keys() -> None:
    """The summary schema itself has none of the forbidden fields."""
    assert _FORBIDDEN_SUMMARY_KEYS.isdisjoint(FeedbackTriageSummary.model_fields)


@pytest.mark.asyncio
async def test_feedback_inbox_requires_admin(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Anonymous gets 401, the reporter gets 403, an administrator gets the page."""
    reporter = await make_account(db_session, "reporter@example.com")
    report = await seed_report(db_session, reporter.user_id)

    anonymous = await async_client.get("/admin/feedback")
    assert anonymous.status_code == HTTPStatus.UNAUTHORIZED

    refused = await async_client.get("/admin/feedback", headers=reporter.headers)
    assert refused.status_code == HTTPStatus.FORBIDDEN
    assert refused.json()["detail"] == "admin_required"
    assert report.public_id not in refused.text

    admin = await make_account(db_session, "operator@example.com", admin=True)
    page = await async_client.get("/admin/feedback", headers=admin.headers)
    assert page.status_code == HTTPStatus.OK
    body = page.json()
    assert body["total"] == 1
    assert body["has_more"] is False
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["public_id"] == report.public_id
    assert item["status"] == "new"
    assert _FORBIDDEN_SUMMARY_KEYS.isdisjoint(item)
