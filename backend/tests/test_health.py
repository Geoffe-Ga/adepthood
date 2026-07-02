import asyncio
import re
from http import HTTPStatus

import pytest
from fastapi.testclient import TestClient
from httpx import AsyncClient

import main
from conftest import db_error_session, failing_probe_session, probe_via_session
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


@pytest.mark.asyncio
async def test_readiness_returns_503_when_db_unavailable() -> None:
    """``/health/ready`` returns 503 ``not_ready`` when the DB probe errors.

    Drives the readiness failure branch deterministically -- the probe's
    ``SELECT 1`` raises ``SQLAlchemyError`` -- so a regression that swallowed the
    error or returned 200 would fail this test (unlike the environment-dependent
    tautology this replaces).
    """
    response = await probe_via_session("/health/ready", db_error_session())
    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json()["detail"] == "not_ready"


@pytest.mark.asyncio
async def test_readiness_returns_503_when_db_socket_drops() -> None:
    """``/health/ready`` returns 503 when the probe raises ``OSError``.

    Pins the ``OSError`` member of the probe's caught-exception tuple (a dropped
    socket / connection reset) alongside the ``SQLAlchemyError`` and timeout
    cases, so narrowing the tuple would be caught.
    """
    response = await probe_via_session(
        "/health/ready", db_error_session(OSError("connection reset"))
    )
    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json()["detail"] == "not_ready"


@pytest.mark.asyncio
async def test_readiness_returns_503_when_db_probe_times_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``/health/ready`` returns 503 when the DB probe exceeds its timeout.

    The probe timeout is shrunk to a few milliseconds and ``execute`` stalls
    past it, so ``asyncio.timeout`` raises ``TimeoutError`` into the 503 branch
    without a multi-second wait.
    """
    monkeypatch.setattr(main, "_DB_PROBE_TIMEOUT_SECONDS", 0.01)

    async def _stall(*_args: object, **_kwargs: object) -> object:
        await asyncio.sleep(0.5)
        return None

    response = await probe_via_session("/health/ready", failing_probe_session(_stall))
    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json()["detail"] == "not_ready"
