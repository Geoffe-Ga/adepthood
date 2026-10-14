"""The privacy orderings hold across separate OS processes on real PostgreSQL (#3163, B15).

The claims rest on orderings: the account barrier serializes one account's
egress (C21), an Intimate reclassification linearizes after any copy already in
flight to Creek and withdraws it (C07, C11), an erasure refuses a write already
past authentication without orphaning its row (C21), and a durable pipeline run
is resumed by exactly one worker (C21). Every other proof of them runs in one
process -- two serializer instances, or two tasks on one event loop -- and audit
evidence E28 is blunt about what that certifies: unit SQLite tests do not
certify production workers.

So each race here is two or more ``multiprocessing`` **spawn** processes
(:mod:`tests.integration.privacy_order_workers`), each importing the app afresh
and building its own engine and pool against the migrated Postgres. Nothing in
memory is shared; the ``multiprocessing`` primitives only pace the race. The
ordering is read back from rows the workers committed to an evidence table --
sequence numbers assigned by the database -- and from the product's own tables.

Each race also carries the control that makes it mean something: the egress
race is rerun with the cross-worker half switched off and must then overlap;
the reclassification is released only once PostgreSQL itself reports it queued
on an advisory lock; and the resume race proves the losers finished while the
winner still held its claim.

Marked ``integration``: it runs only in the Postgres lane, skips without
``TEST_POSTGRES_URL``, and fails rather than skips under
``INTEGRATION_LANE_REQUIRE_POSTGRES`` (``pg_lane.py``'s rule, via the
``pg_database_url`` fixture).
"""

from __future__ import annotations

import asyncio
import multiprocessing
from collections.abc import AsyncGenerator, Callable, Iterable
from http import HTTPStatus
from typing import TYPE_CHECKING, Final

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlmodel import col, func, select

from domain.creek_vault import VaultPipelineStage
from models.journal_entry import JournalEntry
from models.user import User
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services.creek_vault_pipeline import VaultPipelineTrigger
from tests.integration import privacy_order_workers as workers
from tests.integration.privacy_order_workers import (
    CREATE_EVIDENCE_TABLE,
    DROP_EVIDENCE_TABLE,
    Evidence,
    EvidenceLog,
    EvidenceVault,
    Worker,
    app_client,
    read_evidence,
    status_event,
)

if TYPE_CHECKING:
    from multiprocessing.context import SpawnContext, SpawnProcess
    from multiprocessing.synchronize import Event

    from tests.integration.session_per_request import SessionPerRequest

pytestmark = pytest.mark.integration

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

#: Spawned workers import the whole app before they do anything, so a join is
#: allowed far longer than any race inside it takes.
_JOIN_TIMEOUT_SECONDS: Final = 120.0
_SIGNAL_TIMEOUT_SECONDS: Final = 90.0
_LOCK_POLL_SECONDS: Final = 0.05

#: How long each egress worker stays inside the barrier. Long enough that two
#: unordered workers released by one barrier certainly overlap.
_EGRESS_HOLD_SECONDS: Final = 1.5
#: How long the resume winner keeps its claim, for the losers to try and fail.
_CLAIM_HOLD_SECONDS: Final = 2.0
_RESUME_WORKERS: Final = 3

_BARRIER_OFF: Final = "false"

_WAITING_ADVISORY_LOCKS: Final = text(
    "SELECT count(*) FROM pg_locks "
    "WHERE locktype = 'advisory' AND NOT granted "
    "AND database = (SELECT oid FROM pg_database WHERE datname = current_database())"
)


@pytest.fixture
def spawn() -> SpawnContext:
    """The ``spawn`` start method: a fresh interpreter, never a forked copy of this one."""
    return multiprocessing.get_context("spawn")


@pytest_asyncio.fixture
async def evidence_engine(pg_database_url: str) -> AsyncGenerator[AsyncEngine, None]:
    """An engine for reading the evidence table, which exists for this test only."""
    engine = create_async_engine(pg_database_url)
    async with engine.begin() as connection:
        await connection.execute(text(DROP_EVIDENCE_TABLE))
        await connection.execute(text(CREATE_EVIDENCE_TABLE))
    try:
        yield engine
    finally:
        async with engine.begin() as connection:
            await connection.execute(text(DROP_EVIDENCE_TABLE))
        await engine.dispose()


def _start(spawn: SpawnContext, target: Callable[..., None], *args: object) -> SpawnProcess:
    process = spawn.Process(target=target, args=args, daemon=True)
    process.start()
    return process


async def _join(processes: Iterable[SpawnProcess]) -> None:
    """Wait for every worker, and fail on any that did not exit cleanly."""
    for process in processes:
        await asyncio.to_thread(process.join, _JOIN_TIMEOUT_SECONDS)
        if process.is_alive():
            process.kill()
        assert process.exitcode == 0, f"worker {process.name} exited {process.exitcode}"


async def _signalled(event: Event) -> None:
    signalled = await asyncio.to_thread(event.wait, _SIGNAL_TIMEOUT_SECONDS)
    assert signalled, "a worker never signalled"


async def _signup(pair: SessionPerRequest, email: str) -> tuple[str, int]:
    """Sign a user up through the app, returning their token and id."""
    response = await pair.client.post(
        "/auth/signup", json={"email": email, "password": _SIGNUP_PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK
    async with pair.factory() as session:
        user_id = (
            await session.execute(select(col(User.id)).where(User.email == email))
        ).scalar_one()
    token: str = response.json()["token"]
    assert user_id is not None
    return token, user_id


def _by_worker(evidence: list[Evidence], worker: str) -> list[str]:
    return [row.event for row in evidence if row.worker == worker]


def _seq(evidence: list[Evidence], worker: str, event: str) -> int:
    matches = [row.seq for row in evidence if row.worker == worker and row.event == event]
    assert len(matches) == 1, f"{worker} recorded {event!r} {len(matches)} times: {evidence}"
    return matches[0]


# ── (a) two egress operations for one account ────────────────────────────────


async def _race_two_egress_sections(
    spawn: SpawnContext, url: str, user_id: int, barrier_env: str | None
) -> None:
    start = spawn.Barrier(2)
    processes = [
        _start(
            spawn,
            workers.run_egress_section,
            Worker(url, label),
            user_id,
            start,
            _EGRESS_HOLD_SECONDS,
            barrier_env,
        )
        for label in ("first", "second")
    ]
    await _join(processes)


def _sections_overlap(evidence: list[Evidence]) -> bool:
    first = (_seq(evidence, "first", workers.ENTER), _seq(evidence, "first", workers.EXIT))
    second = (_seq(evidence, "second", workers.ENTER), _seq(evidence, "second", workers.EXIT))
    return first[0] < second[1] and second[0] < first[1]


@pytest.mark.asyncio
async def test_two_processes_egressing_for_one_account_are_serialized(
    pair: SessionPerRequest,
    pg_database_url: str,
    evidence_engine: AsyncEngine,
    spawn: SpawnContext,
) -> None:
    """Race (a): no process enters the account barrier while another is inside it."""
    _token, user_id = await _signup(pair, "mp_egress@example.com")

    await _race_two_egress_sections(spawn, pg_database_url, user_id, barrier_env=None)

    evidence = await read_evidence(evidence_engine)
    assert not _sections_overlap(evidence), evidence


@pytest.mark.asyncio
async def test_without_the_cross_worker_half_the_two_processes_overlap(
    pair: SessionPerRequest,
    pg_database_url: str,
    evidence_engine: AsyncEngine,
    spawn: SpawnContext,
) -> None:
    """Control for (a): the serialization above is PostgreSQL's, not an artifact of timing.

    With the advisory half switched off each process still takes its own
    in-process lock -- which orders nothing across processes -- so the same race
    must interleave. If it did not, the test above would prove nothing.
    """
    _token, user_id = await _signup(pair, "mp_egress_control@example.com")

    await _race_two_egress_sections(spawn, pg_database_url, user_id, barrier_env=_BARRIER_OFF)

    evidence = await read_evidence(evidence_engine)
    assert _sections_overlap(evidence), evidence


# ── (b) an Intimate reclassification racing a vault mirror ──────────────────


async def _queued_on_an_advisory_lock(engine: AsyncEngine) -> None:
    """Return once PostgreSQL reports a backend waiting for an advisory lock here."""

    async def _poll() -> None:
        while True:
            async with engine.connect() as connection:
                waiting = (await connection.execute(_WAITING_ADVISORY_LOCKS)).scalar_one()
            if waiting:
                return
            await asyncio.sleep(_LOCK_POLL_SECONDS)

    await asyncio.wait_for(_poll(), _SIGNAL_TIMEOUT_SECONDS)


async def _create_personal_entry(pair: SessionPerRequest, url: str, token: str) -> int:
    log = EvidenceLog(Worker(url, "seed"))
    try:
        async with app_client(pair.factory, EvidenceVault(log)) as client:
            created = await client.post(
                "/journal/",
                json={"message": "A first body, mirrored to Creek.", "classification": "personal"},
                headers={"Authorization": f"Bearer {token}"},
            )
    finally:
        await log.close()
    assert created.status_code == HTTPStatus.CREATED
    return int(created.json()["id"])


@pytest.mark.asyncio
async def test_no_mirror_lands_after_an_intimate_reclassification_in_another_process(
    pair: SessionPerRequest,
    pg_database_url: str,
    evidence_engine: AsyncEngine,
    spawn: SpawnContext,
) -> None:
    """Race (b): the reclassification waits out the in-flight copy, then withdraws it."""
    token, _user_id = await _signup(pair, "mp_reclassify@example.com")
    entry_id = await _create_personal_entry(pair, pg_database_url, token)
    started, release = spawn.Event(), spawn.Event()

    mirror = _start(
        spawn,
        workers.run_mirror_edit,
        Worker(pg_database_url, "mirror"),
        token,
        entry_id,
        started,
        release,
    )
    try:
        await _signalled(started)
        reclassify = _start(
            spawn, workers.run_reclassify, Worker(pg_database_url, "reclassify"), token, entry_id
        )
        await _queued_on_an_advisory_lock(evidence_engine)
    finally:
        release.set()
    await _join([mirror, reclassify])

    evidence = await read_evidence(evidence_engine)
    ok = status_event(HTTPStatus.OK)
    assert _by_worker(evidence, "mirror") == [workers.UPSERT_STARTED, workers.UPSERT_LANDED, ok]
    assert _by_worker(evidence, "reclassify") == [workers.RECLASSIFY_SENT, workers.WITHDRAW, ok]
    sent = _seq(evidence, "reclassify", workers.RECLASSIFY_SENT)
    landed = _seq(evidence, "mirror", workers.UPSERT_LANDED)
    withdrawn = _seq(evidence, "reclassify", workers.WITHDRAW)
    assert sent < landed < withdrawn, "the reclassification did not wait out the copy in flight"
    assert not [
        row for row in evidence if row.seq > withdrawn and row.event == workers.UPSERT_LANDED
    ]
    async with pair.factory() as session:
        entry = await session.get(JournalEntry, entry_id)
    assert entry is not None
    assert entry.classification == "intimate"
    assert entry.vault_ref is None


# ── (c) account erasure racing a journal write ───────────────────────────────


@pytest.mark.asyncio
async def test_a_write_racing_its_erasure_in_another_process_is_refused_and_orphans_nothing(
    pair: SessionPerRequest,
    pg_database_url: str,
    evidence_engine: AsyncEngine,
    spawn: SpawnContext,
) -> None:
    """Race (c): the write past authentication answers 401, and leaves no row behind."""
    email = "mp_erasure@example.com"
    token, user_id = await _signup(pair, email)
    paused, release = spawn.Event(), spawn.Event()

    writer = _start(
        spawn, workers.run_paused_write, Worker(pg_database_url, "write"), token, paused, release
    )
    try:
        await _signalled(paused)
        eraser = _start(spawn, workers.run_erasure, Worker(pg_database_url, "erase"), token, email)
        await _join([eraser])
    finally:
        release.set()
    await _join([writer])

    evidence = await read_evidence(evidence_engine)
    assert _by_worker(evidence, "erase") == [status_event(HTTPStatus.OK)]
    assert _by_worker(evidence, "write") == [
        workers.WRITE_PAUSED,
        workers.WRITE_RESUMED,
        status_event(HTTPStatus.UNAUTHORIZED),
    ]
    assert _seq(evidence, "erase", status_event(HTTPStatus.OK)) < _seq(
        evidence, "write", workers.WRITE_RESUMED
    )
    async with pair.factory() as session:
        assert await session.get(User, user_id) is None
        owned = await session.execute(
            select(func.count()).select_from(JournalEntry).where(JournalEntry.user_id == user_id)
        )
        orphaned = await session.execute(
            select(func.count())
            .select_from(JournalEntry)
            .where(col(JournalEntry.user_id).not_in(select(col(User.id))))
        )
    assert owned.scalar_one() == 0
    assert orphaned.scalar_one() == 0


# ── (d) workers resuming the same durable pipeline run ───────────────────────


async def _seed_resumable_run(session: AsyncSession, user_id: int) -> int:
    run = VaultPipelineRun(
        user_id=user_id,
        stage=VaultPipelineStage.CLASSIFY.value,
        trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
        outcome=VaultPipelineOutcome.ATTEMPTED.value,
        job_id="classification-job",
        attempt_count=1,
        fragments_seen=0,
        fragments_touched=0,
        fragments_lost=0,
    )
    session.add(run)
    await session.commit()
    assert run.id is not None
    return run.id


@pytest.mark.asyncio
async def test_exactly_one_process_resumes_a_durable_pipeline_run(
    pair: SessionPerRequest,
    pg_database_url: str,
    evidence_engine: AsyncEngine,
    spawn: SpawnContext,
) -> None:
    """Race (d): of several booting workers, one claims the run and the rest find it taken."""
    _token, user_id = await _signup(pair, "mp_resume@example.com")
    async with pair.factory() as session:
        run_id = await _seed_resumable_run(session, user_id)
    start = spawn.Barrier(_RESUME_WORKERS)
    labels = [f"boot-{index}" for index in range(_RESUME_WORKERS)]

    await _join(
        [
            _start(
                spawn,
                workers.run_resume,
                Worker(pg_database_url, label),
                start,
                _CLAIM_HOLD_SECONDS,
            )
            for label in labels
        ]
    )

    evidence = await read_evidence(evidence_engine)
    claimers = [row.worker for row in evidence if row.event == workers.CLAIMED]
    assert len(claimers) == 1, evidence
    (winner,) = claimers
    assert _by_worker(evidence, winner) == [
        workers.RESUME_STARTED,
        workers.CLAIMED,
        workers.STOOD_DOWN,
    ]
    stood_down = _seq(evidence, winner, workers.STOOD_DOWN)
    for loser in (label for label in labels if label != winner):
        assert _by_worker(evidence, loser) == [workers.RESUME_STARTED, workers.RETURNED]
        assert _seq(evidence, loser, workers.RETURNED) < stood_down, (
            f"{loser} only looked after {winner} let the claim go, so nothing raced"
        )
    async with pair.factory() as session:
        run = await session.get(VaultPipelineRun, run_id)
    assert run is not None
    assert run.resume_claim_id is None, "the winner's failed resume did not release its claim"
