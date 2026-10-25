"""The writer's key on a document import and a journal save, at the HTTP edge (#3437).

``POST /corpus/import`` and ``POST /journal/`` hand a vault new writing, and
the classification pass that onboards it is the one call of theirs that may
carry the writer's own key: never the upload or the journal upsert. Driven
through the real HTTP adapter against a scripted managed vault, so the headers
asserted are the ones a socket would have carried.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import Final
from uuid import UUID

import pytest
import pytest_asyncio
from httpx import AsyncClient, MockTransport, Request, Response
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekVaultPipelineClient,
    VaultKeyProvider,
    VaultPipelineStage,
    VaultProviderKey,
)
from main import app
from models.user import User
from models.vault_pipeline_follow_up import VaultPipelineFollowUp
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services import creek_vault_pipeline as pipeline
from services.botmason import LLM_API_KEY_MAX_LENGTH
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_pipeline import VaultPipelineTrigger, wait_for_vault_pipeline_tasks
from services.creek_vault_pipeline import _Continuation as PipelineContinuation
from services.creek_vault_pipeline import _forget_background_task as forget_background_task
from services.creek_vault_pipeline import _RunResult as PipelineRunResult
from services.creek_vault_pipeline import _schedule_continuation as schedule_continuation
from services.creek_vault_pipeline import _start_queued_run as start_queued_run
from services.creek_vault_relay import (
    PROVIDER_HEADER,
    PROVIDER_KEY_HEADER,
    forwarding_provider_key,
    has_forwarded_provider_key,
)
from tests.provider_transport import ANTHROPIC_KEY

_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_BYOK_HEADER: Final = "X-LLM-API-Key"
_CLASSIFICATIONS: Final = "/v1/classifications"
_UPLOADS: Final = "/v1/uploads"
_JOURNAL_ENTRIES: Final = "/v1/journal-entries/"
_MINOR: Final = ".".join(CONTRACT_VERSION.split(".")[:2])
#: Longer than the header limit the reading routes enforce, and shaped like a key.
_OVERLONG_KEY: Final = "sk-ant-api03-" + "x" * LLM_API_KEY_MAX_LENGTH


def _counts(**extra: object) -> dict[str, object]:
    return {"status": "ok", "tier_ceiling": "personal", **extra}


_CLASSIFIED: Final = _counts(
    method="llm",
    total=1,
    classified=1,
    preserved_manual=0,
    preserved_llm=0,
    privacy_tiers_assigned=0,
    retiered=0,
    praxis_marked=0,
    tags_extracted=1,
    complete=True,
)


def _linked(method: str) -> dict[str, object]:
    return _counts(
        method=method,
        fragment_count=1,
        link_count=1,
        largest_cluster_fragments=1,
        clusters_split=0,
        oversized_discarded=0,
    )


@dataclass
class _ManagedVault:
    """A managed vault that spends Anthropic and OpenAI keys, recording each send's key."""

    sends: list[tuple[str, str | None]] = field(default_factory=list)
    providers: tuple[str, ...] = ("anthropic", "openai")

    def keyed(self) -> list[str]:
        """The paths of every send that carried a writer's key."""
        return [path for path, key in self.sends if key is not None]

    def paths(self) -> list[str]:
        """The paths of every send, keyed or not."""
        return [path for path, _key in self.sends]

    def __call__(self, request: Request) -> Response:
        path = request.url.path
        self.sends.append((path, request.headers.get(PROVIDER_KEY_HEADER)))
        return Response(HTTPStatus.OK, json=self._answer(path, request))

    def _answer(self, path: str, request: Request) -> Mapping[str, object]:
        if path == "/v1/capabilities":
            return {
                "vault": {"available": True},
                "capabilities": ["capabilities", "journal-upsert", "upload", "pipeline"],
                "contract_version": CONTRACT_VERSION,
                "contract_minor": _MINOR,
                "supported_contract_minors": [_MINOR],
                "request_key_providers": list(self.providers),
                "ontology_version": "1.0.0",
                "attestation": None,
            }
        if path == _UPLOADS:
            external_id = json.loads(request.content)["external_id"]
            return {
                "status": "ok",
                "action": "created",
                "external_id": external_id,
                "fragment_id": "frag-document-1",
                "affected_fragment_ids": ["frag-document-1"],
                "source_type": "document",
                "tier_ceiling": "personal",
            }
        if path.startswith(_JOURNAL_ENTRIES):
            tier = json.loads(request.content)["tier"]
            return {
                "status": "ok",
                "action": "created",
                "external_id": path.removeprefix(_JOURNAL_ENTRIES),
                "fragment_id": "frag-journal-1",
                "tier": tier,
                "tier_ceiling": "personal",
            }
        if path == _CLASSIFICATIONS:
            return _CLASSIFIED
        return _linked(str(json.loads(request.content)["method"]))


@dataclass
class _ManagedJobVault:
    """Admit durable classification, retaining the request's source only inside the fake worker."""

    peer: _ManagedVault = field(default_factory=_ManagedVault)
    release_jobs: asyncio.Event = field(default_factory=asyncio.Event)
    sources: dict[str, str] = field(default_factory=dict)
    before_first_classification: Callable[[], Awaitable[None]] | None = None
    admission_failure: HTTPStatus | None = None

    async def __call__(self, request: Request) -> Response:
        """Return a handle immediately; hold job status until the originating request is over."""
        if request.url.path.startswith("/v1/jobs/"):
            self.peer.sends.append((request.url.path, request.headers.get(PROVIDER_KEY_HEADER)))
            await self.release_jobs.wait()
            source = self.sources[request.url.path.rsplit("/", 1)[-1]]
            return Response(
                HTTPStatus.OK,
                json={
                    "status": "ok",
                    "job_id": request.url.path.rsplit("/", 1)[-1],
                    "state": "succeeded",
                    "result": {**_CLASSIFIED, "inference_source": source},
                },
            )
        response = self.peer(request)
        if request.url.path != _CLASSIFICATIONS:
            return response
        if self.admission_failure is not None:
            return Response(
                self.admission_failure,
                json=(
                    {"detail": "unauthorized"}
                    if self.admission_failure == HTTPStatus.UNAUTHORIZED
                    else {"code": "unavailable", "message": "no", "request_id": "req-admission"}
                ),
            )
        provider = request.headers.get(PROVIDER_HEADER)
        source = f"request_key:{provider}" if provider is not None else "local"
        if not self.sources and self.before_first_classification is not None:
            await self.before_first_classification()
            self.sources["synchronous"] = source
            return Response(HTTPStatus.OK, json={**_CLASSIFIED, "inference_source": source})
        job_id = str(UUID(int=len(self.sources) + 1, version=4))
        self.sources[job_id] = source
        return Response(
            HTTPStatus.ACCEPTED,
            json={"status": "accepted", "job_id": job_id, "state": "queued"},
        )


@pytest_asyncio.fixture
async def managed_vault() -> AsyncIterator[_ManagedVault]:
    """Install a real HTTP vault client, over a scripted managed vault, for one test."""
    script = _ManagedVault()
    async with AsyncClient(transport=MockTransport(script)) as http:
        client = HttpCreekVaultClient(
            "https://vault.example.test", "vault-key", http_client=http, pin_destination=False
        )
        app.dependency_overrides[get_creek_vault_client] = lambda: client
        try:
            yield script
            await wait_for_vault_pipeline_tasks()
        finally:
            app.dependency_overrides.pop(get_creek_vault_client, None)


@pytest_asyncio.fixture
async def managed_jobs() -> AsyncIterator[_ManagedJobVault]:
    """Keep the real adapter and detached polling path live without real network calls."""
    script = _ManagedJobVault()
    async with AsyncClient(transport=MockTransport(script)) as http:
        client = HttpCreekVaultClient(
            "https://vault.example.test", "vault-key", http_client=http, pin_destination=False
        )
        app.dependency_overrides[get_creek_vault_client] = lambda: client
        try:
            yield script
        finally:
            script.release_jobs.set()
            await wait_for_vault_pipeline_tasks()
            app.dependency_overrides.pop(get_creek_vault_client, None)


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    response = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _owner_id(session: AsyncSession, username: str) -> int:
    """Read the signed-up account's identity for a pre-existing queued snapshot."""
    result = await session.execute(select(User.id).where(User.email == f"{username}@example.com"))
    user_id = result.scalar_one()
    assert isinstance(user_id, int)
    return user_id


async def _queue_classification(session: AsyncSession, user_id: int) -> None:
    """Persist an unstarted promise, as a previous terminalizer or startup can leave."""
    session.add(
        VaultPipelineRun(
            user_id=user_id,
            stage="classify",
            trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
            outcome=VaultPipelineOutcome.QUEUED.value,
            attempt_count=0,
            fragments_seen=0,
            fragments_touched=0,
            fragments_lost=0,
        )
    )
    await session.commit()


def _document() -> dict[str, str]:
    return {
        "filename": "field-notes.md",
        "content_base64": base64.b64encode(b"the willow bent").decode("ascii"),
        "classification": "personal",
    }


@pytest.mark.asyncio
async def test_an_import_relays_the_key_to_classification_and_never_to_the_upload(
    async_client: AsyncClient, managed_vault: _ManagedVault
) -> None:
    """The import's own classification pass is keyed; the document's upload is not."""
    headers = await _signup(async_client, "import_relay")

    response = await async_client.post(
        "/corpus/import", json=_document(), headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY}
    )
    await wait_for_vault_pipeline_tasks()

    assert response.status_code == HTTPStatus.ACCEPTED, response.text
    assert _UPLOADS in managed_vault.paths(), managed_vault.sends
    assert managed_vault.keyed() == [_CLASSIFICATIONS], managed_vault.sends
    assert {key for _path, key in managed_vault.sends if key} == {ANTHROPIC_KEY}
    assert ANTHROPIC_KEY not in response.text


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/corpus/import", _document()),
        ("/journal/", {"message": "the willow bent", "classification": "personal"}),
    ],
    ids=["import", "journal-save"],
)
@pytest.mark.asyncio
async def test_an_overlong_key_header_never_fails_the_save(
    async_client: AsyncClient, managed_vault: _ManagedVault, path: str, body: dict[str, str]
) -> None:
    """A key header past the length limit is ignored: the writing is kept, nothing relayed."""
    headers = await _signup(async_client, f"overlong_{path.strip('/').replace('/', '_')}")

    response = await async_client.post(
        path, json=body, headers={**headers, _BYOK_HEADER: _OVERLONG_KEY}
    )
    await wait_for_vault_pipeline_tasks()

    assert response.status_code in {HTTPStatus.CREATED, HTTPStatus.ACCEPTED}, response.text
    assert managed_vault.keyed() == [], managed_vault.sends
    assert _OVERLONG_KEY not in response.text
    assert _OVERLONG_KEY[:40] not in response.text


@pytest.mark.asyncio
async def test_a_journal_save_admits_queued_classification_with_its_key_before_handoff(
    async_client: AsyncClient, db_session: AsyncSession, managed_jobs: _ManagedJobVault
) -> None:
    """The keyless continuation must inherit a durable handle, never an unstarted keyed submit."""
    headers = await _signup(async_client, "queued_relay")
    user_id = await _owner_id(db_session, "queued_relay")
    await _queue_classification(db_session, user_id)

    response = await async_client.post(
        "/journal/",
        json={"message": "the willow bent", "classification": "personal"},
        headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY},
    )

    assert response.status_code == HTTPStatus.CREATED, response.text
    assert managed_jobs.peer.keyed() == [_CLASSIFICATIONS], managed_jobs.peer.sends
    assert {key for _path, key in managed_jobs.peer.sends if key} == {ANTHROPIC_KEY}
    rows = await db_session.execute(
        select(VaultPipelineRun).where(VaultPipelineRun.user_id == user_id)
    )
    run = rows.scalars().one()
    assert run.job_id is not None
    assert run.job_id in managed_jobs.sources
    assert managed_jobs.sources[run.job_id] == "request_key:anthropic"
    assert run.outcome == VaultPipelineOutcome.ATTEMPTED.value
    assert run.attempt_count == 1
    managed_jobs.release_jobs.set()
    await wait_for_vault_pipeline_tasks()
    assert len([path for path, _key in managed_jobs.peer.sends if path == _CLASSIFICATIONS]) == 1
    assert all(key is None for path, key in managed_jobs.peer.sends if path.startswith("/v1/jobs/"))


@pytest.mark.asyncio
async def test_a_due_keyed_classification_is_admitted_even_after_the_polling_clock_is_spent(
    async_client: AsyncClient,
    managed_jobs: _ManagedJobVault,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A spent foreground polling budget does not spend the writer's one key opportunity."""
    headers = await _signup(async_client, "spent_clock_relay")
    monkeypatch.setattr(pipeline, "_JOURNAL_RUN_BUDGET_SECONDS", 0.0)
    caplog.set_level(logging.INFO, logger=pipeline.__name__)

    response = await async_client.post(
        "/journal/",
        json={"message": "the willow bent", "classification": "personal"},
        headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY},
    )

    assert response.status_code == HTTPStatus.CREATED, response.text
    assert managed_jobs.peer.keyed() == [_CLASSIFICATIONS], managed_jobs.peer.sends
    assert list(managed_jobs.sources.values()) == ["request_key:anthropic"]
    assert {key for _path, key in managed_jobs.peer.sends if key} == {ANTHROPIC_KEY}
    assert "creek vault pipeline job admitted; polling deferred" in caplog.messages
    assert "creek vault pipeline stage did not land" not in caplog.messages
    assert ANTHROPIC_KEY not in caplog.text


@pytest.mark.asyncio
async def test_a_fresh_follow_up_is_admitted_before_the_keyed_request_ends(
    async_client: AsyncClient, db_session: AsyncSession, managed_jobs: _ManagedJobVault
) -> None:
    """A write arriving after the first snapshot is included in a keyed successor, once."""
    headers = await _signup(async_client, "follow_up_relay")
    user_id = await _owner_id(db_session, "follow_up_relay")

    async def _another_write_arrived() -> None:
        """Simulate durable new-writing intent while the first classification is in flight."""
        db_session.add(
            VaultPipelineFollowUp(user_id=user_id, trigger=VaultPipelineTrigger.JOURNAL_WRITE.value)
        )
        await db_session.commit()

    managed_jobs.before_first_classification = _another_write_arrived
    response = await async_client.post(
        "/journal/",
        json={"message": "the willow bent", "classification": "personal"},
        headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY},
    )

    assert response.status_code == HTTPStatus.CREATED, response.text
    assert managed_jobs.peer.keyed() == [_CLASSIFICATIONS, _CLASSIFICATIONS], (
        managed_jobs.peer.sends
    )
    assert list(managed_jobs.sources.values()) == ["request_key:anthropic", "request_key:anthropic"]
    managed_jobs.release_jobs.set()
    await wait_for_vault_pipeline_tasks()
    assert len([path for path, _key in managed_jobs.peer.sends if path == _CLASSIFICATIONS]) == 2


@pytest.mark.parametrize("providers", [("anthropic",), ("openai",)])
@pytest.mark.parametrize("key", [None, ANTHROPIC_KEY], ids=["absent", "provided"])
@pytest.mark.asyncio
async def test_queued_admission_relays_only_a_present_eligible_provider_key(
    async_client: AsyncClient,
    db_session: AsyncSession,
    managed_jobs: _ManagedJobVault,
    providers: tuple[str, ...],
    key: str | None,
) -> None:
    """Admission timing never widens the adapter's eligible-vendor send boundary."""
    managed_jobs.peer.providers = providers
    headers = await _signup(async_client, "eligible_relay")
    user_id = await _owner_id(db_session, "eligible_relay")
    await _queue_classification(db_session, user_id)
    if key is not None:
        headers[_BYOK_HEADER] = key

    response = await async_client.post(
        "/journal/",
        json={"message": "the willow bent", "classification": "personal"},
        headers=headers,
    )
    managed_jobs.release_jobs.set()
    await wait_for_vault_pipeline_tasks()

    assert response.status_code == HTTPStatus.CREATED, response.text
    submitted = [value for path, value in managed_jobs.peer.sends if path == _CLASSIFICATIONS]
    assert submitted == [key if key is not None and "anthropic" in providers else None]
    assert all(value is None for path, value in managed_jobs.peer.sends if path != _CLASSIFICATIONS)


@pytest.mark.asyncio
async def test_a_keyed_write_never_readmits_an_active_classification_handle(
    async_client: AsyncClient, db_session: AsyncSession, managed_jobs: _ManagedJobVault
) -> None:
    """An admitted snapshot keeps its identity; later writing leaves content-free intent."""
    headers = await _signup(async_client, "active_relay")
    user_id = await _owner_id(db_session, "active_relay")
    job_id = str(UUID(int=1, version=4))
    active = VaultPipelineRun(
        user_id=user_id,
        stage="classify",
        trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
        outcome=VaultPipelineOutcome.ATTEMPTED.value,
        attempt_count=1,
        job_id=job_id,
        fragments_seen=0,
        fragments_touched=0,
        fragments_lost=0,
    )
    db_session.add(active)
    await db_session.commit()

    response = await async_client.post(
        "/journal/",
        json={"message": "the willow bent", "classification": "personal"},
        headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY},
    )

    assert response.status_code == HTTPStatus.CREATED, response.text
    assert managed_jobs.peer.keyed() == []
    assert _CLASSIFICATIONS not in managed_jobs.peer.paths()
    await db_session.refresh(active)
    assert active.job_id == job_id
    assert active.attempt_count == 1
    assert active.follow_up_trigger == VaultPipelineTrigger.JOURNAL_WRITE.value


@pytest.mark.asyncio
async def test_a_queued_synchronous_result_is_not_submitted_twice(
    async_client: AsyncClient, db_session: AsyncSession, managed_vault: _ManagedVault
) -> None:
    """Compatible immediate counts advance successors without a second admission."""
    headers = await _signup(async_client, "synchronous_relay")
    user_id = await _owner_id(db_session, "synchronous_relay")
    await _queue_classification(db_session, user_id)

    response = await async_client.post(
        "/journal/",
        json={"message": "the willow bent", "classification": "personal"},
        headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY},
    )
    await wait_for_vault_pipeline_tasks()

    assert response.status_code == HTTPStatus.CREATED, response.text
    assert managed_vault.keyed() == [_CLASSIFICATIONS], managed_vault.sends
    assert managed_vault.paths().count(_CLASSIFICATIONS) == 1


@pytest.mark.parametrize(
    "case",
    [
        (HTTPStatus.UNAUTHORIZED, VaultPipelineOutcome.FAILED, 1),
        (HTTPStatus.SERVICE_UNAVAILABLE, VaultPipelineOutcome.AMBIGUOUS, 3),
    ],
)
@pytest.mark.asyncio
async def test_only_first_admission_may_relay_the_key_when_the_vault_refuses(
    async_client: AsyncClient,
    db_session: AsyncSession,
    managed_jobs: _ManagedJobVault,
    monkeypatch: pytest.MonkeyPatch,
    case: tuple[HTTPStatus, VaultPipelineOutcome, int],
) -> None:
    """The writing survives; definitive refusal stops and uncertain retries stay keyless."""
    status, expected_outcome, attempts = case
    managed_jobs.admission_failure = status
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", 0.001)
    headers = await _signup(async_client, "refused_relay")
    user_id = await _owner_id(db_session, "refused_relay")
    await _queue_classification(db_session, user_id)

    response = await async_client.post(
        "/journal/",
        json={"message": "the willow bent", "classification": "personal"},
        headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY},
    )
    await wait_for_vault_pipeline_tasks()

    assert response.status_code == HTTPStatus.CREATED, response.text
    submitted = [key for path, key in managed_jobs.peer.sends if path == _CLASSIFICATIONS]
    assert submitted == [ANTHROPIC_KEY, *([None] * (attempts - 1))]
    rows = await db_session.execute(
        select(VaultPipelineRun).where(VaultPipelineRun.user_id == user_id)
    )
    run = rows.scalars().one()
    assert run.outcome == expected_outcome.value
    assert run.attempt_count == attempts


@pytest.mark.asyncio
async def test_an_unconfirmed_admission_log_does_not_claim_the_stage_failed(
    async_client: AsyncClient,
    managed_jobs: _ManagedJobVault,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A missing answer cannot prove either admission or rejection."""
    managed_jobs.admission_failure = HTTPStatus.SERVICE_UNAVAILABLE
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", 0.001)
    caplog.set_level(logging.INFO, logger=pipeline.__name__)
    headers = await _signup(async_client, "unconfirmed_relay")

    response = await async_client.post(
        "/journal/",
        json={"message": "the willow bent", "classification": "personal"},
        headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY},
    )
    await wait_for_vault_pipeline_tasks()

    assert response.status_code == HTTPStatus.CREATED, response.text
    assert managed_jobs.sources == {}
    assert "creek vault pipeline admission unconfirmed" in caplog.messages
    assert "creek vault pipeline job admitted; polling deferred" not in caplog.messages
    assert "creek vault pipeline stage did not land" not in caplog.messages
    assert ANTHROPIC_KEY not in caplog.text


@pytest.mark.parametrize("failures", [1, 2], ids=["recovered", "degraded"])
@pytest.mark.asyncio
async def test_scheduler_recovery_uses_the_key_only_while_the_request_can_admit(
    async_client: AsyncClient,
    db_session: AsyncSession,
    managed_jobs: _ManagedJobVault,
    monkeypatch: pytest.MonkeyPatch,
    failures: int,
) -> None:
    """A recovered queue can admit keyed; repeated DB failure still saves and recovers keyless."""
    headers = await _signup(async_client, "recovery_relay")
    user_id = await _owner_id(db_session, "recovery_relay")
    await _queue_classification(db_session, user_id)
    original = start_queued_run
    calls = 0

    async def _fail_before_admission(
        session: AsyncSession,
        client: CreekVaultPipelineClient,
        run: VaultPipelineRun,
        stage: VaultPipelineStage,
        *,
        budget: float | None = None,
    ) -> PipelineRunResult | None:
        """Fault only DB admission; never pretend a failed transaction opened a socket."""
        nonlocal calls
        calls += 1
        if calls <= failures:
            raise OperationalError("claim", {}, RuntimeError("simulated DB failure"))
        return await original(session, client, run, stage, budget=budget)

    monkeypatch.setattr(pipeline, "_start_queued_run", _fail_before_admission)
    async with asyncio.timeout(5):
        response = await async_client.post(
            "/journal/",
            json={"message": "the willow bent", "classification": "personal"},
            headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY},
        )
    managed_jobs.release_jobs.set()
    await wait_for_vault_pipeline_tasks()

    assert response.status_code == HTTPStatus.CREATED, response.text
    assert calls == failures + 1
    submitted = [key for path, key in managed_jobs.peer.sends if path == _CLASSIFICATIONS]
    assert submitted == [ANTHROPIC_KEY if failures == 1 else None]


@pytest.mark.asyncio
async def test_continuation_completion_callback_does_not_retain_the_request_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both the detached task and its delayed callback use a keyless context."""
    release = asyncio.Event()
    finished = asyncio.Event()
    observed: dict[str, bool] = {}

    async def controlled_body(_continuation: PipelineContinuation) -> None:
        """Observe only key presence, never a credential or its representation."""
        observed["body"] = has_forwarded_provider_key()
        await release.wait()

    def observe_completion(key: tuple[int, VaultPipelineStage], task: asyncio.Task[None]) -> None:
        """The callback can outlive the originating request by an arbitrary time."""
        observed["callback"] = has_forwarded_provider_key()
        forget_background_task(key, task)
        finished.set()

    monkeypatch.setattr(pipeline, "_continue_ladder", controlled_body)
    monkeypatch.setattr(pipeline, "_forget_background_task", observe_completion)
    async with AsyncClient(transport=MockTransport(_ManagedVault())) as http:
        client = HttpCreekVaultClient("https://vault.example.test", "vault-key", http_client=http)
        continuation = PipelineContinuation(
            factory=async_sessionmaker(),
            client=client,
            user_id=1,
            trigger=VaultPipelineTrigger.JOURNAL_WRITE,
            pending=PipelineRunResult(run_id=1, outcome=VaultPipelineOutcome.QUEUED),
            stage=VaultPipelineStage.CLASSIFY,
            remaining=(),
        )
        try:
            with forwarding_provider_key(
                VaultProviderKey(provider=VaultKeyProvider.ANTHROPIC, _secret=ANTHROPIC_KEY)
            ):
                assert schedule_continuation(continuation)
            release.set()
            await asyncio.wait_for(finished.wait(), 5)
            assert observed == {"body": False, "callback": False}
        finally:
            release.set()
            await pipeline.close_vault_pipeline_tasks()
