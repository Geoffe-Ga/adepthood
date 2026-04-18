import logging
from http import HTTPStatus
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import DEV_ORIGINS, _assert_credentials_safe, app, get_cors_origins

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
    with pytest.raises(RuntimeError, match=r"must use HTTPS.*http://bad\.com"):
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


@patch.dict(
    "os.environ",
    {"PROD_DOMAIN": "https://app.adepthood.com, https://app.adepthood.com"},
)
def test_production_dedupes_origins() -> None:
    """BUG-INFRA-007: duplicate PROD_DOMAIN entries collapse to a single origin."""
    origins = get_cors_origins("production")
    assert origins == ["https://app.adepthood.com"]


@patch.dict("os.environ", {"PROD_DOMAIN": "https://app.adepthood.com"})
def test_dev_env_warns_when_prod_domain_set(caplog: pytest.LogCaptureFixture) -> None:
    """BUG-INFRA-006: dev env logs a warning when PROD_DOMAIN is configured."""
    with caplog.at_level(logging.WARNING, logger="main"):
        origins = get_cors_origins("development")
    assert origins == DEV_ORIGINS
    assert any("PROD_DOMAIN" in rec.message for rec in caplog.records)


def test_credentials_with_wildcard_origin_raises() -> None:
    """BUG-INFRA-005: ``*`` plus credentials must fail closed at startup."""
    with pytest.raises(RuntimeError, match="allow_credentials"):
        _assert_credentials_safe(["*"])


def test_credentials_safe_with_explicit_origins() -> None:
    """``_assert_credentials_safe`` returns silently for explicit origins."""
    _assert_credentials_safe(["https://app.adepthood.com"])  # no exception


# --- Security headers ------------------------------------------------------


def test_security_headers_present_on_every_response() -> None:
    """BUG-INFRA-001/002/003: CSP, Referrer-Policy, and Permissions-Policy.

    must be on every response (not just authenticated ones).
    """
    response = client.get("/auth/login")  # public path; CORS-friendly
    assert "Content-Security-Policy" in response.headers
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "Permissions-Policy" in response.headers
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"


def test_csp_blocks_inline_scripts_by_default() -> None:
    """CSP should not include unsafe-inline so XSS attempts are mitigated."""
    response = client.get("/auth/login")
    csp = response.headers["Content-Security-Policy"]
    assert "unsafe-inline" not in csp
    assert "default-src 'self'" in csp
    assert "frame-ancestors 'none'" in csp


# --- Correlation ID --------------------------------------------------------


def test_response_includes_correlation_id() -> None:
    """BUG-INFRA-025: every response carries an ``X-Request-ID`` header."""
    response = client.get("/auth/login")
    assert "X-Request-ID" in response.headers
    assert response.headers["X-Request-ID"]


def test_correlation_id_echoed_when_supplied() -> None:
    """Inbound ``X-Request-ID`` is echoed back so clients can correlate logs."""
    response = client.get("/auth/login", headers={"X-Request-ID": "abc-123-xyz"})
    assert response.headers["X-Request-ID"] == "abc-123-xyz"


def test_correlation_id_minted_when_missing_or_empty() -> None:
    """Empty / whitespace ``X-Request-ID`` triggers a fresh UUID4."""
    response = client.get("/auth/login", headers={"X-Request-ID": "   "})
    minted = response.headers["X-Request-ID"]
    min_uuid_hex_length = 16  # UUIDs are 32 hex chars; sanity bound
    assert minted
    assert minted != "   "
    assert len(minted) >= min_uuid_hex_length


# --- Integration tests (middleware behavior) ---


def test_options_request_allowed() -> None:
    """Preflight OPTIONS request should succeed for allowed origin/method.

    We hit ``/auth/login`` (a real public endpoint) because ``/`` is now
    intentionally unmapped (BUG-INFRA-004); CORS preflight is handled by
    middleware so the route's auth requirements don't matter.
    """
    headers = {
        "Origin": ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
    }
    response = client.options("/auth/login", headers=headers)
    assert response.status_code == HTTPStatus.OK
    assert response.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN


def test_cross_origin_get_allowed() -> None:
    """GET requests from an allowed origin include CORS headers.

    Uses ``/auth/login`` rather than ``/`` (BUG-INFRA-004 removed root).
    The 405 status is fine — CORS headers are emitted regardless.
    """
    headers = {"Origin": ALLOWED_ORIGIN}
    response = client.get("/auth/login", headers=headers)
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
    response = client.get("/auth/login", headers=headers)
    assert "access-control-allow-origin" not in response.headers


def test_preflight_disallowed_method() -> None:
    """Preflight request for a disallowed method should return 400."""
    headers = {
        "Origin": ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "PATCH",
    }
    response = client.options("/auth/login", headers=headers)
    assert response.status_code == HTTPStatus.BAD_REQUEST
