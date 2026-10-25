"""A queued worker must observe the handle admitted by a concurrent keyed request."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import Final
from uuid import UUID

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekVaultPipelineClient,
    VaultKeyProvider,
    VaultPipelineStage,
    VaultProviderKey,
)
from models.user import User
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services import creek_vault_pipeline as pipeline
from services.account_egress_barrier import hold_account
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_pipeline import _DETACHED_DIAL as DETACHED_DIAL
from services.creek_vault_pipeline import _RESUME_CLAIM_STALE_AFTER as RESUME_CLAIM_STALE_AFTER
from services.creek_vault_pipeline import _claim_one_resumable_run as claim_one_resumable_run
from services.creek_vault_pipeline import _Continuation as Continuation
from services.creek_vault_pipeline import _continue_ladder as continue_ladder
from services.creek_vault_pipeline import _ordered_dial as ordered_dial
from services.creek_vault_pipeline import _prepare_reconciliation as prepare_reconciliation
from services.creek_vault_pipeline import _RunResult as RunResult
from services.creek_vault_pipeline import _schedule_continuation as schedule_continuation
from services.creek_vault_pipeline import _stands_down as stands_down
from services.creek_vault_pipeline import _start_queued_run as start_queued_run
from services.creek_vault_relay import (
    PROVIDER_KEY_HEADER,
    forwarding_provider_key,
    has_forwarded_provider_key,
    keyless_context,
)
from tests.provider_transport import ANTHROPIC_KEY

_OWNER: Final = 701
_CLASSIFY: Final = "/v1/classifications"
_JOB_PREFIX: Final = "/v1/jobs/"
_FIRST_JOB: Final = str(UUID(int=1, version=4))
_OLD_CLAIM: Final = str(UUID(int=73, version=4))
_SETTLE_SECONDS: Final = 10.0


@dataclass
class _RaceGates:
    """Explicitly order liveness, foreground submission, and the old worker's dial."""

    old_live: asyncio.Event = field(default_factory=asyncio.Event)
    release_old: asyncio.Event = field(default_factory=asyncio.Event)
    submit_started: asyncio.Event = field(default_factory=asyncio.Event)
    release_submit: asyncio.Event = field(default_factory=asyncio.Event)
    old_waiting: asyncio.Event = field(default_factory=asyncio.Event)
    old_inside: asyncio.Event = field(default_factory=asyncio.Event)
    release_old_dial: asyncio.Event = field(default_factory=asyncio.Event)

    def release(self) -> None:
        """Unblock every waiter even when an intermediate assertion fails."""
        self.release_old.set()
        self.release_submit.set()
        self.release_old_dial.set()


def _classified() -> dict[str, object]:
    """A terminal classification result with the real wire vocabulary."""
    return {
        "status": "ok",
        "tier_ceiling": "personal",
        "method": "llm",
        "total": 1,
        "classified": 1,
        "preserved_manual": 0,
        "preserved_llm": 0,
        "privacy_tiers_assigned": 0,
        "retiered": 0,
        "praxis_marked": 0,
        "tags_extracted": 1,
        "complete": True,
    }


@dataclass
class _RacingVault:
    """Pause the keyed admission and make any duplicate receive a different handle."""

    gates: _RaceGates
    posts: list[httpx.Request] = field(default_factory=list)
    polls: list[httpx.Request] = field(default_factory=list)
    polled: asyncio.Event = field(default_factory=asyncio.Event)
    links: list[httpx.Request] = field(default_factory=list)
    hold_polls: asyncio.Event | None = None

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record actual adapter headers and return durable, terminal job answers."""
        path = request.url.path
        if path == "/v1/capabilities":
            minor = ".".join(CONTRACT_VERSION.split(".")[:2])
            return httpx.Response(
                HTTPStatus.OK,
                json={
                    "vault": {"available": True},
                    "capabilities": ["capabilities", "pipeline"],
                    "contract_version": CONTRACT_VERSION,
                    "contract_minor": minor,
                    "supported_contract_minors": [minor],
                    "request_key_providers": ["anthropic"],
                    "ontology_version": "1.0.0",
                    "attestation": None,
                },
            )
        if path == _CLASSIFY:
            self.posts.append(request)
            if len(self.posts) == 1:
                self.gates.submit_started.set()
                await self.gates.release_submit.wait()
            return httpx.Response(
                HTTPStatus.ACCEPTED,
                json={
                    "status": "accepted",
                    "job_id": str(UUID(int=len(self.posts), version=4)),
                    "state": "queued",
                },
            )
        if path.startswith(_JOB_PREFIX):
            self.polls.append(request)
            self.polled.set()
            if self.hold_polls is not None:
                await self.hold_polls.wait()
            return httpx.Response(
                HTTPStatus.OK,
                json={
                    "status": "ok",
                    "job_id": path.removeprefix(_JOB_PREFIX),
                    "state": "succeeded",
                    "result": _classified(),
                },
            )
        if path == "/v1/links":
            self.links.append(request)
            return httpx.Response(
                HTTPStatus.OK,
                json={
                    "status": "ok",
                    "tier_ceiling": "personal",
                    "method": str(json.loads(request.content)["method"]),
                    "fragment_count": 1,
                    "link_count": 1,
                    "largest_cluster_fragments": 1,
                    "clusters_split": 0,
                    "oversized_discarded": 0,
                },
            )
        raise AssertionError(f"unexpected vault request: {request.method} {path}")


async def _seed_queue(
    factory: async_sessionmaker[AsyncSession], *, debounce_links: bool = True
) -> int:
    """Create a live account and the unstarted promise both contenders can observe."""
    async with factory() as session:
        session.add(
            User(id=_OWNER, email="keyed-admission-race@example.com", password_hash=str(_OWNER))
        )
        run = VaultPipelineRun(
            user_id=_OWNER,
            stage=VaultPipelineStage.CLASSIFY.value,
            trigger=pipeline.VaultPipelineTrigger.JOURNAL_WRITE.value,
            outcome=VaultPipelineOutcome.QUEUED.value,
            attempt_count=0,
            fragments_seen=0,
            fragments_touched=0,
            fragments_lost=0,
        )
        session.add(run)
        # Debounce the unrelated journal-only linker so this test observes only
        # admission and reconciliation of the shared classification snapshot.
        if debounce_links:
            session.add(
                VaultPipelineRun(
                    user_id=_OWNER,
                    stage=VaultPipelineStage.TEMPORAL.value,
                    trigger=pipeline.VaultPipelineTrigger.JOURNAL_WRITE.value,
                    outcome=VaultPipelineOutcome.COMPLETED.value,
                    fragments_seen=0,
                    fragments_touched=0,
                    fragments_lost=0,
                )
            )
        await session.commit()
        assert run.id is not None
        return run.id


async def _read_run(factory: async_sessionmaker[AsyncSession], run_id: int) -> VaultPipelineRun:
    """Read committed truth independently of either contender's ORM identity map."""
    async with factory() as session:
        result = await session.execute(
            select(VaultPipelineRun).where(VaultPipelineRun.id == run_id)
        )
        return result.scalars().one()


async def _keyed_request(
    factory: async_sessionmaker[AsyncSession], client: HttpCreekVaultClient
) -> None:
    """Use the production request's account barrier and request-scoped relay context."""
    async with factory() as session, hold_account(session, _OWNER):
        with forwarding_provider_key(
            VaultProviderKey(provider=VaultKeyProvider.ANTHROPIC, _secret=ANTHROPIC_KEY)
        ):
            await pipeline.drive_vault_pipeline(
                session,
                client,
                user_id=_OWNER,
                trigger=pipeline.VaultPipelineTrigger.JOURNAL_WRITE,
            )


async def _admit_while_old_worker_waits(
    factory: async_sessionmaker[AsyncSession],
    wire: _RacingVault,
    client: HttpCreekVaultClient,
    run_id: int,
) -> None:
    """Prove keyed admission and a committed handle before releasing the old dial."""
    gates = wire.gates
    await asyncio.wait_for(gates.old_live.wait(), _SETTLE_SECONDS)
    request_task = asyncio.create_task(_keyed_request(factory, client))
    try:
        await asyncio.wait_for(gates.submit_started.wait(), _SETTLE_SECONDS)
        claimed = await _read_run(factory, run_id)
        assert claimed.outcome == VaultPipelineOutcome.ATTEMPTED.value
        assert claimed.job_id is None
        assert claimed.attempt_count == 1
        assert wire.posts[0].headers.get(PROVIDER_KEY_HEADER) == ANTHROPIC_KEY

        gates.release_old.set()
        await asyncio.wait_for(gates.old_waiting.wait(), _SETTLE_SECONDS)
        gates.release_submit.set()
        await asyncio.wait_for(request_task, _SETTLE_SECONDS)
        await asyncio.wait_for(gates.old_inside.wait(), _SETTLE_SECONDS)
        admitted = await _read_run(factory, run_id)
        assert admitted.job_id == _FIRST_JOB
    finally:
        if not request_task.done():
            request_task.cancel()
            await asyncio.gather(request_task, return_exceptions=True)


async def _finish_race(
    factory: async_sessionmaker[AsyncSession], wire: _RacingVault, run_id: int
) -> None:
    """Require the stale worker to poll the published handle without another submit."""
    wire.gates.release_old_dial.set()
    await asyncio.wait_for(wire.polled.wait(), _SETTLE_SECONDS)
    await asyncio.wait_for(pipeline.wait_for_vault_pipeline_tasks(), _SETTLE_SECONDS)
    finished = await _read_run(factory, run_id)
    assert len(wire.posts) == 1, "old worker re-admitted after the keyed handle was committed"
    assert finished.job_id == _FIRST_JOB
    assert finished.attempt_count == 1
    assert finished.outcome == VaultPipelineOutcome.COMPLETED.value
    assert wire.polls
    assert {request.url.path for request in wire.polls} == {_JOB_PREFIX + _FIRST_JOB}
    assert all(PROVIDER_KEY_HEADER not in request.headers for request in wire.polls)


async def _vault_client(http: httpx.AsyncClient) -> HttpCreekVaultClient:
    """Handshake one worker's real adapter against the local wire fixture."""
    client = HttpCreekVaultClient(
        "https://vault.example.test", str(_OWNER), http_client=http, pin_destination=False
    )
    await client.handshake()
    return client


def _continuation_for(
    factory: async_sessionmaker[AsyncSession],
    client: HttpCreekVaultClient,
    run_id: int,
    outcome: VaultPipelineOutcome = VaultPipelineOutcome.ATTEMPTED,
    claim_id: str | None = None,
) -> Continuation:
    """Model one worker entry without a second worker's process-local registry."""
    return Continuation(
        factory=factory,
        client=client,
        user_id=_OWNER,
        trigger=pipeline.VaultPipelineTrigger.JOURNAL_WRITE,
        pending=RunResult(run_id=run_id, outcome=outcome),
        stage=VaultPipelineStage.CLASSIFY,
        remaining=(),
        resume_claim_id=claim_id,
    )


def _release_wire(wire: _RacingVault) -> None:
    """Release both admission and status waiters before task cleanup."""
    wire.gates.release()
    if wire.hold_polls is not None:
        wire.hold_polls.set()


@dataclass
class _LeaseGates:
    """Pause the actual owner's queued snapshot and record the losing admission CAS."""

    loaded_queue: asyncio.Event = field(default_factory=asyncio.Event)
    release_owner: asyncio.Event = field(default_factory=asyncio.Event)
    lost_cas: asyncio.Event = field(default_factory=asyncio.Event)
    foreground_tokens: list[str | None] = field(default_factory=list)


def _pause_owned_queue(monkeypatch: pytest.MonkeyPatch, run_id: int, gates: _LeaseGates) -> None:
    """Retain real reconciliation/CAS behavior while ordering its stale queued read."""

    async def pause_before_cas(
        session: AsyncSession,
        client: CreekVaultPipelineClient,
        run: VaultPipelineRun,
        stage: VaultPipelineStage,
    ) -> VaultPipelineRun | VaultPipelineOutcome | None:
        """Keep the ORM snapshot but release its read transaction before the writer."""
        if run.id == run_id and run.outcome == VaultPipelineOutcome.QUEUED.value:
            await session.commit()
            gates.loaded_queue.set()
            await gates.release_owner.wait()
        return await prepare_reconciliation(session, client, run, stage)

    async def observe_cas(
        session: AsyncSession,
        client: CreekVaultPipelineClient,
        run: VaultPipelineRun,
        stage: VaultPipelineStage,
        *,
        budget: float | None = None,
    ) -> RunResult | None:
        """Identify the old owner losing QUEUED admission to the keyed foreground."""
        result = await start_queued_run(session, client, run, stage, budget=budget)
        if result is None and run.id == run_id and DETACHED_DIAL.get() is not None:
            gates.lost_cas.set()
        return result

    def observe_schedule(continuation: Continuation) -> bool:
        """A foreground snapshot must not pass another worker's lease as its own."""
        if has_forwarded_provider_key():
            gates.foreground_tokens.append(continuation.resume_claim_id)
        return schedule_continuation(continuation)

    monkeypatch.setattr(pipeline, "_prepare_reconciliation", pause_before_cas)
    monkeypatch.setattr(pipeline, "_start_queued_run", observe_cas)
    monkeypatch.setattr(pipeline, "_schedule_continuation", observe_schedule)


async def _resume_with(
    factory: async_sessionmaker[AsyncSession], client: HttpCreekVaultClient
) -> None:
    """Use the production startup lease CAS, not a forged owned continuation."""

    async def resolve(_session: AsyncSession, user_id: int) -> CreekVaultPipelineClient:
        """Both simulated workers resolve only their one live account's vault."""
        assert user_id == _OWNER
        return client

    await pipeline.resume_vault_pipeline_runs(factory, resolve)


async def _finish_owned_queue(
    factory: async_sessionmaker[AsyncSession],
    wire: _RacingVault,
    run_id: int,
    lease: _LeaseGates,
    old_claim: str,
) -> None:
    """The old lease owner must follow the foreground handle after losing admission."""
    lease.release_owner.set()
    await asyncio.wait_for(lease.lost_cas.wait(), _SETTLE_SECONDS)
    await asyncio.wait_for(wire.polled.wait(), _SETTLE_SECONDS)
    polling = await _read_run(factory, run_id)
    assert polling.resume_claim_id == old_claim
    assert wire.hold_polls is not None
    wire.hold_polls.set()
    await _finish_race(factory, wire, run_id)
    finished = await _read_run(factory, run_id)
    assert finished.resume_claim_id is None
    assert finished.resume_claimed_at is None
    assert lease.foreground_tokens
    assert all(token is None for token in lease.foreground_tokens)


@pytest.mark.asyncio
async def test_owned_queued_cas_loser_follows_foreground_handle_without_lending_its_lease(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A startup owner that loaded QUEUED remains the sole poller after foreground admission."""
    wire = _RacingVault(_RaceGates(), hold_polls=asyncio.Event())
    wire.gates.release_submit.set()
    lease = _LeaseGates()
    run_id = await _seed_queue(concurrent_session_factory)
    await pipeline.close_vault_pipeline_tasks()
    _pause_owned_queue(monkeypatch, run_id, lease)
    async with httpx.AsyncClient(transport=httpx.MockTransport(wire)) as http:
        old_client = await _vault_client(http)
        request_client = await _vault_client(http)
        try:
            await _resume_with(concurrent_session_factory, old_client)
            await asyncio.wait_for(lease.loaded_queue.wait(), _SETTLE_SECONDS)
            owned = await _read_run(concurrent_session_factory, run_id)
            assert owned.resume_claim_id is not None
            old_claim = owned.resume_claim_id
            await _keyed_request(concurrent_session_factory, request_client)
            admitted = await _read_run(concurrent_session_factory, run_id)
            assert admitted.job_id == _FIRST_JOB
            assert admitted.resume_claim_id == old_claim
            await _finish_owned_queue(concurrent_session_factory, wire, run_id, lease, old_claim)
        finally:
            lease.release_owner.set()
            _release_wire(wire)
            await pipeline.close_vault_pipeline_tasks()


async def _abandon_lease(factory: async_sessionmaker[AsyncSession], run_id: int) -> None:
    """Represent a dead worker past the production stale-claim horizon."""
    async with factory() as session:
        run = await session.get(VaultPipelineRun, run_id)
        assert run is not None
        run.resume_claim_id = _OLD_CLAIM
        run.resume_claimed_at = datetime.now(UTC) - RESUME_CLAIM_STALE_AFTER - timedelta(seconds=1)
        session.add(run)
        await session.commit()


@pytest.mark.asyncio
async def test_keyed_handle_is_recovered_with_a_new_lease_after_an_old_owner_died(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Stale recovery polls the keyed handle with a fresh UUID, never the dead owner's token."""
    wire = _RacingVault(_RaceGates(), hold_polls=asyncio.Event())
    wire.gates.release_submit.set()
    run_id = await _seed_queue(concurrent_session_factory)
    await _abandon_lease(concurrent_session_factory, run_id)
    await pipeline.close_vault_pipeline_tasks()
    async with httpx.AsyncClient(transport=httpx.MockTransport(wire)) as http:
        request_client = await _vault_client(http)
        try:
            await _keyed_request(concurrent_session_factory, request_client)
            await asyncio.wait_for(wire.polled.wait(), _SETTLE_SECONDS)
            polling = await _read_run(concurrent_session_factory, run_id)
            assert polling.job_id == _FIRST_JOB
            assert polling.resume_claim_id not in {None, _OLD_CLAIM}
            assert wire.hold_polls is not None
            wire.hold_polls.set()
            await _finish_race(concurrent_session_factory, wire, run_id)
            finished = await _read_run(concurrent_session_factory, run_id)
            assert finished.resume_claim_id is None
            assert finished.resume_claimed_at is None
        finally:
            _release_wire(wire)
            await pipeline.close_vault_pipeline_tasks()


async def _seed_known_handle(factory: async_sessionmaker[AsyncSession]) -> int:
    """Leave linking due after one already admitted classification snapshot."""
    run_id = await _seed_queue(factory, debounce_links=False)
    async with factory() as session:
        run = await session.get(VaultPipelineRun, run_id)
        assert run is not None
        run.outcome = VaultPipelineOutcome.ATTEMPTED.value
        run.attempt_count = 1
        run.job_id = _FIRST_JOB
        session.add(run)
        await session.commit()
    return run_id


async def _race_independent_workers(
    factory: async_sessionmaker[AsyncSession],
    wire: _RacingVault,
    clients: tuple[HttpCreekVaultClient, HttpCreekVaultClient],
    run_id: int,
) -> None:
    """Bypass only the process-local registry, as two real worker processes would."""
    workers = tuple(
        asyncio.create_task(
            continue_ladder(_continuation_for(factory, client, run_id)), context=keyless_context()
        )
        for client in clients
    )
    try:
        await asyncio.wait_for(wire.polled.wait(), _SETTLE_SECONDS)
        done, pending = await asyncio.wait(
            workers, timeout=_SETTLE_SECONDS, return_when=asyncio.FIRST_COMPLETED
        )
        assert len(done) == 1, "a live lease must make the peer stand down"
        assert len(pending) == 1
        await asyncio.gather(*done)
        polling = await _read_run(factory, run_id)
        assert polling.resume_claim_id is not None
        assert wire.hold_polls is not None
        wire.hold_polls.set()
        await asyncio.wait_for(asyncio.gather(*workers), _SETTLE_SECONDS)
    finally:
        _release_wire(wire)
        for worker in workers:
            if not worker.done():
                worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)


@pytest.mark.asyncio
async def test_two_unleased_worker_entries_have_one_poller_and_one_successor_climber(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The durable lease, rather than an in-process task map, selects the only ladder owner."""
    wire = _RacingVault(_RaceGates(), hold_polls=asyncio.Event())
    run_id = await _seed_known_handle(concurrent_session_factory)
    await pipeline.close_vault_pipeline_tasks()
    async with httpx.AsyncClient(transport=httpx.MockTransport(wire)) as http:
        clients = (await _vault_client(http), await _vault_client(http))
        try:
            await _race_independent_workers(concurrent_session_factory, wire, clients, run_id)
            assert not wire.posts
            assert len(wire.polls) == 1
            assert len(wire.links) == 1
            assert PROVIDER_KEY_HEADER not in wire.polls[0].headers
            assert PROVIDER_KEY_HEADER not in wire.links[0].headers
            async with concurrent_session_factory() as session:
                result = await session.execute(
                    select(VaultPipelineRun).where(VaultPipelineRun.user_id == _OWNER)
                )
                rows = result.scalars().all()
            assert len(rows) == 2
            assert all(row.outcome == VaultPipelineOutcome.COMPLETED.value for row in rows)
            assert all(row.resume_claim_id is None for row in rows)
        finally:
            _release_wire(wire)
            await pipeline.close_vault_pipeline_tasks()


async def _transfer_expired_lease(
    factory: async_sessionmaker[AsyncSession], run_id: int, old_claim: str
) -> str:
    """Grant a replacement through the real recovery CAS while the old wire waits."""
    async with factory() as session:
        run = await session.get(VaultPipelineRun, run_id)
        assert run is not None
        assert run.resume_claim_id == old_claim
        run.resume_claimed_at = datetime.now(UTC) - RESUME_CLAIM_STALE_AFTER - timedelta(seconds=1)
        session.add(run)
        await session.commit()
        replacement = await claim_one_resumable_run(session)
        assert replacement is not None
        assert replacement.id == run_id
        assert replacement.resume_claim_id is not None
        assert replacement.resume_claim_id != old_claim
        return replacement.resume_claim_id


async def _settle_transferred_admission(
    factory: async_sessionmaker[AsyncSession], wire: _RacingVault, run_id: int, new_claim: str
) -> None:
    """The accepted handle is published without restoring the sender's former lease."""
    wire.gates.release_submit.set()
    await asyncio.wait_for(wire.polled.wait(), _SETTLE_SECONDS)
    await asyncio.wait_for(pipeline.wait_for_vault_pipeline_tasks(), _SETTLE_SECONDS)
    admitted = await _read_run(factory, run_id)
    assert admitted.job_id == _FIRST_JOB
    assert admitted.resume_claim_id == new_claim
    assert admitted.attempt_count == 1
    assert len(wire.posts) == 1
    assert len(wire.polls) == 1
    assert wire.hold_polls is not None
    wire.hold_polls.set()


@pytest.mark.asyncio
async def test_accepted_handle_survives_lease_transfer_and_only_new_owner_polls(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Losing a lease during POST preserves its answer but stops the old sender's climb."""
    wire = _RacingVault(_RaceGates(), hold_polls=asyncio.Event())
    run_id = await _seed_queue(concurrent_session_factory)
    replacement_waiting = asyncio.Event()
    replacement_name = "replacement-lease-owner"
    await pipeline.close_vault_pipeline_tasks()

    async def observe_replacement_barrier(session: AsyncSession, user_id: int) -> bool:
        """Prove the new worker starts its real account wait before the old POST ends."""
        task = asyncio.current_task()
        if task is not None and task.get_name() == replacement_name:
            replacement_waiting.set()
        return await stands_down(session, user_id)

    monkeypatch.setattr(pipeline, "_stands_down", observe_replacement_barrier)
    async with httpx.AsyncClient(transport=httpx.MockTransport(wire)) as http:
        old_client = await _vault_client(http)
        new_client = await _vault_client(http)
        replacement: asyncio.Task[None] | None = None
        try:
            await _resume_with(concurrent_session_factory, old_client)
            await asyncio.wait_for(wire.gates.submit_started.wait(), _SETTLE_SECONDS)
            sending = await _read_run(concurrent_session_factory, run_id)
            assert sending.resume_claim_id is not None
            new_claim = await _transfer_expired_lease(
                concurrent_session_factory, run_id, sending.resume_claim_id
            )
            replacement = asyncio.create_task(
                continue_ladder(
                    _continuation_for(
                        concurrent_session_factory, new_client, run_id, claim_id=new_claim
                    )
                ),
                name=replacement_name,
                context=keyless_context(),
            )
            await asyncio.wait_for(replacement_waiting.wait(), _SETTLE_SECONDS)
            await _settle_transferred_admission(concurrent_session_factory, wire, run_id, new_claim)
            await asyncio.wait_for(replacement, _SETTLE_SECONDS)
            finished = await _read_run(concurrent_session_factory, run_id)
            assert finished.outcome == VaultPipelineOutcome.COMPLETED.value
            assert finished.job_id == _FIRST_JOB
            assert finished.resume_claim_id is None
            assert len(wire.polls) == 1
            assert all(PROVIDER_KEY_HEADER not in request.headers for request in wire.polls)
        finally:
            _release_wire(wire)
            if replacement is not None:
                if not replacement.done():
                    replacement.cancel()
                await asyncio.gather(replacement, return_exceptions=True)
            await pipeline.close_vault_pipeline_tasks()


async def _seed_terminal_chain(
    factory: async_sessionmaker[AsyncSession],
    terminal_claim: str | None,
    *,
    active: bool,
    active_claim: str | None = None,
) -> tuple[int, int | None]:
    """Represent a completed import whose original continuation arrived very late."""
    run_id = await _seed_queue(factory, debounce_links=False)
    async with factory() as session:
        run = await session.get(VaultPipelineRun, run_id)
        assert run is not None
        run.trigger = pipeline.VaultPipelineTrigger.DOCUMENT_IMPORT.value
        run.outcome = VaultPipelineOutcome.COMPLETED.value
        run.attempt_count = 1
        run.fragments_seen = 1
        run.fragments_touched = 1
        run.resume_claim_id = terminal_claim
        run.resume_claimed_at = (
            datetime.now(UTC) - RESUME_CLAIM_STALE_AFTER - timedelta(seconds=1)
            if terminal_claim is not None
            else None
        )
        session.add(run)
        anchor = None
        if active:
            anchor = VaultPipelineRun(
                user_id=_OWNER,
                stage=VaultPipelineStage.TEMPORAL.value,
                trigger=pipeline.VaultPipelineTrigger.DOCUMENT_IMPORT.value,
                outcome=VaultPipelineOutcome.ATTEMPTED.value,
                attempt_count=1,
                fragments_seen=0,
                fragments_touched=0,
                fragments_lost=0,
                resume_claim_id=active_claim,
                resume_claimed_at=datetime.now(UTC) if active_claim is not None else None,
            )
            session.add(anchor)
        await session.commit()
        return run_id, None if anchor is None else anchor.id


async def _enter_terminal_continuation(
    factory: async_sessionmaker[AsyncSession], wire: _RacingVault, run_id: int
) -> None:
    """Start a late worker entry independently of all process-local task registration."""
    await pipeline.close_vault_pipeline_tasks()
    async with httpx.AsyncClient(transport=httpx.MockTransport(wire)) as http:
        client = await _vault_client(http)
        task = asyncio.create_task(
            continue_ladder(
                replace(
                    _continuation_for(
                        factory, client, run_id, outcome=VaultPipelineOutcome.COMPLETED
                    ),
                    trigger=pipeline.VaultPipelineTrigger.DOCUMENT_IMPORT,
                )
            ),
            context=keyless_context(),
        )
        try:
            await asyncio.wait_for(task, _SETTLE_SECONDS)
        finally:
            _release_wire(wire)
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await pipeline.close_vault_pipeline_tasks()


@pytest.mark.asyncio
async def test_stale_terminal_entry_cannot_split_an_already_advanced_chain(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A stale terminal token does not grant a second owner of future unstamped stages."""
    wire = _RacingVault(_RaceGates())
    run_id, anchor_id = await _seed_terminal_chain(
        concurrent_session_factory, _OLD_CLAIM, active=True, active_claim=_OLD_CLAIM
    )
    assert anchor_id is not None
    await _enter_terminal_continuation(concurrent_session_factory, wire, run_id)
    assert not wire.links, "late terminal entry climbed future stages beside an active chain"
    assert not wire.posts
    terminal = await _read_run(concurrent_session_factory, run_id)
    anchor = await _read_run(concurrent_session_factory, anchor_id)
    assert terminal.resume_claim_id == _OLD_CLAIM
    assert anchor.resume_claim_id == _OLD_CLAIM
    assert anchor.outcome == VaultPipelineOutcome.ATTEMPTED.value


@pytest.mark.asyncio
@pytest.mark.parametrize("active_claim", [_OLD_CLAIM, None], ids=["owned", "awaiting-recovery"])
async def test_terminal_first_entry_defers_to_a_later_attempted_rung(
    concurrent_session_factory: async_sessionmaker[AsyncSession], active_claim: str | None
) -> None:
    """An old released anchor cannot create another climber around a later in-flight rung."""
    wire = _RacingVault(_RaceGates())
    run_id, anchor_id = await _seed_terminal_chain(
        concurrent_session_factory, None, active=True, active_claim=active_claim
    )
    assert anchor_id is not None
    await _enter_terminal_continuation(concurrent_session_factory, wire, run_id)
    assert not wire.links, "terminal first-entry ignored a later in-flight continuation anchor"
    terminal = await _read_run(concurrent_session_factory, run_id)
    anchor = await _read_run(concurrent_session_factory, anchor_id)
    assert terminal.resume_claim_id is None
    assert anchor.resume_claim_id == active_claim
    assert anchor.outcome == VaultPipelineOutcome.ATTEMPTED.value


@pytest.mark.asyncio
async def test_terminal_first_entry_without_an_advanced_chain_runs_its_successors(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The terminal-entry guard still permits a newly settled request's first continuation."""
    wire = _RacingVault(_RaceGates())
    run_id, anchor_id = await _seed_terminal_chain(concurrent_session_factory, None, active=False)
    assert anchor_id is None
    await _enter_terminal_continuation(concurrent_session_factory, wire, run_id)
    assert len(wire.links) == 4
    assert not wire.posts
    assert not wire.polls
    assert all(PROVIDER_KEY_HEADER not in request.headers for request in wire.links)


@pytest.mark.asyncio
async def test_old_worker_polls_the_keyed_requests_committed_handle_without_readmission(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stale handleless snapshot cannot clear or replace a newly committed keyed job."""
    gates = _RaceGates()
    wire = _RacingVault(gates)
    run_id = await _seed_queue(concurrent_session_factory)
    await pipeline.close_vault_pipeline_tasks()

    async def pause_after_liveness(session: AsyncSession, user_id: int) -> bool:
        """Let the old worker pass its real liveness gate before the request arrives."""
        gone = await stands_down(session, user_id)
        if not gates.old_live.is_set():
            assert not gone
            gates.old_live.set()
            await gates.release_old.wait()
        return gone

    @asynccontextmanager
    async def observe_real_ordering() -> AsyncIterator[None]:
        """Keep the real barrier and pause only its first detached entrant."""
        is_old_first_dial = DETACHED_DIAL.get() is not None and not gates.old_waiting.is_set()
        if is_old_first_dial:
            gates.old_waiting.set()
        async with ordered_dial():
            if is_old_first_dial:
                gates.old_inside.set()
                await gates.release_old_dial.wait()
            yield

    monkeypatch.setattr(pipeline, "_stands_down", pause_after_liveness)
    monkeypatch.setattr(pipeline, "_ordered_dial", observe_real_ordering)
    async with httpx.AsyncClient(transport=httpx.MockTransport(wire)) as http:
        old_client = HttpCreekVaultClient(
            "https://vault.example.test", str(_OWNER), http_client=http, pin_destination=False
        )
        request_client = HttpCreekVaultClient(
            "https://vault.example.test", str(_OWNER), http_client=http, pin_destination=False
        )
        await old_client.handshake()
        await request_client.handshake()
        try:
            assert schedule_continuation(
                Continuation(
                    factory=concurrent_session_factory,
                    client=old_client,
                    user_id=_OWNER,
                    trigger=pipeline.VaultPipelineTrigger.JOURNAL_WRITE,
                    pending=RunResult(run_id=run_id, outcome=VaultPipelineOutcome.QUEUED),
                    stage=VaultPipelineStage.CLASSIFY,
                    remaining=(),
                )
            )
            await _admit_while_old_worker_waits(
                concurrent_session_factory, wire, request_client, run_id
            )
            await _finish_race(concurrent_session_factory, wire, run_id)
        finally:
            gates.release()
            await pipeline.close_vault_pipeline_tasks()
