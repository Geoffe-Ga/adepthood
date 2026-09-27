"""``POST /prompts/{week}/respond`` under an ``Idempotency-Key`` (#2936).

Respond could never write a second row: ``uq_promptresponse_user_week`` already
refuses one. Its defect was *misreporting*. When the answer to a successful
respond is lost, the client's retry met that constraint and was told 409
``already_responded``, which the journal screen renders as "this week is
already answered" -- the writer's own words, reported back as somebody else's.
A key lets the server recognise the retry and answer it with the stored
response instead.
"""

from __future__ import annotations

import logging
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from main import app
from models.journal_entry import JournalEntry, JournalTag
from models.prompt_response import PromptResponse
from routers import prompts as prompts_router
from security.idempotency import IDEMPOTENCY_KEY_MAX_LENGTH, hash_idem_key

_IDEMPOTENCY_HEADER = "Idempotency-Key"
_A_KEY = "prompt-respond-1"
_ANOTHER_KEY = "prompt-respond-2"
_SUBMITTED_EVENT = "prompt_response_submitted"
_ANSWER = {"response": "What I noticed this week."}


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


async def _counts(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """``(promptresponse rows, weekly_prompt journal rows)`` for the account."""
    responses = await session.execute(
        select(func.count())
        .select_from(PromptResponse)
        .where(col(PromptResponse.user_id) == user_id)
    )
    mirrors = await session.execute(
        select(func.count())
        .select_from(JournalEntry)
        .where(
            col(JournalEntry.user_id) == user_id,
            col(JournalEntry.tag) == JournalTag.WEEKLY_PROMPT,
        )
    )
    return int(responses.scalar_one()), int(mirrors.scalar_one())


def _always_miss(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the pre-insert replay read find nothing, as a racing twin would see it."""

    async def _miss(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(prompts_router, "_replay_response", _miss)


@pytest.mark.asyncio
async def test_a_respond_replayed_after_a_lost_response_answers_with_the_stored_response(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The writer's own first attempt is not a conflict: 201 and the original detail."""
    auth, user_id = await _signup(async_client, "respond_replay")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}

    first = await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)
    second = await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)

    assert first.status_code == HTTPStatus.CREATED
    assert second.status_code == HTTPStatus.CREATED
    assert second.json() == first.json()
    assert second.json()["has_responded"] is True
    assert second.json()["response"] == _ANSWER["response"]
    assert await _counts(db_session, user_id) == (1, 1)


@pytest.mark.asyncio
async def test_a_replay_answers_with_the_stored_text_not_the_retried_text(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Newer words on the retry are not saved by it; the stored answer is what comes back."""
    auth, user_id = await _signup(async_client, "respond_replay_drift")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}

    await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)
    second = await async_client.post(
        "/prompts/1/respond", json={"response": "Something newer."}, headers=headers
    )

    assert second.json()["response"] == _ANSWER["response"]
    assert await _counts(db_session, user_id) == (1, 1)


@pytest.mark.asyncio
async def test_a_replay_logs_no_second_submission(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """One answer, one ``prompt_response_submitted`` event, however often it is retried."""
    auth, _ = await _signup(async_client, "respond_quiet_replay")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}

    with caplog.at_level(logging.INFO):
        await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)
        await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)

    assert len([r for r in caplog.records if r.message == _SUBMITTED_EVENT]) == 1


@pytest.mark.asyncio
async def test_a_retry_that_misses_the_replay_read_resolves_through_the_key_index(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The losing twin of a race is recognised by its key, not refused as ``already_responded``."""
    auth, user_id = await _signup(async_client, "respond_recovery")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    first = await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)
    _always_miss(monkeypatch)
    # Only the retry's records: the first answer's own event is not under test.
    caplog.clear()

    with caplog.at_level(logging.INFO):
        second = await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)

    assert second.status_code == HTTPStatus.CREATED
    assert second.json() == first.json()
    assert [r for r in caplog.records if r.message == _SUBMITTED_EVENT] == []
    assert await _counts(db_session, user_id) == (1, 1)


@pytest.mark.parametrize("second_key", [None, _ANOTHER_KEY])
@pytest.mark.asyncio
async def test_an_unkeyed_or_differently_keyed_second_respond_is_still_a_409(
    async_client: AsyncClient, db_session: AsyncSession, second_key: str | None
) -> None:
    """Only the same key is the same act; anything else is a second answer, and refused."""
    auth, user_id = await _signup(async_client, f"respond_second_{second_key or 'unkeyed'}")
    await async_client.post(
        "/prompts/1/respond", json=_ANSWER, headers={**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    )
    headers = auth if second_key is None else {**auth, _IDEMPOTENCY_HEADER: second_key}

    second = await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)

    assert second.status_code == HTTPStatus.CONFLICT
    assert second.json()["detail"] == "already_responded"
    assert await _counts(db_session, user_id) == (1, 1)


@pytest.mark.asyncio
async def test_a_different_key_that_misses_the_replay_read_is_still_a_409(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The recovery re-reads the presented key only; a stranger's key finds nothing and 409s."""
    auth, user_id = await _signup(async_client, "respond_recovery_other_key")
    await async_client.post(
        "/prompts/1/respond", json=_ANSWER, headers={**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    )
    _always_miss(monkeypatch)

    second = await async_client.post(
        "/prompts/1/respond", json=_ANSWER, headers={**auth, _IDEMPOTENCY_HEADER: _ANOTHER_KEY}
    )

    assert second.status_code == HTTPStatus.CONFLICT
    assert second.json()["detail"] == "already_responded"
    assert await _counts(db_session, user_id) == (1, 1)


@pytest.mark.asyncio
async def test_a_key_reused_on_another_week_is_refused_and_persists_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A key names one act. Answering week 2 with week 1's detail would be a lie told in a 201."""
    auth, user_id = await _signup(async_client, "respond_key_other_week")
    headers = {**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)

    reused = await async_client.post("/prompts/2/respond", json=_ANSWER, headers=headers)

    assert reused.status_code == HTTPStatus.CONFLICT
    assert reused.json()["detail"] == "idempotency_key_reused"
    assert await _counts(db_session, user_id) == (1, 1)


@pytest.mark.asyncio
async def test_the_stored_key_is_the_shared_digest_and_only_on_the_response(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The dedup lives on ``promptresponse``; the mirrored journal row stays unkeyed."""
    auth, user_id = await _signup(async_client, "respond_key_hashed")

    await async_client.post(
        "/prompts/1/respond", json=_ANSWER, headers={**auth, _IDEMPOTENCY_HEADER: _A_KEY}
    )

    response = (await db_session.execute(select(PromptResponse))).scalars().one()
    mirror = (await db_session.execute(select(JournalEntry))).scalars().one()
    assert response.idem_key == hash_idem_key(user_id, _A_KEY)
    assert mirror.idem_key is None


@pytest.mark.asyncio
async def test_an_idempotency_key_past_its_bound_is_rejected_and_persists_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One character over ``IDEMPOTENCY_KEY_MAX_LENGTH`` is a 422, and no row."""
    auth, user_id = await _signup(async_client, "respond_key_too_long")
    headers = {**auth, _IDEMPOTENCY_HEADER: "k" * (IDEMPOTENCY_KEY_MAX_LENGTH + 1)}

    resp = await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert await _counts(db_session, user_id) == (0, 0)


@pytest.mark.asyncio
async def test_an_idempotency_key_at_its_bound_is_accepted_and_replays(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Exactly ``IDEMPOTENCY_KEY_MAX_LENGTH`` characters is a key, not a refusal."""
    auth, user_id = await _signup(async_client, "respond_key_at_bound")
    headers = {**auth, _IDEMPOTENCY_HEADER: "k" * IDEMPOTENCY_KEY_MAX_LENGTH}

    first = await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)
    second = await async_client.post("/prompts/1/respond", json=_ANSWER, headers=headers)

    assert first.status_code == HTTPStatus.CREATED
    assert second.status_code == HTTPStatus.CREATED
    assert await _counts(db_session, user_id) == (1, 1)


def test_the_idempotency_key_is_a_header_parameter_and_not_a_body_field() -> None:
    """Where every other idempotent surface puts it."""
    document = app.openapi()
    operation = document["paths"]["/prompts/{week_number}/respond"]["post"]
    headers = {p["name"] for p in operation.get("parameters", []) if p["in"] == "header"}

    assert _IDEMPOTENCY_HEADER in headers
    assert "idempotency_key" not in document["components"]["schemas"]["PromptSubmit"]["properties"]
