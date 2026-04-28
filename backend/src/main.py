"""Main FastAPI application instance."""

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from errors import install_exception_handlers
from middleware import (
    CorrelationIdMiddleware,
    RequestLoggingMiddleware,
    SecurityHeadersMiddleware,
)
from observability import install_trace_id_logging
from rate_limit import limiter
from routers.admin import router as admin_router
from routers.auth import router as auth_router
from routers.botmason import router as botmason_router
from routers.course import router as course_router
from routers.energy import router as energy_router
from routers.goal_completions import router as goal_completion_router
from routers.goal_groups import router as goal_groups_router
from routers.habits import router as habits_router
from routers.journal import router as journal_router
from routers.practice_sessions import router as practice_sessions_router
from routers.practices import router as practices_router
from routers.prompts import router as prompts_router
from routers.stages import router as stages_router
from routers.user_practices import router as user_practices_router

logger = logging.getLogger(__name__)

VALID_ENVIRONMENTS = {"development", "staging", "production"}

DEV_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
]

# CORS — only the methods the API actually serves are allowed.  Listing them
# explicitly (BUG-INFRA-008) keeps the preflight surface tight; if a new
# method is added (PATCH, etc.) the test suite will surface the omission.
ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
# ``X-Request-ID`` is included so browser clients on a different origin
# can SET the header on outbound requests (otherwise the preflight
# strips it).  It is also exposed via ``EXPOSED_HEADERS`` below so the
# response copy survives the cross-origin filter and the AuthContext /
# logging adapter can correlate client-side telemetry with server logs.
ALLOWED_HEADERS = [
    "Authorization",
    "Content-Type",
    "X-LLM-API-Key",
    "X-Admin-API-Key",
    "X-Request-ID",
]
# Headers the browser is allowed to read from the response.  Without
# ``expose_headers`` the trace-id echoed by ``CorrelationIdMiddleware``
# is silently dropped by every cross-origin browser client and the PR's
# end-to-end correlation contract is broken (BUG-APP-001 follow-up).
EXPOSED_HEADERS = ["X-Request-ID"]


def _validate_https_origins(origins: list[str]) -> None:
    """Ensure every origin uses HTTPS; raise RuntimeError otherwise."""
    for origin in origins:
        if not origin.startswith("https://"):
            raise RuntimeError(f"PROD_DOMAIN entries must use HTTPS, got '{origin}'")


def _parse_prod_origins() -> list[str]:
    """Parse and validate PROD_DOMAIN for staging/production environments.

    Raises ``RuntimeError`` when PROD_DOMAIN is missing, empty, or contains
    non-HTTPS entries — the server should fail fast on bad config.
    """
    prod_domain = os.getenv("PROD_DOMAIN")
    if not prod_domain:
        raise RuntimeError("PROD_DOMAIN must be set in production/staging")

    origins = [d.strip() for d in prod_domain.split(",") if d.strip()]
    if not origins:
        raise RuntimeError("PROD_DOMAIN must not be empty")

    _validate_https_origins(origins)
    # BUG-INFRA-007: order-preserving dedup so duplicate entries in
    # PROD_DOMAIN don't produce duplicate Access-Control-Allow-Origin lines.
    return list(dict.fromkeys(origins))


def get_cors_origins(env: str | None = None) -> list[str]:
    """Build the CORS allowed-origins list based on the current environment.

    Raises ``RuntimeError`` for invalid configuration so the server fails fast
    rather than silently accepting bad requests.
    """
    if env is None:
        env = os.getenv("ENV", "development")

    if env not in VALID_ENVIRONMENTS:
        raise RuntimeError(
            f"Unknown ENV value '{env}'. Must be one of: {', '.join(sorted(VALID_ENVIRONMENTS))}"
        )

    if env == "development":
        # BUG-INFRA-006: warn loudly when PROD_DOMAIN is set in dev so
        # developers notice misconfiguration before staging rollout.
        if os.getenv("PROD_DOMAIN"):
            logger.warning(
                "PROD_DOMAIN is set but ENV=development — production origins ignored. "
                "Set ENV=staging or ENV=production to honour PROD_DOMAIN."
            )
        return list(DEV_ORIGINS)

    return _parse_prod_origins()


def _assert_credentials_safe(origins: list[str]) -> None:
    """Reject ``*`` in the CORS allow-list when credentials are enabled.

    BUG-INFRA-005: ``Access-Control-Allow-Origin: *`` plus
    ``Access-Control-Allow-Credentials: true`` is forbidden by the CORS
    spec and silently ignored by browsers.  Failing closed at startup
    surfaces the misconfiguration immediately instead of letting a
    misbehaving prod env appear to be working.
    """
    if "*" in origins:
        raise RuntimeError(
            "CORS allow-list contains '*' but allow_credentials=True. "
            "Browsers will reject the response — pick explicit origins instead."
        )


def _rate_limit_exceeded_handler(_request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Return a JSON 429 response with Retry-After header when rate limit is exceeded."""
    retry_after = getattr(exc, "retry_after", 60)
    return JSONResponse(
        status_code=429,
        content={"detail": "rate_limit_exceeded"},
        headers={"Retry-After": str(retry_after)},
    )


# BUG-APP-007: install the trace-id log filter at *import* time, not in the
# lifespan startup hook.  Module imports (router registration, seed data
# loading) run before lifespan fires, and a missing filter at that point
# would leave their log records without a ``trace_id`` field — breaking
# the formatter and causing a flood of ``KeyError`` messages on the very
# first request a worker process serves.  The function is idempotent.
install_trace_id_logging()


@asynccontextmanager
async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
    """Startup/shutdown lifecycle for the application."""
    import models  # noqa: F401, PLC0415

    yield


app = FastAPI(lifespan=lifespan)

# Attach the rate limiter to the app so slowapi can find it
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]

# BUG-OBS-002 / -003: install the global exception handlers BEFORE the
# routers are mounted so any unhandled exception during route execution
# (or in the middleware stack itself) is caught, logged with the
# request ID, reported to Sentry, and returned as a stable JSON envelope
# instead of leaking exception messages to the client.
install_exception_handlers(app)

# BUG-APP-001: Starlette's ``add_middleware`` is LIFO — the LAST class added
# becomes the OUTERMOST layer.  We register innermost-first so the actual
# request flow becomes:
#
#   RequestLoggingMiddleware  (outermost; always emits an access record)
#   -> CorrelationIdMiddleware  (mints / honours X-Request-ID)
#      -> SecurityHeadersMiddleware  (CSP / HSTS / Referrer-Policy / etc.)
#         -> CORSMiddleware  (preflight handling + ACAO / ACAC)
#            -> SlowAPIMiddleware  (rate-limit; innermost so 429s carry headers)
#               -> route handler
#
# Putting CORS *inside* SecurityHeaders means preflight (BUG-APP-002) and
# rate-limited responses inherit the security-header set; putting trace-id
# outside CORS means even preflight responses echo ``X-Request-ID``.
origins = get_cors_origins()
_assert_credentials_safe(origins)

app.add_middleware(SlowAPIMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=ALLOWED_METHODS,
    allow_headers=ALLOWED_HEADERS,
    expose_headers=EXPOSED_HEADERS,
)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(CorrelationIdMiddleware)
app.add_middleware(RequestLoggingMiddleware)

# Register feature routers
app.include_router(admin_router)
app.include_router(auth_router)
app.include_router(botmason_router)
app.include_router(course_router)
app.include_router(practices_router)
app.include_router(user_practices_router)
app.include_router(practice_sessions_router)
app.include_router(habits_router)
app.include_router(journal_router)
app.include_router(prompts_router)
app.include_router(energy_router)
app.include_router(goal_completion_router)
app.include_router(goal_groups_router)
app.include_router(stages_router)


@app.get("/health")
async def health_check(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, str]:
    """Health check that validates database connectivity.

    Returns a 200 with ``{"status": "healthy", "database": "connected"}`` when
    the database is reachable.  Railway pings this endpoint to determine
    service health; a 503 signals an unhealthy container.

    BUG-INFRA-021: session lifecycle is owned by ``Depends(get_session)`` —
    we don't open or close the session here, so a failed ``SELECT 1`` cannot
    leak a connection.  The dependency's ``async with`` (in ``database.py``)
    guarantees ``close()`` runs even when the handler raises.
    """
    try:
        await session.execute(text("SELECT 1"))
    except Exception as exc:
        logger.exception("health_check_failed")
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    return {"status": "healthy", "database": "connected"}
