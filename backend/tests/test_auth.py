from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from main import app
from routers import auth

client = TestClient(app)

OK = 200
UNAUTHORIZED = 401


def test_signup_and_login_flow() -> None:
    signup = client.post(
        "/auth/signup",
        json={"username": "bob", "password": "secret"},  # pragma: allowlist secret
    )
    assert signup.status_code == OK
    data = signup.json()
    user_id = data["user_id"]

    login = client.post(
        "/auth/login",
        json={"username": "bob", "password": "secret"},  # pragma: allowlist secret
    )
    assert login.status_code == OK
    login_token = login.json()["token"]

    payload = {
        "user_id": user_id,
        "practice_id": 1,
        "stage_number": 1,
        "duration_minutes": 10,
    }
    headers = {"Authorization": f"Bearer {login_token}"}  # pragma: allowlist secret
    practice = client.post("/practice_sessions/", json=payload, headers=headers)
    assert practice.status_code == OK


def test_login_fails_with_bad_credentials() -> None:
    client.post(
        "/auth/signup",
        json={"username": "eve", "password": "pw"},  # pragma: allowlist secret
    )

    bad = client.post(
        "/auth/login",
        json={"username": "eve", "password": "wrong"},  # pragma: allowlist secret
    )
    assert bad.status_code == UNAUTHORIZED

    headers = {"Authorization": "Bearer badtoken"}  # pragma: allowlist secret
    payload = {
        "user_id": 1,
        "practice_id": 1,
        "stage_number": 1,
        "duration_minutes": 1,
    }
    practice = client.post("/practice_sessions/", json=payload, headers=headers)
    assert practice.status_code == UNAUTHORIZED


def test_expired_token_rejected() -> None:
    signup = client.post(
        "/auth/signup",
        json={"username": "tim", "password": "secret"},  # pragma: allowlist secret
    )
    token = signup.json()["token"]
    auth._tokens[token] = (  # noqa: SLF001
        auth._tokens[token][0],  # noqa: SLF001
        datetime.now(UTC) - timedelta(seconds=1),
    )
    headers = {"Authorization": f"Bearer {token}"}  # pragma: allowlist secret
    resp = client.get("/practice_sessions/1/week_count", headers=headers)
    assert resp.status_code == UNAUTHORIZED
