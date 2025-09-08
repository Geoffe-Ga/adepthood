from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_options_request_allowed() -> None:
    """OPTIONS request should succeed when CORS is enabled."""
    headers = {
        "Origin": "http://example.com",
        "Access-Control-Request-Method": "GET",
    }
    response = client.options("/", headers=headers)
    ok_status = 200
    assert response.status_code == ok_status
    assert response.headers.get("access-control-allow-origin") == "http://example.com"
