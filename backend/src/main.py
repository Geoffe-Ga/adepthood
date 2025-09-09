"""Main FastAPI application instance."""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers.auth import router as auth_router
from routers.energy import router as energy_router
from routers.goal_completions import router as goal_completion_router
from routers.habits import router as habits_router
from routers.practice import router as practice_router

app = FastAPI()

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
    """Basic health check endpoint."""
    return {"status": "ok"}
