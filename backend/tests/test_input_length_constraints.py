"""Tests for sec-03: input length constraints on user-facing string fields.

Verifies that oversized payloads are rejected with 422 and that fields
requiring non-empty input reject empty/whitespace-only strings.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from schemas.botmason import CHAT_MESSAGE_MAX_LENGTH
from schemas.journal import JOURNAL_MESSAGE_MAX_LENGTH
from schemas.practice import (
    PRACTICE_DESCRIPTION_MAX_LENGTH,
    PRACTICE_INSTRUCTIONS_MAX_LENGTH,
    PRACTICE_NAME_MAX_LENGTH,
    PRACTICE_REFLECTION_MAX_LENGTH,
)
from schemas.prompt import PROMPT_RESPONSE_MAX_LENGTH


async def _signup(client: AsyncClient, username: str = "alice") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


async def _add_balance(client: AsyncClient, headers: dict[str, str], amount: int = 10) -> None:
    """Add offering credits to the authenticated user."""
    resp = await client.post("/user/balance/add", json={"amount": amount}, headers=headers)
    assert resp.status_code == HTTPStatus.OK


async def _seed_practice_and_select(
    client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
) -> int:
    """Insert a practice, select it for the user, and return user_practice_id."""
    practice = Practice(
        stage_number=1,
        name="Meditation",
        description="Sit quietly",
        instructions="Close your eyes and breathe",
        default_duration_minutes=10,
        approved=True,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)

    resp = await client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    user_practice_id: int = resp.json()["id"]
    return user_practice_id


# ── Journal message length constraints ─────────────────────────────────


@pytest.mark.asyncio
async def test_journal_message_at_max_length(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    message = "a" * JOURNAL_MESSAGE_MAX_LENGTH
    resp = await async_client.post("/journal/", json={"message": message}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["message"] == message


@pytest.mark.asyncio
async def test_journal_message_over_max_length_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    message = "a" * (JOURNAL_MESSAGE_MAX_LENGTH + 1)
    resp = await async_client.post("/journal/", json={"message": message}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── Chat message length constraints ────────────────────────────────────


@pytest.mark.asyncio
async def test_chat_message_at_max_length(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    message = "a" * CHAT_MESSAGE_MAX_LENGTH
    resp = await async_client.post("/journal/chat", json={"message": message}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_chat_message_over_max_length_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    message = "a" * (CHAT_MESSAGE_MAX_LENGTH + 1)
    resp = await async_client.post("/journal/chat", json={"message": message}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_chat_empty_message_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)
    resp = await async_client.post("/journal/chat", json={"message": ""}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── Practice creation length constraints ───────────────────────────────


def _practice_payload(**overrides: object) -> dict[str, object]:
    """Return a valid practice creation payload."""
    payload: dict[str, object] = {
        "stage_number": 1,
        "name": "My Practice",
        "description": "A description",
        "instructions": "Do this",
        "default_duration_minutes": 15,
    }
    payload.update(overrides)
    return payload


@pytest.mark.asyncio
async def test_practice_name_at_max_length(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    payload = _practice_payload(name="a" * PRACTICE_NAME_MAX_LENGTH)
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_practice_name_over_max_length_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    payload = _practice_payload(name="a" * (PRACTICE_NAME_MAX_LENGTH + 1))
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_practice_name_empty_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    payload = _practice_payload(name="")
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_practice_description_over_max_length_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    payload = _practice_payload(description="a" * (PRACTICE_DESCRIPTION_MAX_LENGTH + 1))
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_practice_instructions_over_max_length_returns_422(
    async_client: AsyncClient,
) -> None:
    headers = await _signup(async_client)
    payload = _practice_payload(instructions="a" * (PRACTICE_INSTRUCTIONS_MAX_LENGTH + 1))
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── Practice session reflection length constraints ──────────────────────


@pytest.mark.asyncio
async def test_practice_session_reflection_at_max_length(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers = await _signup(async_client)
    user_practice_id = await _seed_practice_and_select(async_client, db_session, headers)
    reflection = "a" * PRACTICE_REFLECTION_MAX_LENGTH
    resp = await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": user_practice_id,
            "duration_minutes": 10.0,
            "reflection": reflection,
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["reflection"] == reflection


@pytest.mark.asyncio
async def test_practice_session_reflection_over_max_length_returns_422(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    headers = await _signup(async_client)
    user_practice_id = await _seed_practice_and_select(async_client, db_session, headers)
    reflection = "a" * (PRACTICE_REFLECTION_MAX_LENGTH + 1)
    resp = await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": user_practice_id,
            "duration_minutes": 10.0,
            "reflection": reflection,
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── Prompt response length constraints ─────────────────────────────────


@pytest.mark.asyncio
async def test_prompt_response_at_max_length(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    response_text = "a" * PROMPT_RESPONSE_MAX_LENGTH
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": response_text},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["response"] == response_text


@pytest.mark.asyncio
async def test_prompt_response_over_max_length_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    response_text = "a" * (PROMPT_RESPONSE_MAX_LENGTH + 1)
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": response_text},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_prompt_response_empty_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": ""},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
