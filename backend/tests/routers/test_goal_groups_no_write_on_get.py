"""``GET /goal-groups`` must not write (audit §5.3 GET-that-writes).

Template seeding used to run inside the list handler — a SELECT + conditional
INSERT + commit on every read. It now runs at app startup, so the read path is
write-free. These tests pin that: the GET issues zero INSERTs and zero commits,
and the relocated seeder still makes the templates available.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.engine import Connection, ExecutionContext
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlmodel import select

from conftest import test_engine
from models.goal_group import GoalGroup
from routers.goal_groups import SEED_TEMPLATES, seed_goal_group_templates


@contextmanager
def _count_inserts(engine: AsyncEngine) -> Iterator[list[str]]:
    """Yield a list of INSERT statements executed while the context is open."""
    inserts: list[str] = []

    def _before_cursor_execute(
        _conn: Connection,
        _cursor: object,
        statement: str,
        _params: object,
        _context: ExecutionContext,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().upper().startswith("INSERT"):
            inserts.append(statement)

    sync_engine = engine.sync_engine
    event.listen(sync_engine, "before_cursor_execute", _before_cursor_execute)
    try:
        yield inserts
    finally:
        event.remove(sync_engine, "before_cursor_execute", _before_cursor_execute)


async def _signup(client: AsyncClient, username: str = "reader") -> dict[str, str]:
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
async def test_list_goal_groups_get_performs_no_insert_or_commit(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A GET to list_goal_groups issues no INSERT and no commit."""
    headers = await _signup(async_client)

    commits = 0
    real_commit = db_session.commit

    async def _spy_commit() -> None:
        nonlocal commits
        commits += 1
        await real_commit()

    monkeypatch.setattr(db_session, "commit", _spy_commit)

    with _count_inserts(test_engine) as inserts:
        resp = await async_client.get("/goal-groups/", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert inserts == [], f"GET must not INSERT, saw:\n{chr(10).join(inserts)}"
    assert commits == 0


@pytest.mark.asyncio
async def test_seed_templates_available_after_relocated_seeder(
    db_session: AsyncSession,
) -> None:
    """The startup seeder still provisions the built-in templates."""
    inserted = await seed_goal_group_templates(db_session)
    assert inserted == len(SEED_TEMPLATES)

    result = await db_session.execute(
        select(GoalGroup).where(
            GoalGroup.shared_template == True,  # noqa: E712
            GoalGroup.source == "built-in",
        )
    )
    names = {g.name for g in result.scalars().all()}
    assert names == {t["name"] for t in SEED_TEMPLATES}
