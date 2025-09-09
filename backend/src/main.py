"""Main FastAPI application instance."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers.energy import router as energy_router
from routers.goals import router as goals_router
from routers.practice import router as practice_router

# Origin allowed to make cross-origin requests with credentials.
ALLOWED_ORIGIN = "https://example.com"

app = FastAPI()

# Enable cross-origin requests with credentials for the allowed origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register feature routers
app.include_router(practice_router)
app.include_router(energy_router)
app.include_router(goals_router)


@app.get("/")
def read_root() -> dict[str, str]:
    """Basic health check endpoint."""
    return {"status": "ok"}
