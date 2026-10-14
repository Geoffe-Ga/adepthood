"""Worker processes for the multi-process privacy orderings (#3163, B15).

Every function named ``run_*`` here is the target of one ``multiprocessing``
**spawn** process: a fresh interpreter that imports the application on its own,
builds its own ``create_async_engine`` and pool, and shares nothing in memory
with the test that started it or with its sibling workers. Whatever order the
workers end up in therefore came from PostgreSQL -- an advisory lock, a foreign
key, a compare-and-swap ``UPDATE`` -- and from nowhere else.

**Evidence is a table, not a variable.** Each worker records what it did, as it
did it, into :data:`EVIDENCE_TABLE` on its own autocommit connection: a
``bigserial`` sequence number assigned at insert, the worker's label and the
event. The test reads that table back and proves the ordering from it. The
``multiprocessing`` primitives passed in only *pace* the race (start together,
wait here until released); none of them is read as evidence.

Spawned workers do not run ``conftest.py``. They inherit the environment the
test process had when it spawned them, and import the app against pristine
model metadata -- which is what the Postgres lane wants.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from database import get_session
from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    HandshakeResult,
    VaultClassification,
    VaultIngestRequest,
    VaultIngestResult,
    VaultJournalWithdrawResult,
    VaultReflection,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelBalance,
)
from main import app
from routers import journal as journal_router
from services.account_egress_barrier import (
    ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR,
    ensure_account_live,
    hold_account,
)
from services.creek_vault_pipeline import resume_vault_pipeline_runs
from tests.vault_client_doubles import NoPipelineVaultDouble

if TYPE_CHECKING:
    from multiprocessing.synchronize import Barrier, Event

    from domain.creek_vault import CreekVaultPipelineClient

#: The one table every worker writes its evidence to.
EVIDENCE_TABLE: Final = "privacy_order_evidence"

CREATE_EVIDENCE_TABLE: Final = (
    "CREATE TABLE IF NOT EXISTS privacy_order_evidence ("
    "seq bigserial PRIMARY KEY, "
    "worker text NOT NULL, "
    "event text NOT NULL, "
    "at timestamptz NOT NULL DEFAULT clock_timestamp())"
)
DROP_EVIDENCE_TABLE: Final = "DROP TABLE IF EXISTS privacy_order_evidence"
_INSERT_EVIDENCE: Final = (
    "INSERT INTO privacy_order_evidence (worker, event) VALUES (:worker, :event)"
)
_SELECT_EVIDENCE: Final = "SELECT seq, worker, event FROM privacy_order_evidence ORDER BY seq"

#: How long a paced worker waits on the test before giving up. A worker that
#: times out exits non-zero, which the test reports; it never hangs the lane.
PACE_TIMEOUT_SECONDS: Final = 60.0

#: The fingerprint every worker's journal router resolves an account's vault to,
#: as production always records one (see ``tests/vault_client_doubles.py``).
RECORDED_VAULT: Final = "d" * 32

# Evidence events. One vocabulary for workers and the test that reads them.
ENTER: Final = "enter"
EXIT: Final = "exit"
UPSERT_STARTED: Final = "upsert-started"
UPSERT_LANDED: Final = "upsert-landed"
WITHDRAW: Final = "withdraw"
RECLASSIFY_SENT: Final = "reclassify-sent"
WRITE_PAUSED: Final = "write-paused"
WRITE_RESUMED: Final = "write-resumed"
RESUME_STARTED: Final = "resume-started"
CLAIMED: Final = "claimed"
STOOD_DOWN: Final = "stood-down"
RETURNED: Final = "returned"

_STATUS_PREFIX: Final = "status:"
_MIRRORED_BODY: Final = "A second body, mirrored while a reclassification waits."
_RACED_BODY: Final = "Written into an account that is being erased."


def status_event(code: int) -> str:
    """The evidence event a worker records for the HTTP status it was answered."""
    return f"{_STATUS_PREFIX}{code}"


class PacingTimeoutError(RuntimeError):
    """The test never released a worker it had paused."""


class StandDownError(RuntimeError):
    """Raised by a resume worker's resolver once it has recorded its claim."""


def _wait(event: Event) -> None:
    if not event.wait(PACE_TIMEOUT_SECONDS):
        msg = "the test never released this worker"
        raise PacingTimeoutError(msg)


async def _released(event: Event) -> None:
    """Wait for the test without blocking this worker's event loop."""
    await asyncio.to_thread(_wait, event)


async def _started_together(start: Barrier) -> None:
    await asyncio.to_thread(start.wait, PACE_TIMEOUT_SECONDS)


@dataclass(frozen=True, slots=True)
class Worker:
    """Which database a worker process connects to, and the label its evidence carries."""

    url: str
    label: str


@dataclass(frozen=True, slots=True)
class Evidence:
    """One row a worker wrote."""

    seq: int
    worker: str
    event: str


class EvidenceLog:
    """A worker's autocommit connection to :data:`EVIDENCE_TABLE`."""

    def __init__(self, worker: Worker) -> None:
        """Open nothing yet; each record takes and returns its own connection."""
        self._engine = create_async_engine(
            worker.url, poolclass=NullPool, isolation_level="AUTOCOMMIT"
        )
        self._label = worker.label

    async def record(self, event: str) -> None:
        """Commit one event now, so a sibling process can already see it."""
        async with self._engine.connect() as connection:
            await connection.execute(
                text(_INSERT_EVIDENCE),
                {"worker": self._label, "event": event},
            )

    async def close(self) -> None:
        """Dispose of the evidence engine."""
        await self._engine.dispose()


async def read_evidence(engine: AsyncEngine) -> list[Evidence]:
    """Every evidence row, in the order the database assigned them."""
    async with engine.connect() as connection:
        rows = await connection.execute(text(_SELECT_EVIDENCE))
        return [Evidence(seq=row.seq, worker=row.worker, event=row.event) for row in rows]


@asynccontextmanager
async def _evidence(worker: Worker) -> AsyncIterator[EvidenceLog]:
    log = EvidenceLog(worker)
    try:
        yield log
    finally:
        await log.close()


@asynccontextmanager
async def _worker_database(url: str) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """This process's own engine, with a real pool, as a production worker has."""
    engine = create_async_engine(url)
    try:
        yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    finally:
        await engine.dispose()


class EvidenceVault(NoPipelineVaultDouble):
    """A Creek Vault double that writes every mutation it receives to the evidence table.

    With ``pause`` it announces its first ingest on ``pause[0]`` and holds that
    ingest -- inside whatever privacy locks the caller holds -- until the test
    sets ``pause[1]``.
    """

    def __init__(self, evidence: EvidenceLog, *, pause: tuple[Event, Event] | None = None) -> None:
        """Bind the evidence log and the optional pause point."""
        self._evidence = evidence
        self._pause = pause
        self._ingests = 0

    async def handshake(self) -> HandshakeResult:
        """Report available, with journal ingest and withdrawal."""
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=frozenset({CreekCapability.JOURNAL, CreekCapability.JOURNAL_WITHDRAW}),
            attestation=None,
        )

    def is_available(self) -> bool:
        """Always available."""
        return True

    def supports(self, capability: CreekCapability, /) -> bool:
        """Journal ingest and withdrawal only."""
        return capability in {CreekCapability.JOURNAL, CreekCapability.JOURNAL_WITHDRAW}

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Record the mirror starting and landing, pausing between if asked to."""
        del request
        self._ingests += 1
        await self._evidence.record(UPSERT_STARTED)
        if self._pause is not None:
            started, release = self._pause
            started.set()
            await _released(release)
        await self._evidence.record(UPSERT_LANDED)
        return VaultIngestResult(stored=True, vault_ref=f"vault-ref-{self._ingests}")

    async def withdraw_journal_entry(self, entry_id: int, /) -> VaultJournalWithdrawResult:
        """Record the withdrawal and confirm it."""
        del entry_id
        await self._evidence.record(WITHDRAW)
        return VaultJournalWithdrawResult(withdrawn=True)

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Unused on these paths."""
        raise NotImplementedError(request)

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """A fixed tag set."""
        return VaultClassification(tags=("courage",))

    async def reflect(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """An empty reflection."""
        return VaultReflection(
            status=VaultReflectionStatus.EMPTY,
            notes=(),
            essay=None,
            essay_grounded=False,
            routed_tier=VaultTierCeiling.OPEN,
        )

    async def wheel(self) -> VaultWheelBalance:
        """An empty wheel."""
        return VaultWheelBalance(aspects=())


async def _recorded_vault(_session: AsyncSession, _user_id: int) -> str:
    return RECORDED_VAULT


@asynccontextmanager
async def app_client(
    factory: async_sessionmaker[AsyncSession], vault: EvidenceVault
) -> AsyncIterator[AsyncClient]:
    """Drive this process's own copy of the app: a session per request, ``vault`` as Creek."""

    async def _per_request_session() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = _per_request_session
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(journal_router, "resolved_vault_destination", _recorded_vault)
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                yield client
    finally:
        app.dependency_overrides.clear()


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ── (a) two egress operations for one account ────────────────────────────────


async def _egress_section(
    worker: Worker, user_id: int, start: Barrier, hold_seconds: float
) -> None:
    async with (
        _evidence(worker) as evidence,
        _worker_database(worker.url) as factory,
        factory() as session,
    ):
        await _started_together(start)
        async with hold_account(session, user_id):
            await ensure_account_live(session, user_id)
            await evidence.record(ENTER)
            await asyncio.sleep(hold_seconds)
            await evidence.record(EXIT)


def run_egress_section(
    worker: Worker,
    user_id: int,
    start: Barrier,
    hold_seconds: float,
    barrier_env: str | None,
) -> None:
    """Hold this account's egress barrier for ``hold_seconds``, as every egress site does.

    ``barrier_env``, when given, sets the barrier's rollout switch in this
    worker only: the negative control turns the cross-worker half off with it.
    """
    with pytest.MonkeyPatch.context() as patch:
        if barrier_env is not None:
            patch.setenv(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR, barrier_env)
        asyncio.run(_egress_section(worker, user_id, start, hold_seconds))


# ── (b) an Intimate reclassification racing a vault mirror ──────────────────


async def _mirror_edit(
    worker: Worker, token: str, entry_id: int, pause: tuple[Event, Event]
) -> None:
    async with _evidence(worker) as evidence, _worker_database(worker.url) as factory:
        vault = EvidenceVault(evidence, pause=pause)
        async with app_client(factory, vault) as client:
            response = await client.patch(
                f"/journal/{entry_id}", json={"message": _MIRRORED_BODY}, headers=_bearer(token)
            )
        await evidence.record(status_event(response.status_code))


def run_mirror_edit(
    worker: Worker, token: str, entry_id: int, started: Event, release: Event
) -> None:
    """Edit the entry's body, so Creek is sent a new copy -- and hold that send mid-flight."""
    asyncio.run(_mirror_edit(worker, token, entry_id, (started, release)))


async def _reclassify(worker: Worker, token: str, entry_id: int) -> None:
    async with _evidence(worker) as evidence, _worker_database(worker.url) as factory:
        async with app_client(factory, EvidenceVault(evidence)) as client:
            await evidence.record(RECLASSIFY_SENT)
            response = await client.patch(
                f"/journal/{entry_id}",
                json={"classification": "intimate"},
                headers=_bearer(token),
            )
        await evidence.record(status_event(response.status_code))


def run_reclassify(worker: Worker, token: str, entry_id: int) -> None:
    """Reclassify the entry as Intimate."""
    asyncio.run(_reclassify(worker, token, entry_id))


# ── (c) account erasure racing a journal write ───────────────────────────────


async def _paused_write(worker: Worker, token: str, paused: Event, release: Event) -> None:
    async with _evidence(worker) as evidence, _worker_database(worker.url) as factory:

        async def _pause_before_the_insert(*_args: object, **_kwargs: object) -> None:
            """Hold the write between authentication and the row it is about to commit."""
            await evidence.record(WRITE_PAUSED)
            paused.set()
            await _released(release)
            await evidence.record(WRITE_RESUMED)

        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(journal_router, "_authorize_practice_links", _pause_before_the_insert)
            async with app_client(factory, EvidenceVault(evidence)) as client:
                response = await client.post(
                    "/journal/",
                    json={"message": _RACED_BODY, "classification": "personal"},
                    headers=_bearer(token),
                )
        await evidence.record(status_event(response.status_code))


def run_paused_write(worker: Worker, token: str, paused: Event, release: Event) -> None:
    """Create a journal entry, paused after authentication until the test releases it."""
    asyncio.run(_paused_write(worker, token, paused, release))


async def _erasure(worker: Worker, token: str, email: str) -> None:
    async with _evidence(worker) as evidence, _worker_database(worker.url) as factory:
        async with app_client(factory, EvidenceVault(evidence)) as client:
            response = await client.request(
                "DELETE", "/users/me", json={"confirm_email": email}, headers=_bearer(token)
            )
        await evidence.record(status_event(response.status_code))


def run_erasure(worker: Worker, token: str, email: str) -> None:
    """Erase the account."""
    asyncio.run(_erasure(worker, token, email))


# ── (d) workers resuming the same durable pipeline run ───────────────────────


async def _resume(worker: Worker, start: Barrier, hold_seconds: float) -> None:
    async with _evidence(worker) as evidence, _worker_database(worker.url) as factory:

        async def _resolve(_session: AsyncSession, _user_id: int) -> CreekVaultPipelineClient:
            """Reached only by the worker holding the run's claim; hold it, then stand down."""
            await evidence.record(CLAIMED)
            await asyncio.sleep(hold_seconds)
            raise StandDownError

        await _started_together(start)
        await evidence.record(RESUME_STARTED)
        try:
            await resume_vault_pipeline_runs(factory, _resolve)
        except StandDownError:
            await evidence.record(STOOD_DOWN)
        else:
            await evidence.record(RETURNED)


def run_resume(worker: Worker, start: Barrier, hold_seconds: float) -> None:
    """Resume every persisted pipeline run, as each worker does at boot."""
    asyncio.run(_resume(worker, start, hold_seconds))
