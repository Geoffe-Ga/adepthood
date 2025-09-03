from typing import Any

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def sample_payload() -> dict[str, Any]:
    return {
        "habits": [
            {"id": 1, "name": "Run", "energy": 3},
            {"id": 2, "name": "Sleep", "energy": -1},
        ],
        "start_date": "2024-01-01",
    }


def test_energy_plan_endpoint_returns_plan() -> None:
    res = client.post("/v1/energy/plan", json=sample_payload())
    assert res.status_code == 200  # noqa: PLR2004
    data = res.json()
    assert data["reason_code"] == "generated_21_day_plan"
    assert len(data["plan"]["items"]) == 21  # noqa: PLR2004


def test_energy_plan_endpoint_idempotency() -> None:
    headers = {"X-Idempotency-Key": "abc"}
    res1 = client.post("/v1/energy/plan", json=sample_payload(), headers=headers)
    res2 = client.post("/v1/energy/plan", json=sample_payload(), headers=headers)
    assert res1.json() == res2.json()
