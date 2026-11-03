"""One press sorts everything: ``/corpus/sweep`` as a background run.

The bounded pass this replaces sorted at most forty entries per press, so a
long backlog took a press per forty -- the same decision asked for again and
again. A press now starts a run (:mod:`services.corpus_sort_run`) that walks
every pending entry once, in the background, and the screen follows its
progress. The properties pinned here:

* **Comprehensive.** One press reaches a backlog past the old ceiling, and a
  run ends even when the classifier places some entries nowhere.
* **Idempotent and single-flight.** A second press joins the run already going;
  a run left by a dead worker is reclaimed rather than duplicated, and a live
  one elsewhere is joined rather than restarted.
* **Gated per entry.** No standing yes, no run; a yes withdrawn mid-run stops
  it; a vault connected mid-run stops the app classifier (#3156).
* **Durable.** Progress and outcome are rows a later request can read, a
  shutdown leaves the run resumable, and recovery resumes it.
* **Content-free.** Nothing on a response or a log line quotes the writing.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from types import SimpleNamespace

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, func, select

from dependencies.creek_vault import get_creek_vault_client
from domain.frequencies import Frequency
from main import app
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.corpus_sort_run import CorpusSortRun, SortLane, SortRunState, SortStopReason
from models.corpus_sweep import CorpusSweep
from models.journal_entry import JournalEntry
from services import corpus_backfill, corpus_sort_run
from services import frequency_classification as fc
from services.corpus_consent import set_consent
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_telemetry import VaultTelemetryOutcome
from services.user_vault_config import store_vault_config
from tests.test_corpus_sweep_vault_bound import _DownVault
from tests.test_journal_vault_write import SequencedVaultClient

_SWEEP_PATH = "/corpus/sweep"
_PASSWORD = "secret12345"  # pragma: allowlist secret
_VAULT_URL = "https://vault.example.test"
_VAULT_KEY = "creek-vault-sort-run-unit-key"  # pragma: allowlist secret

_PLACED = json.dumps({"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9})
_UNPLACED = json.dumps({"weights": {}, "overall_confidence": 0.0})

# Past the old forty-entry ceiling, so one press reaching all of it is the point.
_PAST_THE_OLD_CEILING = 45
_SMALL_BACKLOG = 3
_SENTINEL = "quartzlight-sort-run-sentinel"
_FOREIGN_OWNER = "f" * 32
# Comfortably past the staleness horizon, whatever it is tuned to.
_LONG_AGO = timedelta(days=1)


class _Classifier:
    """A fake provider: counts calls, and can hold the first one until released."""

    def __init__(self, reply: str, *, hold_first: bool = False) -> None:
        """Answer every call with ``reply``; optionally hold the first."""
        self.reply = reply
        self.calls = 0
        self.hold_first = hold_first
        self.first_started = asyncio.Event()
        self.release = asyncio.Event()

    async def __call__(self, **_kwargs: object) -> SimpleNamespace:
        """Count the call, wait if it is the held one, then answer."""
        self.calls += 1
        if self.calls == 1:
            self.first_started.set()
            if self.hold_first:
                await self.release.wait()
        return SimpleNamespace(text=self.reply)


@pytest.fixture
def placed(monkeypatch: pytest.MonkeyPatch) -> _Classifier:
    """A classifier that places every entry."""
    fake = _Classifier(_PLACED)
    monkeypatch.setattr(fc, "generate_response", fake)
    return fake


@pytest.fixture
def held(monkeypatch: pytest.MonkeyPatch) -> _Classifier:
    """A classifier that places every entry, holding the first until released."""
    fake = _Classifier(_PLACED, hold_first=True)
    monkeypatch.setattr(fc, "generate_response", fake)
    return fake


@pytest.fixture(autouse=True)
def _no_vault() -> Iterator[None]:
    """Serve no vault unless a test installs one, and finish every run before teardown."""
    app.dependency_overrides[get_creek_vault_client] = lambda: LocalFallbackCreekVaultClient(
        VaultTelemetryOutcome.FALLBACK_UNCONFIGURED
    )
    yield
    app.dependency_overrides.pop(get_creek_vault_client, None)


@pytest_asyncio.fixture(autouse=True)
async def _settle_runs() -> AsyncIterator[None]:
    """Never leave a background run alive past its test."""
    yield
    await corpus_sort_run.close_corpus_sort_tasks()


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create an account and return its auth headers and id."""
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


async def _consent(session: AsyncSession, user_id: int) -> None:
    """Grant journal corpus consent directly, so no inline sweep runs first."""
    await set_consent(session, user_id=user_id, source=CorpusSource.JOURNAL, granted=True)
    await session.commit()


async def _entries(session: AsyncSession, user_id: int, count: int) -> None:
    """Insert ``count`` entries no save path has sorted or sent."""
    session.add_all(
        JournalEntry(
            message=f"{_SENTINEL} {index}",
            sender="user",
            user_id=user_id,
            classification="personal",
            timestamp=datetime.now(UTC),
        )
        for index in range(count)
    )
    await session.commit()


async def _press(client: AsyncClient, headers: dict[str, str]) -> dict[str, object]:
    """Press Sort: the run starts (or is joined) and the request returns at once."""
    resp = await client.post(_SWEEP_PATH, headers=headers)
    assert resp.status_code == HTTPStatus.ACCEPTED, resp.text
    assert _SENTINEL not in resp.text
    return dict(resp.json())


async def _read(client: AsyncClient, headers: dict[str, str]) -> dict[str, object]:
    """Read the count and the latest run, as the screen polls them."""
    resp = await client.get(_SWEEP_PATH, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert _SENTINEL not in resp.text
    return dict(resp.json())


def _run_of(body: dict[str, object]) -> dict[str, object]:
    """The ``run`` object from a response body."""
    run = body["run"]
    assert isinstance(run, dict)
    return run


async def _settled(client: AsyncClient, headers: dict[str, str]) -> dict[str, object]:
    """Let every background run finish, then read."""
    await corpus_sort_run.wait_for_corpus_sort_tasks()
    return await _read(client, headers)


async def _count(
    session: AsyncSession, model: type[CorpusFragment] | type[CorpusSortRun], user_id: int
) -> int:
    """How many ``model`` rows ``user_id`` owns, read fresh."""
    session.expire_all()
    result = await session.execute(
        select(func.count()).select_from(model).where(col(model.user_id) == user_id)
    )
    return int(result.scalar_one())


async def _stale_run(session: AsyncSession, user_id: int, *, stale: bool) -> int:
    """Insert a running row held by another worker; ``stale`` ages its heartbeat."""
    beat = datetime.now(UTC) - (_LONG_AGO if stale else timedelta(0))
    run = CorpusSortRun(
        user_id=user_id,
        lane=SortLane.APP_PROVIDER.value,
        state=SortRunState.RUNNING.value,
        entries_total=_SMALL_BACKLOG,
        owner_id=_FOREIGN_OWNER,
        heartbeat_at=beat,
        started_at=beat,
    )
    session.add(run)
    await session.commit()
    assert run.id is not None
    return run.id


@pytest.mark.asyncio
async def test_one_press_sorts_a_backlog_past_the_old_ceiling(
    async_client: AsyncClient, db_session: AsyncSession, placed: _Classifier
) -> None:
    """The headline: forty-five entries, one press, nothing left."""
    headers, user_id = await _signup(async_client, "sort-run-all")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _PAST_THE_OLD_CEILING)

    started = _run_of(await _press(async_client, headers))
    settled = await _settled(async_client, headers)

    assert started["state"] == SortRunState.RUNNING.value
    assert started["entries_total"] == _PAST_THE_OLD_CEILING
    assert settled["entries_pending"] == 0
    run = _run_of(settled)
    assert run["id"] == started["id"]
    assert run["state"] == SortRunState.COMPLETED.value
    assert (run["entries_offered"], run["entries_sorted"]) == (
        _PAST_THE_OLD_CEILING,
        _PAST_THE_OLD_CEILING,
    )
    assert run["finished_at"] is not None
    assert placed.calls == _PAST_THE_OLD_CEILING
    assert await _count(db_session, CorpusFragment, user_id) == _PAST_THE_OLD_CEILING
    # The reach is still receipted, so the export carries it as before.
    receipts = (
        await db_session.execute(select(CorpusSweep).where(col(CorpusSweep.user_id) == user_id))
    ).scalars()
    assert [r.fragments_added for r in receipts] == [_PAST_THE_OLD_CEILING]


@pytest.mark.asyncio
async def test_a_second_press_joins_the_running_sort(
    async_client: AsyncClient, db_session: AsyncSession, held: _Classifier
) -> None:
    """Idempotent: pressing again while it runs starts nothing new."""
    headers, user_id = await _signup(async_client, "sort-run-join")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)

    first = _run_of(await _press(async_client, headers))
    await held.first_started.wait()
    second = _run_of(await _press(async_client, headers))
    held.release.set()
    settled = _run_of(await _settled(async_client, headers))

    assert second["id"] == first["id"]
    assert second["state"] == SortRunState.RUNNING.value
    assert await _count(db_session, CorpusSortRun, user_id) == 1
    assert settled["state"] == SortRunState.COMPLETED.value
    assert held.calls == _SMALL_BACKLOG


@pytest.mark.asyncio
async def test_entries_the_classifier_cannot_place_still_end_the_run(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each entry is offered once per run, so writing that stays pending cannot loop it."""
    unplaced = _Classifier(_UNPLACED)
    monkeypatch.setattr(fc, "generate_response", unplaced)
    headers, user_id = await _signup(async_client, "sort-run-unplaced")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)

    await _press(async_client, headers)
    settled = await _settled(async_client, headers)

    run = _run_of(settled)
    assert run["state"] == SortRunState.COMPLETED.value
    assert (run["entries_offered"], run["entries_sorted"]) == (_SMALL_BACKLOG, 0)
    assert settled["entries_pending"] == _SMALL_BACKLOG
    assert unplaced.calls == _SMALL_BACKLOG


@pytest.mark.asyncio
async def test_a_press_without_consent_records_a_stopped_run_and_offers_nothing(
    async_client: AsyncClient, db_session: AsyncSession, placed: _Classifier
) -> None:
    """No standing yes, no run: said plainly, and nothing reaches a provider."""
    headers, user_id = await _signup(async_client, "sort-run-no-consent")
    await _entries(db_session, user_id, _SMALL_BACKLOG)

    body = await _press(async_client, headers)
    settled = await _settled(async_client, headers)

    run = _run_of(body)
    assert run["state"] == SortRunState.STOPPED.value
    assert run["stop_reason"] == SortStopReason.NO_CONSENT.value
    assert body["entries_pending"] == _SMALL_BACKLOG
    assert _run_of(settled)["id"] == run["id"]
    assert placed.calls == 0


@pytest.mark.asyncio
async def test_withdrawing_consent_mid_run_stops_it(
    async_client: AsyncClient, db_session: AsyncSession, held: _Classifier
) -> None:
    """A revocation waits for the entry in flight, and the run stops at the next one."""
    headers, user_id = await _signup(async_client, "sort-run-revoke")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)

    await _press(async_client, headers)
    await held.first_started.wait()
    revoke = asyncio.create_task(
        async_client.put("/corpus/consent/journal", json={"granted": False}, headers=headers)
    )
    held.release.set()
    assert (await revoke).status_code == HTTPStatus.OK
    run = _run_of(await _settled(async_client, headers))

    assert run["state"] == SortRunState.STOPPED.value
    assert run["stop_reason"] == SortStopReason.CONSENT_WITHDRAWN.value
    assert held.calls == 1


@pytest.mark.asyncio
async def test_connecting_a_vault_mid_run_stops_the_app_classifier(
    async_client: AsyncClient, db_session: AsyncSession, held: _Classifier
) -> None:
    """The boundary is re-read per entry: once a vault answers, the app model is not asked."""
    headers, user_id = await _signup(async_client, "sort-run-boundary")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)

    await _press(async_client, headers)
    await held.first_started.wait()
    await store_vault_config(
        db_session, user_id, vault_url=_VAULT_URL, api_key=_VAULT_KEY, provisioned=True
    )
    await db_session.commit()
    held.release.set()
    run = _run_of(await _settled(async_client, headers))

    assert run["state"] == SortRunState.STOPPED.value
    assert run["stop_reason"] == SortStopReason.BOUNDARY_CHANGED.value
    assert held.calls == 1


@pytest.mark.asyncio
async def test_a_vault_bound_press_hands_the_vault_everything_it_lacks(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The vault lane is one press too: past the old ceiling, nothing left unsent."""
    vault = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, user_id = await _signup(async_client, "sort-run-vault")
    await store_vault_config(
        db_session, user_id, vault_url=_VAULT_URL, api_key=_VAULT_KEY, provisioned=True
    )
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _PAST_THE_OLD_CEILING)

    started = _run_of(await _press(async_client, headers))
    settled = await _settled(async_client, headers)

    assert started["lane"] == SortLane.VAULT_BOUND.value
    run = _run_of(settled)
    assert run["state"] == SortRunState.COMPLETED.value
    assert run["entries_sorted"] == _PAST_THE_OLD_CEILING
    assert settled["entries_pending"] == 0
    assert len(vault.ingest_calls) == _PAST_THE_OLD_CEILING


@pytest.mark.asyncio
async def test_a_vault_that_cannot_take_writing_stops_the_run(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A down vault is a fact about the vault: the run says so and ends."""
    down = _DownVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: down
    headers, user_id = await _signup(async_client, "sort-run-vault-down")
    await store_vault_config(
        db_session, user_id, vault_url=_VAULT_URL, api_key=_VAULT_KEY, provisioned=True
    )
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)

    await _press(async_client, headers)
    run = _run_of(await _settled(async_client, headers))

    assert run["state"] == SortRunState.STOPPED.value
    assert run["stop_reason"] == SortStopReason.VAULT_UNAVAILABLE.value
    assert down.ingest_calls == []
    assert down.handshakes == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("placed")
async def test_a_run_left_by_a_dead_worker_is_reclaimed_by_the_next_press(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Stale heartbeat: the next press takes the same run over and finishes it."""
    headers, user_id = await _signup(async_client, "sort-run-reclaim")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)
    orphan = await _stale_run(db_session, user_id, stale=True)

    body = _run_of(await _press(async_client, headers))
    run = _run_of(await _settled(async_client, headers))

    assert body["id"] == orphan
    assert run["id"] == orphan
    assert run["state"] == SortRunState.COMPLETED.value
    assert run["entries_sorted"] == _SMALL_BACKLOG
    assert await _count(db_session, CorpusSortRun, user_id) == 1


@pytest.mark.asyncio
async def test_a_live_run_on_another_worker_is_joined_not_restarted(
    async_client: AsyncClient, db_session: AsyncSession, placed: _Classifier
) -> None:
    """A fresh heartbeat means somebody is driving it: join, and dial nothing here."""
    headers, user_id = await _signup(async_client, "sort-run-elsewhere")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)
    elsewhere = await _stale_run(db_session, user_id, stale=False)

    body = _run_of(await _press(async_client, headers))
    run = _run_of(await _settled(async_client, headers))

    assert body["id"] == elsewhere
    assert run["state"] == SortRunState.RUNNING.value
    assert placed.calls == 0


@pytest.mark.asyncio
async def test_recovery_resumes_a_run_its_worker_abandoned(
    async_client: AsyncClient, db_session: AsyncSession, placed: _Classifier
) -> None:
    """Without anybody pressing again, the recovery sweep finishes an orphaned run."""
    headers, user_id = await _signup(async_client, "sort-run-recover")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)
    orphan = await _stale_run(db_session, user_id, stale=True)
    assert db_session.bind is not None
    factory = async_sessionmaker(db_session.bind, class_=AsyncSession, expire_on_commit=False)

    async def _fallback(_session: AsyncSession, _user_id: int) -> LocalFallbackCreekVaultClient:
        return LocalFallbackCreekVaultClient(VaultTelemetryOutcome.FALLBACK_UNCONFIGURED)

    await corpus_sort_run.resume_corpus_sort_runs(factory, _fallback)
    run = _run_of(await _settled(async_client, headers))

    assert run["id"] == orphan
    assert run["state"] == SortRunState.COMPLETED.value
    assert placed.calls == _SMALL_BACKLOG


@pytest.mark.asyncio
async def test_a_shutdown_leaves_the_run_resumable_rather_than_failed(
    async_client: AsyncClient, db_session: AsyncSession, held: _Classifier
) -> None:
    """Cancelling the driver is a deploy, not a fault: the row stays running."""
    headers, user_id = await _signup(async_client, "sort-run-shutdown")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)

    await _press(async_client, headers)
    await held.first_started.wait()
    await corpus_sort_run.close_corpus_sort_tasks()
    run = _run_of(await _read(async_client, headers))

    assert run["state"] == SortRunState.RUNNING.value


@pytest.mark.asyncio
async def test_an_unexpected_fault_fails_the_run_without_quoting_the_writing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A defect marks the run failed so the screen stops waiting; logs carry ids only."""

    async def broken(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError(_SENTINEL)

    monkeypatch.setattr(corpus_backfill, "offer_entry", broken)
    caplog.set_level(logging.INFO)
    headers, user_id = await _signup(async_client, "sort-run-fault")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)

    await _press(async_client, headers)
    run = _run_of(await _settled(async_client, headers))

    assert run["state"] == SortRunState.FAILED.value
    assert all(_SENTINEL not in record.getMessage() for record in caplog.records)
    assert all(_SENTINEL not in str(record.__dict__) for record in caplog.records)


@pytest.mark.asyncio
async def test_one_account_never_sees_or_joins_anothers_run(
    async_client: AsyncClient, db_session: AsyncSession, held: _Classifier
) -> None:
    """Runs are scoped by the token: another account reads none and starts its own."""
    headers, user_id = await _signup(async_client, "sort-run-mine")
    other_headers, _ = await _signup(async_client, "sort-run-theirs")
    await _consent(db_session, user_id)
    await _entries(db_session, user_id, _SMALL_BACKLOG)

    mine = _run_of(await _press(async_client, headers))
    await held.first_started.wait()
    theirs_before = await _read(async_client, other_headers)
    theirs = _run_of(await _press(async_client, other_headers))
    held.release.set()
    await _settled(async_client, headers)

    assert theirs_before == {"entries_pending": 0, "run": None}
    assert theirs["id"] != mine["id"]
    assert theirs["stop_reason"] == SortStopReason.NO_CONSENT.value
