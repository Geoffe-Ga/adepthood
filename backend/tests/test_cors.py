import logging
from collections import defaultdict
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from unittest.mock import patch
from urllib.parse import urlsplit

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from starlette.routing import BaseRoute

from main import (
    ALLOWED_HEADERS,
    ALLOWED_METHODS,
    DEV_ORIGINS,
    _assert_credentials_safe,
    _validate_prod_origin,
    app,
    get_cors_origins,
)

client = TestClient(app)

ALLOWED_ORIGIN = "http://localhost:3000"
FORBIDDEN_ORIGIN = "http://malicious.com"
# The two spellings of the loopback interface a browser can be sitting on.  A
# page served from one of them is a *different origin* from the same page served
# from the other, so an allow-list that names only one silently refuses half the
# ways a developer can open the local web build (#2661).
LOOPBACK_HOST_FORMS = frozenset({"localhost", "127.0.0.1"})
# The origin the issue reproduces from: Expo's web build on the port README
# tells developers to use, opened by IP rather than by name.
LOOPBACK_IP_WEB_ORIGIN = "http://127.0.0.1:8080"
# Both spellings of the idempotency key a route reads: the IETF draft name the
# API client attaches, and the ``X-`` form the energy router declares.
IDEMPOTENCY_KEY_SPELLINGS = frozenset({"idempotency-key", "x-idempotency-key"})
# A route that really reads an idempotency key, so the preflight under test is
# the one a browser sends rather than a hypothetical one.
IDEMPOTENT_ROUTE = "/practice-sessions/"


def _echoed_allow_headers(headers: Mapping[str, str]) -> set[str]:
    """The ``Access-Control-Allow-Headers`` names, lower-cased and split.

    A browser compares the echo case-insensitively and per name, so the test
    does too rather than matching the raw comma-joined string.  Takes the
    response's headers rather than the response so it is not tied to whichever
    HTTP client the test transport happens to be built on.
    """
    raw = headers.get("access-control-allow-headers", "")
    return {name.strip().lower() for name in raw.split(",") if name.strip()}


# --- get_cors_origins unit tests ---


def test_dev_origins_name_both_loopback_host_forms_on_every_port() -> None:
    """#2661: every dev port must be reachable by name *and* by IP.

    ``localhost`` and ``127.0.0.1`` are the same interface but not the same
    origin, so a port listed under only one of them is CORS-refused for anyone
    who typed the other -- and the browser hands JavaScript no way to say why,
    so the app reports itself offline while the backend is up and answering.

    Asserted as a symmetry over whatever the list happens to contain rather
    than as a check for one hard-coded entry, so the next port added under a
    single host form fails here instead of in someone's browser.
    """
    hosts_by_port: defaultdict[tuple[str, int | None], set[str]] = defaultdict(set)
    for origin in DEV_ORIGINS:
        parts = urlsplit(origin)
        if parts.hostname in LOOPBACK_HOST_FORMS:
            hosts_by_port[(parts.scheme, parts.port)].add(parts.hostname)

    asymmetric = {
        port: sorted(LOOPBACK_HOST_FORMS - hosts)
        for port, hosts in hosts_by_port.items()
        if hosts != LOOPBACK_HOST_FORMS
    }
    assert not asymmetric, f"dev ports missing a loopback host form: {asymmetric}"


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


@patch.dict("os.environ", {"PROD_DOMAIN": "https://app.aptitude.guru"})
def test_production_allows_the_live_frontend_origin() -> None:
    """Regression guard (#765): the live web origin is a valid production origin.

    A deploy whose PROD_DOMAIN omits app.aptitude.guru makes the browser block
    every cross-origin response, so the whole app falsely reports "offline".
    The origin must pass validation and be applied verbatim.
    """
    _validate_prod_origin("https://app.aptitude.guru")  # must not raise
    assert get_cors_origins("production") == ["https://app.aptitude.guru"]


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
    """BUG-INFRA-005: a wildcard origin must fail closed at startup."""
    with pytest.raises(RuntimeError, match="explicit origins"):
        _assert_credentials_safe(["*"])


def test_credentials_safe_with_explicit_origins() -> None:
    """``_assert_credentials_safe`` returns silently for explicit origins."""
    _assert_credentials_safe(["https://app.adepthood.com"])  # no exception


# --- Security headers ------------------------------------------------------


def test_security_headers_present_on_every_response() -> None:
    """BUG-INFRA-001/002/003: Security headers must be on every response.

    CSP, Referrer-Policy, and Permissions-Policy are required on all
    responses, not just authenticated ones.
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
    """Preflight OPTIONS request should succeed for an allowed origin and method.

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
    """GET requests from an allowed origin include the expected CORS headers.

    Uses ``/auth/login`` rather than ``/`` (BUG-INFRA-004 removed root).
    The 405 status is fine -- CORS headers are emitted regardless.
    """
    headers = {"Origin": ALLOWED_ORIGIN}
    response = client.get("/auth/login", headers=headers)
    assert response.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN


def test_cross_origin_post_omits_credentials_header() -> None:
    """Cross-origin POSTs get the origin header but NOT allow-credentials.

    The API is cookieless (Bearer-token auth), so credentials mode is disabled
    (audit §5.3): the browser can still read the response (ACAO present) but the
    response never advertises ``Access-Control-Allow-Credentials: true``.
    """
    headers = {"Origin": ALLOWED_ORIGIN}
    ended = datetime.now(UTC)
    started = ended - timedelta(minutes=10)
    payload = {
        "user_practice_id": 1,
        "started_at": started.isoformat(),
        "ended_at": ended.isoformat(),
    }
    response = client.post(
        "/practice-sessions/",
        json=payload,
        headers=headers,
    )
    # The endpoint requires Bearer auth, so we get 401, but the ACAO header
    # must still be present so the browser can read the response.
    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert response.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN
    # Header omitted entirely (credentials mode off), not set to any value.
    assert response.headers.get("access-control-allow-credentials") is None


def test_preflight_from_the_loopback_ip_on_the_web_port() -> None:
    """#2661: the local web build opened at ``127.0.0.1:8080`` can log in.

    This is the exact reproduction from the issue -- a login preflight from the
    IP spelling of the port README hands developers -- and it 400s whenever the
    allow-list carries only the ``localhost`` spelling of that port.
    """
    headers = {
        "Origin": LOOPBACK_IP_WEB_ORIGIN,
        "Access-Control-Request-Method": "POST",
    }
    response = client.options("/auth/login", headers=headers)
    assert response.status_code == HTTPStatus.OK
    assert response.headers.get("access-control-allow-origin") == LOOPBACK_IP_WEB_ORIGIN


def test_forbidden_origin_no_cors_headers() -> None:
    """Requests from disallowed origins should not receive CORS headers."""
    headers = {"Origin": FORBIDDEN_ORIGIN}
    response = client.get("/auth/login", headers=headers)
    assert "access-control-allow-origin" not in response.headers


def test_preflight_patch_allowed() -> None:
    """A PATCH preflight succeeds (#788): the API serves PATCH endpoints.

    Omitting PATCH from the allow-list 400s the browser preflight for every
    PATCH route (user-practices customize, journal, practice tags/recipes), so
    saves fail with a false "offline" on the web app.
    """
    headers = {
        "Origin": ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "PATCH",
    }
    response = client.options("/auth/login", headers=headers)
    assert response.status_code == HTTPStatus.OK
    assert "PATCH" in response.headers.get("access-control-allow-methods", "")


def test_preflight_disallowed_method() -> None:
    """Preflight for a method the API never serves returns 400."""
    headers = {
        "Origin": ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "TRACE",
    }
    response = client.options("/auth/login", headers=headers)
    assert response.status_code == HTTPStatus.BAD_REQUEST


def _api_routes() -> list[APIRoute]:
    """Every route the app serves, including the ones inside included routers.

    ``app.routes`` is not flat.  ``include_router`` leaves a wrapper in it that
    keeps the included router's own routes behind ``original_router``, so a
    single-level sweep sees only the four documentation endpoints and nothing
    any feature router serves -- a sweep meant to cover the API would quietly
    cover almost none of it.  Every sweep below recurses through this helper,
    and each one asserts it found something, so a future framework change that
    breaks the traversal fails here instead of turning a gate blind.
    """
    found: list[APIRoute] = []

    def walk(routes: Iterable[BaseRoute]) -> None:
        for route in routes:
            if isinstance(route, APIRoute):
                found.append(route)
            included = getattr(route, "original_router", None)
            if included is not None:
                walk(included.routes)

    walk(app.routes)
    return found


def _declared_request_headers() -> dict[str, set[str]]:
    """Every request header the routes declare as an input, by route path.

    Read off the resolved dependency tree rather than from a list someone
    maintains: a route that starts reading a header is discovered the moment it
    does, including when it reads it through a shared dependency.
    """
    declared: defaultdict[str, set[str]] = defaultdict(set)
    for route in _api_routes():
        pending = [route.dependant]
        while pending:
            dependant = pending.pop()
            for param in dependant.header_params:
                declared[param.alias.lower()].add(route.path)
            pending.extend(dependant.dependencies)
    return declared


def test_allowed_methods_cover_all_routes() -> None:
    """Every HTTP verb the routers serve must be in the CORS allow-list (#788).

    A PATCH endpoint with PATCH missing from ALLOWED_METHODS 400s its browser
    preflight. HEAD/OPTIONS are auto-handled by Starlette (not served by the
    routers), so they are excluded from the comparison.
    """
    routes = _api_routes()
    assert routes, "route introspection found no routes; the traversal is blind"
    served: set[str] = set()
    for route in routes:
        served |= route.methods or set()
    served -= {"HEAD", "OPTIONS"}
    missing = served - set(ALLOWED_METHODS)
    assert not missing, f"router methods missing from CORS allow-list: {missing}"


def test_declared_request_headers_are_all_allowed_by_cors() -> None:
    """A header a route reads must be one a browser is allowed to send.

    The two idempotency spellings are the case in point: ``POST
    /practice-sessions/`` reads ``Idempotency-Key`` and ``POST /v1/energy/plan``
    reads ``X-Idempotency-Key``, and while neither was in the allow-list every
    cross-origin browser request carrying one was refused at the preflight --
    the request never reached the route that asked for it, and the server never
    saw enough to log why.

    Derived from the app's own dependency tree rather than from a second copy
    of the allow-list, so the next route to read a new header fails here rather
    than in someone's browser.  Only headers a route actually declares are
    demanded: this is an allow-list, and every entry in it is attack surface.
    """
    declared = _declared_request_headers()
    assert declared, "route introspection found no header parameters; it is blind"
    allowed = {header.lower() for header in ALLOWED_HEADERS}
    missing = {header: sorted(paths) for header, paths in declared.items() if header not in allowed}
    assert not missing, f"headers routes read but CORS refuses: {missing}"


def test_preflight_echoes_every_header_in_the_allow_list() -> None:
    """The constant is what the middleware actually answers with.

    Asserting membership in ``ALLOWED_HEADERS`` alone would still pass if the
    middleware were wired to some other list, so the whole constant is offered
    to a real preflight and the echo has to cover it.
    """
    response = client.options(
        IDEMPOTENT_ROUTE,
        headers={
            "Origin": ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": ", ".join(ALLOWED_HEADERS),
        },
    )
    assert response.status_code == HTTPStatus.OK
    assert _echoed_allow_headers(response.headers) >= {h.lower() for h in ALLOWED_HEADERS}


@pytest.mark.parametrize("requested", sorted(IDEMPOTENCY_KEY_SPELLINGS))
def test_preflight_allows_an_idempotency_key(requested: str) -> None:
    """The exact reproduction: a preflight advertising the key header.

    Chromium sends the name lower-cased in ``Access-Control-Request-Headers``.
    While the allow-list omitted it, Starlette answered 400 and the browser
    never issued the POST; worse, the client treats the presence of this header
    as the signal that a POST is retry-safe, so it retried the blocked request
    before giving up.
    """
    response = client.options(
        IDEMPOTENT_ROUTE,
        headers={
            "Origin": ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": requested,
        },
    )
    assert response.status_code == HTTPStatus.OK
    assert requested in _echoed_allow_headers(response.headers)


# ── BUG-APP-003: PROD_DOMAIN URL-validation hardening ─────────────────────


@pytest.mark.parametrize(
    "origin",
    [
        "http://example.com",  # not https
        "https://localhost",  # loopback
        "https://127.0.0.1",  # bare IPv4
        "https://[::1]",  # bare IPv6 loopback
        "https://10.0.0.5",  # bare IP
        "https://*.example.com",  # wildcard
        "https://user:pass@example.com",  # userinfo  # pragma: allowlist secret
        "https://",  # no hostname
    ],
    ids=[
        "http-scheme",
        "loopback-localhost",
        "loopback-ipv4",
        "loopback-ipv6",
        "bare-ip",
        "wildcard",
        "userinfo",
        "no-hostname",
    ],
)
def test_validate_prod_origin_rejects_unsafe_inputs(origin: str) -> None:
    """Each form should fail fast at startup so misconfig never serves traffic."""
    with pytest.raises(RuntimeError):
        _validate_prod_origin(origin)


def test_validate_prod_origin_accepts_well_formed_https() -> None:
    """A vanilla https://host.tld passes the gauntlet."""
    _validate_prod_origin("https://app.example.com")
    _validate_prod_origin("https://api.example.org:8443")
