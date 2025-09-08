from itertools import count

import pytest  # type: ignore[import-not-found]
from fastapi.testclient import TestClient

from main import app
from routers import habits as habits_module

client = TestClient(app)
OK = 200
NOT_FOUND = 404


def sample_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "user_id": 1,
        "name": "Drink Water",
        "icon": "💧",
        "start_date": "2024-01-01",
        "energy_cost": 1,
        "energy_return": 2,
        "notification_times": ["08:00"],
        "notification_frequency": "daily",
        "notification_days": ["mon"],
        "milestone_notifications": True,
        "sort_order": 1,
    }
    payload.update(overrides)
    return payload


@pytest.fixture(autouse=True)
def clear_store() -> None:
    habits_module._habits.clear()  # noqa: SLF001
    habits_module._id_counter = count(1)  # noqa: SLF001


def test_create_habit() -> None:
    response = client.post("/habits/", json=sample_payload())
    assert response.status_code == OK
    data = response.json()
    assert data["id"] == 1
    assert data["notification_times"] == ["08:00"]


def test_list_habits_sorted() -> None:
    client.post("/habits/", json=sample_payload(name="Two", sort_order=2))
    client.post("/habits/", json=sample_payload(name="One", sort_order=1))
    response = client.get("/habits/")
    assert response.status_code == OK
    names = [h["name"] for h in response.json()]
    assert names == ["One", "Two"]


def test_get_update_delete_habit() -> None:
    client.post("/habits/", json=sample_payload())
    # Get
    response = client.get("/habits/1")
    assert response.status_code == OK
    # Update
    response = client.put("/habits/1", json=sample_payload(name="Updated"))
    assert response.status_code == OK
    assert response.json()["name"] == "Updated"
    # Delete
    delete_resp = client.delete("/habits/1")
    assert delete_resp.status_code == OK
    missing = client.get("/habits/1")
    assert missing.status_code == NOT_FOUND
