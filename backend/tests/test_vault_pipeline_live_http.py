"""Live HTTP convergence between Adepthood and a contract-real Creek peer.

The narrow adapter tests use ``MockTransport`` on purpose, but that transport
cannot reproduce the regression this file owns: a write crossing one HTTP
server, a durable job crossing another, and classification finishing after the
ordinary ten-second read budget has elapsed.  Both ASGI applications therefore
listen on kernel-assigned loopback sockets here and every request uses httpx's
normal network transport.

The Creek peer is deliberately small rather than a second implementation.  It
serves only the published 0.14 shapes used by this journey, keeps the uploaded
fragment and its labels as observable state, and refuses to report a completed
classification until more than ten real seconds have elapsed.  The contract
bundle and the adapter's parser suites remain the authorities for every other
cell of the protocol.
"""

from __future__ import annotations

import asyncio
import base64
import socket
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from http import HTTPStatus
from typing import Annotated
from uuid import uuid4

import httpx
import pytest
import uvicorn
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select
from starlette.types import ASGIApp

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import CONTRACT_VERSION, CreekVaultPipelineClient
from main import app
from models.user import User
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from routers.auth import get_current_user
from services import creek_vault_pipeline as pipeline
from services.creek_vault_client import HttpCreekVaultClient

_HOST = "127.0.0.1"
_API_KEY = "live-boundary-key"  # pragma: allowlist secret
_PASSWORD = "correct-horse-battery-staple-42"  # pragma: allowlist secret
_CLASSIFICATION_SECONDS = 10.2
_JOURNAL_TEXT = "We are caring, sharing, and building momentum together."
_DOCUMENT_TEXT = "Community, equality, empathy, inclusion, and collaboration are kindling."


@dataclass
class _Fragment:
    """The observable Creek state one accepted write creates."""

    source: str
    tier: str
    labels: dict[str, str]


@dataclass(frozen=True)
class _Job:
    """The minimum private state needed to advance one durable job."""

    method: str
    started_at: float


class _SlowCreekPeer:
    """A 0.14 Creek HTTP peer whose LLM job really takes longer than ten seconds."""

    def __init__(self) -> None:
        """Create the observable state and mount the published routes."""
        self.app = FastAPI()
        self.fragments: dict[str, _Fragment] = {}
        self.jobs: dict[str, _Job] = {}
        self.classification_requests: list[Mapping[str, object]] = []
        self.link_methods: list[str] = []
        self.classification_elapsed: float | None = None
        self._mount()

    def _mount(self) -> None:
        """Mount the exact route vocabulary this end-to-end journey needs."""
        self.app.add_api_route("/v1/capabilities", self._capabilities, methods=["GET"])
        self.app.add_api_route("/v1/journal-entries/{external_id}", self._journal, methods=["PUT"])
        self.app.add_api_route("/v1/uploads", self._upload, methods=["POST"])
        self.app.add_api_route("/v1/classifications", self._classify, methods=["POST"])
        self.app.add_api_route("/v1/links", self._link, methods=["POST"], response_model=None)
        self.app.add_api_route("/v1/jobs/{job_id}", self._job, methods=["GET"])

    @staticmethod
    def _require_auth(request: Request) -> None:
        """Fail the test server if Adepthood drops its bearer credential."""
        assert request.headers.get("authorization") == f"Bearer {_API_KEY}"

    @staticmethod
    def _require_contract(request: Request) -> None:
        """Fail the peer if a post-handshake request does not declare 0.14."""
        assert request.headers.get("x-creek-contract-version") == "0.14"

    async def _capabilities(self, request: Request) -> Mapping[str, object]:
        """Advertise the three capabilities used by the two write journeys."""
        self._require_auth(request)
        return {
            "status": "ok",
            "vault": {"available": True},
            "capabilities": ["capabilities", "journal-upsert", "upload", "pipeline"],
            "contract_version": CONTRACT_VERSION,
            "contract_minor": "0.14",
            "supported_contract_minors": ["0.14"],
            "ontology_version": "aptitude-wavelength/2026-05-23",
            "tier_model": {
                "ceilings": ["open", "personal"],
                "default": "open",
                "intimate_never_egresses": True,
            },
        }

    async def _journal(self, external_id: str, request: Request) -> Mapping[str, object]:
        """Store one journal fragment without changing the submitted tier."""
        self._require_auth(request)
        self._require_contract(request)
        body = await request.json()
        assert isinstance(body, dict)
        tier = body["tier"]
        assert isinstance(tier, str)
        fragment_id = f"frag-journal-{len(self.fragments) + 1}"
        self.fragments[fragment_id] = _Fragment("journal", tier, {})
        return {
            "status": "ok",
            "action": "created",
            "external_id": external_id,
            "fragment_id": fragment_id,
            "tier": tier,
            "tier_ceiling": request.headers["x-creek-tier-ceiling"],
        }

    async def _upload(self, request: Request) -> Mapping[str, object]:
        """Store one imported fragment without changing the submitted tier."""
        self._require_auth(request)
        self._require_contract(request)
        body = await request.json()
        assert isinstance(body, dict)
        tier = body["tier"]
        external_id = body["external_id"]
        assert isinstance(tier, str)
        assert isinstance(external_id, str)
        fragment_id = f"frag-document-{len(self.fragments) + 1}"
        self.fragments[fragment_id] = _Fragment("document", tier, {})
        return {
            "status": "ok",
            "action": "created",
            "external_id": external_id,
            "fragment_id": fragment_id,
            "affected_fragment_ids": [fragment_id],
            "source_type": "document",
            "tier_ceiling": request.headers["x-creek-tier-ceiling"],
        }

    def _accepted(self, method: str) -> JSONResponse:
        """Persist one opaque job before returning its published 202 handle."""
        job_id = str(uuid4())
        self.jobs[job_id] = _Job(method=method, started_at=time.monotonic())
        return JSONResponse(
            status_code=HTTPStatus.ACCEPTED,
            content={"status": "accepted", "job_id": job_id, "state": "queued"},
        )

    async def _classify(self, request: Request) -> JSONResponse:
        """Admit a semantic pass and verify Adepthood never asks Creek to retier."""
        self._require_auth(request)
        self._require_contract(request)
        body = await request.json()
        assert body == {"method": "llm"}
        self.classification_requests.append(body)
        return self._accepted("llm")

    async def _link(self, request: Request) -> Mapping[str, object] | JSONResponse:
        """Answer short links inline and the published embeddings method by job."""
        self._require_auth(request)
        self._require_contract(request)
        body = await request.json()
        assert isinstance(body, dict)
        method = body.get("method")
        assert isinstance(method, str)
        self.link_methods.append(method)
        if method == "embeddings":
            return self._accepted(method)
        return self._link_result(method)

    def _classification_result(self) -> Mapping[str, object]:
        """Return counts for the labels the peer has actually landed."""
        count = len(self.fragments)
        return {
            "status": "ok",
            "tier_ceiling": "personal",
            "method": "llm",
            "total": count,
            "classified": count,
            "preserved_manual": 0,
            "preserved_llm": 0,
            "privacy_tiers_assigned": 0,
            "retiered": 0,
            "praxis_marked": 0,
            "tags_extracted": count,
            "complete": True,
        }

    def _link_result(self, method: str) -> Mapping[str, object]:
        """Return the contract's counts-only linker result."""
        count = len(self.fragments)
        return {
            "status": "ok",
            "tier_ceiling": "personal",
            "method": method,
            "fragment_count": count,
            "link_count": count,
            "largest_cluster_fragments": count,
            "clusters_split": 0,
            "oversized_discarded": 0,
        }

    async def _job(self, job_id: str, request: Request) -> Mapping[str, object]:
        """Expose running until the real clock passes ten seconds, then land labels."""
        self._require_auth(request)
        self._require_contract(request)
        job = self.jobs[job_id]
        elapsed = time.monotonic() - job.started_at
        if job.method == "llm" and elapsed < _CLASSIFICATION_SECONDS:
            return {"status": "ok", "job_id": job_id, "state": "running", "result": None}
        if job.method == "llm":
            for fragment in self.fragments.values():
                fragment.labels.update({"frequency.primary": "F6", "wavelength.phase": "rising"})
            self.classification_elapsed = elapsed
            result = self._classification_result()
        else:
            result = self._link_result(job.method)
        return {"status": "ok", "job_id": job_id, "state": "succeeded", "result": result}


class _NoSignalServer(uvicorn.Server):
    """A task-owned Uvicorn server that never installs process signal handlers."""

    def install_signal_handlers(self) -> None:
        """Leave shutdown under the test's control."""


@asynccontextmanager
async def _serve_tcp(asgi_app: ASGIApp) -> AsyncIterator[str]:
    """Serve ``asgi_app`` on a kernel-assigned loopback socket."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((_HOST, 0))
    listener.listen()
    port = int(listener.getsockname()[1])
    config = uvicorn.Config(
        asgi_app,
        host=_HOST,
        port=port,
        lifespan="off",
        access_log=False,
        log_level="critical",
    )
    server = _NoSignalServer(config)
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if serving.done():
                    await serving
                await asyncio.sleep(0.01)
        yield f"http://{_HOST}:{port}"
    finally:
        server.should_exit = True
        await serving
        listener.close()


async def _signup(client: httpx.AsyncClient, name: str) -> tuple[str, dict[str, str]]:
    """Create one account through live HTTP and return its email and auth header."""
    email = f"{name}@example.com"
    response = await client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    assert response.status_code == HTTPStatus.OK
    return email, {"Authorization": f"Bearer {response.json()['token']}"}


async def _user_ids(
    factory: async_sessionmaker[AsyncSession], emails: tuple[str, str]
) -> dict[str, int]:
    """Resolve the two accounts created through HTTP without assuming sequence ids."""
    async with factory() as session:
        result = await session.execute(select(User).where(col(User.email).in_(emails)))
        users = list(result.scalars().all())
    assert all(user.id is not None for user in users)
    return {user.email: int(user.id) for user in users if user.id is not None}


async def _pipeline_rows(
    factory: async_sessionmaker[AsyncSession], user_ids: set[int]
) -> list[VaultPipelineRun]:
    """Load the two live journeys' durable records after every continuation lands."""
    async with factory() as session:
        result = await session.execute(
            select(VaultPipelineRun)
            .where(col(VaultPipelineRun.user_id).in_(user_ids))
            .order_by(col(VaultPipelineRun.id))
        )
        return list(result.scalars().all())


async def _submit_writes_while_jobs_continue(
    client: httpx.AsyncClient,
    headers: tuple[dict[str, str], dict[str, str]],
    peers: tuple[_SlowCreekPeer, _SlowCreekPeer],
) -> tuple[httpx.Response, httpx.Response]:
    """Submit both writes and prove their accepted jobs are still in flight."""
    journal_headers, import_headers = headers
    started = time.monotonic()
    responses = await asyncio.gather(
        client.post(
            "/journal/",
            json={"message": _JOURNAL_TEXT, "classification": "public"},
            headers=journal_headers,
        ),
        client.post(
            "/corpus/import",
            json={
                "filename": "community-notes.md",
                "content_base64": base64.b64encode(_DOCUMENT_TEXT.encode()).decode(),
                "classification": "personal",
            },
            headers=import_headers,
        ),
    )
    assert time.monotonic() - started < _CLASSIFICATION_SECONDS
    assert all(peer.classification_elapsed is None for peer in peers)
    return responses


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slow_creek_jobs_converge_journal_and_import_over_live_http(
    concurrent_async_client: httpx.AsyncClient,  # noqa: ARG001 - provisions the live app DB
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both writes answer before their real ten-second jobs land, then converge."""
    monkeypatch.setattr(pipeline, "_JOURNAL_RUN_BUDGET_SECONDS", 0.5)
    monkeypatch.setattr(pipeline, "_DEEP_RUN_BUDGET_SECONDS", 0.5)
    monkeypatch.setattr(pipeline, "_LEAST_WORTH_STARTING_SECONDS", 0.05)
    monkeypatch.setattr(pipeline, "_JOB_POLL_MAX_SECONDS", 1.0)
    journal_peer = _SlowCreekPeer()
    import_peer = _SlowCreekPeer()

    async with (
        _serve_tcp(app) as adepthood_url,
        _serve_tcp(journal_peer.app) as journal_url,
        _serve_tcp(import_peer.app) as import_url,
        httpx.AsyncClient() as journal_http,
        httpx.AsyncClient() as import_http,
    ):
        journal_vault = HttpCreekVaultClient(journal_url, _API_KEY, http_client=journal_http)
        import_vault = HttpCreekVaultClient(import_url, _API_KEY, http_client=import_http)
        await asyncio.gather(journal_vault.handshake(), import_vault.handshake())

        async with httpx.AsyncClient(base_url=adepthood_url, timeout=30) as client:
            journal_email, journal_headers = await _signup(client, "live-journal-writer")
            import_email, import_headers = await _signup(client, "live-document-importer")
            ids = await _user_ids(concurrent_session_factory, (journal_email, import_email))
            clients: dict[int, CreekVaultPipelineClient] = {
                ids[journal_email]: journal_vault,
                ids[import_email]: import_vault,
            }

            async def _vault_for_user(
                current_user: Annotated[int, Depends(get_current_user)],
            ) -> CreekVaultPipelineClient:
                return clients[current_user]

            app.dependency_overrides[get_creek_vault_client] = _vault_for_user
            try:
                journal_response, import_response = await _submit_writes_while_jobs_continue(
                    client,
                    (journal_headers, import_headers),
                    (journal_peer, import_peer),
                )
                await pipeline.wait_for_vault_pipeline_tasks()
            finally:
                app.dependency_overrides.pop(get_creek_vault_client, None)
                await pipeline.close_vault_pipeline_tasks()

    assert journal_response.status_code == HTTPStatus.CREATED
    assert import_response.status_code == HTTPStatus.ACCEPTED
    assert journal_peer.classification_elapsed is not None
    assert import_peer.classification_elapsed is not None
    assert journal_peer.classification_elapsed > 10
    assert import_peer.classification_elapsed > 10
    assert journal_peer.classification_requests == [{"method": "llm"}]
    assert import_peer.classification_requests == [{"method": "llm"}]
    assert journal_peer.link_methods == ["temporal"]
    assert import_peer.link_methods == ["temporal", "embeddings", "eddies", "threads"]

    journal_fragment = next(iter(journal_peer.fragments.values()))
    import_fragment = next(iter(import_peer.fragments.values()))
    assert journal_fragment.tier == "open"
    assert import_fragment.tier == "personal"
    assert journal_fragment.labels == {
        "frequency.primary": "F6",
        "wavelength.phase": "rising",
    }
    assert import_fragment.labels == journal_fragment.labels

    rows = await _pipeline_rows(concurrent_session_factory, set(clients))
    journal_rows = [row for row in rows if row.user_id == ids[journal_email]]
    import_rows = [row for row in rows if row.user_id == ids[import_email]]
    assert [row.stage for row in journal_rows] == ["classify", "temporal"]
    assert [row.stage for row in import_rows] == [
        "classify",
        "temporal",
        "embeddings",
        "eddies",
        "threads",
    ]
    assert {row.outcome for row in rows} == {VaultPipelineOutcome.COMPLETED}
    assert {(row.fragments_seen, row.fragments_touched) for row in rows} == {(1, 1)}
