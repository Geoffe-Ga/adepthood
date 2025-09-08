from http import HTTPStatus

import pytest  # type: ignore[import-not-found]
from fastapi.testclient import TestClient

from main import app
from routers import goal_completions as gc_module

client = TestClient(app)
OK = 200


@pytest.fixture(autouse=True)
def reset_state() -> None:
    """Reset in-memory goal state before each test."""
    gc_module._goal_state[1].streak = 0  # noqa: SLF001


def test_completion_increments_streak_and_returns_milestone() -> None:
    res = client.post(
        "/goal_completions/",
        json={"goal_id": 1, "did_complete": True},
    )
    assert res.status_code == OK
    data = res.json()
    assert data["streak"] == 1
    assert data["reason_code"] == "streak_incremented"
    assert data["milestones"] == [{"threshold": 1}]


def test_miss_resets_streak() -> None:
    gc_module._goal_state[1].streak = 2  # noqa: SLF001
    res = client.post(
        "/goal_completions/",
        json={"goal_id": 1, "did_complete": False},
    )
    assert res.status_code == OK
    data = res.json()
    assert data["streak"] == 0
    assert data["milestones"] == []
    assert data["reason_code"] == "streak_reset"


def test_unknown_goal_returns_404() -> None:
    res = client.post(
        "/goal_completions/",
        json={"goal_id": 999, "did_complete": True},
    )
    assert res.status_code == HTTPStatus.NOT_FOUND
