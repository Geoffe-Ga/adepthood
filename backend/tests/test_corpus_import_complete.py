"""One full vault pass when a bulk upload finishes: ``/corpus/import/complete`` (#3773).

A bulk upload used to drive the vault's ontologization ladder inline, inside
every single document's request, for up to a minute each -- and then the six
hour clustering window closed behind the first document, so most of a
morning's import was not clustered that day. A document sent as part of an
upload run now costs one upload and nothing more; when the run drains, the
client presses ``/corpus/import/complete`` once and one background run drives
the whole ladder over what the batch landed.

The properties pinned here:

* **No inline pass for a run's documents.** A document carrying ``upload_run``
  reaches no pipeline stage. A document sent on its own keeps the inline pass.
* **The whole ladder, once, past the clustering window.** Classification, then
  temporal, embeddings, eddies and threads, each recorded in ``vaultpipelinerun``
  under the ``bulk_import`` trigger -- even right after an inline pass closed
  every window.
* **Idempotent and single-flight.** A second press of the same batch joins its
  run; another batch arriving mid-run waits its turn rather than racing it.
* **Never raises, records why.** A vault that cannot be reached records a
  ``stopped`` run; a failing stage is recorded on its own row.
* **Durable.** A run whose driver died is resumed by recovery.
"""

from __future__ import annotations

import base64
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import cast

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CreekVaultClient,
    CreekVaultContractError,
    HandshakeResult,
    VaultLinkStage,
    VaultPipelineStage,
)
from main import app
from models.corpus_fragment import CorpusSource
from models.journal_entry import JournalEntry
from models.vault_bulk_import_run import (
    BulkImportRunState,
    BulkImportStopReason,
    VaultBulkImportRun,
)
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services import corpus_sort_run, vault_bulk_import_run
from services import creek_vault_pipeline_scope as scope
from services.corpus_consent import set_consent
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_pipeline import VaultPipelineTrigger, close_vault_pipeline_tasks
from services.creek_vault_telemetry import VaultTelemetryOutcome
from tests.test_vault_pipeline_triggers import _PipelineVaultDouble

_PASSWORD = "correct-horse-battery-staple-42"  # pragma: allowlist secret
_IMPORT_PATH = "/corpus/import"
_COMPLETE_PATH = "/corpus/import/complete"
_BATCH = "a1" * 16
_OTHER_BATCH = "b2" * 16
_FOREIGN_OWNER = "f" * 32
_FILENAME = "field-notes.pdf"
_CONTENT_B64 = base64.b64encode(b"%PDF-1.7 a page of field notes").decode("ascii")
_LANDED = 3
_LONG_AGO = timedelta(days=1)

_EVERY_LINK_STAGE = [
    VaultLinkStage.TEMPORAL,
    VaultLinkStage.EMBEDDINGS,
    VaultLinkStage.EDDIES,
    VaultLinkStage.THREADS,
]


class _UnreachableVault(_PipelineVaultDouble):
    """A connected vault that does not answer its handshake (#3679)."""

    async def handshake(self) -> HandshakeResult:
        """Report no usable vault, as the adapter does for an outage."""
        return HandshakeResult.unavailable()

    def is_available(self) -> bool:
        """Report unavailable."""
        return False


class _RefusingVault(_PipelineVaultDouble):
    """A vault whose classification pass is refused definitively."""

    def __init__(self) -> None:
        """Refuse every pipeline call with a contract error."""
        super().__init__(pipeline_error=CreekVaultContractError("refused"))


@pytest.fixture
def vault() -> Iterator[_PipelineVaultDouble]:
    """Serve a pipeline-capable vault for one test."""
    double = _PipelineVaultDouble()
    app.dependency_overrides[get_creek_vault_client] = lambda: double
    yield double
    app.dependency_overrides.pop(get_creek_vault_client, None)


@pytest_asyncio.fixture(autouse=True)
async def _settle() -> AsyncIterator[None]:
    """Never leave a background driver or continuation alive past its test."""
    yield
    await vault_bulk_import_run.close_bulk_import_tasks()
    await corpus_sort_run.close_corpus_sort_tasks()
    await close_vault_pipeline_tasks()


def _serve(double: _PipelineVaultDouble | LocalFallbackCreekVaultClient) -> None:
    """Install ``double`` as every route's vault."""
    app.dependency_overrides[get_creek_vault_client] = lambda: double


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create an account and return its auth headers and id."""
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


async def _complete(
    client: AsyncClient, headers: dict[str, str], batch_id: str = _BATCH, landed: int = _LANDED
) -> dict[str, object]:
    """Press complete for one batch and return its run."""
    resp = await client.post(
        _COMPLETE_PATH, json={"batch_id": batch_id, "landed": landed}, headers=headers
    )
    assert resp.status_code == HTTPStatus.ACCEPTED, resp.text
    run = resp.json()["run"]
    assert isinstance(run, dict)
    return run


async def _read(
    client: AsyncClient, headers: dict[str, str], batch_id: str = _BATCH
) -> dict[str, object] | None:
    """Read one batch's run as the client polls it."""
    resp = await client.get(f"{_COMPLETE_PATH}/{batch_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    run = resp.json()["run"]
    assert run is None or isinstance(run, dict)
    return run


async def _settled(
    client: AsyncClient, headers: dict[str, str], batch_id: str = _BATCH
) -> dict[str, object]:
    """Let every driver finish, then read the batch's run."""
    await vault_bulk_import_run.wait_for_bulk_import_tasks()
    run = await _read(client, headers, batch_id)
    assert run is not None
    return run


async def _stage_runs(session: AsyncSession) -> list[VaultPipelineRun]:
    """Every pipeline stage row, oldest first."""
    result = await session.execute(
        select(VaultPipelineRun)
        .order_by(col(VaultPipelineRun.id))
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _import(
    client: AsyncClient, headers: dict[str, str], *, upload_run: str | None
) -> dict[str, object]:
    """Send one document, as part of a run or on its own."""
    body: dict[str, object] = {
        "filename": _FILENAME,
        "content_base64": _CONTENT_B64,
        "classification": "personal",
    }
    if upload_run is not None:
        body["upload_run"] = upload_run
    resp = await client.post(_IMPORT_PATH, json=body, headers=headers)
    assert resp.status_code == HTTPStatus.ACCEPTED, resp.text
    return dict(resp.json())


def _bulk_row(user_id: int, batch_id: str, **fields: object) -> VaultBulkImportRun:
    """A run row as another worker would have left it."""
    return VaultBulkImportRun(user_id=user_id, batch_id=batch_id, landed=_LANDED, **fields)


@pytest.mark.asyncio
async def test_a_document_sent_in_an_upload_run_reaches_no_pipeline_stage(
    async_client: AsyncClient, db_session: AsyncSession, vault: _PipelineVaultDouble
) -> None:
    """A run's documents cost one upload each; the pass waits for the run to drain."""
    headers, _ = await _signup(async_client, "bulk-no-inline")

    body = await _import(async_client, headers, upload_run=_BATCH)

    assert body["stored"] is True
    assert vault.classification_calls == 0
    assert vault.link_stages == []
    assert await _stage_runs(db_session) == []


@pytest.mark.asyncio
async def test_a_document_sent_on_its_own_keeps_its_inline_pass(
    async_client: AsyncClient, vault: _PipelineVaultDouble
) -> None:
    """A single import outside any run is unchanged: it still drives the ladder."""
    headers, _ = await _signup(async_client, "bulk-single")

    await _import(async_client, headers, upload_run=None)

    assert vault.classification_calls == 1
    assert vault.link_stages == _EVERY_LINK_STAGE


@pytest.mark.asyncio
async def test_complete_drives_the_whole_ladder_once_under_the_bulk_trigger(
    async_client: AsyncClient, db_session: AsyncSession, vault: _PipelineVaultDouble
) -> None:
    """One press: classify, then every link stage, each recorded as a bulk import."""
    headers, user_id = await _signup(async_client, "bulk-ladder")

    pressed = await _complete(async_client, headers)
    run = await _settled(async_client, headers)

    assert pressed["batch_id"] == _BATCH
    assert pressed["landed"] == _LANDED
    assert run["state"] == BulkImportRunState.COMPLETED.value
    assert run["stop_reason"] is None
    assert run["finished_at"] is not None
    assert vault.classification_calls == 1
    assert vault.link_stages == _EVERY_LINK_STAGE
    rows = await _stage_runs(db_session)
    assert [row.stage for row in rows] == [
        VaultPipelineStage.CLASSIFY.value,
        VaultPipelineStage.TEMPORAL.value,
        VaultPipelineStage.EMBEDDINGS.value,
        VaultPipelineStage.EDDIES.value,
        VaultPipelineStage.THREADS.value,
    ]
    assert {row.trigger for row in rows} == {VaultPipelineTrigger.BULK_IMPORT.value}
    assert {row.outcome for row in rows} == {VaultPipelineOutcome.COMPLETED.value}
    assert {row.user_id for row in rows} == {user_id}


@pytest.mark.asyncio
async def test_complete_reaches_every_stage_even_inside_the_clustering_window(
    async_client: AsyncClient, vault: _PipelineVaultDouble
) -> None:
    """A pass that just closed every window does not stand the bulk run down."""
    headers, _ = await _signup(async_client, "bulk-window")
    await _import(async_client, headers, upload_run=None)
    assert vault.classification_calls == 1

    await _complete(async_client, headers)
    run = await _settled(async_client, headers)

    assert run["state"] == BulkImportRunState.COMPLETED.value
    assert vault.classification_calls == 2  # the inline pass, then the bulk pass
    assert vault.link_stages == _EVERY_LINK_STAGE * 2


@pytest.mark.asyncio
async def test_a_second_press_of_the_same_batch_joins_its_run(
    async_client: AsyncClient, db_session: AsyncSession, vault: _PipelineVaultDouble
) -> None:
    """Pressing twice is pressing once: one run, one pass."""
    headers, user_id = await _signup(async_client, "bulk-join")

    first = await _complete(async_client, headers)
    second = await _complete(async_client, headers)
    await _settled(async_client, headers)
    third = await _complete(async_client, headers)

    assert first["started_at"] == second["started_at"] == third["started_at"]
    assert third["state"] == BulkImportRunState.COMPLETED.value
    assert vault.classification_calls == 1
    rows = await db_session.execute(
        select(VaultBulkImportRun).where(col(VaultBulkImportRun.user_id) == user_id)
    )
    assert len(rows.scalars().all()) == 1


@pytest.mark.asyncio
async def test_an_unreachable_vault_records_a_stopped_run(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault outage is a run that says so, not an error and not a silent success."""
    _serve(_UnreachableVault())
    headers, _ = await _signup(async_client, "bulk-outage")

    await _complete(async_client, headers)
    run = await _settled(async_client, headers)

    assert run["state"] == BulkImportRunState.STOPPED.value
    assert run["stop_reason"] == BulkImportStopReason.VAULT_UNAVAILABLE.value
    assert await _stage_runs(db_session) == []


@pytest.mark.asyncio
async def test_an_account_with_no_vault_records_a_stopped_run(
    async_client: AsyncClient,
) -> None:
    """No vault behind the account: the run stops before reaching anything."""
    _serve(LocalFallbackCreekVaultClient(VaultTelemetryOutcome.FALLBACK_UNCONFIGURED))
    headers, _ = await _signup(async_client, "bulk-no-vault")

    await _complete(async_client, headers)
    run = await _settled(async_client, headers)

    assert run["state"] == BulkImportRunState.STOPPED.value
    assert run["stop_reason"] == BulkImportStopReason.VAULT_UNAVAILABLE.value


@pytest.mark.asyncio
async def test_a_vault_without_the_pipeline_records_a_stopped_run(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch, vault: _PipelineVaultDouble
) -> None:
    """A vault that takes files but advertises no batch pipeline is told apart."""
    monkeypatch.setattr(vault, "supports", lambda _capability: False)
    headers, _ = await _signup(async_client, "bulk-no-pipeline")

    await _complete(async_client, headers)
    run = await _settled(async_client, headers)

    assert run["state"] == BulkImportRunState.STOPPED.value
    assert run["stop_reason"] == BulkImportStopReason.PIPELINE_UNSUPPORTED.value
    assert vault.classification_calls == 0


@pytest.mark.asyncio
async def test_a_refused_stage_is_recorded_and_the_run_still_completes(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stage the vault refuses is a recorded outcome, never a raise into anyone."""
    _serve(_RefusingVault())
    headers, _ = await _signup(async_client, "bulk-refused")

    await _complete(async_client, headers)
    run = await _settled(async_client, headers)

    assert run["state"] == BulkImportRunState.COMPLETED.value
    rows = await _stage_runs(db_session)
    assert [(row.stage, row.outcome) for row in rows] == [
        (VaultPipelineStage.CLASSIFY.value, VaultPipelineOutcome.FAILED.value)
    ]


@pytest.mark.asyncio
async def test_another_batch_arriving_mid_run_waits_its_turn(
    async_client: AsyncClient, db_session: AsyncSession, vault: _PipelineVaultDouble
) -> None:
    """At most one run per account: a second batch queues, then runs after."""
    headers, user_id = await _signup(async_client, "bulk-queue")
    db_session.add(
        _bulk_row(
            user_id,
            _BATCH,
            state=BulkImportRunState.RUNNING.value,
            owner_id=_FOREIGN_OWNER,
            heartbeat_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    queued = await _complete(async_client, headers, batch_id=_OTHER_BATCH)
    assert queued["state"] == BulkImportRunState.QUEUED.value
    assert vault.classification_calls == 0

    first = (
        await db_session.execute(
            select(VaultBulkImportRun).where(col(VaultBulkImportRun.batch_id) == _BATCH)
        )
    ).scalar_one()
    first.state = BulkImportRunState.COMPLETED.value
    first.owner_id = None
    first.heartbeat_at = None
    first.finished_at = datetime.now(UTC)
    await db_session.commit()
    await vault_bulk_import_run.resume_bulk_import_runs(
        vault_bulk_import_run.factory_for(db_session), _resolver(vault)
    )
    run = await _settled(async_client, headers, _OTHER_BATCH)

    assert run["state"] == BulkImportRunState.COMPLETED.value
    assert vault.classification_calls == 1


def _resolver(
    double: _PipelineVaultDouble,
) -> vault_bulk_import_run.VaultClientResolver:
    """Resolve every account to ``double``, as recovery would resolve the real vault."""

    async def resolve(_session: AsyncSession, _user_id: int) -> CreekVaultClient:
        # The route doubles stand in for the whole protocol only where these runs dial.
        return cast("CreekVaultClient", double)

    return resolve


@pytest.mark.asyncio
async def test_a_run_whose_driver_died_is_resumed_by_recovery(
    async_client: AsyncClient, db_session: AsyncSession, vault: _PipelineVaultDouble
) -> None:
    """A stale running row is claimed and carried to its end without another press."""
    headers, user_id = await _signup(async_client, "bulk-resume")
    db_session.add(
        _bulk_row(
            user_id,
            _BATCH,
            state=BulkImportRunState.RUNNING.value,
            owner_id=_FOREIGN_OWNER,
            heartbeat_at=datetime.now(UTC) - _LONG_AGO,
        )
    )
    await db_session.commit()

    await vault_bulk_import_run.resume_bulk_import_runs(
        vault_bulk_import_run.factory_for(db_session), _resolver(vault)
    )
    run = await _settled(async_client, headers)

    assert run["state"] == BulkImportRunState.COMPLETED.value
    assert vault.classification_calls == 1


@pytest.mark.asyncio
async def test_a_resumed_run_that_already_handed_on_its_pass_does_not_send_it_again(
    async_client: AsyncClient, db_session: AsyncSession, vault: _PipelineVaultDouble
) -> None:
    """The pass is durable once handed on; recovery finishes the run without a second one."""
    headers, user_id = await _signup(async_client, "bulk-resume-dispatched")
    db_session.add(
        _bulk_row(
            user_id,
            _BATCH,
            state=BulkImportRunState.RUNNING.value,
            owner_id=_FOREIGN_OWNER,
            heartbeat_at=datetime.now(UTC) - _LONG_AGO,
            dispatched_at=datetime.now(UTC) - _LONG_AGO,
        )
    )
    await db_session.commit()

    await vault_bulk_import_run.resume_bulk_import_runs(
        vault_bulk_import_run.factory_for(db_session), _resolver(vault)
    )
    run = await _settled(async_client, headers)

    assert run["state"] == BulkImportRunState.COMPLETED.value
    assert vault.classification_calls == 0


@pytest.mark.asyncio
async def test_a_live_run_on_another_worker_is_joined_not_restarted(
    async_client: AsyncClient, db_session: AsyncSession, vault: _PipelineVaultDouble
) -> None:
    """A fresh heartbeat elsewhere means somebody is driving it: nothing new starts."""
    headers, user_id = await _signup(async_client, "bulk-live-elsewhere")
    db_session.add(
        _bulk_row(
            user_id,
            _BATCH,
            state=BulkImportRunState.RUNNING.value,
            owner_id=_FOREIGN_OWNER,
            heartbeat_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    joined = await _complete(async_client, headers)
    await vault_bulk_import_run.wait_for_bulk_import_tasks()

    assert joined["state"] == BulkImportRunState.RUNNING.value
    assert vault.classification_calls == 0


@pytest.mark.asyncio
async def test_a_stale_run_is_taken_over_by_the_next_press(
    async_client: AsyncClient, vault: _PipelineVaultDouble, db_session: AsyncSession
) -> None:
    """A press that finds its batch's driver dead claims the run and carries it on."""
    headers, user_id = await _signup(async_client, "bulk-takeover")
    db_session.add(
        _bulk_row(
            user_id,
            _BATCH,
            state=BulkImportRunState.RUNNING.value,
            owner_id=_FOREIGN_OWNER,
            heartbeat_at=datetime.now(UTC) - _LONG_AGO,
        )
    )
    await db_session.commit()

    await _complete(async_client, headers)
    run = await _settled(async_client, headers)

    assert run["state"] == BulkImportRunState.COMPLETED.value
    assert vault.classification_calls == 1


@pytest.mark.asyncio
async def test_the_corpus_sweep_is_started_after_the_ladder_when_writing_waits(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    vault: _PipelineVaultDouble,
) -> None:
    """With a standing yes and unsorted writing, the run starts or joins the sort."""
    headers, user_id = await _signup(async_client, "bulk-sweep")
    await set_consent(db_session, user_id=user_id, source=CorpusSource.JOURNAL, granted=True)
    db_session.add(
        JournalEntry(
            message="an entry nobody has sorted yet",
            sender="user",
            user_id=user_id,
            classification="personal",
            timestamp=datetime.now(UTC),
        )
    )
    await db_session.commit()
    pressed: list[int] = []

    async def count(_session: AsyncSession, *, user_id: int, client: object) -> None:
        assert client is vault
        pressed.append(user_id)

    monkeypatch.setattr(corpus_sort_run, "start_or_join", count)

    await _complete(async_client, headers)
    await _settled(async_client, headers)

    assert pressed == [user_id]


@pytest.mark.asyncio
async def test_the_corpus_sweep_is_left_alone_without_a_standing_yes(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch, vault: _PipelineVaultDouble
) -> None:
    """No consent, no sort: the run never records a refused sort on the person's behalf."""
    headers, _ = await _signup(async_client, "bulk-no-sweep")
    pressed: list[int] = []

    async def count(_session: AsyncSession, *, user_id: int, **_others: object) -> None:
        pressed.append(user_id)

    monkeypatch.setattr(corpus_sort_run, "start_or_join", count)

    await _complete(async_client, headers)
    await _settled(async_client, headers)

    assert vault.classification_calls == 1
    assert pressed == []


@pytest.mark.asyncio
async def test_reading_a_batch_nobody_pressed_answers_no_run(
    async_client: AsyncClient,
) -> None:
    """Never a 404: a batch that has not been pressed simply has no run yet."""
    headers, _ = await _signup(async_client, "bulk-unknown")

    assert await _read(async_client, headers, _OTHER_BATCH) is None


@pytest.mark.parametrize(
    "body",
    [
        {"batch_id": _BATCH, "landed": 0},
        {"batch_id": _BATCH, "landed": -1},
        {"batch_id": "short", "landed": 1},
        {"batch_id": "not a/valid id!" * 4, "landed": 1},
        {"landed": 1},
    ],
)
@pytest.mark.asyncio
async def test_a_malformed_press_is_refused(
    async_client: AsyncClient, body: dict[str, object], vault: _PipelineVaultDouble
) -> None:
    """A press names a real batch that landed something, or it is refused before any run."""
    headers, _ = await _signup(async_client, "bulk-malformed")

    resp = await async_client.post(_COMPLETE_PATH, json=body, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert vault.classification_calls == 0


@pytest.mark.asyncio
async def test_the_bulk_trigger_outranks_both_others() -> None:
    """A bulk scope joined to any other run keeps its whole, window-free ladder."""
    strongest = scope.strongest_trigger(
        VaultPipelineTrigger.JOURNAL_WRITE.value,
        VaultPipelineTrigger.BULK_IMPORT.value,
        VaultPipelineTrigger.DOCUMENT_IMPORT.value,
    )
    assert strongest is VaultPipelineTrigger.BULK_IMPORT
    assert (
        scope.strongest_trigger(None, VaultPipelineTrigger.DOCUMENT_IMPORT.value)
        is VaultPipelineTrigger.DOCUMENT_IMPORT
    )


def test_a_bulk_scope_finds_every_stage_due_however_recent() -> None:
    """The bulk trigger ignores each stage's window; the others keep theirs."""
    now = datetime.now(UTC)
    stamps = {stage.value: now for stage in scope.LADDER}

    bulk = scope.due_stages(VaultPipelineTrigger.BULK_IMPORT, stamps, now)
    document = scope.due_stages(VaultPipelineTrigger.DOCUMENT_IMPORT, stamps, now)

    assert bulk == scope.LADDER
    assert document == ()


@pytest.mark.usefixtures("vault")
@pytest.mark.asyncio
async def test_concurrent_presses_from_two_sessions_share_one_run(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Two presses that race each other land on one row, across sessions."""
    headers, user_id = await _signup(concurrent_async_client, "bulk-race")

    await _complete(concurrent_async_client, headers)
    await _complete(concurrent_async_client, headers)
    await vault_bulk_import_run.wait_for_bulk_import_tasks()

    async with concurrent_session_factory() as session:
        rows = await session.execute(
            select(VaultBulkImportRun).where(col(VaultBulkImportRun.user_id) == user_id)
        )
        assert len(rows.scalars().all()) == 1
