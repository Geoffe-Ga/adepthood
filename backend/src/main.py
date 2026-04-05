"""Main FastAPI application instance."""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from routers.auth import router as auth_router
from routers.course import router as course_router
from routers.energy import router as energy_router
from routers.goal_completions import router as goal_completion_router
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

    # staging and production both require PROD_DOMAIN
    prod_domain = os.getenv("PROD_DOMAIN")
    if not prod_domain:
        raise RuntimeError("PROD_DOMAIN must be set in production/staging")

    origins = [d.strip() for d in prod_domain.split(",") if d.strip()]
    if not origins:
        raise RuntimeError("PROD_DOMAIN must not be empty")

    for origin in origins:
        if not origin.startswith("https://"):
            raise RuntimeError(f"PROD_DOMAIN entries must use HTTPS, got '{origin}'")

    return origins


@asynccontextmanager
async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
    """Startup/shutdown lifecycle for the application."""
    import models  # noqa: F401, PLC0415

    yield


app = FastAPI(lifespan=lifespan)

origins = get_cors_origins()

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

# Register feature routers
app.include_router(auth_router)
app.include_router(course_router)
app.include_router(practices_router)
app.include_router(user_practices_router)
app.include_router(practice_sessions_router)
app.include_router(habits_router)
app.include_router(journal_router)
app.include_router(prompts_router)
app.include_router(energy_router)
app.include_router(goal_completion_router)
app.include_router(stages_router)


@app.get("/")
def read_root() -> dict[str, str]:
    """Basic root endpoint."""
    return {"status": "ok"}


@app.get("/health")
async def health_check(
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> dict[str, str]:
    """Health check that validates database connectivity."""
    try:
        await session.execute(text("SELECT 1"))
        return {"status": "ok", "database": "connected"}
    except Exception:
        return JSONResponse(  # type: ignore[return-value]
            status_code=503,
            content={"status": "error", "database": "disconnected"},
        )
