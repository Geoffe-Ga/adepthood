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
from routers.energy import router as energy_router
from routers.goal_completions import router as goal_completion_router
from routers.habits import router as habits_router
from routers.practice import router as practice_router


@asynccontextmanager
async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
    """Startup/shutdown lifecycle for the application."""
    import models  # noqa: F401, PLC0415

    yield


app = FastAPI(lifespan=lifespan)

# Configure allowed CORS origins based on environment to avoid wildcard usage
# with credentials enabled which is disallowed by browsers. Default to a
# development setup with local origins.
if os.getenv("ENV", "development") == "development":
    origins = [
        "http://localhost:3000",
        "http://localhost:8080",
        "http://127.0.0.1:3000",
    ]
else:
    origins = [
        os.getenv("PROD_DOMAIN", ""),
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

# Register feature routers
app.include_router(auth_router)
app.include_router(practice_router)
app.include_router(habits_router)
app.include_router(energy_router)
app.include_router(goal_completion_router)


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
