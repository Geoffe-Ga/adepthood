"""Two operators acting on the triage inbox at once, on a real PostgreSQL.

The in-process suite runs on SQLite with a single shared session, which can
express neither a row lock nor two transactions interleaving. This module gives
each request its own session on a real pool, holds both requests at the point
between "report loaded" and "change applied", and lets them go together -- the
exact interleaving under which a read-check-write with no lock lets both pass
the check against the same stale state.

Three races, three invariants:

- two transitions from one state: exactly one lands, the other is refused with
  ``feedback_transition_not_allowed``, and the trail holds exactly one event
  whose ``old_state`` is the state the report really had;
- two unlinks of one link: exactly one lands and one event is written;
- ``X -> Y`` and ``Y -> X`` together: exactly one lands and the other is
  refused as a cycle, so the table never holds a 2-cycle.
"""

from __future__ import annotations

import asyncio
import contextlib
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, col, select

from database import get_session
from main import app
from models.feedback import FeedbackReport
from models.feedback_triage import FeedbackTriageEvent
from services import feedback_triage
from tests.helpers.feedback_triage import Account, force_status, make_account, seed_report

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator, Awaitable, Callable

    from sqlalchemy.ext.asyncio import AsyncEngine

pytestmark = pytest.mark.integration

# How long a request that reached the change waits for its twin to reach it too.
# Long enough that two unserialised requests always meet; when the fix holds the
# twin back at its row lock, the first simply proceeds once this runs out.
_RENDEZVOUS_SECONDS = 1.0
_PARTIES = 2


class _Pair:
    """Session factory, client, and the two operators acting at once."""

    def __init__(
        self,
        factory: async_sessionmaker[AsyncSession],
        client: AsyncClient,
    ) -> None:
        self.factory = factory
        self.client = client


@pytest_asyncio.fixture
async def pair(pg_database_url: str) -> AsyncGenerator[_Pair, None]:
    """A client whose requests each get their own PostgreSQL session."""
    engine: AsyncEngine = create_async_engine(pg_database_url)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _per_request_session() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = _per_request_session
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield _Pair(factory, client)
    finally:
        app.dependency_overrides.clear()
        names = ", ".join(f'"{table.name}"' for table in SQLModel.metadata.sorted_tables)
        async with engine.begin() as connection:
            await connection.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))
        await engine.dispose()


def _hold_at(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    """Hold each call of ``feedback_triage.<name>`` until its twin arrives.

    The router looks the service function up on the module at call time, so the
    wrapper sits after the report was loaded (and, when the fix holds, locked)
    and before the change is checked and applied.
    """
    real: Callable[..., Awaitable[object]] = getattr(feedback_triage, name)
    arrived = 0
    both_here = asyncio.Event()

    async def _held(*args: object, **kwargs: object) -> object:
        nonlocal arrived
        arrived += 1
        if arrived >= _PARTIES:
            both_here.set()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(both_here.wait(), timeout=_RENDEZVOUS_SECONDS)
        return await real(*args, **kwargs)

    monkeypatch.setattr(feedback_triage, name, _held)


async def _seed(pair: _Pair, count: int) -> tuple[Account, Account, list[FeedbackReport]]:
    """Two operators and ``count`` reports, written through their own session."""
    async with pair.factory() as session:
        first = await make_account(session, "race_admin_a@example.com", admin=True)
        second = await make_account(session, "race_admin_b@example.com", admin=True)
        reporter = await make_account(session, "race_reporter@example.com")
        reports = [await seed_report(session, reporter.user_id) for _ in range(count)]
    return first, second, reports


def _act(pair: _Pair, who: Account, public_id: str, command: dict[str, str]) -> Awaitable[Response]:
    return pair.client.post(
        f"/admin/feedback/{public_id}/actions", json=command, headers=who.headers
    )


async def _events(pair: _Pair, report_id: int) -> list[tuple[str, str | None, str | None]]:
    async with pair.factory() as session:
        rows = (
            await session.execute(
                select(FeedbackTriageEvent)
                .where(col(FeedbackTriageEvent.report_id) == report_id)
                .order_by(col(FeedbackTriageEvent.id))
            )
        ).scalars()
        return [(row.action, row.old_state, row.new_state) for row in rows]


async def _state(pair: _Pair, report_id: int) -> tuple[str, int | None]:
    async with pair.factory() as session:
        row = await session.get(FeedbackReport, report_id)
        assert row is not None
        return row.status, row.duplicate_of_id


def _statuses(responses: list[Response]) -> list[int]:
    return sorted(response.status_code for response in responses)


@pytest.mark.asyncio
async def test_two_transitions_from_one_state_cannot_both_land(
    pair: _Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    """triaged->closed and triaged->planned at once: one lands, one is refused."""
    first, second, [report] = await _seed(pair, 1)
    report_id = report.id or 0
    async with pair.factory() as session:
        await force_status(session, report_id, "triaged")
    _hold_at(monkeypatch, "transition")

    responses = list(
        await asyncio.gather(
            _act(pair, first, report.public_id, {"action": "transition", "status": "closed"}),
            _act(pair, second, report.public_id, {"action": "transition", "status": "planned"}),
        )
    )

    assert _statuses(responses) == [HTTPStatus.OK, HTTPStatus.CONFLICT]
    refused = next(r for r in responses if r.status_code == HTTPStatus.CONFLICT)
    assert refused.json()["detail"] == "feedback_transition_not_allowed"
    landed = next(r for r in responses if r.status_code == HTTPStatus.OK)
    final_status = landed.json()["operator_added"]["status"]
    assert (await _state(pair, report_id))[0] == final_status
    assert await _events(pair, report_id) == [("status_changed", "triaged", final_status)]


@pytest.mark.asyncio
async def test_two_unlinks_of_one_link_write_one_event(
    pair: _Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both operators clear the same link: one clears it, the other is told there is none."""
    first, second, [canonical, duplicate] = await _seed(pair, 2)
    duplicate_id = duplicate.id or 0
    async with pair.factory() as session:
        row = await session.get(FeedbackReport, duplicate_id)
        assert row is not None
        row.duplicate_of_id = canonical.id
        session.add(row)
        await session.commit()
    _hold_at(monkeypatch, "unlink_duplicate")
    unlink = {"action": "unlink_duplicate"}

    responses = list(
        await asyncio.gather(
            _act(pair, first, duplicate.public_id, unlink),
            _act(pair, second, duplicate.public_id, unlink),
        )
    )

    assert _statuses(responses) == [HTTPStatus.OK, HTTPStatus.CONFLICT]
    assert await _state(pair, duplicate_id) == ("new", None)
    assert await _events(pair, duplicate_id) == [("duplicate_unlinked", canonical.public_id, None)]


@pytest.mark.asyncio
async def test_crossed_links_cannot_form_a_two_cycle(
    pair: _Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    """X -> Y and Y -> X at once: one lands, the other is refused as a cycle."""
    first, second, [left, right] = await _seed(pair, 2)
    _hold_at(monkeypatch, "link_duplicate")

    responses = list(
        await asyncio.gather(
            _act(
                pair,
                first,
                left.public_id,
                {"action": "link_duplicate", "target_public_id": right.public_id},
            ),
            _act(
                pair,
                second,
                right.public_id,
                {"action": "link_duplicate", "target_public_id": left.public_id},
            ),
        )
    )

    assert _statuses(responses) == [HTTPStatus.OK, HTTPStatus.CONFLICT]
    refused = next(r for r in responses if r.status_code == HTTPStatus.CONFLICT)
    assert refused.json()["detail"] == "feedback_duplicate_cycle"
    links = [(await _state(pair, r.id or 0))[1] for r in (left, right)]
    assert links.count(None) == 1
