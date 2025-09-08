"""Main FastAPI application instance."""

from fastapi import FastAPI

from routers.energy import router as energy_router
from routers.goal_completions import router as goal_completion_router
from routers.practice import router as practice_router

app = FastAPI()

# Register feature routers
app.include_router(practice_router)
app.include_router(energy_router)
app.include_router(goal_completion_router)


@app.get("/")
def read_root() -> dict[str, str]:
    """Basic health check endpoint."""
    return {"status": "ok"}
