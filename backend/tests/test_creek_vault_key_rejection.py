"""A writer key the vendor refused ends the classification run; it is not re-submitted.

Creek contract 0.26 (Creek-Vault#1877) ends a classification job whose writer
request key got a vendor ``401``/``403`` as ``failed`` with ``failure_code:
"request_key_rejected"``. Every other failed job is still re-admitted with
bounded backoff (``test_a_terminal_failed_job_is_readmitted_with_bounded_backoff``)
because a transient fault may clear; this one cannot, so the run lands
``failed`` with the code recorded on its content-free row -- which is what lets
Settings tell the writer to replace the key -- and no second pass is sent.

Synthetic throughout: no real key, no journal content, ids and counts only.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.creek_vault import VaultPipelineStage
from models.user import User
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services import creek_vault_pipeline as pipeline
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline
from services.creek_vault_pipeline import _reconcile_run as reconcile_run

_FIXTURES: Final = Path(__file__).parent / "fixtures"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "key-rejection-vault-credential"  # pragma: allowlist secret
_OWNER: Final = 1
_JOB_ID: Final = "44444444-4444-4444-8444-444444444444"
_CLASSIFICATIONS: Final = "/v1/classifications"
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"
_REJECTED: Final = "request_key_rejected"
_FAST: Final = 0.001
# Never verified against: the ladder only needs the account row to exist.
_UNUSED_HASH: Final = "not-a-real-hash"  # pragma: allowlist secret


def _capabilities(*, serves_0_26: bool) -> dict[str, Any]:
    """A published handshake from a vault on the 0.26 image, or on the 0.22 one."""
    path = (
        _FIXTURES / "creek_jobs_v026" / "examples" / "capabilities" / "success.json"
        if serves_0_26
        else _FIXTURES / "creek_v1" / "examples" / "capabilities" / "success.json"
    )
    loaded: dict[str, Any] = json.loads(path.read_bytes())
    return loaded


class _RejectingVault:
    """A managed vault whose vendor refuses the writer's key on every pass.

    It answers exactly as Creek does: the code is in the failed body only for a
    poll declaring 0.26, and an older declared minor gets the old body.
    """

    def __init__(self, *, serves_0_26: bool = True) -> None:
        """Serve the 0.26 handshake, or an older vault's."""
        self.capabilities = _capabilities(serves_0_26=serves_0_26)
        self.submissions = 0
        self.polls = 0
        self.declared_on_polls: list[str | None] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Admit each pass, report it running once, then failed."""
        path = request.url.path
        if path == "/v1/capabilities":
            return httpx.Response(200, json=self.capabilities)
        if path == _CLASSIFICATIONS:
            self.submissions += 1
            return httpx.Response(
                202, json={"status": "accepted", "job_id": _JOB_ID, "state": "queued"}
            )
        if path == f"/v1/jobs/{_JOB_ID}":
            return self._status(request.headers.get(_CONTRACT_HEADER))
        return httpx.Response(404, json={"code": "not_found", "message": "no", "request_id": "r"})

    def _status(self, declared: str | None) -> httpx.Response:
        """Running on the first poll of each pass, then failed for a refused key."""
        self.declared_on_polls.append(declared)
        self.polls += 1
        if self.polls == 1:
            body: dict[str, object] = {"status": "ok", "job_id": _JOB_ID, "state": "running"}
        else:
            body = {"status": "ok", "job_id": _JOB_ID, "state": "failed", "result": None}
            if declared == "0.26":
                body["failure_code"] = _REJECTED
        return httpx.Response(200, json=body)


@pytest.fixture(autouse=True)
def _fast_clocks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink the poll and retry backoff so a retry, if any, happens inside the test."""
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", _FAST)
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", _FAST)


@pytest_asyncio.fixture(autouse=True)
async def _owner(db_session: AsyncSession) -> None:
    """The account the ladder climbs for."""
    db_session.add(
        User(id=_OWNER, email="key-rejection-owner@example.com", password_hash=_UNUSED_HASH)
    )
    await db_session.commit()
    await pipeline.close_vault_pipeline_tasks()


async def _rows(session: AsyncSession) -> list[VaultPipelineRun]:
    """Every pipeline row, oldest first."""
    result = await session.execute(select(VaultPipelineRun).order_by(col(VaultPipelineRun.id)))
    return list(result.scalars().all())


async def _drive(session: AsyncSession, vault: _RejectingVault) -> None:
    """One journal write's pass, and whatever continuation it leaves running."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
        await client.handshake()
        await drive_vault_pipeline(
            session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
        )
        await pipeline.wait_for_vault_pipeline_tasks()


@pytest.mark.asyncio
async def test_a_rejected_key_lands_failed_with_its_code_and_is_not_resubmitted(
    db_session: AsyncSession,
) -> None:
    """One admission, one terminal row naming why, and no linker stage after it."""
    vault = _RejectingVault()
    await _drive(db_session, vault)

    assert vault.submissions == 1
    assert set(vault.declared_on_polls) == {"0.26"}
    rows = await _rows(db_session)
    assert [(row.stage, row.outcome, row.failure_code) for row in rows] == [
        (VaultPipelineStage.CLASSIFY.value, VaultPipelineOutcome.FAILED.value, _REJECTED)
    ]
    assert rows[0].attempt_count == 1
    assert (rows[0].fragments_seen, rows[0].fragments_touched) == (0, 0)


@pytest.mark.asyncio
async def test_a_continuation_polling_a_rejected_key_does_not_readmit_it(
    db_session: AsyncSession,
) -> None:
    """The off-request reconciler reads the code the same way and stops there."""
    vault = _RejectingVault()
    run = VaultPipelineRun(
        user_id=_OWNER,
        stage=VaultPipelineStage.CLASSIFY.value,
        trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
        outcome=VaultPipelineOutcome.ATTEMPTED.value,
        job_id=_JOB_ID,
        fragments_seen=0,
        fragments_touched=0,
        fragments_lost=0,
    )
    db_session.add(run)
    await db_session.commit()
    assert run.id is not None
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
        await client.handshake()
        outcome = await reconcile_run(db_session, client, run.id, VaultPipelineStage.CLASSIFY)

    assert outcome is VaultPipelineOutcome.FAILED
    assert vault.submissions == 0
    rows = await _rows(db_session)
    assert [(row.outcome, row.failure_code, row.attempt_count) for row in rows] == [
        (VaultPipelineOutcome.FAILED.value, _REJECTED, 1)
    ]


@pytest.mark.asyncio
async def test_an_older_vault_keeps_the_bounded_retry_and_records_no_code(
    db_session: AsyncSession,
) -> None:
    """Below 0.26 nothing says why, so the pass behaves exactly as before."""
    vault = _RejectingVault(serves_0_26=False)
    await _drive(db_session, vault)

    assert set(vault.declared_on_polls) == {"0.22"}
    assert vault.submissions > 1
    rows = await _rows(db_session)
    assert [(row.stage, row.failure_code) for row in rows] == [
        (VaultPipelineStage.CLASSIFY.value, None)
    ]
    assert rows[0].outcome == VaultPipelineOutcome.FAILED.value
