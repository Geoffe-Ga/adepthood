from http import HTTPStatus

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

ALLOWED_ORIGIN = "http://localhost:3000"
FORBIDDEN_ORIGIN = "http://malicious.com"


def test_options_request_allowed() -> None:
    """Preflight OPTIONS request should succeed for allowed origin/method."""
    headers = {
        "Origin": ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "GET",
    }
    response = client.options("/", headers=headers)
    assert response.status_code == HTTPStatus.OK
    assert response.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN


def test_cross_origin_get_allowed() -> None:
    """GET requests from an allowed origin include CORS headers."""
    headers = {"Origin": ALLOWED_ORIGIN}
    response = client.get("/", headers=headers)
    assert response.status_code == HTTPStatus.OK
    assert response.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN


def test_cross_origin_post_with_credentials() -> None:
    """POST requests with credentials are permitted for allowed origins."""
    headers = {"Origin": ALLOWED_ORIGIN}
    signup = client.post("/auth/signup", json={"username": "u", "password": "p"}).json()
    headers["Authorization"] = f"Bearer {signup['token']}"
    payload = {
        "user_id": signup["user_id"],
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


def test_forbidden_origin_no_cors_headers() -> None:
    """Requests from disallowed origins should not receive CORS headers."""
    headers = {"Origin": FORBIDDEN_ORIGIN}
    response = client.get("/", headers=headers)
    assert response.status_code == HTTPStatus.OK
    assert "access-control-allow-origin" not in response.headers


def test_preflight_disallowed_method() -> None:
    """Preflight request for a disallowed method should return 400."""
    headers = {
        "Origin": ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "PATCH",
    }
    response = client.options("/", headers=headers)
    assert response.status_code == HTTPStatus.BAD_REQUEST
