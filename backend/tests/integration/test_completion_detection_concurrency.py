"""PostgreSQL proof that simultaneous completion checks cannot duplicate offers."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from http import HTTPStatus

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from database import get_session
from main import app
from models.completion_suggestion import CompletionSuggestion
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse

pytestmark = pytest.mark.integration


@pytest_asyncio.fixture
async def concurrent_pg_client(pg_engine: AsyncEngine) -> AsyncGenerator[AsyncClient, None]:
    """Drive the app with an independent transaction per concurrent request."""
    factory = async_sessionmaker(pg_engine, class_=AsyncSession, expire_on_commit=False)

    async def _session() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = _session
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.clear()


async def _signup(client: AsyncClient) -> dict[str, str]:
    response = await client.post(
        "/auth/signup",
        json={
            "email": "detect-race@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _seed_detectable_entry(client: AsyncClient, headers: dict[str, str]) -> int:
    habit = await client.post(
        "/habits/",
        headers=headers,
        json={
            "name": "Meditation",
            "icon": "🧘",
            "start_date": "2025-01-01",
            "energy_cost": 1,
            "energy_return": 2,
        },
    )
    assert habit.status_code == HTTPStatus.OK
    entry = await client.post("/journal/", headers=headers, json={"message": "I meditated"})
    assert entry.status_code == HTTPStatus.CREATED
    return int(entry.json()["id"])


@pytest.mark.asyncio
async def test_two_detection_requests_persist_one_offer(
    concurrent_pg_client: AsyncClient,
    pg_engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The post-dial entry lock makes the second tab observe the first one's offer."""
    both_at_provider = asyncio.Event()
    provider_calls = 0

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        nonlocal provider_calls
        del history, system_prompt, api_key
        assert '"hits"' in prompt
        provider_calls += 1
        if provider_calls == 1:
            await asyncio.wait_for(both_at_provider.wait(), timeout=5)
        else:
            both_at_provider.set()
        return LLMResponse(
            text=json.dumps({"hits": [{"index": 0, "quote": "I meditated"}]}),
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)
    headers = await _signup(concurrent_pg_client)
    entry_id = await _seed_detectable_entry(concurrent_pg_client, headers)

    responses = await asyncio.gather(
        concurrent_pg_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers),
        concurrent_pg_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers),
    )

    assert [response.status_code for response in responses] == [HTTPStatus.OK, HTTPStatus.OK]
    assert sorted(len(response.json()["items"]) for response in responses) == [0, 1]
    assert provider_calls == 2  # both calls reached the provider before either persisted
    async with AsyncSession(pg_engine) as session:
        count = (
            await session.execute(select(func.count()).select_from(CompletionSuggestion))
        ).scalar_one()
    assert count == 1
