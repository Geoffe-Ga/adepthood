"""Main FastAPI application instance."""

from fastapi import FastAPI

from .practice import router as practice_router

app = FastAPI()

# Register feature routers
app.include_router(practice_router)


@app.get("/")
def read_root() -> dict[str, str]:
    """Basic health check endpoint."""
    return {"status": "ok"}
