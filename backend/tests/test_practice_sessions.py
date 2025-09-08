from datetime import UTC, datetime, timedelta
from itertools import count

import pytest  # type: ignore[import-not-found]
from fastapi.testclient import TestClient

from main import app
from routers import practice as practice_module

client = TestClient(app)
OK = 200
UNAUTHORIZED = 401


@pytest.fixture(autouse=True)
def clear_sessions() -> None:
    """Ensure each test starts with a clean in-memory store."""
    practice_module._sessions.clear()  # noqa: SLF001
    practice_module._id_counter = count(1)  # noqa: SLF001


@pytest.fixture()
def auth_headers() -> tuple[dict[str, str], int]:
    """Create a user and return auth headers and their id."""
    username = f"user-{datetime.now().timestamp()}"
    resp = client.post("/auth/signup", json={"username": username, "password": "pw"})
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


def test_create_session(auth_headers: tuple[dict[str, str], int]) -> None:
    headers, user_id = auth_headers
    payload = {
        "user_id": user_id,
        "practice_id": 2,
        "stage_number": 1,
        "duration_minutes": 5,
        "reflection": "felt calm",
    }
    response = client.post("/practice_sessions/", json=payload, headers=headers)
    assert response.status_code == OK
    data = response.json()
    assert data["reflection"] == "felt calm"
    assert data["id"] == 1


def test_week_count_ignores_old_sessions(auth_headers: tuple[dict[str, str], int]) -> None:
    headers, user_id = auth_headers
    old = practice_module.PracticeSession(
        id=99,
        user_id=user_id,
        practice_id=1,
        stage_number=1,
        duration_minutes=5,
        timestamp=datetime.now(UTC) - timedelta(days=8),
    )
    practice_module._sessions.append(old)  # noqa: SLF001
    response = client.get(f"/practice_sessions/{user_id}/week_count", headers=headers)
    assert response.status_code == OK
    assert response.json()["count"] == 0


def test_requires_token() -> None:
    payload = {
        "user_id": 1,
        "practice_id": 2,
        "stage_number": 1,
        "duration_minutes": 5,
    }
    response = client.post("/practice_sessions/", json=payload)
    assert response.status_code == UNAUTHORIZED
