from datetime import UTC, datetime, timedelta
from itertools import count

import pytest  # type: ignore[import-not-found]
from fastapi.testclient import TestClient

from main import app
from routers import practice as practice_module

client = TestClient(app)
OK = 200


@pytest.fixture(autouse=True)
def clear_sessions() -> None:
    """Ensure each test starts with a clean in-memory store."""
    practice_module._sessions.clear()  # noqa: SLF001
    practice_module._id_counter = count(1)  # noqa: SLF001


def test_create_session() -> None:
    payload = {
        "user_id": 1,
        "practice_id": 2,
        "stage_number": 1,
        "duration_minutes": 5,
        "reflection": "felt calm",
    }
    response = client.post("/practice_sessions/", json=payload)
    assert response.status_code == OK
    data = response.json()
    assert data["reflection"] == "felt calm"
    assert data["id"] == 1


def test_week_count_ignores_old_sessions() -> None:
    old = practice_module.PracticeSession(
        id=99,
        user_id=1,
        practice_id=1,
        stage_number=1,
        duration_minutes=5,
        timestamp=datetime.now(UTC) - timedelta(days=8),
    )
    practice_module._sessions.append(old)  # noqa: SLF001
    response = client.get("/practice_sessions/1/week_count")
    assert response.status_code == OK
    assert response.json()["count"] == 0
