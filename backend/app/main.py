"""Main FastAPI application instance."""

from fastapi import FastAPI

from .practice import router as practice_router
from .routers.energy import router as energy_router

app = FastAPI()

# Register feature routers
app.include_router(practice_router)
app.include_router(energy_router)


@app.get("/")
def read_root() -> dict[str, str]:
    """Basic health check endpoint."""
    return {"status": "ok"}
