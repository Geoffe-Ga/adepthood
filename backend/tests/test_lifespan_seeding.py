"""Tests for the FastAPI lifespan seeder hook.

The seeder integration is opt-out via ``SKIP_STARTUP_SEED=1`` so the test
suite (which mounts a fresh in-memory SQLite per test) can avoid the
overhead and per-test row noise.  Production / dev / staging boot through
the seeders, idempotently, every time the app starts.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

# Direct import rather than a fixture: the lifespan patch needs the engine
# object itself (so it can wire a session factory at it), not a per-test
# session yielded from a fixture.
from conftest import test_engine
from main import _log_botmason_provider, _log_content_status, _seed_startup_data, app, lifespan
from models.course_stage import CourseStage
from models.practice import Practice
from models.stage_content import StageContent
from observability import remove_app_log_handlers_for_tests
from seed_content import desired_content_records
from seed_practices import PRESET_PRACTICES
from services.content_repository import reset_content_repository_for_tests

#: Total preset rows the practice seeder inserts — sourced from
#: ``PRESET_PRACTICES`` so adding a catalog preset doesn't silently drift
#: this test's expectation.
_EXPECTED_PRACTICE_COUNT = len(PRESET_PRACTICES)


def _expected_content_count() -> int:
    """Rows the content seeder should produce in this environment.

    Sourced from ``desired_content_records()`` — the vendored manifest's
    chapters plus site resources, which are present in the test environment.
    Computed at call time because the manifest is runtime data.
    """
    return len(desired_content_records())


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
    assert len(contents) == _expected_content_count()
    assert len(contents) > 0, "content seeder must produce rows from the vendored manifest"


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
async def test_seed_startup_data_continues_after_per_seeder_failure(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A failing seeder must not starve the later, independent seeders.

    Without isolation a ``seed_practices`` blow-up (e.g. a new mode lands
    in a CHECK constraint before the seed list catches up) would skip
    ``seed_content`` and leave stage 1 with zero chapter rows — exactly
    the production symptom that motivated the per-seeder try/except.
    """

    async def _boom(_session: AsyncSession) -> int:
        msg = "practice CHECK constraint mismatch"
        raise RuntimeError(msg)

    caplog.set_level(logging.WARNING, logger="main")
    with patch("main.seed_practices", new=_boom):
        await _seed_startup_data(db_session)

    stages = (await db_session.execute(select(CourseStage))).scalars().all()
    contents = (await db_session.execute(select(StageContent))).scalars().all()
    assert len(stages) == 10
    assert len(contents) == _expected_content_count()

    failure_logs = [r for r in caplog.records if "seed_failed" in r.getMessage()]
    assert failure_logs, "expected a logged failure for the practices seeder"
    assert any(getattr(r, "seeder", None) == "practices" for r in failure_logs), (
        "expected the seed_failed log record to carry extra={'seeder': 'practices'}"
    )


@pytest.mark.asyncio
async def test_seed_startup_data_skips_dependents_when_stages_fails(
    db_session: AsyncSession,
) -> None:
    """``seed_practices`` and ``seed_content`` both read from ``CourseStage`` rows.

    If ``seed_stages`` fails, running the dependent seeders against an
    empty stages table would quietly insert nothing and log a misleading
    ``seed_complete inserted=0`` — masking the real failure.  The seeder
    must short-circuit instead.
    """
    calls: list[str] = []

    async def _boom(_session: AsyncSession) -> int:
        msg = "stages table missing"
        raise RuntimeError(msg)

    async def _track_practices(_session: AsyncSession) -> int:
        calls.append("practices")
        return 0

    async def _track_content(_session: AsyncSession) -> int:
        calls.append("content")
        return 0

    with (
        patch("main.seed_stages", new=_boom),
        patch("main.seed_practices", new=_track_practices),
        patch("main.seed_content", new=_track_content),
    ):
        await _seed_startup_data(db_session)

    assert calls == [], f"dependent seeders must not run when stages fails: {calls}"


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


def test_content_status_logs_error_when_nothing_vendored(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Issue #397: a content-less deploy is loud at boot, not at first open."""
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("CONTENT_DIR", str(empty))
    reset_content_repository_for_tests()
    caplog.set_level(logging.ERROR, logger="main")
    try:
        _log_content_status()
    finally:
        reset_content_repository_for_tests()
    assert any("content_missing_or_invalid" in r.getMessage() for r in caplog.records)


def test_content_status_logs_pin_when_content_vendored(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    root = tmp_path / "content"
    root.mkdir()
    (root / "manifest.json").write_text(
        json.dumps({"schema_version": "1.0.0", "chapters": [], "site_resources": []})
    )
    (root / "CONTENT_VERSION").write_text(
        "sha: " + "c" * 40 + "\nsynced_at: 2026-06-10T00:00:00+00:00\ndigest: sha256:x\n"
    )
    monkeypatch.setenv("CONTENT_DIR", str(root))
    reset_content_repository_for_tests()
    caplog.set_level(logging.INFO, logger="main")
    try:
        _log_content_status()
    finally:
        reset_content_repository_for_tests()
    loaded = [r.getMessage() for r in caplog.records if "content_loaded" in r.getMessage()]
    assert loaded
    assert "c" * 40 in loaded[0]
    assert "chapters=0" in loaded[0]


def test_botmason_provider_logged_at_boot(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Issue #402: the active LLM provider is observable at startup."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("ENV", "development")
    caplog.set_level(logging.INFO, logger="main")
    _log_botmason_provider()
    messages = [r.getMessage() for r in caplog.records]
    assert any("botmason_provider" in m and "openai" in m for m in messages)


def test_stub_in_production_warns_loudly(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Stub in production must be an explicit, visible choice — never silent."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.setenv("ENV", "production")
    caplog.set_level(logging.WARNING, logger="main")
    _log_botmason_provider()
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("botmason_stub_in_production" in r.getMessage() for r in warnings)


def test_stub_in_development_does_not_warn(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.setenv("ENV", "development")
    caplog.set_level(logging.INFO, logger="main")
    _log_botmason_provider()
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert warnings == []


@pytest.mark.asyncio
async def test_seed_complete_logs_carry_seeder_name_and_count(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Success logs must be verifiable from the boot log text alone.

    ``extra={...}`` fields don't render through a plain formatter, so a
    bare ``seed_complete`` message is indistinguishable from another
    seeder's — the deploy-verification contract in docs/content.md needs
    the seeder name and inserted count in the message itself.
    """
    caplog.set_level(logging.INFO, logger="main")
    await _seed_startup_data(db_session)

    messages = [r.getMessage() for r in caplog.records if "seed_complete" in r.getMessage()]
    assert any("seeder=stages" in m and "inserted=10" in m for m in messages), messages
    assert any("seeder=content" in m for m in messages), messages


@pytest.mark.asyncio
async def test_lifespan_configures_app_logging(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Boot must leave the root logger with a real handler.

    Uvicorn only configures its own ``uvicorn.*`` loggers; without this,
    every app INFO record (seed results, content pin, access log) is
    silently dropped in production and deploys cannot be verified.
    """
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    remove_app_log_handlers_for_tests()
    try:
        async with _isolated_factory_patch(), lifespan(app):
            pass
        handlers = [
            h for h in logging.getLogger().handlers if getattr(h, "_adepthood_app_handler", False)
        ]
        assert handlers, "lifespan must install the app log handler"
    finally:
        remove_app_log_handlers_for_tests()
