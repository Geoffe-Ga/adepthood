"""``POST /journal/`` under an ``Idempotency-Key``: a retried write is one entry (#2936).

The client cannot tell a create that never arrived from one whose answer was
lost on the way back, so it retries both the same way. Without a key the
second attempt is a second entry, and the writer finds their page twice. With
one, the server answers the retry from the row it already stored.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from main import app
from models.journal_entry import JournalEntry
from routers import journal as journal_router
from security.idempotency import IDEMPOTENCY_KEY_MAX_LENGTH, hash_idem_key

_IDEMPOTENCY_HEADER = "Idempotency-Key"
_A_KEY = "journal-create-1"
_ANOTHER_KEY = "journal-create-2"
_CREATED_EVENT = "journal_entry_created"
_SCOPED = {
    "message": "Week one, closed.",
    "reflection_level": "week",
    "reflection_scope_key": "c1:w1",
    "tag": "hierarchical_reflection",
}


def _payload(**overrides: object) -> dict[str, object]:
    """A valid create body."""
    payload: dict[str, object] = {"message": "Today I meditated for 20 minutes."}
    payload.update(overrides)
    return payload


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create an account and return ``(auth headers, user id)``."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


async def _entry_count(session: AsyncSession, user_id: int) -> int:
    """Every journal row the account holds, live or soft-deleted."""
    result = await session.execute(
        select(func.count()).select_from(JournalEntry).where(col(JournalEntry.user_id) == user_id)
    )
    return int(result.scalar_one())


@pytest.mark.asyncio
async def test_a_create_replayed_under_its_key_after_a_lost_response_persists_one_entry(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The first answer is discarded, as a dropped connection would; the retry finds it."""
    auth, user_id = await _signup(async_client, "journal_replay")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}

    first = await async_client.post("/journal/", json=_payload(), headers=headers)
    second = await async_client.post("/journal/", json=_payload(), headers=headers)

    assert first.status_code == HTTPStatus.CREATED
    assert second.status_code == HTTPStatus.CREATED
    assert second.json()["id"] == first.json()["id"]
    assert await _entry_count(db_session, user_id) == 1


async def _stored(session: AsyncSession, user_id: int) -> list[JournalEntry]:
    """The account's journal rows, oldest first."""
    result = await session.execute(
        select(JournalEntry)
        .where(col(JournalEntry.user_id) == user_id)
        .order_by(col(JournalEntry.id))
    )
    return list(result.scalars().all())


def _always_miss(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the pre-insert replay read find nothing, as a racing twin would see it.

    The second request then reaches the insert and collides on the key index,
    which is the only way to reach the ``IntegrityError`` recovery without
    depending on how two real requests happen to interleave.
    """

    async def _miss(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(journal_router, "_replay_hit", _miss)


def _count_calls(monkeypatch: pytest.MonkeyPatch, name: str) -> list[object]:
    """Wrap ``journal_router.<name>`` so every await is recorded, then delegated."""
    real: Callable[..., Awaitable[object]] = getattr(journal_router, name)
    calls: list[object] = []

    async def _counting(*args: object, **kwargs: object) -> object:
        calls.append(args)
        return await real(*args, **kwargs)

    monkeypatch.setattr(journal_router, name, _counting)
    return calls


# ── A replay is read-only ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_replay_inserts_nothing_writes_nothing_outward_and_logs_one_creation(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The retry is answered from the stored row: no insert, no vault, no corpus, one event.

    The response cannot distinguish a replay from a collision recovered after an
    insert, so the side effects are what pin it. A replay that reached the vault
    write would hand the same writing to Creek twice.
    """
    auth, user_id = await _signup(async_client, "journal_quiet_replay")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    inserts = _count_calls(monkeypatch, "_commit_new_entry")
    vault = _count_calls(monkeypatch, "_record_vault_outcome")
    corpus = _count_calls(monkeypatch, "_record_corpus_fragment")

    with caplog.at_level(logging.INFO):
        first = await async_client.post("/journal/", json=_payload(), headers=headers)
        second = await async_client.post("/journal/", json=_payload(), headers=headers)

    assert second.status_code == HTTPStatus.CREATED
    assert second.json() == first.json()
    assert (len(inserts), len(vault), len(corpus)) == (1, 1, 1)
    created = [r for r in caplog.records if r.message == _CREATED_EVENT]
    assert [r.__dict__["entry_id"] for r in created] == [first.json()["id"]]
    assert await _entry_count(db_session, user_id) == 1


@pytest.mark.asyncio
async def test_a_replay_answers_with_the_stored_text_not_the_retried_text(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A retry carrying newer words gets the row as first written; the client PATCHes the rest.

    The body is deliberately not compared (the feedback precedent): refusing
    the retry would strand a writer whose first attempt did land. What the
    server must not do is pretend the newer text was saved.
    """
    auth, user_id = await _signup(async_client, "journal_replay_drift")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}

    await async_client.post("/journal/", json=_payload(message="First words."), headers=headers)
    second = await async_client.post(
        "/journal/", json=_payload(message="First words, and more."), headers=headers
    )

    assert second.json()["message"] == "First words."
    assert [row.message for row in await _stored(db_session, user_id)] == ["First words."]


# ── The IntegrityError recovery ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_retry_that_misses_the_replay_read_resolves_through_the_key_index(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A twin that loses the insert is handed the winner's row and runs none of its side effects."""
    auth, user_id = await _signup(async_client, "journal_recovery")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    first = await async_client.post("/journal/", json=_payload(), headers=headers)
    _always_miss(monkeypatch)
    vault = _count_calls(monkeypatch, "_record_vault_outcome")
    # Only the retry's records: the first create's own event is not under test.
    caplog.clear()

    with caplog.at_level(logging.INFO):
        second = await async_client.post("/journal/", json=_payload(), headers=headers)

    assert second.status_code == HTTPStatus.CREATED
    assert second.json()["id"] == first.json()["id"]
    assert vault == []
    assert [r for r in caplog.records if r.message == _CREATED_EVENT] == []
    assert await _entry_count(db_session, user_id) == 1


@pytest.mark.asyncio
async def test_two_concurrent_creates_under_one_key_write_one_entry(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The database serialises the race; both callers are handed the one entry."""
    auth, user_id = await _signup(concurrent_async_client, "journal_race")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}

    first, second = await asyncio.gather(
        concurrent_async_client.post("/journal/", json=_payload(), headers=headers),
        concurrent_async_client.post("/journal/", json=_payload(), headers=headers),
    )

    assert first.status_code == HTTPStatus.CREATED
    assert second.status_code == HTTPStatus.CREATED
    assert first.json()["id"] == second.json()["id"]
    async with concurrent_session_factory() as session:
        assert await _entry_count(session, user_id) == 1


# ── Scoped reflections ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_keyed_replay_of_a_scoped_reflection_returns_it_rather_than_a_409(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The scope is taken by the writer's own first attempt, which is not a conflict."""
    auth, user_id = await _signup(async_client, "journal_scope_replay")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}

    first = await async_client.post("/journal/", json=_SCOPED, headers=headers)
    second = await async_client.post("/journal/", json=_SCOPED, headers=headers)

    assert second.status_code == HTTPStatus.CREATED
    assert second.json()["id"] == first.json()["id"]
    assert await _entry_count(db_session, user_id) == 1


@pytest.mark.asyncio
async def test_a_scoped_retry_that_misses_the_replay_read_is_not_reported_as_scope_taken(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A retried scoped write collides on both indexes; the key is checked first."""
    auth, user_id = await _signup(async_client, "journal_scope_recovery")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    first = await async_client.post("/journal/", json=_SCOPED, headers=headers)
    _always_miss(monkeypatch)

    second = await async_client.post("/journal/", json=_SCOPED, headers=headers)

    assert second.status_code == HTTPStatus.CREATED
    assert second.json()["id"] == first.json()["id"]
    assert await _entry_count(db_session, user_id) == 1


@pytest.mark.asyncio
async def test_a_different_key_for_a_taken_scope_is_still_a_409(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A second key is a second write, and the scope holds one live entry."""
    auth, user_id = await _signup(async_client, "journal_scope_other_key")

    keyed = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    await async_client.post("/journal/", json=_SCOPED, headers=keyed)
    second = await async_client.post(
        "/journal/", json=_SCOPED, headers={**auth, _IDEMPOTENCY_HEADER: _ANOTHER_KEY}
    )

    assert second.status_code == HTTPStatus.CONFLICT
    assert second.json()["detail"] == "reflection_scope_taken"
    assert await _entry_count(db_session, user_id) == 1


# ── Unkeyed writes are never collapsed ─────────────────────────────────────


@pytest.mark.asyncio
async def test_unkeyed_creates_are_each_a_new_entry_even_beside_a_keyed_one(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No header, no replay: reading an absent key would match every ``idem_key IS NULL`` row."""
    auth, user_id = await _signup(async_client, "journal_unkeyed")
    keyed = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    await async_client.post("/journal/", json=_payload(), headers=keyed)

    ids = [
        (await async_client.post("/journal/", json=_payload(), headers=auth)).json()["id"]
        for _ in range(2)
    ]

    assert len(set(ids)) == len(ids)
    assert await _entry_count(db_session, user_id) == 1 + len(ids)


@pytest.mark.asyncio
async def test_an_unkeyed_scope_collision_never_resolves_to_an_earlier_unkeyed_entry(
    async_client: AsyncClient,
) -> None:
    """The recovery re-read runs only for a presented key, so this stays the scope 409.

    Unguarded, ``idem_key == None`` compiles to ``IS NULL`` and the second write
    would be answered 201 with the first one's id -- its words silently dropped.
    """
    auth, _ = await _signup(async_client, "journal_unkeyed_scope")
    await async_client.post("/journal/", json=_SCOPED, headers=auth)

    second = await async_client.post(
        "/journal/", json={**_SCOPED, "message": "Another take."}, headers=auth
    )

    assert second.status_code == HTTPStatus.CONFLICT
    assert second.json()["detail"] == "reflection_scope_taken"


# ── Storage and bounds ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_stored_key_is_the_shared_digest_never_the_raw_header(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One digest for every idempotent surface, and nothing a dump could replay."""
    auth, user_id = await _signup(async_client, "journal_key_hashed")

    resp = await async_client.post(
        "/journal/", json=_payload(), headers={**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    )

    (row,) = await _stored(db_session, user_id)
    assert row.idem_key == hash_idem_key(user_id, _A_KEY)
    assert row.idem_key != _A_KEY
    assert "idem_key" not in resp.json()


@pytest.mark.asyncio
async def test_an_idempotency_key_past_its_bound_is_rejected_and_persists_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One character over ``IDEMPOTENCY_KEY_MAX_LENGTH`` is a 422, and no row."""
    auth, user_id = await _signup(async_client, "journal_key_too_long")
    headers = {**auth, _IDEMPOTENCY_HEADER: "k" * (IDEMPOTENCY_KEY_MAX_LENGTH + 1)}

    resp = await async_client.post("/journal/", json=_payload(), headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert await _entry_count(db_session, user_id) == 0


@pytest.mark.asyncio
async def test_an_idempotency_key_at_its_bound_is_accepted_and_replays(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Exactly ``IDEMPOTENCY_KEY_MAX_LENGTH`` characters is a key, not a refusal."""
    auth, user_id = await _signup(async_client, "journal_key_at_bound")
    headers = {**auth, _IDEMPOTENCY_HEADER: "k" * IDEMPOTENCY_KEY_MAX_LENGTH}

    first = await async_client.post("/journal/", json=_payload(), headers=headers)
    second = await async_client.post("/journal/", json=_payload(), headers=headers)

    assert first.status_code == HTTPStatus.CREATED
    assert second.json()["id"] == first.json()["id"]
    assert await _entry_count(db_session, user_id) == 1


# ── A deleted entry stays deleted ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_replay_after_the_entry_was_deleted_is_a_404_that_writes_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The key stays spent: no deleted words come back, and none are written again."""
    auth, user_id = await _signup(async_client, "journal_replay_deleted")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    first = await async_client.post("/journal/", json=_payload(), headers=headers)
    await async_client.delete(f"/journal/{first.json()['id']}", headers=auth)

    replay = await async_client.post("/journal/", json=_payload(), headers=headers)

    assert replay.status_code == HTTPStatus.NOT_FOUND
    assert replay.json() == {"detail": "journal_entry_not_found"}
    assert await _entry_count(db_session, user_id) == 1


@pytest.mark.asyncio
async def test_a_recovered_collision_on_a_deleted_entry_is_a_404_too(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The recovery re-read keeps the same rule as the replay read."""
    auth, user_id = await _signup(async_client, "journal_recovery_deleted")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    first = await async_client.post("/journal/", json=_payload(), headers=headers)
    await async_client.delete(f"/journal/{first.json()['id']}", headers=auth)
    _always_miss(monkeypatch)

    replay = await async_client.post("/journal/", json=_payload(), headers=headers)

    assert replay.status_code == HTTPStatus.NOT_FOUND
    assert await _entry_count(db_session, user_id) == 1


# ── Contract ───────────────────────────────────────────────────────────────


def test_the_idempotency_key_is_a_header_parameter_and_not_a_body_field() -> None:
    """Where every other idempotent surface puts it."""
    document = app.openapi()
    operation = document["paths"]["/journal/"]["post"]
    headers = {p["name"] for p in operation.get("parameters", []) if p["in"] == "header"}

    assert _IDEMPOTENCY_HEADER in headers
    schemas = document["components"]["schemas"]
    assert "idempotency_key" not in schemas["JournalMessageCreate"]["properties"]
    assert "idem_key" not in schemas["JournalMessageResponse"]["properties"]
