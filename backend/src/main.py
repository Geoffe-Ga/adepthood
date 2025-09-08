"""Main FastAPI application instance."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers.energy import router as energy_router
from routers.practice import router as practice_router

app = FastAPI()

origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register feature routers
app.include_router(practice_router)
app.include_router(energy_router)


@app.get("/")
def read_root() -> dict[str, str]:
    """Basic health check endpoint."""
    return {"status": "ok"}
