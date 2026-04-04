from datetime import UTC, datetime, timedelta
from itertools import count

import pytest
from httpx import AsyncClient

from routers import practice as practice_module

OK = 200
UNAUTHORIZED = 401


@pytest.fixture(autouse=True)
def _clear_sessions() -> None:
    """Ensure each test starts with a clean in-memory store."""
    practice_module._sessions.clear()  # noqa: SLF001
    practice_module._id_counter = count(1)  # noqa: SLF001


async def _signup_practice(client: AsyncClient) -> tuple[dict[str, str], int]:
    """Create a user and return auth headers and their id."""
    email = f"user-{datetime.now().timestamp()}@example.com"
    resp = await client.post(
        "/auth/signup",
        json={"email": email, "password": "securepassword123"},  # pragma: allowlist secret
    )
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


@pytest.mark.asyncio
async def test_create_session(async_client: AsyncClient) -> None:
    headers, user_id = await _signup_practice(async_client)
    payload = {
        "user_id": user_id,
        "practice_id": 2,
        "stage_number": 1,
        "duration_minutes": 5,
        "reflection": "felt calm",
    }
    response = await async_client.post("/practice_sessions/", json=payload, headers=headers)
    assert response.status_code == OK
    data = response.json()
    assert data["reflection"] == "felt calm"
    assert data["id"] == 1


@pytest.mark.asyncio
async def test_week_count_ignores_old_sessions(async_client: AsyncClient) -> None:
    headers, user_id = await _signup_practice(async_client)
    old = practice_module.PracticeSession(
        id=99,
        user_id=user_id,
        practice_id=1,
        stage_number=1,
        duration_minutes=5,
        timestamp=datetime.now(UTC) - timedelta(days=8),
    )
    practice_module._sessions.append(old)  # noqa: SLF001
    response = await async_client.get(f"/practice_sessions/{user_id}/week_count", headers=headers)
    assert response.status_code == OK
    assert response.json()["count"] == 0


@pytest.mark.asyncio
async def test_requires_token(async_client: AsyncClient) -> None:
    payload = {
        "user_id": 1,
        "practice_id": 2,
        "stage_number": 1,
        "duration_minutes": 5,
    }
    response = await async_client.post("/practice_sessions/", json=payload)
    assert response.status_code == UNAUTHORIZED
