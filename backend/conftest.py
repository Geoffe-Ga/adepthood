import os
import sys
from collections.abc import AsyncGenerator, Awaitable, Callable, Generator
from pathlib import Path
from types import SimpleNamespace
from typing import cast

# Set SECRET_KEY for tests before any app modules are imported
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")
# Opt out of the startup seeder for the test suite — fixtures mount a clean
# SQLite per test and the seeders would add 30+ rows of noise to every
# ``async_client`` fixture. Lifespan-seeding behaviour itself is exercised by
# ``tests/test_lifespan_seeding.py``, which sets / unsets this flag locally.
os.environ.setdefault("SKIP_STARTUP_SEED", "1")

# Absolute path to the repo root (directory that contains 'backend')
REPO_ROOT = (Path(__file__).parent / "..").resolve()

# Add backend/src to sys.path — must happen before importing app modules
sys.path.insert(0, str(REPO_ROOT / "backend/src"))

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient, Response  # noqa: E402
from sqlalchemy import JSON, text  # noqa: E402
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY  # noqa: E402
from sqlalchemy.exc import SQLAlchemyError  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncConnection,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlmodel import SQLModel  # noqa: E402

import models as _models  # noqa: E402, F401
import routers.auth as _auth_router  # noqa: E402
from database import get_session  # noqa: E402
from domain.entitlements import AptitudeLicenseCheck, LicenseOutcome  # noqa: E402
from main import app  # noqa: E402
from rate_limit import limiter, reset_invalid_license_attempts  # noqa: E402
from schemas.gumroad import GumroadPurchase  # noqa: E402

# The default signup license gate stubbed into every test that does not opt into
# the real gate (via the ``real_license_gate`` marker). Feature-specific tests in
# ``tests/routers/test_auth_signup_license.py`` and
# ``tests/routers/test_gumroad_sale_dispatch.py`` mark themselves to exercise the
# genuine Gumroad-backed gate; every other test just needs signup to succeed.
_STUB_LICENSE_PRODUCT_ID = "prod_stub_aptitude"
_STUB_LICENSE_SALE_PREFIX = "stub-sale-"

# ---------------------------------------------------------------------------
# Test database: SQLite in-memory (no external services needed)
# ---------------------------------------------------------------------------
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

test_engine = create_async_engine(TEST_DATABASE_URL, echo=False)
test_session_factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


def _replace_array_columns() -> None:
    """Swap PostgreSQL ARRAY columns to JSON for SQLite compatibility."""
    for table in SQLModel.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, PG_ARRAY):
                column.type = JSON()


# Production-only Postgres functional / partial unique indexes that SQLite
# cannot express in the same syntax.  Tests that exercise the
# ``IntegrityError → idempotent / 409`` path must see equivalent
# constraints on the test DB; we install SQLite-compatible variants below
# after ``metadata.create_all``.  Each entry is a ``CREATE UNIQUE INDEX
# IF NOT EXISTS …`` statement; the ``IF NOT EXISTS`` clause keeps the
# helper idempotent across the per-test fixture lifecycle.
# Always-installed functional unique indexes -- mirrored on every test DB
# because the application contract depends on the constraint, not on the
# integration / concurrent paths only.
_SQLITE_ALWAYS_INDEXES: tuple[str, ...] = (
    # habit: one row per (user_id, normalized name) so the duplicate-name
    # TOCTOU in ``create_habit`` is closed at the DB layer.  Mirrors the
    # production migration ``b5c6d7e8f9a0``; SQLite supports
    # ``lower()`` / ``trim()`` in functional indexes natively.
    'CREATE UNIQUE INDEX IF NOT EXISTS "ix_habit_user_lower_name_unique_test" '
    "ON habit (user_id, lower(trim(name)))",
    # practice presets: one preset row per (stage_number, normalized name).
    # Closes the seeder-race duplication noted in PR fixing the
    # 5-4-3-2-1 duplicate. Mirrors production migration ``d2e3f4a5b6c7``;
    # user-submitted practices are exempt via the partial ``WHERE`` clause.
    'CREATE UNIQUE INDEX IF NOT EXISTS "ix_practice_preset_stage_lower_name_unique_test" '
    "ON practice (stage_number, lower(trim(name))) WHERE submitted_by_user_id IS NULL",
    # coursestage: one row per stage_number. Closes the two-worker startup
    # seeder race that duplicated every stage on a fresh database and left
    # the Course screen serving the content-less duplicate ("No Content
    # Yet" with all-200 responses). Mirrors production migration
    # ``e8f9a0b1c2d3``.
    'CREATE UNIQUE INDEX IF NOT EXISTS "ix_coursestage_stage_number_unique_test" '
    "ON coursestage (stage_number)",
    # stagecontent: one ``content://`` reference per stage — the seeder's
    # stable chapter identity. Scoped to the content:// scheme so legacy
    # rows with empty/CMS urls stay unconstrained. Mirrors production
    # migration ``e8f9a0b1c2d3``.
    'CREATE UNIQUE INDEX IF NOT EXISTS "ix_stagecontent_stage_content_ref_unique_test" '
    "ON stagecontent (course_stage_id, url) WHERE url LIKE 'content://%'",
)

# Concurrency-only indexes: the regular ``db_session`` fixture deliberately
# omits these because some streak / aggregation tests insert multiple
# ``GoalCompletion`` rows per (goal, user, day) to exercise the bucketing
# logic, which the production unique-per-day index would (correctly)
# reject.  Concurrency tests opt in to exercise the
# ``IntegrityError -> idempotent`` path.
_SQLITE_CONCURRENT_ONLY_INDEXES: tuple[str, ...] = (
    # goal_completion: one row per (goal, user, user-local calendar day).
    # Production keys uniqueness off the ``local_day`` column the check-in
    # service writes, so the mirror indexes the same column rather than
    # re-deriving a day from ``timestamp``.
    'CREATE UNIQUE INDEX IF NOT EXISTS "ix_goal_completion_unique_per_day_test" '
    "ON goalcompletion (goal_id, user_id, local_day)",
)


async def _install_always_unique_indexes(conn: AsyncConnection) -> None:
    """Add SQLite mirrors for production indexes the application contract relies on."""
    if conn.dialect.name != "sqlite":
        return
    for stmt in _SQLITE_ALWAYS_INDEXES:
        await conn.execute(text(stmt))


async def _install_test_only_unique_indexes(conn: AsyncConnection) -> None:
    """Add concurrency-only indexes for tests that exercise IntegrityError races."""
    if conn.dialect.name != "sqlite":
        return
    for stmt in (*_SQLITE_ALWAYS_INDEXES, *_SQLITE_CONCURRENT_ONLY_INDEXES):
        await conn.execute(text(stmt))


@pytest_asyncio.fixture
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    """Provide a clean async session with all tables created.

    BUG-INFRA-027: schema teardown lives in ``finally`` so tables are dropped
    even when a test raises mid-flight.  Without this, a failing test can
    leave residual rows that pollute the next test in the same engine.

    The test-only unique indexes are intentionally **not** installed here:
    streak / aggregation tests insert multiple ``GoalCompletion`` rows
    per (goal, user, day) to exercise the bucketing logic, which the
    production unique-per-day index would (correctly) reject.  The
    concurrency fixture below opts in because its tests cover the
    DB-level ``IntegrityError`` paths the indexes guard.
    """
    _replace_array_columns()

    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
        await _install_always_unique_indexes(conn)

    try:
        async with test_session_factory() as session:
            yield session
    finally:
        async with test_engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.drop_all)


@pytest_asyncio.fixture
async def async_client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client with database dependency overridden to use test DB.

    BUG-INFRA-026: ``app.dependency_overrides`` is cleared in ``finally`` and
    asserted empty at teardown so a failing test cannot leak its session
    override into subsequent tests in the same process.
    """

    async def _override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session

    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        assert not app.dependency_overrides, "dependency_overrides leaked between tests"


@pytest.fixture(autouse=True)
def _reset_rate_limiter() -> Generator[None, None, None]:
    """Reset both the limiter's storage AND its ``enabled`` flag between tests.

    ``limiter.reset()`` clears the in-memory bucket counts but does NOT
    restore ``limiter.enabled`` -- so a test using the ``disable_rate_limit``
    fixture would leave the limiter off for every subsequent test that
    runs in the same process.  Forcing ``enabled = True`` here makes the
    autouse contract a single source of truth: every test starts with the
    limiter on and storage empty, regardless of what its predecessors did.

    The second-layer invalid-license counter (``rate_limit``'s moving-window
    limiter for signup license failures) is cleared alongside for the same
    reason: its hourly window would otherwise leak 429s across tests.
    """
    limiter.enabled = True
    limiter.reset()
    reset_invalid_license_attempts()
    yield
    limiter.enabled = True
    limiter.reset()
    reset_invalid_license_attempts()


@pytest.fixture(autouse=True)
def _stub_signup_license_gate(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stub the signup license gate open for tests that do not opt into it.

    Account creation now requires a verified Gumroad license, so the dozens of
    suites that create users via ``POST /auth/signup`` would otherwise all fail
    the gate. This autouse fixture replaces ``verify_aptitude_license`` (as the
    auth router looks it up) with a stub that verifies any request, echoing the
    submitted email so the email-match check always passes. Tests carrying the
    ``real_license_gate`` marker are skipped so they exercise the genuine gate.
    """
    if request.node.get_closest_marker("real_license_gate") is not None:
        return

    async def _verify_stub(
        email: str,
        license_key: str | None,  # noqa: ARG001 — stub verifies unconditionally
        *,
        client: object | None = None,  # noqa: ARG001 — matches the real signature
    ) -> AptitudeLicenseCheck:
        purchase = GumroadPurchase(
            email=email,
            product_id=_STUB_LICENSE_PRODUCT_ID,
            sale_id=f"{_STUB_LICENSE_SALE_PREFIX}{email}",
            refunded=False,
        )
        return AptitudeLicenseCheck(LicenseOutcome.VERIFIED, purchase)

    monkeypatch.setattr(_auth_router, "verify_aptitude_license", _verify_stub)


@pytest.fixture
def disable_rate_limit() -> Generator[None, None, None]:
    """Temporarily disable rate limiting for tests that need many requests."""
    limiter.enabled = False
    yield
    limiter.enabled = True


@pytest.fixture
def zero_monthly_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    """Disable the free monthly BotMason allocation for the duration of a test.

    Many legacy tests assert on ``offering_balance`` directly and predate the
    monthly-cap wallet.  Setting ``BOTMASON_MONTHLY_CAP=0`` forces every chat
    request to draw from ``offering_balance``, preserving their original
    intent without duplicating the new cap tests elsewhere.
    """
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "0")


@pytest_asyncio.fixture
async def concurrent_async_client(tmp_path: Path) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client with per-request sessions for concurrency testing.

    Uses a file-based SQLite database so each request gets its own connection,
    enabling meaningful concurrency tests with ``asyncio.gather``.  Tests that
    also need to seed state (e.g. flip ``User.is_admin``) should depend on
    :func:`concurrent_session_factory` to open a session against the same
    engine.
    """
    db_url = f"sqlite+aiosqlite:///{tmp_path / 'concurrent.db'}"
    concurrent_engine = create_async_engine(db_url, echo=False)
    concurrent_factory = async_sessionmaker(
        concurrent_engine, class_=AsyncSession, expire_on_commit=False
    )

    _replace_array_columns()
    async with concurrent_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
        await _install_test_only_unique_indexes(conn)

    async def _per_request_session() -> AsyncGenerator[AsyncSession, None]:
        async with concurrent_factory() as session:
            yield session

    app.dependency_overrides[get_session] = _per_request_session
    app.state.concurrent_session_factory = concurrent_factory
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client

    app.dependency_overrides.clear()
    app.state.concurrent_session_factory = None
    await concurrent_engine.dispose()


@pytest_asyncio.fixture
async def concurrent_session_factory(
    concurrent_async_client: AsyncClient,  # noqa: ARG001 — side-effect: sets up the factory
) -> async_sessionmaker[AsyncSession]:
    """Session maker bound to the :func:`concurrent_async_client` engine.

    Tests that need to seed rows in the concurrency fixture's DB (e.g. promote
    a freshly-signed-up user to admin) should depend on this fixture and open
    a short-lived session via ``async with factory() as session:``.
    """
    factory: async_sessionmaker[AsyncSession] | None = app.state.concurrent_session_factory
    if factory is None:
        msg = "concurrent_async_client must be requested before concurrent_session_factory"
        raise RuntimeError(msg)
    return factory


# ---------------------------------------------------------------------------
# DB-probe failure helpers: drive the /health & /health/ready 503 branch
# deterministically without a live (or broken) database.  The readiness /
# health handlers touch the session only via ``execute(text("SELECT 1"))``, so
# a ``SimpleNamespace`` with a single ``execute`` coroutine is a sufficient,
# dependency-free stand-in.
# ---------------------------------------------------------------------------
def failing_probe_session(execute: Callable[..., Awaitable[object]]) -> AsyncSession:
    """Return a stand-in session whose ``execute`` runs ``execute``."""
    return cast("AsyncSession", SimpleNamespace(execute=execute))


def db_error_session(exc: Exception | None = None) -> AsyncSession:
    """Return a stand-in session whose probe ``execute`` raises ``exc``.

    Defaults to ``SQLAlchemyError`` -- the dropped-connection failure the
    readiness / health 503 branch exists to catch.
    """
    error = exc if exc is not None else SQLAlchemyError("connection refused")

    async def _execute(*_args: object, **_kwargs: object) -> object:
        raise error

    return failing_probe_session(_execute)


async def probe_via_session(path: str, session: AsyncSession) -> Response:
    """GET ``path`` with ``get_session`` overridden to yield ``session``.

    The override is always removed in ``finally`` so a stand-in session cannot
    leak into other tests sharing the process.
    """

    async def _override() -> AsyncGenerator[AsyncSession, None]:
        yield session

    app.dependency_overrides[get_session] = _override
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.get(path)
    finally:
        app.dependency_overrides.pop(get_session, None)
