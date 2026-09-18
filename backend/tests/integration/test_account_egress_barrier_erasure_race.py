"""AC5's 401 where the foreign keys are real.

``create_journal_entry`` commits its row *before* it takes the account barrier,
because the row's id has to exist before the entry serializer can be keyed on
it. On SQLite that commit succeeds whatever happened to the user row, because
the default lane does not enforce foreign keys -- so the shipped unit test
reaches ``ensure_account_live`` and sees its 401, and a plaintext journal row is
left committed for an account whose user row is gone.

On PostgreSQL ``journalentry.user_id`` carries a real ``ON DELETE CASCADE``
foreign key and ``delete_account`` hard-deletes the user, so the same
interleaving makes that commit a foreign-key violation: ``IntegrityError``, and
before this change an HTTP 500 that never reached the liveness refusal at all.
The one acceptance criterion in this lane that names a status code was therefore
only ever true of the database adepthood does not deploy.

The fixture here is a deliberate second one: the package's ``pg_client`` hands
every request the test's own savepoint-joined session, which cannot express two
requests racing. This one gives each request its own session on a real pool, the
way :func:`conftest.concurrent_async_client` does for SQLite, and truncates what
it wrote on the way out.
"""

from __future__ import annotations

import asyncio
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

from database import get_session
from main import app
from routers import journal

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

    from sqlalchemy.ext.asyncio import AsyncEngine

pytestmark = pytest.mark.integration

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret
_EMAIL = "pg_erasure_race@example.com"
_SETTLE_TIMEOUT_SECONDS = 20.0


@pytest_asyncio.fixture
async def pg_concurrent_client(pg_database_url: str) -> AsyncGenerator[AsyncClient, None]:
    """A client whose requests each get their own Postgres session.

    Every table is truncated on the way out rather than rolled back, because
    rolling back is exactly the thing this fixture cannot do: the requests under
    test must really commit, or the foreign key this test exists for never
    fires.
    """
    engine: AsyncEngine = create_async_engine(pg_database_url)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _per_request_session() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = _per_request_session
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        await _truncate_everything(engine)
        await engine.dispose()


async def _truncate_everything(engine: AsyncEngine) -> None:
    """Empty every mapped table, so the next test in this database starts clean."""
    names = ", ".join(f'"{table.name}"' for table in SQLModel.metadata.sorted_tables)
    async with engine.begin() as connection:
        await connection.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))


@pytest.mark.asyncio
async def test_a_write_racing_its_own_erasure_answers_401_on_postgres(
    pg_concurrent_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The refusal is a refusal, not a foreign-key violation wearing a 500."""
    entered = asyncio.Event()
    release = asyncio.Event()

    async def _pause_before_the_insert(*_args: object, **_kwargs: object) -> None:
        """Hold the write between authentication and the row it is about to commit."""
        entered.set()
        await release.wait()

    monkeypatch.setattr(journal, "_authorize_practice_links", _pause_before_the_insert)
    signed_up = await pg_concurrent_client.post(
        "/auth/signup", json={"email": _EMAIL, "password": _SIGNUP_PASSWORD}
    )
    assert signed_up.status_code == HTTPStatus.OK
    headers = {"Authorization": f"Bearer {signed_up.json()['token']}"}

    writing = asyncio.create_task(
        pg_concurrent_client.post(
            "/journal/",
            json={"message": "Written into a vanishing account.", "classification": "personal"},
            headers=headers,
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=_SETTLE_TIMEOUT_SECONDS)
    deleted = await pg_concurrent_client.request(
        "DELETE", "/users/me", json={"confirm_email": _EMAIL}, headers=headers
    )
    assert deleted.status_code == HTTPStatus.OK
    release.set()
    written = await asyncio.wait_for(writing, timeout=_SETTLE_TIMEOUT_SECONDS)

    assert written.status_code == HTTPStatus.UNAUTHORIZED
    assert written.json()["detail"] == "unauthorized"
