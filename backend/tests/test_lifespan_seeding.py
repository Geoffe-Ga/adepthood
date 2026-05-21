"""Tests for the FastAPI lifespan seeder hook.

The seeder integration is opt-out via ``SKIP_STARTUP_SEED=1`` so the test
suite (which mounts a fresh in-memory SQLite per test) can avoid the
overhead and per-test row noise.  Production / dev / staging boot through
the seeders, idempotently, every time the app starts.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

# Direct import rather than a fixture: the lifespan patch needs the engine
# object itself (so it can wire a session factory at it), not a per-test
# session yielded from a fixture.
from conftest import test_engine
from content_config import STAGE_PLANS
from main import _seed_startup_data, app, lifespan
from models.course_stage import CourseStage
from models.practice import Practice
from models.stage_content import StageContent
from seed_practices import PRESET_PRACTICES

#: Total preset rows the practice seeder inserts — sourced from
#: ``PRESET_PRACTICES`` so adding a catalog preset doesn't silently drift
#: this test's expectation.
_EXPECTED_PRACTICE_COUNT = len(PRESET_PRACTICES)


@asynccontextmanager
async def _isolated_factory_patch() -> AsyncGenerator[None, None]:
    """Redirect ``main.async_session_factory`` at the conftest's SQLite engine.

    The production factory is wired to ``DATABASE_URL`` (Postgres) at module
    import time; tests need the lifespan body to see a SQLite session it can
    actually open instead of failing on a refused TCP connect. Borrows the
    in-memory engine that ``conftest`` already sets up (schema created, ARRAY
    columns swapped to JSON, functional unique indexes installed).
    """
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with patch("main.async_session_factory", new=factory):
        yield


@pytest.mark.asyncio
async def test_seed_startup_data_inserts_stages_practices_and_content(
    db_session: AsyncSession,
) -> None:
    """Happy path: fresh DB ends with all three seeders' rows present after one call."""
    await _seed_startup_data(db_session)

    stages = (await db_session.execute(select(CourseStage))).scalars().all()
    practices = (await db_session.execute(select(Practice))).scalars().all()
    contents = (await db_session.execute(select(StageContent))).scalars().all()

    assert len(stages) == 10
    assert len(practices) == _EXPECTED_PRACTICE_COUNT
    # ``seed_content`` seeds the chapters configured for the beige stage
    # (14 today) plus the 6 placeholder rows that still cover stages 2
    # and 3.  Asserting the count means a regression that drops the
    # content seeder from the lifespan fails this test, not just a
    # /course smoke check.  Adjust this when ``content_config`` changes.
    expected_content_count = sum(p.chapter_count for p in STAGE_PLANS) + 6
    assert len(contents) == expected_content_count


@pytest.mark.asyncio
async def test_seed_startup_data_is_idempotent(
    db_session: AsyncSession,
) -> None:
    """Running the seeder twice does not duplicate rows."""
    await _seed_startup_data(db_session)
    await _seed_startup_data(db_session)

    stages = (await db_session.execute(select(CourseStage))).scalars().all()
    practices = (await db_session.execute(select(Practice))).scalars().all()

    assert len(stages) == 10
    assert len(practices) == _EXPECTED_PRACTICE_COUNT


@pytest.mark.asyncio
async def test_lifespan_skips_seeding_when_env_flag_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``SKIP_STARTUP_SEED=1`` (used by the test suite) prevents seeder invocation."""
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    with patch("main._seed_startup_data", new=AsyncMock()) as seed_mock:
        async with _isolated_factory_patch(), lifespan(app):
            pass
        seed_mock.assert_not_called()


@pytest.mark.asyncio
async def test_lifespan_invokes_seed_when_env_flag_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without the opt-out, the lifespan hands the seeder a real session."""
    monkeypatch.delenv("SKIP_STARTUP_SEED", raising=False)
    with patch("main._seed_startup_data", new=AsyncMock()) as seed_mock:
        async with _isolated_factory_patch(), lifespan(app):
            pass
        seed_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_lifespan_logs_and_continues_when_seeder_raises(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A seeder failure must not prevent app startup; the error is logged."""
    monkeypatch.delenv("SKIP_STARTUP_SEED", raising=False)

    async def _boom(_session: AsyncSession) -> None:
        raise RuntimeError("table 'practice' does not exist")

    caplog.set_level(logging.WARNING, logger="main")
    with patch("main._seed_startup_data", new=_boom):
        # The lifespan must enter and exit cleanly; absence of an exception
        # here is the assertion that startup was not blocked.
        async with _isolated_factory_patch(), lifespan(app):
            pass

    seed_error = [r for r in caplog.records if "startup seed" in r.getMessage().lower()]
    assert seed_error, "expected a logged warning about the seed failure"


@pytest.mark.asyncio
async def test_seed_startup_data_runs_stages_before_practices(
    db_session: AsyncSession,
) -> None:
    """Pin the stages → practices → content seeder ordering."""
    call_log: list[str] = []

    async def _track_stages(_session: AsyncSession) -> int:
        call_log.append("stages")
        return 0

    async def _track_practices(_session: AsyncSession) -> int:
        call_log.append("practices")
        return 0

    async def _track_content(_session: AsyncSession) -> int:
        call_log.append("content")
        return 0

    with (
        patch("main.seed_stages", new=_track_stages),
        patch("main.seed_practices", new=_track_practices),
        patch("main.seed_content", new=_track_content),
    ):
        await _seed_startup_data(db_session)

    assert call_log == ["stages", "practices", "content"]
