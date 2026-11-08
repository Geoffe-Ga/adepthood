"""A ``busy`` job is retried with backoff; it never forgets a key or reads as a refused one.

Creek contract 0.29 (Creek-Vault#2090) ends a durable pass that could not take
the vault content-mutation lock in time ``failed`` with ``failure_code:
"busy"``. Nothing was written and the condition is transient, so -- unlike a
refused writer key, which is final -- the run joins the same bounded retry an
unnamed failure does (``_MAX_STAGE_ATTEMPTS`` admissions, backed off):

* busy once, then a clean pass: two admissions, the run completes;
* busy on every admission: the retry is spent, and the run lands ``failed``
  with ``busy`` recorded -- the one reason the bounded retry gives up for;
* the same, on a run whose earlier admission went unanswered: ``ambiguous``
  with no reason, because that lost admission may have landed labels;
* in every case the writer's stored key survives, and Settings' "your key was
  refused" notice neither turns on nor turns off.

The ladder here reads each busy job as a 0.29 poll would (``_BusyReadingClient``),
so the bounded retry is pinned independently of how the job-status poll
negotiates its minor. Synthetic throughout: no real key, no journal content.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from http import HTTPStatus
from pathlib import Path
from typing import Final
from uuid import UUID

import httpx
import pytest
import pytest_asyncio
from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import OWNER_ENV_VAR
from domain.creek_vault import (
    VaultClassificationPass,
    VaultJobFailureCode,
    VaultLinkPass,
    VaultPipelineJob,
    VaultPipelineJobState,
    VaultPipelineStage,
)
from models.user import User
from models.vault_classification_key import VaultClassificationKey
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services import creek_vault_pipeline as pipeline
from services import journal_encryption
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_pipeline import _MAX_STAGE_ATTEMPTS as MAX_STAGE_ATTEMPTS
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline
from services.creek_vault_pipeline_results import StageCounts, poll_needs_reconciliation
from services.user_vault_config import store_vault_config
from services.vault_classification_key import forget_if_rejected
from services.vault_classification_status import classification_status

_FIXTURES: Final = Path(__file__).parent / "fixtures"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "busy-retry-vault-credential"  # pragma: allowlist secret
_WRITER_KEY: Final = "sk-ant-api03-BUSYretryCANARYwriterKEYAAAA"  # pragma: allowlist secret
_UNUSED_HASH: Final = "not-a-real-hash"  # pragma: allowlist secret
_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_OWNER: Final = 1
_CLASSIFICATIONS: Final = "/v1/classifications"
_JOBS: Final = "/v1/jobs/"
_BUSY: Final = "busy"
_REJECTED: Final = "request_key_rejected"
_FAST: Final = 0.001
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"
_NO_MINOR: Final = "0.0"
#: Creek's own gates, as literals: the ``failure_code`` key (0.26) and ``busy`` (0.29).
_FAILURE_CODE_KEY_SINCE: Final = (0, 26)
_BUSY_SINCE: Final = (0, 29)
#: Enough busy admissions to outlast any bounded retry.
_ALWAYS: Final = 99
_CONNECTION_PATH: Final = "/vault/connection"
_CONNECTED_VAULT_URL: Final = "https://vault.example.com"
_CONNECTED_VAULT_KEY: Final = "vault-key-3710"  # pragma: allowlist secret


def _capabilities() -> dict[str, object]:
    """The published 0.29 handshake."""
    path = _FIXTURES / "creek_jobs_v029" / "examples" / "capabilities" / "success.json"
    loaded: dict[str, object] = json.loads(path.read_bytes())
    return loaded


def _classified() -> dict[str, object]:
    """A published counts-only classification result, from an ``llm`` pass."""
    path = _FIXTURES / "creek_v1" / "examples" / "pipeline" / "success.json"
    loaded: dict[str, object] = json.loads(path.read_bytes())
    loaded["method"] = "llm"
    return loaded


def _linked(method: str) -> dict[str, object]:
    """A published counts-only link result for ``method``."""
    path = _FIXTURES / "creek_v1" / "examples" / "pipeline" / "empty.json"
    loaded: dict[str, object] = json.loads(path.read_bytes())
    loaded["method"] = method
    return loaded


def _minor(text: str) -> tuple[int, ...]:
    """A declared ``"0.29"``-style minor as comparable integers."""
    return tuple(int(part) for part in text.split("."))


class _LadderVault:
    """A vault whose first ``busy_passes`` admitted classification jobs meet lock contention.

    Each admission gets its own job. A busy job stays failed on every poll, and
    names its reason exactly as Creek does: ``busy`` to a poll declaring 0.29 or
    later, ``null`` at 0.26-0.28, and no key at all below 0.26.
    """

    def __init__(self, *, busy_passes: int, lose_first_admission: bool = False) -> None:
        """Script how many admitted jobs end busy, and whether the first admission is lost."""
        self.submissions = 0
        self.busy_jobs: set[str] = set()
        self._busy_passes = busy_passes
        self._lose_first_admission = lose_first_admission

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer the handshake, admissions, polls and synchronous link stages."""
        path = request.url.path
        if path == "/v1/capabilities":
            return httpx.Response(HTTPStatus.OK, json=_capabilities())
        if path == _CLASSIFICATIONS:
            return self._admit()
        if path.startswith(_JOBS):
            return self._status(path.removeprefix(_JOBS), request.headers)
        return httpx.Response(HTTPStatus.OK, json=_linked(json.loads(request.content)["method"]))

    def _admit(self) -> httpx.Response:
        """Admit one pass as its own job, unless this is the admission whose answer is lost."""
        self.submissions += 1
        if self._lose_first_admission and self.submissions == 1:
            return httpx.Response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                json={"code": "temporarily_unavailable", "message": "no", "request_id": "r"},
            )
        job_id = str(UUID(int=self.submissions))
        if len(self.busy_jobs) < self._busy_passes:
            self.busy_jobs.add(job_id)
        return httpx.Response(
            HTTPStatus.ACCEPTED, json={"status": "accepted", "job_id": job_id, "state": "queued"}
        )

    def _status(self, job_id: str, headers: httpx.Headers) -> httpx.Response:
        """A busy job's failure, served by declared minor; any other job's counts."""
        if job_id not in self.busy_jobs:
            succeeded = {"status": "ok", "job_id": job_id, "state": "succeeded"}
            return httpx.Response(HTTPStatus.OK, json={**succeeded, "result": _classified()})
        body: dict[str, object] = {"status": "ok", "job_id": job_id, "state": "failed"}
        body["result"] = None
        declared = _minor(headers.get(_CONTRACT_HEADER, _NO_MINOR))
        if declared >= _FAILURE_CODE_KEY_SINCE:
            body["failure_code"] = _BUSY if declared >= _BUSY_SINCE else None
        return httpx.Response(HTTPStatus.OK, json=body)


class _BusyReadingClient(HttpCreekVaultClient):
    """The real adapter, reading each busy job as its 0.29 poll would.

    Admissions and every other job travel the wire unchanged; only a job the
    vault holds busy is answered here, so the ladder's handling of ``busy`` is
    pinned whatever minor the poll itself negotiates.
    """

    def __init__(self, vault: _LadderVault, http: httpx.AsyncClient) -> None:
        """Wrap ``http`` against ``vault``."""
        super().__init__(_VAULT_URL, _API_KEY, http_client=http)
        self._vault = vault

    async def pipeline_job(
        self, job: VaultPipelineJob, /
    ) -> VaultClassificationPass | VaultLinkPass | VaultPipelineJob:
        """A busy job's 0.29 answer, or the wire's for any other job."""
        if str(job.job_id) in self._vault.busy_jobs:
            return VaultPipelineJob(
                job_id=job.job_id,
                stage=job.stage,
                state=VaultPipelineJobState.FAILED,
                failure_code=VaultJobFailureCode.BUSY,
            )
        return await super().pipeline_job(job)


# -- fixtures and drivers ------------------------------------------------------


@pytest.fixture(autouse=True)
def _fast_clocks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink polling and retry backoff so the whole bounded retry runs inside the test."""
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", _FAST)
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", _FAST)


@pytest.fixture
def _encrypted(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Configure a throwaway at-rest key, which a stored writer key requires."""
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


@pytest_asyncio.fixture
async def _owner(db_session: AsyncSession) -> AsyncIterator[None]:
    """The account the ladder climbs for, and an empty continuation registry around it."""
    db_session.add(User(id=_OWNER, email="busy-owner@example.com", password_hash=_UNUSED_HASH))
    await db_session.commit()
    await pipeline.close_vault_pipeline_tasks()
    yield
    await pipeline.close_vault_pipeline_tasks()


async def _drive(session: AsyncSession, vault: _LadderVault) -> None:
    """One journal write's pass, and the continuation it leaves running, to the end."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = _BusyReadingClient(vault, http)
        await client.handshake()
        await drive_vault_pipeline(
            session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
        )
        await pipeline.wait_for_vault_pipeline_tasks()


async def _classify_rows(session: AsyncSession) -> list[tuple[str, str | None, int]]:
    """Every classification row as ``(outcome, failure_code, attempt_count)``, oldest first."""
    session.expire_all()
    result = await session.execute(
        select(VaultPipelineRun)
        .where(col(VaultPipelineRun.stage) == VaultPipelineStage.CLASSIFY.value)
        .order_by(col(VaultPipelineRun.id))
    )
    return [(row.outcome, row.failure_code, row.attempt_count) for row in result.scalars()]


async def _store_key(session: AsyncSession) -> None:
    """Seed the writer's stored key, as an earlier keyed admission would have."""
    session.add(VaultClassificationKey(user_id=_OWNER, provider="anthropic", api_key=_WRITER_KEY))
    await session.commit()


async def _stored_keys(session: AsyncSession) -> list[int]:
    """Whose stored keys exist."""
    session.expire_all()
    result = await session.execute(select(VaultClassificationKey))
    return [row.user_id for row in result.scalars()]


# -- the retry decision ---------------------------------------------------------


@pytest.mark.parametrize(
    ("code", "retries"),
    [
        (None, True),
        (VaultJobFailureCode.BUSY, True),
        (VaultJobFailureCode.REQUEST_KEY_REJECTED, False),
    ],
    ids=["unnamed", "busy", "request_key_rejected"],
)
def test_a_failed_poll_hands_every_transient_reason_to_the_bounded_retry(
    code: VaultJobFailureCode | None, *, retries: bool
) -> None:
    """The first pass lands only a final reason; busy waits for the continuation."""
    run = VaultPipelineRun(
        user_id=_OWNER,
        stage=VaultPipelineStage.CLASSIFY.value,
        outcome=VaultPipelineOutcome.ATTEMPTED.value,
        fragments_seen=0,
        fragments_touched=0,
        fragments_lost=0,
    )
    counts = StageCounts(failure_code=code)
    assert poll_needs_reconciliation(run, VaultPipelineOutcome.FAILED, counts) is retries


# -- the ladder -----------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.usefixtures("_owner")
async def test_a_busy_pass_is_resubmitted_and_the_next_one_completes(
    db_session: AsyncSession,
) -> None:
    """Busy once, then a clean pass: two admissions, completed, no reason kept."""
    vault = _LadderVault(busy_passes=1)
    await _drive(db_session, vault)

    assert vault.submissions == 2
    assert await _classify_rows(db_session) == [(VaultPipelineOutcome.COMPLETED.value, None, 2)]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_owner")
async def test_a_vault_busy_on_every_pass_spends_the_retry_then_records_busy(
    db_session: AsyncSession,
) -> None:
    """The bounded retry is spent, never exceeded, and the row says why it gave up."""
    vault = _LadderVault(busy_passes=_ALWAYS)
    await _drive(db_session, vault)

    assert vault.submissions == MAX_STAGE_ATTEMPTS
    assert await _classify_rows(db_session) == [
        (VaultPipelineOutcome.FAILED.value, _BUSY, MAX_STAGE_ATTEMPTS)
    ]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_owner")
async def test_busy_exhaustion_after_a_lost_admission_stays_ambiguous_and_uncoded(
    db_session: AsyncSession,
) -> None:
    """An unanswered first admission may have landed labels, so no failure is claimed."""
    vault = _LadderVault(busy_passes=_ALWAYS, lose_first_admission=True)
    await _drive(db_session, vault)

    assert vault.submissions == MAX_STAGE_ATTEMPTS
    assert await _classify_rows(db_session) == [
        (VaultPipelineOutcome.AMBIGUOUS.value, None, MAX_STAGE_ATTEMPTS)
    ]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_owner")
async def test_the_stored_key_survives_a_busy_ladder_to_the_end(
    db_session: AsyncSession,
) -> None:
    """Busy says nothing about the key: the writer's copy is kept through every retry."""
    await _store_key(db_session)
    vault = _LadderVault(busy_passes=_ALWAYS)
    await _drive(db_session, vault)

    assert vault.submissions == MAX_STAGE_ATTEMPTS
    assert await _stored_keys(db_session) == [_OWNER]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_owner")
@pytest.mark.parametrize(
    ("code", "kept"),
    [
        (None, True),
        (VaultJobFailureCode.BUSY, True),
        (VaultJobFailureCode.REQUEST_KEY_REJECTED, False),
    ],
    ids=["unnamed", "busy", "request_key_rejected"],
)
async def test_only_a_refused_key_is_forgotten(
    db_session: AsyncSession, code: VaultJobFailureCode | None, *, kept: bool
) -> None:
    """``forget_if_rejected`` deletes the copy for a refusal alone, never for busy."""
    await _store_key(db_session)

    await forget_if_rejected(db_session, _OWNER, code)
    await db_session.commit()

    assert await _stored_keys(db_session) == ([_OWNER] if kept else [])


# -- what Settings reads -------------------------------------------------------


async def _settled(session: AsyncSession, *rows: tuple[VaultPipelineOutcome, str | None]) -> None:
    """Persist classification rows for ``_OWNER``, oldest first."""
    for outcome, code in rows:
        session.add(
            VaultPipelineRun(
                user_id=_OWNER,
                stage=VaultPipelineStage.CLASSIFY.value,
                outcome=outcome.value,
                failure_code=code,
                fragments_seen=0,
                fragments_touched=0,
                fragments_lost=0,
            )
        )
        await session.commit()


_FAILED: Final = VaultPipelineOutcome.FAILED
_COMPLETED: Final = VaultPipelineOutcome.COMPLETED


@pytest.mark.asyncio
@pytest.mark.usefixtures("_owner")
@pytest.mark.parametrize(
    ("rows", "rejected"),
    [
        pytest.param([(_FAILED, _BUSY)], False, id="a-lone-busy-pass"),
        pytest.param([(_FAILED, _REJECTED), (_FAILED, _BUSY)], True, id="busy-after-a-refusal"),
        pytest.param(
            [(_FAILED, _REJECTED), (_FAILED, _BUSY), (_FAILED, _BUSY)],
            True,
            id="repeated-busy-after-a-refusal",
        ),
        pytest.param(
            [(_FAILED, _REJECTED), (_FAILED, _BUSY), (_COMPLETED, None)],
            False,
            id="a-landed-pass-after-busy",
        ),
        pytest.param([(_FAILED, _REJECTED), (_FAILED, None)], False, id="an-unnamed-failure"),
        pytest.param([(_FAILED, _BUSY), (_FAILED, _REJECTED)], True, id="a-refusal-after-busy"),
    ],
)
async def test_a_busy_pass_neither_raises_nor_clears_the_refused_key_notice(
    db_session: AsyncSession,
    rows: list[tuple[VaultPipelineOutcome, str | None]],
    *,
    rejected: bool,
) -> None:
    """The key verdict skips busy rows: the lock, not the key, stopped that pass."""
    await _settled(db_session, *rows)

    assert (await classification_status(db_session, _OWNER)).key_rejected is rejected


@pytest.mark.asyncio
@pytest.mark.usefixtures("_owner")
async def test_a_busy_pass_does_not_mask_the_sort_the_writing_has(
    db_session: AsyncSession,
) -> None:
    """Busy wrote nothing, so the latest landed pass still describes the writing."""
    await _settled(db_session, (_COMPLETED, None), (_FAILED, _BUSY))

    status = await classification_status(db_session, _OWNER)

    assert status.landed_outcome is VaultPipelineOutcome.COMPLETED


@pytest.fixture
def _no_deployment_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only the account's own stored connection decides whether it has a vault."""
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    monkeypatch.delenv(OWNER_ENV_VAR, raising=False)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_no_deployment_vault")
async def test_vault_connection_reads_the_same_before_and_after_a_busy_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Every classification field Settings shows is unmoved by a busy row."""
    signup = await async_client.post(
        "/auth/signup", json={"email": "busy-settings@example.com", "password": _PASSWORD}
    )
    assert signup.status_code == HTTPStatus.OK
    body = signup.json()
    headers = {"Authorization": f"Bearer {body['token']}"}
    user_id = int(body["user_id"])
    await store_vault_config(
        db_session, user_id, vault_url=_CONNECTED_VAULT_URL, api_key=_CONNECTED_VAULT_KEY
    )
    for outcome, code in ((_COMPLETED, None), (_FAILED, _REJECTED)):
        db_session.add(
            VaultPipelineRun(
                user_id=user_id,
                stage=VaultPipelineStage.CLASSIFY.value,
                outcome=outcome.value,
                failure_code=code,
                fragments_seen=0,
                fragments_touched=0,
                fragments_lost=0,
            )
        )
        await db_session.commit()

    async def _fields() -> dict[str, object]:
        response = await async_client.get(_CONNECTION_PATH, headers=headers)
        assert response.status_code == HTTPStatus.OK
        return {key: value for key, value in response.json().items() if "classification" in key}

    before = await _fields()
    db_session.add(
        VaultPipelineRun(
            user_id=user_id,
            stage=VaultPipelineStage.CLASSIFY.value,
            outcome=_FAILED.value,
            failure_code=_BUSY,
            fragments_seen=0,
            fragments_touched=0,
            fragments_lost=0,
        )
    )
    await db_session.commit()

    assert before["classification_key_rejected"] is True
    assert before["classification_state"] == "complete"
    assert await _fields() == before
