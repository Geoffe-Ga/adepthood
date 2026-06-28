import re

import pytest
from fastapi.testclient import TestClient
from httpx import AsyncClient

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


# ── BUG-APP-004: liveness + readiness split ────────────────────────────────


def test_liveness_returns_alive() -> None:
    """``/health/live`` does not depend on the DB.

    A liveness probe failing should mean "process is wedged" so the
    orchestrator restarts the container.  A DB outage must NOT flip
    this probe -- a transient DB blip should drop the pod from the
    LB pool (readiness) without restarting it (liveness).
    """
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "alive"}


@pytest.mark.asyncio
async def test_readiness_returns_ready_when_db_up(async_client: AsyncClient) -> None:
    """``/health/ready`` exercises the DB probe with a 2 s timeout.

    Uses the ``async_client`` fixture (which wires the SQLite test DB
    via ``Depends(get_session)`` override) rather than the bare
    ``TestClient`` so the readiness query has a real session to probe.
    """
    response = await async_client.get("/health/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["database"] == "connected"


@pytest.mark.asyncio
async def test_health_reports_content_version(async_client: AsyncClient) -> None:
    """``/health`` surfaces the vendored CONTENT_VERSION sha (issue #397).

    Real content is vendored (course-cms-06), so the field reports the pinned
    commit sha rather than ``none``; the key is always present so dashboards can
    alert on an unexpected value after a deploy.
    """
    response = await async_client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    content_version = body["content_version"]
    assert content_version != "none"
    assert re.fullmatch(r"[0-9a-f]{40}", content_version)
