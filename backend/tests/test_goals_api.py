from http import HTTPStatus

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_goal_group_crud() -> None:
    payload = {"name": "Morning", "user_id": 1}
    res = client.post("/v1/goal-groups", json=payload)
    assert res.status_code == HTTPStatus.CREATED
    group = res.json()
    group_id = group["id"]

    res = client.get("/v1/goal-groups")
    assert res.status_code == HTTPStatus.OK
    assert len(res.json()) == 1

    res = client.get(f"/v1/goal-groups/{group_id}")
    assert res.status_code == HTTPStatus.OK

    update = {"name": "Evening", "user_id": 1}
    res = client.put(f"/v1/goal-groups/{group_id}", json=update)
    assert res.status_code == HTTPStatus.OK
    assert res.json()["name"] == "Evening"

    res = client.delete(f"/v1/goal-groups/{group_id}")
    assert res.status_code == HTTPStatus.NO_CONTENT

    res = client.get(f"/v1/goal-groups/{group_id}")
    assert res.status_code == HTTPStatus.NOT_FOUND


def test_goal_crud_and_nested_listing() -> None:
    payload = {
        "habit_id": 1,
        "title": "Drink Water",
        "tier": "low",
        "target": 8,
        "target_unit": "cups",
        "frequency": 1,
        "frequency_unit": "per_day",
    }
    res = client.post("/v1/goals", json=payload)
    assert res.status_code == HTTPStatus.CREATED
    goal = res.json()
    goal_id = goal["id"]

    res = client.get("/v1/goals")
    assert res.status_code == HTTPStatus.OK
    assert len(res.json()) == 1

    res = client.get(f"/v1/goals/{goal_id}")
    assert res.status_code == HTTPStatus.OK

    update = payload | {"title": "Drink More Water"}
    res = client.put(f"/v1/goals/{goal_id}", json=update)
    assert res.status_code == HTTPStatus.OK
    assert res.json()["title"] == "Drink More Water"

    res = client.get("/v1/habits/1/goals")
    assert res.status_code == HTTPStatus.OK
    assert len(res.json()) == 1

    res = client.delete(f"/v1/goals/{goal_id}")
    assert res.status_code == HTTPStatus.NO_CONTENT

    res = client.get(f"/v1/goals/{goal_id}")
    assert res.status_code == HTTPStatus.NOT_FOUND
