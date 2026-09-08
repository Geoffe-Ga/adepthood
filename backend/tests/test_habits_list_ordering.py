"""``GET /habits/`` must impose a total order, not a partial one.

``sort_order`` is nullable, so a legacy store onboarded before slots existed
holds NULL in every row. A bare ``ORDER BY sort_order ASC`` leaves the order
among those rows undefined, and PostgreSQL sorts NULLs LAST -- so the first
numbered habit the user adds sorts above every habit they onboarded with.

The assertion is on the SQL the endpoint actually emitted, compiled to the
PRODUCTION dialect, because the test lane is SQLite and SQLite sorts NULLs
FIRST natively: a row-order assertion out of this fixture passes on the broken
code. The behavioural test below is kept only because mutating ``nulls_first``
to ``nulls_last`` turns it red; it cannot see the HEAD defect at all.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.engine import Connection
from sqlalchemy.engine.interfaces import Dialect
from sqlalchemy.engine.url import make_url
from sqlalchemy.sql import ClauseElement, Select

from conftest import test_engine
from tests.test_habits_api import sample_payload

# The dialect production actually runs, resolved through the same registry a
# real ``postgresql+asyncpg://`` URL goes through. Rendering the captured
# clause with it is the whole point: the lane is SQLite, whose NULL ordering
# is the opposite of PostgreSQL's, so only the emitted SQL can tell the fix
# from the defect.
_PRODUCTION_DIALECT: Dialect = make_url("postgresql+asyncpg://").get_dialect()()


@contextmanager
def _record_habit_list_order_by() -> Iterator[list[str]]:
    """Collect the ORDER BY of every habit SELECT, rendered for PostgreSQL."""
    clauses: list[str] = []

    def _before_execute(
        _conn: Connection,
        clause: ClauseElement,
        _multiparams: object,
        _params: object,
        _execution_options: object,
    ) -> None:
        if not isinstance(clause, Select):
            return
        compiled = str(clause.compile(dialect=_PRODUCTION_DIALECT))
        if "FROM habit" not in compiled or "ORDER BY" not in compiled:
            return
        order_by = compiled.split("ORDER BY", 1)[1].split("LIMIT", 1)[0].strip()
        if "habit.sort_order" in order_by:
            clauses.append(order_by)

    sync_engine = test_engine.sync_engine
    event.listen(sync_engine, "before_execute", _before_execute)
    try:
        yield clauses
    finally:
        event.remove(sync_engine, "before_execute", _before_execute)


async def _signup(client: AsyncClient, username: str = "orderer") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


@pytest.mark.asyncio
async def test_list_habits_order_by_is_total(async_client: AsyncClient) -> None:
    """The emitted ORDER BY places NULLs first and breaks ties on ``id``."""
    headers = await _signup(async_client)
    await async_client.post("/habits/", json=sample_payload(name="A"), headers=headers)
    with _record_habit_list_order_by() as clauses:
        resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert clauses, "no habit SELECT ordered by sort_order was executed"
    assert clauses == ["habit.sort_order ASC NULLS FIRST, habit.id ASC"], clauses


@pytest.mark.asyncio
async def test_legacy_null_rows_precede_numbered_rows(async_client: AsyncClient) -> None:
    """Unnumbered legacy rows keep the head position a later numbered add cannot take."""
    headers = await _signup(async_client, "legacy")
    for name in ("Alpha", "Bravo", "Charlie"):
        created = await async_client.post(
            "/habits/", json=sample_payload(name=name, sort_order=None), headers=headers
        )
        assert created.status_code == HTTPStatus.OK, created.text
    numbered = await async_client.post(
        "/habits/", json=sample_payload(name="Numbered", sort_order=0), headers=headers
    )
    assert numbered.status_code == HTTPStatus.OK, numbered.text
    resp = await async_client.get("/habits/", headers=headers)
    body = resp.json()
    assert [h["name"] for h in body] == ["Alpha", "Bravo", "Charlie", "Numbered"]
    assert [h["sort_order"] for h in body] == [None, None, None, 0]
