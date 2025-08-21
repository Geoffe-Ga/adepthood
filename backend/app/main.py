from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def read_root() -> dict[str, str]:
    """Basic health check endpoint."""
    return {"status": "ok"}
