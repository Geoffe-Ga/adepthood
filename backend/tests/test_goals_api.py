from itertools import count
from typing import Any, cast

import pytest  # type: ignore[import-not-found]
from fastapi.testclient import TestClient

from main import app
from routers import goals as goals_module

client = TestClient(app)
OK = 200
CREATED = 200  # FastAPI default for POST without status_code
NOT_FOUND = 404


@pytest.fixture(autouse=True)
def clear_state() -> None:
    """Ensure each test starts with a clean in-memory store."""
    goals_module._goals.clear()  # noqa: SLF001
    goals_module._goal_groups.clear()  # noqa: SLF001
    goals_module._goal_id_counter = count(1)  # noqa: SLF001
    goals_module._group_id_counter = count(1)  # noqa: SLF001


def create_sample_goal(habit_id: int = 1) -> dict[str, Any]:
    payload = {
        "habit_id": habit_id,
        "title": "Read",
        "description": "Read pages",
        "tier": "low",
        "target": 10,
        "target_unit": "pages",
        "frequency": 1,
        "frequency_unit": "per_day",
        "is_additive": True,
    }
    response = client.post("/goals/", json=payload)
    assert response.status_code == OK
    return cast(dict[str, Any], response.json())


def create_sample_group() -> dict[str, Any]:
    payload = {
        "name": "Reading",
        "icon": "book",
        "description": "Reading goals",
        "user_id": 1,
    }
    response = client.post("/goal_groups/", json=payload)
    assert response.status_code == OK
    return cast(dict[str, Any], response.json())


def test_create_goal() -> None:
    data = create_sample_goal()
    assert data["title"] == "Read"
    assert data["id"] == 1


def test_get_goal() -> None:
    created = create_sample_goal()
    response = client.get(f"/goals/{created['id']}")
    assert response.status_code == OK
    assert response.json()["id"] == created["id"]


def test_update_goal() -> None:
    created = create_sample_goal()
    payload = {"title": "Read more"}
    response = client.put(f"/goals/{created['id']}", json=payload)
    assert response.status_code == OK
    assert response.json()["title"] == "Read more"


def test_delete_goal() -> None:
    created = create_sample_goal()
    response = client.delete(f"/goals/{created['id']}")
    assert response.status_code == OK
    # ensure it's gone
    response = client.get(f"/goals/{created['id']}")
    assert response.status_code == NOT_FOUND


def test_create_goal_group() -> None:
    data = create_sample_group()
    assert data["name"] == "Reading"
    assert data["id"] == 1


def test_get_goal_group() -> None:
    created = create_sample_group()
    response = client.get(f"/goal_groups/{created['id']}")
    assert response.status_code == OK
    assert response.json()["id"] == created["id"]


def test_update_goal_group() -> None:
    created = create_sample_group()
    payload = {"description": "Updated"}
    response = client.put(f"/goal_groups/{created['id']}", json=payload)
    assert response.status_code == OK
    assert response.json()["description"] == "Updated"


def test_delete_goal_group() -> None:
    created = create_sample_group()
    response = client.delete(f"/goal_groups/{created['id']}")
    assert response.status_code == OK
    response = client.get(f"/goal_groups/{created['id']}")
    assert response.status_code == NOT_FOUND


def test_list_goals_by_habit() -> None:
    create_sample_goal(habit_id=1)
    create_sample_goal(habit_id=2)
    response = client.get("/habits/1/goals")
    assert response.status_code == OK
    data = response.json()
    assert len(data) == 1
    assert data[0]["habit_id"] == 1
