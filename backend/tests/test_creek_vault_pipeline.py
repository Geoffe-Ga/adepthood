"""What adepthood does with a vault that advertises Creek's batch pipeline.

A vault takes journal entries and documents and files them as fragments, but a
fragment nobody classified carries no APTITUDE frequency, no Archetypal
Wavelength phase and no links -- so the reflection surface, the wheel read and
the invitation engine all run over an inert corpus. Creek's answer is two batch
routes, ``POST /v1/classifications`` and ``POST /v1/links``, and until now
adepthood called neither.

Every wire shape asserted here is read out of the vendored bundle under
``tests/fixtures/creek_v1/`` rather than written down a second time. The two
request schemas are ``additionalProperties: false``, so a body carrying a field
adepthood invented fails validation here instead of at a live vault -- which is
the whole reason the bundle is vendored.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator, Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from jsonschema import Draft202012Validator
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from domain.creek_vault import (
    CreekCapability,
    CreekCapabilityUnsupportedError,
    VaultLinkStage,
    VaultPipelineJob,
    VaultPipelineStage,
)
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services import creek_vault_pipeline as pipeline
from services.creek_vault_client import (
    CONTRACT_MINOR,
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
)
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline
from services.creek_vault_telemetry import (
    VaultTelemetryOutcome,
    reset_vault_telemetry_for_tests,
    vault_outcome_counts,
)

_VAULT_URL = "https://vault.example.test"
_API_KEY = "test-key"  # pragma: allowlist secret
_OWNER = 1

_BUNDLE = Path(__file__).parent / "fixtures" / "creek_v1"

_CLASSIFICATIONS_PATH = "/v1/classifications"
_LINKS_PATH = "/v1/links"
_JOBS_PREFIX = "/v1/jobs/"
_CAPABILITIES_PATH = "/v1/capabilities"

# The read budget the adapter applies to every non-pipeline call. The cold
# embedding stages exist precisely because they cannot fit inside it, so a
# recorded read timeout at or below this number means the per-call deadline
# never reached httpx and the feature is a no-op.
_ORDINARY_READ_BUDGET_SECONDS = 10.0
_CONCURRENT_RACE_SETTLE_SECONDS = 2.0


def _example(capability: str, cell: str) -> dict[str, Any]:
    """Load one vendored example body."""
    path = _BUNDLE / "examples" / capability / f"{cell}.json"
    loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return loaded


def _schema(name: str) -> Draft202012Validator:
    """Load one vendored schema as a validator."""
    path = _BUNDLE / "schemas" / f"{name}.schema.json"
    return Draft202012Validator(json.loads(path.read_text(encoding="utf-8")))


def _link_body(stage: str) -> dict[str, Any]:
    """A LinkResponse shaped like the vendored one, echoing ``stage``."""
    body = _example("pipeline", "empty")
    body["method"] = stage
    body["fragment_count"] = 12
    body["link_count"] = 7
    return body


class _Recorder:
    """A MockTransport handler recording every request that reached the wire."""

    def __init__(
        self,
        *,
        classification: httpx.Response | None = None,
        link: Callable[[str], httpx.Response] | None = None,
    ) -> None:
        """Bind optional overrides for either pipeline route."""
        self.requests: list[httpx.Request] = []
        self.bodies: list[Any] = []
        self._classification = classification
        self._link = link

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer one request, recording it first."""
        self.requests.append(request)
        self.bodies.append(json.loads(request.content) if request.content else None)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(200, json=_example("capabilities", "success"))
        if request.url.path == _CLASSIFICATIONS_PATH:
            if self._classification is not None:
                return self._classification
            result = _example("pipeline", "success")
            result["method"] = json.loads(request.content)["method"]
            return httpx.Response(200, json=result)
        if request.url.path == _LINKS_PATH:
            stage = json.loads(request.content)["method"]
            if self._link is not None:
                return self._link(stage)
            return httpx.Response(200, json=_link_body(stage))
        return httpx.Response(404, json={"code": "not_found", "message": "no", "request_id": "r"})

    @property
    def paths(self) -> list[str]:
        """The path of every request that reached the wire, in order."""
        return [request.url.path for request in self.requests]

    @property
    def pipeline_bodies(self) -> list[Any]:
        """The decoded body of every pipeline request, in order."""
        return [
            body
            for request, body in zip(self.requests, self.bodies, strict=True)
            if request.url.path in {_CLASSIFICATIONS_PATH, _LINKS_PATH}
        ]


class _SlowRecorder:
    """An async handler that answers only after ``delay`` seconds have really passed.

    Composition rather than a subclass of :class:`_Recorder`: the ordinary
    recorder is a *synchronous* handler, and an async override of the same name
    is not a compatible signature. Wrapping one keeps both handlers honest.
    """

    def __init__(self, *, delay: float) -> None:
        """Bind how long each answer should take, and the recorder behind it."""
        self._delay = delay
        self._inner = _Recorder()

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, wait, then answer as the ordinary recorder would.

        Recording happens *before* the delay on purpose: a call this test cuts
        short is one that reached the wire and never came back, and a recorder
        that only logged completed exchanges would make "the budget cut a call
        short" indistinguishable from "no call was ever made".
        """
        response = self._inner(request)
        await asyncio.sleep(self._delay)
        return response

    @property
    def requests(self) -> list[httpx.Request]:
        """Every request that reached the wire, in order."""
        return self._inner.requests


class _DurableJobRecorder:
    """A contract-0.14 vault whose long pipeline methods finish through jobs."""

    CLASSIFICATION_JOB = "11111111-1111-4111-8111-111111111111"
    EMBEDDING_JOB = "22222222-2222-4222-8222-222222222222"

    def __init__(
        self,
        *,
        reject_first_classification: bool = False,
        fail_first_classification_job: bool = False,
        lose_first_classification_job: bool = False,
    ) -> None:
        """Optionally fault the first admission or first admitted job."""
        self.requests: list[httpx.Request] = []
        self.bodies: list[Any] = []
        self.classification_submissions = 0
        self._reject_first_classification = reject_first_classification
        self._fail_first_classification_job = fail_first_classification_job
        self._lose_first_classification_job = lose_first_classification_job
        self._polls: dict[str, int] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Serve the published admission, status, and synchronous response shapes."""
        self.requests.append(request)
        body = json.loads(request.content) if request.content else None
        self.bodies.append(body)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(200, json=_example("capabilities", "success"))
        if request.url.path == _CLASSIFICATIONS_PATH:
            return self._classification(body)
        if request.url.path == _LINKS_PATH:
            return self._link(body)
        if request.url.path.startswith(_JOBS_PREFIX):
            return self._status(request.url.path.removeprefix(_JOBS_PREFIX))
        return httpx.Response(404, json={"code": "not_found", "message": "no", "request_id": "r"})

    def _classification(self, body: object) -> httpx.Response:
        """Admit an LLM pass, after the optional one-shot availability fault."""
        self.classification_submissions += 1
        if self._reject_first_classification and self.classification_submissions == 1:
            return httpx.Response(503, json=_example("pipeline", "unavailable-service"))
        if body != {"method": "llm"}:
            return httpx.Response(422, json=_example("pipeline", "malformed-input"))
        return self._accepted(self.CLASSIFICATION_JOB)

    def _link(self, body: object) -> httpx.Response:
        """Admit embedding preparation and answer the short link methods inline."""
        if body == {"method": "embeddings"}:
            return self._accepted(self.EMBEDDING_JOB)
        assert isinstance(body, dict)
        return httpx.Response(200, json=_link_body(body["method"]))

    @staticmethod
    def _accepted(job_id: str) -> httpx.Response:
        """Return the published durable-admission shape."""
        return httpx.Response(
            202,
            json={"status": "accepted", "job_id": job_id, "state": "queued"},
        )

    def _status(self, job_id: str) -> httpx.Response:
        """Report running once, then the job's counts-only landed result."""
        if (
            job_id == self.CLASSIFICATION_JOB
            and self._lose_first_classification_job
            and self.classification_submissions == 1
        ):
            return httpx.Response(
                404,
                json={"code": "not_found", "message": "no", "request_id": "r"},
            )
        if (
            job_id == self.CLASSIFICATION_JOB
            and self._fail_first_classification_job
            and self.classification_submissions == 1
        ):
            return httpx.Response(
                200,
                json={"status": "ok", "job_id": job_id, "state": "failed", "result": None},
            )
        polls = self._polls.get(job_id, 0)
        self._polls[job_id] = polls + 1
        if polls == 0:
            return httpx.Response(
                200,
                json={"status": "ok", "job_id": job_id, "state": "running", "result": None},
            )
        if job_id == self.CLASSIFICATION_JOB:
            result = _example("pipeline", "success")
            result["method"] = "llm"
        else:
            result = _link_body("embeddings")
        return httpx.Response(
            200,
            json={"status": "ok", "job_id": job_id, "state": "succeeded", "result": result},
        )

    @property
    def paths(self) -> list[str]:
        """The path of every request that reached the wire, in order."""
        return [request.url.path for request in self.requests]

    @property
    def pipeline_bodies(self) -> list[Any]:
        """Bodies sent to pipeline admission routes, excluding status polls."""
        return [
            body
            for request, body in zip(self.requests, self.bodies, strict=True)
            if request.url.path in {_CLASSIFICATIONS_PATH, _LINKS_PATH}
        ]


class _RecorderLike(Protocol):
    """The recorder surface shared by synchronous mock Creek peers."""

    requests: list[httpx.Request]
    bodies: list[Any]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer one mock transport request."""


@pytest_asyncio.fixture
async def http_clients() -> AsyncGenerator[Callable[[_RecorderLike], httpx.AsyncClient], None]:
    """Yield a factory for MockTransport-backed clients, closing each afterwards."""
    built: list[httpx.AsyncClient] = []

    def _build(handler: _RecorderLike) -> httpx.AsyncClient:
        """Build one in-memory client and register it for teardown."""
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        built.append(client)
        return client

    yield _build
    for client in built:
        await client.aclose()


@pytest_asyncio.fixture
async def handshaken() -> Callable[[_RecorderLike, httpx.AsyncClient], Any]:
    """Yield a builder for an already-handshaken HTTP client."""

    async def _build(recorder: _RecorderLike, http: httpx.AsyncClient) -> HttpCreekVaultClient:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
        await client.handshake()
        recorder.requests.clear()
        recorder.bodies.clear()
        return client

    return _build


async def _rows(session: AsyncSession) -> list[VaultPipelineRun]:
    """Every pipeline row in the order it was written."""
    result = await session.execute(select(VaultPipelineRun).order_by(col(VaultPipelineRun.id)))
    return list(result.scalars().all())


async def _wait_for_background_pipeline() -> None:
    """Wait for the deliberately short-backoff continuation used by a test."""
    await pipeline.wait_for_vault_pipeline_tasks()


@pytest_asyncio.fixture(autouse=True)
async def _isolate_background_pipeline_tasks() -> AsyncGenerator[None, None]:
    """Give every test an empty in-process continuation registry.

    The production registry is process-global by design. Pytest reuses that
    process for many independent databases, so a task still unwinding after a
    test must not suppress the next test's same-user continuation or touch its
    successor's schema.
    """
    await pipeline.close_vault_pipeline_tasks()
    try:
        yield
    finally:
        await pipeline.close_vault_pipeline_tasks()


def _test_session_factory(session: AsyncSession) -> async_sessionmaker[AsyncSession]:
    """Build independent sessions over the current test's in-memory engine."""
    assert session.bind is not None
    return async_sessionmaker(session.bind, class_=AsyncSession, expire_on_commit=False)


@pytest.mark.asyncio
async def test_a_journal_write_converges_through_a_durable_llm_job(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A slow semantic pass lands its real counts, then temporal linking runs."""
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", 0.001, raising=False)
    recorder = _DurableJobRecorder()
    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()
    recorder.requests.clear()
    recorder.bodies.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )
    await http.aclose()

    assert recorder.pipeline_bodies == [{"method": "llm"}, {"method": "temporal"}]
    assert recorder.paths == [
        _CLASSIFICATIONS_PATH,
        f"{_JOBS_PREFIX}{recorder.CLASSIFICATION_JOB}",
        f"{_JOBS_PREFIX}{recorder.CLASSIFICATION_JOB}",
        _LINKS_PATH,
    ]
    rows = await _rows(db_session)
    assert [(row.stage, row.outcome) for row in rows] == [
        ("classify", VaultPipelineOutcome.COMPLETED),
        ("temporal", VaultPipelineOutcome.COMPLETED),
    ]
    assert all(row.resume_claimed_at is None for row in rows)
    assert (rows[0].fragments_seen, rows[0].fragments_touched) == (12, 10)


@pytest.mark.asyncio
async def test_an_accepted_job_tolerates_a_transient_status_outage(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Foreground polling shares the retry behavior used after the request clock."""

    class _TransientStatusOutage(_DurableJobRecorder):
        def __init__(self) -> None:
            """Fail only the first status read for the classification job."""
            super().__init__()
            self.status_reads = 0

        def _status(self, job_id: str) -> httpx.Response:
            """Expose one transient outage before the ordinary durable result."""
            self.status_reads += 1
            if self.status_reads == 1:
                return httpx.Response(503, json=_example("pipeline", "unavailable-service"))
            return super()._status(job_id)

    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", 0.001)
    scheduled: list[object] = []
    monkeypatch.setattr(pipeline, "_schedule_continuation", scheduled.append)
    recorder = _TransientStatusOutage()
    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )
    await http.aclose()

    rows = await _rows(db_session)
    assert recorder.status_reads == 3
    assert scheduled == []
    assert [(row.stage, row.outcome) for row in rows] == [
        ("classify", VaultPipelineOutcome.COMPLETED),
        ("temporal", VaultPipelineOutcome.COMPLETED),
    ]
    assert (rows[0].fragments_seen, rows[0].fragments_touched) == (12, 10)


@pytest.mark.asyncio
async def test_a_document_import_prepares_embeddings_and_finishes_the_whole_ladder(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The deep trigger waits on both durable jobs before eddies and threads."""
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", 0.001, raising=False)
    recorder = _DurableJobRecorder()
    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()
    recorder.requests.clear()
    recorder.bodies.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )
    await http.aclose()

    assert recorder.pipeline_bodies == [
        {"method": "llm"},
        {"method": "temporal"},
        {"method": "embeddings"},
        {"method": "eddies"},
        {"method": "threads"},
    ]
    rows = await _rows(db_session)
    assert [row.stage for row in rows] == [
        "classify",
        "temporal",
        "embeddings",
        "eddies",
        "threads",
    ]
    assert {row.outcome for row in rows} == {VaultPipelineOutcome.COMPLETED}


@pytest.mark.asyncio
async def test_failed_admission_retries_without_waiting_for_another_write(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transient admission failure schedules bounded retry and then continues."""
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", 0.001, raising=False)
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", 0.001, raising=False)
    recorder = _DurableJobRecorder(reject_first_classification=True)
    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()
    recorder.requests.clear()
    recorder.bodies.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )
    await _wait_for_background_pipeline()
    await http.aclose()

    assert recorder.classification_submissions == 2
    rows = await _rows(db_session)
    assert [(row.stage, row.outcome) for row in rows] == [
        ("classify", VaultPipelineOutcome.COMPLETED),
        ("temporal", VaultPipelineOutcome.COMPLETED),
    ]


@pytest.mark.asyncio
async def test_a_terminal_failed_job_is_readmitted_with_bounded_backoff(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A job-level failure retries the logical run instead of falsifying its counts."""
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", 0.001)
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", 0.001)
    recorder = _DurableJobRecorder(fail_first_classification_job=True)
    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()
    recorder.requests.clear()
    recorder.bodies.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )
    await _wait_for_background_pipeline()
    await http.aclose()

    assert recorder.classification_submissions == 2
    rows = await _rows(db_session)
    assert [(row.stage, row.outcome) for row in rows] == [
        ("classify", VaultPipelineOutcome.COMPLETED),
        ("temporal", VaultPipelineOutcome.COMPLETED),
    ]
    assert rows[0].attempt_count == 2
    assert (rows[0].fragments_seen, rows[0].fragments_touched) == (12, 10)


@pytest.mark.asyncio
async def test_a_lost_job_handle_is_readmitted_instead_of_polled_forever(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A terminal status refusal consumes one bounded attempt, then converges."""
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", 0.001)
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", 0.001)
    recorder = _DurableJobRecorder(lose_first_classification_job=True)
    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()
    recorder.requests.clear()
    recorder.bodies.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )
    await _wait_for_background_pipeline()
    await http.aclose()

    assert recorder.classification_submissions == 2
    rows = await _rows(db_session)
    assert [(row.stage, row.outcome) for row in rows] == [
        ("classify", VaultPipelineOutcome.COMPLETED),
        ("temporal", VaultPipelineOutcome.COMPLETED),
    ]
    assert rows[0].attempt_count == 2


@pytest.mark.asyncio
async def test_a_job_that_never_finishes_releases_its_continuation_as_ambiguous(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A perpetually-running job cannot wedge the per-user stage slot forever.

    The continuation deliberately overlaps its caller, so this test uses the
    repository's file-backed concurrency database.  A second connection to an
    in-memory SQLite URL has a different, empty database; under a loaded xdist
    worker that made this assertion test the fixture rather than the pipeline.
    """

    class _NeverTerminal(_DurableJobRecorder):
        def _status(self, job_id: str) -> httpx.Response:
            """Keep every admitted job running forever."""
            return httpx.Response(
                200,
                json={
                    "status": "ok",
                    "job_id": job_id,
                    "state": "running",
                    "result": None,
                },
            )

    monkeypatch.setattr(pipeline, "_JOURNAL_RUN_BUDGET_SECONDS", 0.005)
    monkeypatch.setattr(pipeline, "_LEAST_WORTH_STARTING_SECONDS", 0.001)
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", 0.001)
    monkeypatch.setattr(pipeline, "_JOB_RECONCILIATION_BUDGET_SECONDS", 0.01)
    recorder = _NeverTerminal()
    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()
    recorder.requests.clear()
    recorder.bodies.clear()

    async with concurrent_session_factory() as session:
        await drive_vault_pipeline(
            session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
        )
    await _wait_for_background_pipeline()
    await http.aclose()

    assert recorder.classification_submissions == 1
    async with concurrent_session_factory() as session:
        rows = await _rows(session)
    assert len(rows) == 1
    assert rows[0].outcome == VaultPipelineOutcome.AMBIGUOUS
    assert rows[0].attempt_count == 1
    assert rows[0].job_id == recorder.CLASSIFICATION_JOB


@pytest.mark.asyncio
async def test_a_journal_clock_expires_without_abandoning_the_accepted_job(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The save returns on its clock while the same durable job finishes later.

    Hold the terminal status until after the immediate read. This proves the
    attempted row is observable while work continues without racing a 10ms
    sleep against CI scheduling.
    """
    monkeypatch.setattr(pipeline, "_JOURNAL_RUN_BUDGET_SECONDS", 0.005)
    monkeypatch.setattr(pipeline, "_LEAST_WORTH_STARTING_SECONDS", 0.001)
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", 0.01)
    recorder = _DurableJobRecorder()
    terminal_release = asyncio.Event()

    async def _hold_terminal_status(request: httpx.Request) -> httpx.Response:
        response = recorder(request)
        if (
            request.url.path == f"{_JOBS_PREFIX}{recorder.CLASSIFICATION_JOB}"
            and response.json().get("state") == "succeeded"
        ):
            await terminal_release.wait()
        return response

    http = httpx.AsyncClient(transport=httpx.MockTransport(_hold_terminal_status))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()
    recorder.requests.clear()
    recorder.bodies.clear()

    started = time.monotonic()
    async with concurrent_session_factory() as session:
        await drive_vault_pipeline(
            session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
        )
    foreground_elapsed = time.monotonic() - started
    async with concurrent_session_factory() as session:
        immediate = await _rows(session)
    # Event-loop scheduling under the repository's ten-worker gate can add a
    # few milliseconds after the 5ms deadline. The durable attempted row below
    # is the semantic assertion; this ceiling only catches an accidental wait
    # for the job's terminal result.
    assert foreground_elapsed < 0.1
    assert [(row.stage, row.outcome) for row in immediate] == [
        ("classify", VaultPipelineOutcome.ATTEMPTED)
    ]

    terminal_release.set()
    await _wait_for_background_pipeline()
    await http.aclose()

    async with concurrent_session_factory() as session:
        landed = await _rows(session)
    assert [(row.stage, row.outcome) for row in landed] == [
        ("classify", VaultPipelineOutcome.COMPLETED),
        ("temporal", VaultPipelineOutcome.COMPLETED),
    ]


@pytest.mark.asyncio
async def test_an_accepted_job_resumes_after_the_adepthood_process_restarts(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Startup polls the persisted handle and finishes the trigger's successors."""
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", 0.001)
    recorder = _DurableJobRecorder()
    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    db_session.add(
        VaultPipelineRun(
            user_id=_OWNER,
            stage="classify",
            trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
            outcome=VaultPipelineOutcome.ATTEMPTED.value,
            job_id=recorder.CLASSIFICATION_JOB,
            attempt_count=1,
            fragments_seen=0,
            fragments_touched=0,
            fragments_lost=0,
        )
    )
    await db_session.commit()

    async def _resolve(_session: AsyncSession, user_id: int) -> HttpCreekVaultClient:
        assert user_id == _OWNER
        return client

    await pipeline.resume_vault_pipeline_runs(_test_session_factory(db_session), _resolve)
    await _wait_for_background_pipeline()
    await http.aclose()

    assert _CLASSIFICATIONS_PATH not in recorder.paths
    assert recorder.paths[-1] == _LINKS_PATH
    rows = await _rows(db_session)
    assert [(row.stage, row.outcome) for row in rows] == [
        ("classify", VaultPipelineOutcome.COMPLETED),
        ("temporal", VaultPipelineOutcome.COMPLETED),
    ]
    assert all(row.resume_claim_id is None and row.resume_claimed_at is None for row in rows)


@pytest.mark.asyncio
async def test_two_startups_claim_a_persisted_run_only_once(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two worker processes must not both resume and retry-admit one run."""
    async with concurrent_session_factory() as session:
        session.add(
            VaultPipelineRun(
                user_id=_OWNER,
                stage=VaultPipelineStage.CLASSIFY.value,
                trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
                outcome=VaultPipelineOutcome.ATTEMPTED.value,
                job_id=str(_DurableJobRecorder.CLASSIFICATION_JOB),
                fragments_seen=0,
                fragments_touched=0,
                fragments_lost=0,
            )
        )
        await session.commit()

    first_claimed = asyncio.Event()
    release_first = asyncio.Event()
    claimed_ids: list[int] = []

    async def _hold_claim(
        _factory: async_sessionmaker[AsyncSession],
        _resolve: object,
        _session: AsyncSession,
        run: VaultPipelineRun,
    ) -> None:
        assert run.id is not None
        claimed_ids.append(run.id)
        first_claimed.set()
        await release_first.wait()

    monkeypatch.setattr(pipeline, "_resume_run", _hold_claim)

    first = asyncio.create_task(
        pipeline.resume_vault_pipeline_runs(concurrent_session_factory, AsyncMock())
    )
    await asyncio.wait_for(first_claimed.wait(), _CONCURRENT_RACE_SETTLE_SECONDS)
    second = asyncio.create_task(
        pipeline.resume_vault_pipeline_runs(concurrent_session_factory, AsyncMock())
    )
    await asyncio.sleep(0.05)
    release_first.set()
    await asyncio.gather(first, second)

    assert len(claimed_ids) == 1


@pytest.mark.asyncio
async def test_a_lost_claim_race_continues_to_the_next_resumable_row(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Losing the oldest row to a peer is not the same as an empty queue."""
    async with concurrent_session_factory() as session:
        for stage in (VaultPipelineStage.CLASSIFY, VaultPipelineStage.TEMPORAL):
            session.add(
                VaultPipelineRun(
                    user_id=_OWNER,
                    stage=stage.value,
                    trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
                    outcome=VaultPipelineOutcome.ATTEMPTED.value,
                    job_id=str(_DurableJobRecorder.CLASSIFICATION_JOB),
                    fragments_seen=0,
                    fragments_touched=0,
                    fragments_lost=0,
                )
            )
        await session.commit()

    original_claim_one = pipeline._claim_one_resumable_run  # noqa: SLF001
    lose_oldest_once = True

    async def _lose_once(session: AsyncSession) -> VaultPipelineRun | None:
        nonlocal lose_oldest_once
        if lose_oldest_once:
            lose_oldest_once = False
            return None
        return await original_claim_one(session)

    resumed: list[int] = []

    async def _record_claim(
        _factory: async_sessionmaker[AsyncSession],
        _resolve: object,
        _session: AsyncSession,
        run: VaultPipelineRun,
    ) -> None:
        assert run.id is not None
        resumed.append(run.id)

    monkeypatch.setattr(pipeline, "_claim_one_resumable_run", _lose_once)
    monkeypatch.setattr(pipeline, "_resume_run", _record_claim)

    await pipeline.resume_vault_pipeline_runs(concurrent_session_factory, AsyncMock())

    assert len(resumed) == 2
    assert len(set(resumed)) == 2


@pytest.mark.asyncio
async def test_a_stale_startup_claim_is_recoverable(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A process crash delays recovery only until the bounded claim lease expires."""
    stale = datetime(2000, 1, 1, tzinfo=UTC)
    async with concurrent_session_factory() as session:
        session.add(
            VaultPipelineRun(
                user_id=_OWNER,
                stage=VaultPipelineStage.CLASSIFY.value,
                trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
                outcome=VaultPipelineOutcome.ATTEMPTED.value,
                job_id=str(_DurableJobRecorder.CLASSIFICATION_JOB),
                resume_claim_id="abandoned-process-claim",
                resume_claimed_at=stale,
                fragments_seen=0,
                fragments_touched=0,
                fragments_lost=0,
            )
        )
        await session.commit()

    resumed: list[int] = []

    async def _record_claim(
        _factory: async_sessionmaker[AsyncSession],
        _resolve: object,
        _session: AsyncSession,
        run: VaultPipelineRun,
    ) -> None:
        assert run.id is not None
        resumed.append(run.id)

    monkeypatch.setattr(pipeline, "_resume_run", _record_claim)

    await pipeline.resume_vault_pipeline_runs(concurrent_session_factory, AsyncMock())

    assert len(resumed) == 1


@pytest.mark.asyncio
async def test_concurrent_triggers_submit_only_one_pass_per_user_and_stage(
    db_session: AsyncSession,
) -> None:
    """The committed active row closes the race before a second socket opens."""
    started = asyncio.Event()
    release = asyncio.Event()
    inner = _Recorder()

    async def _blocking(request: httpx.Request) -> httpx.Response:
        if request.url.path == _CLASSIFICATIONS_PATH:
            started.set()
            await release.wait()
        return inner(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(_blocking))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()
    inner.requests.clear()
    inner.bodies.clear()
    factory = _test_session_factory(db_session)

    async with factory() as first_session, factory() as second_session:
        first = asyncio.create_task(
            drive_vault_pipeline(
                first_session,
                client,
                user_id=_OWNER,
                trigger=VaultPipelineTrigger.JOURNAL_WRITE,
            )
        )
        await started.wait()
        await drive_vault_pipeline(
            second_session,
            client,
            user_id=_OWNER,
            trigger=VaultPipelineTrigger.JOURNAL_WRITE,
        )
        release.set()
        await first
    await http.aclose()

    assert inner.paths.count(_CLASSIFICATIONS_PATH) == 1


@pytest.mark.asyncio
async def test_two_stale_schedulers_race_real_inserts_and_only_one_reaches_creek(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The partial index rejects one of two genuinely concurrent active inserts."""
    schedulers_arrived = 0
    both_schedulers_are_stale = asyncio.Event()
    creek_started = asyncio.Event()
    release_creek = asyncio.Event()
    recorder = _Recorder()

    async def _same_stale_due_answer(
        _session: AsyncSession,
        _user_id: int,
        _trigger: VaultPipelineTrigger,
    ) -> tuple[VaultPipelineStage, ...]:
        nonlocal schedulers_arrived
        schedulers_arrived += 1
        if schedulers_arrived == 2:
            both_schedulers_are_stale.set()
        await both_schedulers_are_stale.wait()
        return (VaultPipelineStage.CLASSIFY,)

    async def _hold_the_winner(request: httpx.Request) -> httpx.Response:
        if request.url.path == _CLASSIFICATIONS_PATH:
            creek_started.set()
            await release_creek.wait()
        return recorder(request)

    monkeypatch.setattr(pipeline, "_pipeline_stages", _same_stale_due_answer)
    http = httpx.AsyncClient(transport=httpx.MockTransport(_hold_the_winner))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()
    recorder.requests.clear()
    recorder.bodies.clear()

    async with (
        concurrent_session_factory() as first_session,
        concurrent_session_factory() as second_session,
    ):
        contenders = (
            asyncio.create_task(
                drive_vault_pipeline(
                    first_session,
                    client,
                    user_id=_OWNER,
                    trigger=VaultPipelineTrigger.JOURNAL_WRITE,
                )
            ),
            asyncio.create_task(
                drive_vault_pipeline(
                    second_session,
                    client,
                    user_id=_OWNER,
                    trigger=VaultPipelineTrigger.JOURNAL_WRITE,
                )
            ),
        )
        try:
            await asyncio.wait_for(creek_started.wait(), _CONCURRENT_RACE_SETTLE_SECONDS)
            losers, _pending = await asyncio.wait(
                contenders,
                timeout=_CONCURRENT_RACE_SETTLE_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            release_creek.set()
            await asyncio.gather(*contenders)
    await http.aclose()

    assert len(losers) == 1
    assert recorder.paths.count(_CLASSIFICATIONS_PATH) == 1
    async with concurrent_session_factory() as reading:
        rows = await _rows(reading)
    assert [row.stage for row in rows].count(VaultPipelineStage.CLASSIFY) == 1


@pytest.mark.asyncio
async def test_the_partial_unique_index_rejects_a_stale_duplicate_and_rolls_back(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The database backstop catches a race and leaves the session reusable.

    Force the scheduling read to return the stale answer a real race loser saw
    before its peer committed. The second attempt must reach the actual partial
    unique index, be swallowed by the best-effort boundary, and roll back; the
    query below then proves the same session is healthy and only the winner's
    durable row survived.
    """
    db_session.add(
        VaultPipelineRun(
            user_id=_OWNER,
            stage=VaultPipelineStage.CLASSIFY.value,
            trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
            outcome=VaultPipelineOutcome.ATTEMPTED.value,
            fragments_seen=0,
            fragments_touched=0,
            fragments_lost=0,
        )
    )
    await db_session.commit()

    async def _stale_due_answer(
        _session: AsyncSession,
        _user_id: int,
        _trigger: VaultPipelineTrigger,
    ) -> tuple[VaultPipelineStage, ...]:
        return (VaultPipelineStage.CLASSIFY,)

    monkeypatch.setattr(pipeline, "_pipeline_stages", _stale_due_answer)
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session,
        client,
        user_id=_OWNER,
        trigger=VaultPipelineTrigger.JOURNAL_WRITE,
    )

    assert recorder.requests == []
    rows = await _rows(db_session)
    assert len(rows) == 1
    assert rows[0].outcome == VaultPipelineOutcome.ATTEMPTED


@pytest.mark.asyncio
async def test_an_import_joins_a_journal_classification_without_losing_its_deep_stages(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A deeper trigger promotes the durable run instead of opening a duplicate."""
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", 0.001)
    status_started = asyncio.Event()
    release_status = asyncio.Event()
    recorder = _DurableJobRecorder()

    async def _hold_first_status(request: httpx.Request) -> httpx.Response:
        response = recorder(request)
        if (
            request.url.path == f"{_JOBS_PREFIX}{recorder.CLASSIFICATION_JOB}"
            and response.json().get("state") == "running"
        ):
            status_started.set()
            await release_status.wait()
        return response

    http = httpx.AsyncClient(transport=httpx.MockTransport(_hold_first_status))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()
    recorder.requests.clear()
    recorder.bodies.clear()
    factory = _test_session_factory(db_session)

    async with factory() as journal_session, factory() as import_session:
        journal = asyncio.create_task(
            drive_vault_pipeline(
                journal_session,
                client,
                user_id=_OWNER,
                trigger=VaultPipelineTrigger.JOURNAL_WRITE,
            )
        )
        await status_started.wait()
        await drive_vault_pipeline(
            import_session,
            client,
            user_id=_OWNER,
            trigger=VaultPipelineTrigger.DOCUMENT_IMPORT,
        )
        release_status.set()
        await journal
    await http.aclose()

    assert recorder.classification_submissions == 1
    assert recorder.pipeline_bodies == [
        {"method": "llm"},
        {"method": "temporal"},
        {"method": "embeddings"},
        {"method": "eddies"},
        {"method": "threads"},
    ]
    rows = await _rows(db_session)
    assert [row.stage for row in rows] == [
        "classify",
        "temporal",
        "embeddings",
        "eddies",
        "threads",
    ]
    assert {row.trigger for row in rows} == {VaultPipelineTrigger.DOCUMENT_IMPORT.value}
    assert {row.outcome for row in rows} == {VaultPipelineOutcome.COMPLETED}


@pytest.mark.asyncio
async def test_an_import_runs_the_published_classify_then_link_ladder_on_its_own_budget(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """The deep trigger classifies, prepares embeddings, then links in order."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session,
        client,
        user_id=_OWNER,
        trigger=VaultPipelineTrigger.DOCUMENT_IMPORT,
    )

    assert recorder.paths == [
        _CLASSIFICATIONS_PATH,
        _LINKS_PATH,
        _LINKS_PATH,
        _LINKS_PATH,
        _LINKS_PATH,
    ]
    assert recorder.pipeline_bodies == [
        {"method": "llm"},
        {"method": "temporal"},
        {"method": "embeddings"},
        {"method": "eddies"},
        {"method": "threads"},
    ]

    classification_schema = _schema("ClassificationRequest")
    link_schema = _schema("LinkRequest")
    classification_schema.validate(recorder.pipeline_bodies[0])
    for body in recorder.pipeline_bodies[1:]:
        link_schema.validate(body)

    for request in recorder.requests:
        assert request.headers["X-Creek-Contract-Version"] == CONTRACT_MINOR
        assert request.headers["X-Creek-Tier-Ceiling"] == "personal"

    budgets = [request.extensions["timeout"]["read"] for request in recorder.requests]
    assert budgets[3] > _ORDINARY_READ_BUDGET_SECONDS
    assert budgets[4] > _ORDINARY_READ_BUDGET_SECONDS

    rows = await _rows(db_session)
    assert [row.stage for row in rows] == [
        VaultPipelineStage.CLASSIFY,
        VaultPipelineStage.TEMPORAL,
        VaultPipelineStage.EMBEDDINGS,
        VaultPipelineStage.EDDIES,
        VaultPipelineStage.THREADS,
    ]
    assert {row.outcome for row in rows} == {VaultPipelineOutcome.COMPLETED}
    assert rows[0].fragments_seen == 12
    assert rows[0].fragments_touched == 10
    assert rows[0].fragments_lost == 0


@pytest.mark.asyncio
async def test_a_journal_save_never_reaches_an_embedding_stage(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """The write path runs the cheap half only, and under the ordinary budget."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    assert recorder.pipeline_bodies == [{"method": "llm"}, {"method": "temporal"}]
    for request in recorder.requests:
        assert request.extensions["timeout"]["read"] <= _ORDINARY_READ_BUDGET_SECONDS


@pytest.mark.asyncio
async def test_a_vault_that_never_advertised_pipeline_is_never_dialled(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
) -> None:
    """A vault whose capability document omits pipeline costs no request and no row."""

    class _NoPipeline(_Recorder):
        def __call__(self, request: httpx.Request) -> httpx.Response:
            if request.url.path == _CAPABILITIES_PATH:
                self.requests.append(request)
                self.bodies.append(None)
                document = _example("capabilities", "success")
                document["capabilities"] = [
                    name for name in document["capabilities"] if name != "pipeline"
                ]
                return httpx.Response(200, json=document)
            return super().__call__(request)

    recorder = _NoPipeline()
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(recorder))
    await client.handshake()
    recorder.requests.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert recorder.requests == []
    assert await _rows(db_session) == []


@pytest.mark.asyncio
async def test_a_vault_less_user_makes_no_extra_call_and_writes_no_row(
    db_session: AsyncSession,
) -> None:
    """The local fallback answers the gate without a socket or a row."""
    await drive_vault_pipeline(
        db_session,
        LocalFallbackCreekVaultClient(),
        user_id=_OWNER,
        trigger=VaultPipelineTrigger.DOCUMENT_IMPORT,
    )

    assert await _rows(db_session) == []


@pytest.mark.asyncio
async def test_the_local_fallback_refuses_both_pipeline_calls() -> None:
    """Neither pipeline call has a local implementation to fall back to."""
    client = LocalFallbackCreekVaultClient()

    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.classify_corpus()
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.link_corpus(VaultLinkStage.TEMPORAL)


@pytest.mark.asyncio
async def test_a_durable_status_read_is_counted_as_its_own_pipeline_attempt(
    http_clients: Callable[[_RecorderLike], httpx.AsyncClient],
    handshaken: Callable[[_RecorderLike, httpx.AsyncClient], Any],
) -> None:
    """Admission and status are two real calls, so telemetry must see both."""
    recorder = _DurableJobRecorder()
    client = await handshaken(recorder, http_clients(recorder))
    reset_vault_telemetry_for_tests()
    try:
        admitted = await client.classify_corpus()
        assert isinstance(admitted, VaultPipelineJob)
        await client.pipeline_job(admitted)

        assert vault_outcome_counts() == {
            (VaultTelemetryOutcome.SUCCESS, CreekCapability.PIPELINE): 2
        }
    finally:
        reset_vault_telemetry_for_tests()


@pytest.mark.asyncio
async def test_a_second_write_inside_the_debounce_window_opens_no_socket(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A stage that ran a moment ago is not run again on the next trigger."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )
    first = len(recorder.requests)
    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    assert len(recorder.requests) == first
    assert len(await _rows(db_session)) == first


@pytest.mark.asyncio
async def test_the_debounce_is_per_user(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """One account's recent pass does not stand down another account's."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )
    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER + 1, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert {row.user_id for row in rows} == {_OWNER, _OWNER + 1}


@pytest.mark.asyncio
async def test_a_link_stage_never_runs_before_a_classification_landed(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed classification leaves the link stages unrun: threads reads its labels."""
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", 0.001)
    refusal = httpx.Response(503, json=_example("pipeline", "unavailable-service"))
    recorder = _Recorder(classification=refusal)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )
    await _wait_for_background_pipeline()

    assert recorder.paths == [_CLASSIFICATIONS_PATH] * 3
    rows = await _rows(db_session)
    assert [row.stage for row in rows] == [VaultPipelineStage.CLASSIFY]
    assert rows[0].outcome == VaultPipelineOutcome.AMBIGUOUS
    assert rows[0].attempt_count == 3


@pytest.mark.asyncio
async def test_a_failed_stage_retries_off_request_then_allows_independent_successors(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed linker exhausts bounded retries without starving later stages."""
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", 0.001)

    def _fail_eddies(stage: str) -> httpx.Response:
        if stage == VaultLinkStage.EDDIES.value:
            return httpx.Response(503, json=_example("pipeline", "unavailable-service"))
        return httpx.Response(200, json=_link_body(stage))

    recorder = _Recorder(link=_fail_eddies)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )
    await _wait_for_background_pipeline()

    assert recorder.pipeline_bodies == [
        {"method": "llm"},
        {"method": "temporal"},
        {"method": "embeddings"},
        {"method": "eddies"},
        {"method": "eddies"},
        {"method": "eddies"},
        {"method": "threads"},
    ]
    rows = await _rows(db_session)
    assert [(row.stage, row.outcome) for row in rows] == [
        (VaultPipelineStage.CLASSIFY, VaultPipelineOutcome.COMPLETED),
        (VaultPipelineStage.TEMPORAL, VaultPipelineOutcome.COMPLETED),
        (VaultPipelineStage.EMBEDDINGS, VaultPipelineOutcome.COMPLETED),
        (VaultPipelineStage.EDDIES, VaultPipelineOutcome.AMBIGUOUS),
        (VaultPipelineStage.THREADS, VaultPipelineOutcome.COMPLETED),
    ]


@pytest.mark.asyncio
async def test_a_stage_that_just_failed_is_not_retried_on_the_next_pass(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed attempt sets the stage's stamp, so the next pass stands it down too.

    The interval covers failures as well as successes, and that is what stops a
    vault refusing one stage from being asked again by every request that
    arrives afterwards. The stages whose windows have reopened still run.
    """
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", 0.001)

    def _fail_eddies(stage: str) -> httpx.Response:
        if stage == VaultLinkStage.EDDIES.value:
            return httpx.Response(503, json=_example("pipeline", "unavailable-service"))
        return httpx.Response(200, json=_link_body(stage))

    recorder = _Recorder(link=_fail_eddies)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )
    await _wait_for_background_pipeline()
    await _age_rows(db_session, only={VaultPipelineStage.CLASSIFY, VaultPipelineStage.TEMPORAL})
    recorder.requests.clear()
    recorder.bodies.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert {body["method"] for body in recorder.pipeline_bodies} == {"llm", "temporal"}


async def _age_rows(session: AsyncSession, *, only: set[VaultPipelineStage]) -> None:
    """Push the named stages' rows far enough back to reopen their windows."""
    for row in await _rows(session):
        if row.stage in only:
            row.ran_at = datetime.now(UTC) - timedelta(days=7)
            session.add(row)
    await session.commit()


@pytest.mark.asyncio
async def test_an_incomplete_classification_is_not_a_failure(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """``complete: false`` means call again, not that the pass failed."""
    body = _example("pipeline", "success")
    body["complete"] = False
    body["method"] = "llm"
    recorder = _Recorder(classification=httpx.Response(200, json=body))
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert rows[0].outcome == VaultPipelineOutcome.INCOMPLETE
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_zero_privacy_tiers_assigned_is_the_expected_answer(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A network-seeded corpus derives no tiers, and that is a completed pass."""
    assert _example("pipeline", "success")["privacy_tiers_assigned"] == 0
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert rows[0].outcome == VaultPipelineOutcome.COMPLETED


@pytest.mark.asyncio
async def test_oversized_discarded_is_recorded_as_the_data_loss_it_is(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """Fragments dropped to noise are counted, not folded away."""

    def _lossy(stage: str) -> httpx.Response:
        body = _link_body(stage)
        body["oversized_discarded"] = 3
        return httpx.Response(200, json=body)

    recorder = _Recorder(link=_lossy)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert rows[1].fragments_lost == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["complete", "total", "method", "tier_ceiling", "status"])
async def test_a_classification_missing_a_required_field_is_a_payload_error(
    missing: str,
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A 2xx body short one published field is refused, not completed with a default."""
    body = _example("pipeline", "success")
    del body[missing]
    recorder = _Recorder(classification=httpx.Response(200, json=body))
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert [row.outcome for row in rows] == [VaultPipelineOutcome.FAILED]


@pytest.mark.asyncio
async def test_a_boolean_in_a_count_field_is_a_payload_error(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """``True`` is an ``int`` in Python and is not a count on this wire."""
    body = _example("pipeline", "success")
    body["total"] = True
    recorder = _Recorder(classification=httpx.Response(200, json=body))
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    assert [row.outcome for row in await _rows(db_session)] == [VaultPipelineOutcome.FAILED]


@pytest.mark.asyncio
async def test_a_wider_echoed_ceiling_than_adepthood_accepts_is_refused(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A vault that says it ran wider than adepthood authorized is not believed."""
    body = _example("pipeline", "success")
    body["tier_ceiling"] = "intimate"
    recorder = _Recorder(classification=httpx.Response(200, json=body))
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    assert [row.outcome for row in await _rows(db_session)] == [VaultPipelineOutcome.FAILED]


@pytest.mark.asyncio
async def test_a_link_response_echoing_another_stage_is_refused(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """The echoed method is what correlates the answer with the stage that was asked for."""
    recorder = _Recorder(link=lambda _stage: httpx.Response(200, json=_link_body("threads")))
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert rows[1].outcome == VaultPipelineOutcome.FAILED


def test_the_link_stage_vocabulary_is_exactly_creeks() -> None:
    """Every published linker method, including durable embeddings, is constructible."""
    published = json.loads(
        (_BUNDLE / "schemas" / "LinkRequest.schema.json").read_text(encoding="utf-8")
    )
    assert [stage.value for stage in VaultLinkStage] == published["$defs"]["LinkMethod"]["enum"]


@pytest.mark.asyncio
async def test_no_pipeline_request_can_spell_retier(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """Re-deriving a tier the operator settled is not adepthood's decision to make."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    assert "retier" not in recorder.pipeline_bodies[0]


def test_the_stage_ladder_runs_classification_first_and_the_documented_link_order() -> None:
    """Creek documents classify, temporal, embeddings, eddies, then threads."""
    assert pipeline.LADDER == (
        VaultPipelineStage.CLASSIFY,
        VaultPipelineStage.TEMPORAL,
        VaultPipelineStage.EMBEDDINGS,
        VaultPipelineStage.EDDIES,
        VaultPipelineStage.THREADS,
    )


def test_every_link_stage_has_a_wire_spelling_and_classification_has_none() -> None:
    """The ladder's one non-link stage is expressed by absence, not by a branch."""
    mapping: Mapping[VaultPipelineStage, VaultLinkStage] = pipeline.LINK_STAGE_BY_PIPELINE_STAGE
    assert set(mapping) == set(pipeline.LADDER) - {VaultPipelineStage.CLASSIFY}
    assert set(mapping.values()) == set(VaultLinkStage)


@pytest.mark.asyncio
async def test_no_stage_starts_once_the_run_budget_is_spent(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Don't start what won't finish: a spent budget opens no socket at all.

    The rule that bounds what one document import may cost. With the whole
    budget already gone, the ladder must decline to begin rather than start a
    stage it cannot afford and let the request run over.
    """
    monkeypatch.setattr(pipeline, "_DEEP_RUN_BUDGET_SECONDS", 0.0)
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert recorder.requests == []
    assert await _rows(db_session) == []


@pytest.mark.asyncio
async def test_a_vault_whose_classification_keeps_failing_never_clusters_unlabelled_text(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A failed classification inside its own window leaves the link stages unrun.

    The case the ladder's ordering alone does not cover: on the *second* pass the
    classification window has not reopened, so classification is skipped rather
    than failed -- and the clustering stages must still stand down, because the
    APTITUDE labels they read were never written.
    """
    refusal = httpx.Response(503, json=_example("pipeline", "unavailable-service"))
    recorder = _Recorder(classification=refusal)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )
    recorder.requests.clear()
    recorder.bodies.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert recorder.requests == []
    assert len(await _rows(db_session)) == 1


@pytest.mark.asyncio
async def test_a_database_that_will_not_record_the_pass_costs_the_caller_nothing(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pass runs after somebody's entry is committed, so it may never raise."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    async def _refuse() -> None:
        raise OperationalError("INSERT", {}, Exception("disk is full"))

    monkeypatch.setattr(db_session, "commit", _refuse)

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )


@pytest.mark.asyncio
async def test_a_busy_journal_does_not_reopen_the_clustering_window(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A clustering stage's stamp is found however many cheap attempts came after it.

    The cheap stages run every fifteen minutes on an active account, so they
    accumulate rows far faster than the clustering stages do. If the scheduler
    reads "the newest few rows" instead of "the newest row per stage", an hour of
    ordinary journalling buries the clustering stages' stamps, they read as
    never-run, and their six-hour interval reopens on an account that did nothing
    but write.
    """
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))
    recent = datetime.now(UTC) - timedelta(minutes=1)
    db_session.add(
        VaultPipelineRun(
            user_id=_OWNER,
            stage=VaultPipelineStage.EDDIES.value,
            outcome=VaultPipelineOutcome.COMPLETED.value,
            fragments_seen=1,
            fragments_touched=1,
            fragments_lost=0,
            ran_at=recent,
        )
    )
    for stage in (VaultPipelineStage.CLASSIFY, VaultPipelineStage.TEMPORAL):
        for _ in range(6):
            db_session.add(
                VaultPipelineRun(
                    user_id=_OWNER,
                    stage=stage.value,
                    outcome=VaultPipelineOutcome.COMPLETED.value,
                    fragments_seen=1,
                    fragments_touched=1,
                    fragments_lost=0,
                    ran_at=datetime.now(UTC) - timedelta(days=1),
                )
            )
    await db_session.commit()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert "eddies" not in {body["method"] for body in recorder.pipeline_bodies}


@pytest.mark.asyncio
async def test_no_database_connection_is_held_across_a_vault_round_trip(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """The pass must not hold a pooled connection while it waits on the network.

    A Session autobegins on its first ``execute`` and stays in that transaction
    across every later ``await`` -- and an open transaction is a checked-out
    pool connection. The engine runs on SQLAlchemy's defaults, five plus ten
    overflow, so fifteen concurrent passes against a slow vault would hold every
    connection in the pool for the length of a network climb and the next
    request to *any* database-backed endpoint would block on checkout.

    This is the invariant ``_record_vault_outcome`` already declares and
    protects by committing before it dials; the pass runs immediately after that
    mitigation and must not undo it.
    """
    in_transaction: list[bool] = []

    class _Watching(_Recorder):
        def __call__(self, request: httpx.Request) -> httpx.Response:
            if request.url.path in {_CLASSIFICATIONS_PATH, _LINKS_PATH}:
                in_transaction.append(db_session.in_transaction())
            return super().__call__(request)

    recorder = _Watching()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert in_transaction, "no pipeline call was observed"
    assert not any(in_transaction)


@pytest.mark.asyncio
async def test_a_journal_save_is_bounded_by_a_wall_clock_not_by_a_read_phase(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The write path's cost is bounded in elapsed time, which is the claim that matters.

    httpx's ``read`` budget restarts on every socket read, so it is a floor on
    how long a call may take rather than a ceiling -- a test that asserts on it
    would pass unchanged while a trickling vault held somebody's journal save
    open for minutes. Elapsed wall-clock time is the only assertion that can
    support "the write path acquires no new latency class".
    """
    monkeypatch.setattr(pipeline, "_JOURNAL_RUN_BUDGET_SECONDS", 0.2)
    monkeypatch.setattr(pipeline, "_LEAST_WORTH_STARTING_SECONDS", 0.05)
    slow = _SlowRecorder(delay=0.5)
    http = httpx.AsyncClient(transport=httpx.MockTransport(slow))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
    await client.handshake()

    started = time.monotonic()
    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )
    elapsed = time.monotonic() - started
    await http.aclose()

    assert elapsed < 0.45
    # Non-vacuous: the bound cut a call short rather than declining to make one.
    assert any(request.url.path == _CLASSIFICATIONS_PATH for request in slow.requests)


@pytest.mark.asyncio
async def test_a_failing_cheap_rung_does_not_starve_the_clustering_stages(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A link stage that keeps failing must not block the ones behind it forever.

    The cheap stages carry a fifteen-minute interval and the clustering stages
    six hours, so a rung that fails on essentially every pass is due again long
    before the stages behind it are -- and a ladder that stops at the first
    failure would retry it first, fail again, and stop again, on every pass for
    good. Classification is the one genuine prerequisite; the three linker
    stages are independent of each other.
    """
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", 0.001)

    def _fail_temporal(stage: str) -> httpx.Response:
        if stage == VaultLinkStage.TEMPORAL.value:
            return httpx.Response(503, json=_example("pipeline", "unavailable-service"))
        return httpx.Response(200, json=_link_body(stage))

    recorder = _Recorder(link=_fail_temporal)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )
    await _wait_for_background_pipeline()

    assert {body["method"] for body in recorder.pipeline_bodies} == {
        "llm",
        "temporal",
        "embeddings",
        "eddies",
        "threads",
    }
