"""The production identity bootstrap, driven against the real application.

Everything else in this package proves the harness grades correctly. This module
proves the one step none of it can: that the two identities the matrix rests on
are real, separate, working accounts of *this* application -- inserted through
its own ORM and logged in over its own ``POST /auth/login``.

The stakes are asymmetric. If the bootstrap silently misbehaves, every request
the matrix sends is answered 401, no cross-user access is ever observed, and the
check goes vacuous while looking healthy. So the assertions here are the two that
cannot be satisfied by a bootstrap that merely returned something: each token has
to work on a genuinely authenticated route, and the two identities have to be
distinct actors -- one's habit must be invisible to the other. Two tokens for the
same user would make every "denied" in the matrix meaningless.

The application runs in-process over ``ASGITransport`` against a throwaway
file-backed SQLite database, which is what lets ``_insert_users`` be handed a
real database URL of its own -- the same shape the production run passes.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

from conftest import _replace_array_columns
from database import get_session
from main import app
from scripts.dast.authz_matrix import _bootstrap_identities
from scripts.dast.runner import Identity

HABITS_PATH = "/habits/"

# The minimum a habit needs; the matrix's own seed registry sends the same shape.
HABIT_BODY: dict[str, object] = {
    "name": "bootstrap probe habit",
    "icon": "star",
    "start_date": "2024-01-01",
    "energy_cost": 1,
    "energy_return": 2,
}


@dataclass(frozen=True)
class BootstrapTarget:
    """An in-process application together with the database URL it is serving from."""

    client: AsyncClient
    database_url: str


def authorized(identity: Identity) -> dict[str, str]:
    """Return the header one identity sends."""
    return {"Authorization": f"Bearer {identity.token}"}


@pytest_asyncio.fixture
async def bootstrap_target(tmp_path: Path) -> AsyncIterator[BootstrapTarget]:
    """Serve the real application from a throwaway file-backed database.

    File-backed rather than in-memory because the bootstrap opens its own engine
    against the URL it is handed, exactly as it does in production; two engines
    onto ``:memory:`` would see two different databases and the login would 401
    for reasons that have nothing to do with the code under test.
    """
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'dast-bootstrap.db'}"
    engine = create_async_engine(database_url)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    _replace_array_columns()
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    async def _per_request_session() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = _per_request_session
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield BootstrapTarget(client=client, database_url=database_url)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.asyncio
async def test_the_bootstrap_mints_two_tokens_that_actually_authenticate(
    bootstrap_target: BootstrapTarget,
) -> None:
    """A token that does not work turns every later denial into a false pass."""
    owner, intruder = await _bootstrap_identities(
        bootstrap_target.client,
        database_url=bootstrap_target.database_url,
    )

    # The report names actors by label, so the order they come back in is contractual.
    assert (owner.label, intruder.label) == ("A", "B")
    for identity in (owner, intruder):
        response = await bootstrap_target.client.get(HABITS_PATH, headers=authorized(identity))
        assert response.status_code == HTTPStatus.OK, (
            f"identity {identity.label} could not use its own token: {response.text}"
        )


@pytest.mark.asyncio
async def test_the_bootstrap_creates_two_genuinely_separate_actors(
    bootstrap_target: BootstrapTarget,
) -> None:
    """The whole matrix rests on this: A's object must be somebody else's object to B.

    Distinct emails and distinct token strings would both be satisfied by two
    logins as the same user, so the proof is behavioural -- the habit A creates
    is not in B's listing.
    """
    owner, intruder = await _bootstrap_identities(
        bootstrap_target.client,
        database_url=bootstrap_target.database_url,
    )
    assert owner.email != intruder.email

    created = await bootstrap_target.client.post(
        HABITS_PATH,
        json=HABIT_BODY,
        headers=authorized(owner),
    )
    assert created.status_code == HTTPStatus.OK, created.text

    owned = await bootstrap_target.client.get(HABITS_PATH, headers=authorized(owner))
    intruders = await bootstrap_target.client.get(HABITS_PATH, headers=authorized(intruder))

    assert [habit["id"] for habit in owned.json()] == [created.json()["id"]]
    assert intruders.json() == [], "the two identities are the same user"
