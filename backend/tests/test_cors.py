from http import HTTPStatus

from fastapi.testclient import TestClient

from main import ALLOWED_ORIGIN, app

client = TestClient(app)


def test_cross_origin_post_with_credentials() -> None:
    """POST requests with credentials are permitted for allowed origins."""
    headers = {"Origin": ALLOWED_ORIGIN}
    payload = {
        "user_id": 1,
        "practice_id": 1,
        "stage_number": 1,
        "duration_minutes": 10,
    }
    cookies = {"session": "abc"}
    response = client.post(
        "/practice_sessions/",
        json=payload,
        headers=headers,
        cookies=cookies,
    )
    assert response.status_code == HTTPStatus.OK
    assert response.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN
    assert response.headers.get("access-control-allow-credentials") == "true"
