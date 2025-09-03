from typing import Any

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def sample_payload() -> dict[str, Any]:
    return {
        "habits": [
            {"id": 1, "name": "Run", "energy_cost": 2, "energy_return": 5},
            {"id": 2, "name": "Sleep", "energy_cost": 1, "energy_return": 0},
        ],
        "start_date": "2024-01-01",
    }


def test_energy_plan_endpoint_returns_plan() -> None:
    res = client.post("/v1/energy/plan", json=sample_payload())
    assert res.status_code == 200  # noqa: PLR2004
    data = res.json()
    assert data["reason_code"] == "generated_21_day_plan"
    assert len(data["plan"]["items"]) == 21  # noqa: PLR2004
    expected_net = (5 - 2) * 11 + (0 - 1) * 10
    assert data["plan"]["net_energy"] == expected_net


def test_energy_plan_endpoint_idempotency() -> None:
    headers = {"X-Idempotency-Key": "abc"}
    res1 = client.post("/v1/energy/plan", json=sample_payload(), headers=headers)
    res2 = client.post("/v1/energy/plan", json=sample_payload(), headers=headers)
    assert res1.json() == res2.json()
