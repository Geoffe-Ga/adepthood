from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_root_returns_404() -> None:
    """BUG-INFRA-004: ``GET /`` is intentionally not exposed.

    The Railway healthcheck uses ``/health``; ``/`` returning 404 means an
    unauthenticated probe can't fingerprint the service from the root path.
    """
    response = client.get("/")
    not_found_status = 404
    assert response.status_code == not_found_status
