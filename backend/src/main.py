"""Main FastAPI application instance."""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from database import get_session
from rate_limit import limiter
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

VALID_ENVIRONMENTS = {"development", "staging", "production"}

DEV_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
]


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
    return origins


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
        return list(DEV_ORIGINS)

    return _parse_prod_origins()


def _rate_limit_exceeded_handler(_request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Return a JSON 429 response with Retry-After header when rate limit is exceeded."""
    retry_after = getattr(exc, "retry_after", 60)
    return JSONResponse(
        status_code=429,
        content={"detail": "rate_limit_exceeded"},
        headers={"Retry-After": str(retry_after)},
    )


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to every response.

    - X-Content-Type-Options: nosniff — prevents MIME-type sniffing
    - X-Frame-Options: DENY — prevents clickjacking via iframes
    - Strict-Transport-Security — enforces HTTPS in production/staging
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"

        env = os.getenv("ENV", "development")
        if env in ("production", "staging"):
            # max-age of 1 year (31536000 seconds) per OWASP recommendation
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

        return response


@asynccontextmanager
async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
    """Startup/shutdown lifecycle for the application."""
    import models  # noqa: F401, PLC0415

    yield


app = FastAPI(lifespan=lifespan)

# Attach the rate limiter to the app so slowapi can find it
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]

# Security headers on all responses
app.add_middleware(SecurityHeadersMiddleware)

# Apply default rate limits to all endpoints (including undecorated ones).
# Must be added after SecurityHeaders and before CORS so that:
#   CORS (outermost) → SlowAPI → SecurityHeaders → route handler
app.add_middleware(SlowAPIMiddleware)

origins = get_cors_origins()

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-LLM-API-Key"],
)

# Register feature routers
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


@app.get("/")
def read_root() -> dict[str, str]:
    """Basic root endpoint."""
    return {"status": "ok"}


@app.get("/health")
async def health_check(
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> dict[str, str]:
    """Health check that validates database connectivity.

    Returns a 200 with ``{"status": "healthy", "database": "connected"}`` when
    the database is reachable.  Railway pings this endpoint to determine
    service health; a 503 signals an unhealthy container.
    """
    try:
        await session.execute(text("SELECT 1"))
        return {"status": "healthy", "database": "connected"}
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
