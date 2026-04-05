"""Tests for the BotMason AI chat API — metered AI conversations."""

from __future__ import annotations

import pathlib
from http import HTTPStatus

import pytest
from httpx import AsyncClient

from services.botmason import generate_response, get_system_prompt


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


# ── Authentication ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chat_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/journal/chat", json={"message": "Hello"})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_balance_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/user/balance")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_add_balance_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/user/balance/add", json={"amount": 5})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Offering balance ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_balance_default_zero(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/user/balance", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["balance"] == 0


@pytest.mark.asyncio
async def test_add_balance(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post("/user/balance/add", json={"amount": 5}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["balance"] == 5  # noqa: PLR2004
    assert data["added"] == 5  # noqa: PLR2004


@pytest.mark.asyncio
async def test_add_balance_accumulates(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=3)
    await _add_balance(async_client, headers, amount=7)

    resp = await async_client.get("/user/balance", headers=headers)
    assert resp.json()["balance"] == 10  # noqa: PLR2004


@pytest.mark.asyncio
async def test_add_balance_rejects_zero_amount(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post("/user/balance/add", json={"amount": 0}, headers=headers)
    assert resp.status_code == HTTPStatus.BAD_REQUEST


@pytest.mark.asyncio
async def test_add_balance_rejects_negative_amount(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post("/user/balance/add", json={"amount": -5}, headers=headers)
    assert resp.status_code == HTTPStatus.BAD_REQUEST


# ── Chat with BotMason ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chat_with_zero_balance_returns_402(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/chat", json={"message": "Hello BotMason"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert resp.json()["detail"] == "insufficient_offerings"


@pytest.mark.asyncio
async def test_chat_success(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=5)

    resp = await async_client.post(
        "/journal/chat", json={"message": "Hello BotMason"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert "response" in data
    assert len(data["response"]) > 0
    assert data["remaining_balance"] == 4  # noqa: PLR2004
    assert data["bot_entry_id"] is not None


@pytest.mark.asyncio
async def test_chat_deducts_balance(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=3)

    await async_client.post("/journal/chat", json={"message": "First message"}, headers=headers)
    await async_client.post("/journal/chat", json={"message": "Second message"}, headers=headers)

    resp = await async_client.get("/user/balance", headers=headers)
    assert resp.json()["balance"] == 1


@pytest.mark.asyncio
async def test_chat_stores_user_and_bot_messages(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    await async_client.post(
        "/journal/chat", json={"message": "Tell me about meditation"}, headers=headers
    )

    # Verify both messages appear in journal
    resp = await async_client.get("/journal/", headers=headers)
    data = resp.json()
    assert data["total"] == 2  # noqa: PLR2004
    senders = {item["sender"] for item in data["items"]}
    assert senders == {"user", "bot"}

    # Verify user message content
    user_msgs = [m for m in data["items"] if m["sender"] == "user"]
    assert user_msgs[0]["message"] == "Tell me about meditation"


@pytest.mark.asyncio
async def test_chat_bot_response_in_journal_history(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    chat_resp = await async_client.post(
        "/journal/chat", json={"message": "Guide me"}, headers=headers
    )
    bot_entry_id = chat_resp.json()["bot_entry_id"]

    # Fetch the bot entry directly
    entry_resp = await async_client.get(f"/journal/{bot_entry_id}", headers=headers)
    assert entry_resp.status_code == HTTPStatus.OK
    assert entry_resp.json()["sender"] == "bot"


@pytest.mark.asyncio
async def test_chat_exhausts_balance_then_402(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await _add_balance(async_client, headers, amount=1)

    # First chat succeeds
    resp1 = await async_client.post("/journal/chat", json={"message": "First"}, headers=headers)
    assert resp1.status_code == HTTPStatus.CREATED
    assert resp1.json()["remaining_balance"] == 0

    # Second chat fails — balance exhausted
    resp2 = await async_client.post("/journal/chat", json={"message": "Second"}, headers=headers)
    assert resp2.status_code == HTTPStatus.PAYMENT_REQUIRED


@pytest.mark.asyncio
async def test_freeform_journal_works_at_zero_balance(async_client: AsyncClient) -> None:
    """Freeform journaling (POST /journal/) still works without offerings."""
    headers = await _signup(async_client)
    # Balance is 0 by default — freeform journaling should still work
    resp = await async_client.post(
        "/journal/",
        json={"message": "A thought without AI"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["sender"] == "user"


# ── BotMason service unit tests ────────────────────────────────────────


@pytest.mark.asyncio
async def test_stub_response_contains_user_message() -> None:
    result = await generate_response("What is the Archetypal Wavelength?", [])
    assert "What is the Archetypal Wavelength?" in result


@pytest.mark.asyncio
async def test_system_prompt_default() -> None:
    prompt = get_system_prompt()
    assert "BotMason" in prompt
    assert "APTITUDE" in prompt


@pytest.mark.asyncio
async def test_system_prompt_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOTMASON_SYSTEM_PROMPT", "Custom prompt text")
    prompt = get_system_prompt()
    assert prompt == "Custom prompt text"


@pytest.mark.asyncio
async def test_system_prompt_from_file(monkeypatch: pytest.MonkeyPatch, tmp_path: object) -> None:
    prompt_file = pathlib.Path(str(tmp_path)) / "prompt.txt"
    prompt_file.write_text("File-based system prompt")
    monkeypatch.setenv("BOTMASON_SYSTEM_PROMPT", str(prompt_file))
    prompt = get_system_prompt()
    assert prompt == "File-based system prompt"
