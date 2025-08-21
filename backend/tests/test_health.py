from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_read_root() -> None:
    response = client.get("/")
    ok_status = 200
    assert response.status_code == ok_status
    assert response.json() == {"status": "ok"}
