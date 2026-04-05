from http import HTTPStatus
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import DEV_ORIGINS, app, get_cors_origins

client = TestClient(app)

ALLOWED_ORIGIN = "http://localhost:3000"
FORBIDDEN_ORIGIN = "http://malicious.com"


# --- get_cors_origins unit tests ---


def test_development_returns_dev_origins() -> None:
    """Development environment returns the predefined localhost origins."""
    origins = get_cors_origins("development")
    assert origins == DEV_ORIGINS
    # Verify it's a copy, not the original list
    assert origins is not DEV_ORIGINS


def test_development_is_default_env() -> None:
    """When ENV is unset, development mode is used."""
    with patch.dict("os.environ", {}, clear=True):
        origins = get_cors_origins()
        assert origins == DEV_ORIGINS


@patch.dict("os.environ", {"PROD_DOMAIN": "https://app.adepthood.com"})
def test_production_with_valid_domain() -> None:
    """Production with a valid HTTPS domain returns that domain."""
    origins = get_cors_origins("production")
    assert origins == ["https://app.adepthood.com"]


@patch.dict(
    "os.environ",
    {"PROD_DOMAIN": "https://app.adepthood.com, https://www.adepthood.com"},
)
def test_production_with_multiple_domains() -> None:
    """Production supports comma-separated HTTPS domains."""
    origins = get_cors_origins("production")
    assert origins == ["https://app.adepthood.com", "https://www.adepthood.com"]


@patch.dict("os.environ", {"PROD_DOMAIN": "https://staging.adepthood.com"})
def test_staging_with_valid_domain() -> None:
    """Staging environment also requires and validates PROD_DOMAIN."""
    origins = get_cors_origins("staging")
    assert origins == ["https://staging.adepthood.com"]


def test_production_without_prod_domain_raises() -> None:
    """Production without PROD_DOMAIN raises RuntimeError."""
    with (
        patch.dict("os.environ", {}, clear=True),
        pytest.raises(RuntimeError, match="PROD_DOMAIN must be set"),
    ):
        get_cors_origins("production")


@patch.dict("os.environ", {"PROD_DOMAIN": "http://app.adepthood.com"})
def test_production_with_http_domain_raises() -> None:
    """Production with HTTP (not HTTPS) domain raises RuntimeError."""
    with pytest.raises(RuntimeError, match="must use HTTPS"):
        get_cors_origins("production")


@patch.dict("os.environ", {"PROD_DOMAIN": "https://good.com, http://bad.com"})
def test_production_rejects_mixed_schemes() -> None:
    """If any domain in the list is not HTTPS, it raises."""
    with pytest.raises(RuntimeError, match="must use HTTPS.*http://bad.com"):
        get_cors_origins("production")


def test_unknown_env_raises() -> None:
    """An unrecognized ENV value raises RuntimeError."""
    with pytest.raises(RuntimeError, match="Unknown ENV value 'testing'"):
        get_cors_origins("testing")


@patch.dict("os.environ", {"PROD_DOMAIN": " , , "})
def test_production_with_blank_entries_raises() -> None:
    """PROD_DOMAIN with only whitespace/commas raises RuntimeError."""
    with pytest.raises(RuntimeError, match="PROD_DOMAIN must not be empty"):
        get_cors_origins("production")


# --- Integration tests (middleware behavior) ---


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
    """POST requests with credentials include CORS headers even when auth fails."""
    headers = {"Origin": ALLOWED_ORIGIN}
    payload = {
        "user_practice_id": 1,
        "duration_minutes": 10,
    }
    cookies = {"session": "abc"}
    response = client.post(
        "/practice-sessions/",
        json=payload,
        headers=headers,
        cookies=cookies,
    )
    # The endpoint requires Bearer auth, so we get 401, but CORS headers
    # must still be present so the browser can read the response.
    assert response.status_code == HTTPStatus.UNAUTHORIZED
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
