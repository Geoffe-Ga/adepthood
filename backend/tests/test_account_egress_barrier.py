"""Order this account's outbound writes against its own erasure and liveness.

The journal database and Creek cannot participate in one transaction, so a
journal write that has already been admitted can still be mid-flight when the
same account's ``DELETE /users/me`` returns its receipt. Nothing at HEAD made
those two agree on an order, and the observable consequence was a receipt that
said "erased" followed by this account's plaintext being handed to Creek.

These tests drive both requests concurrently through the real routers against a
scripted vault double and assert the one property the barrier exists to supply:
**no vault write is recorded after the deletion response**. They are written
against the HTTP seam rather than against the serializer, because a lock that
one of two racing parties takes orders nothing, and only a test that drives both
parties can tell the difference.
"""

from __future__ import annotations

import asyncio
import gc
from http import HTTPStatus
from types import SimpleNamespace

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import VaultIngestRequest, VaultIngestResult
from main import app
from routers import journal
from services import voice_draft_privacy
from services.account_egress_barrier import (
    ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR,
    NOT_POSTGRESQL_DEFECT,
    EgressBarrierState,
    account_egress_barrier,
    load_egress_barrier_rollout,
)
from services.advisory_lock_namespaces import ACCOUNT_EGRESS_LOCK_NAMESPACE
from services.voice_draft_privacy import (
    EGRESS_ORDERING_UNAVAILABLE,
    VoiceDraftPrivacySerializer,
    journal_vault_mutations,
)
from tests.test_journal_vault_write import SequencedVaultClient

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

#: Markers appended to the shared order list. Named once so an assertion and
#: the double cannot drift apart on a typo.
INGEST_START = "ingest-start"
INGEST_SENT = "ingest-sent"
DELETION_BEGIN = "deletion-begin"
DELETION_RESPONSE = "deletion-response-200"

#: A settle bound for a concurrent pair. Long enough that a slow machine is not
#: mistaken for a deadlock, short enough that a real deadlock fails the suite
#: rather than hanging it.
_SETTLE_TIMEOUT_SECONDS = 20.0

#: How long the deletion is given to overtake a paused ingest. Without the
#: barrier it runs to completion well inside this window -- that is the measured
#: defect. With the barrier it is still waiting when the window closes, and the
#: paused writer is then released to finish first. Generous, because a window
#: too short would make an unbarriered deletion look ordered.
_OVERTAKE_PROBE_SECONDS = 1.0


class PausedFirstIngest(SequencedVaultClient):
    """Hold the first ingest open so a deletion can try to overtake it.

    ``order`` is instance-local and the two events are instance-local, so the
    test carries no module state and its result does not depend on the order
    pytest happens to run the file in.
    """

    def __init__(self) -> None:
        """Start with an empty order list and both synchronization points clear."""
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.order: list[str] = []

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Announce arrival, wait to be released, then record the transmission."""
        if not self.started.is_set():
            self.order.append(INGEST_START)
            self.started.set()
            await self.release.wait()
        self.order.append(INGEST_SENT)
        return await super().ingest(request)


async def signup(client: AsyncClient, username: str) -> tuple[dict[str, str], str]:
    """Sign up a fresh account and return its auth header and email address."""
    email = f"{username}@example.com"
    resp = await client.post("/auth/signup", json={"email": email, "password": _SIGNUP_PASSWORD})
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}, email


async def delete_account_recording_order(
    client: AsyncClient,
    headers: dict[str, str],
    email: str,
    order: list[str],
) -> Response:
    """Erase the account and stamp the exact moment its receipt came back."""
    response = await client.request(
        "DELETE", "/users/me", json={"confirm_email": email}, headers=headers
    )
    order.append(f"deletion-response-{response.status_code}")
    return response


@pytest.mark.asyncio
async def test_deletion_response_is_never_followed_by_a_vault_write(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A journal body already in flight cannot reach Creek after the receipt."""
    fake = PausedFirstIngest()
    monkeypatch.setitem(app.dependency_overrides, get_creek_vault_client, lambda: fake)
    headers, email = await signup(concurrent_async_client, "egress_race")

    writing = asyncio.create_task(
        concurrent_async_client.post(
            "/journal/",
            json={"message": "A body that must not outlive me.", "classification": "personal"},
            headers=headers,
        )
    )
    await fake.started.wait()
    fake.order.append(DELETION_BEGIN)
    deleting = asyncio.create_task(
        delete_account_recording_order(concurrent_async_client, headers, email, fake.order)
    )
    # Give the deletion its best chance to overtake: it is released to run while
    # the ingest is still held open, and only once it has had that window does
    # the writer resume. At HEAD the deletion finishes inside the window.
    await asyncio.wait({deleting}, timeout=_OVERTAKE_PROBE_SECONDS)
    fake.release.set()
    _written, deleted = await asyncio.wait_for(
        asyncio.gather(writing, deleting), timeout=_SETTLE_TIMEOUT_SECONDS
    )
    assert deleted.status_code == HTTPStatus.OK

    assert INGEST_SENT not in fake.order[fake.order.index(DELETION_RESPONSE) :], (
        f"a journal body was handed to Creek after the account-deletion response: {fake.order}"
    )


@pytest.mark.asyncio
async def test_a_write_racing_its_own_erasure_is_refused_not_a_five_hundred(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A write already past authentication answers 401, and sends nothing.

    The pause is installed at the one await between ``get_current_user`` and the
    barrier, so the erasure provably wins the race rather than probably winning
    it. What HEAD answered here was a 500 from refreshing a swept row; what a
    barrier without the liveness read answers is a 201 for an account that no
    longer exists.
    """
    fake = SequencedVaultClient()
    monkeypatch.setitem(app.dependency_overrides, get_creek_vault_client, lambda: fake)
    entered = asyncio.Event()
    release = asyncio.Event()

    async def _pause_before_the_barrier(*_args: object, **_kwargs: object) -> None:
        """Hold the write between authentication and the account barrier."""
        entered.set()
        await release.wait()

    monkeypatch.setattr(journal, "_authorize_practice_links", _pause_before_the_barrier)
    headers, email = await signup(concurrent_async_client, "erased_mid_write")

    writing = asyncio.create_task(
        concurrent_async_client.post(
            "/journal/",
            json={"message": "Written into a vanishing account.", "classification": "personal"},
            headers=headers,
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=_SETTLE_TIMEOUT_SECONDS)
    deleted = await concurrent_async_client.request(
        "DELETE", "/users/me", json={"confirm_email": email}, headers=headers
    )
    assert deleted.status_code == HTTPStatus.OK
    release.set()
    written = await asyncio.wait_for(writing, timeout=_SETTLE_TIMEOUT_SECONDS)

    assert written.status_code == HTTPStatus.UNAUTHORIZED
    assert fake.ingest_calls == [], "an erased account's body was still handed to Creek"


@pytest.mark.asyncio
async def test_a_deletion_and_an_entry_patch_cannot_deadlock(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Account-outer / entry-inner nesting settles both requests, in some order.

    The PATCH takes the account barrier and then the entry serializer; the
    deletion takes only the account barrier. A reversal anywhere would let the
    two acquire in opposite orders and hang, so this is the ordering's own test
    rather than a second copy of the race test above.
    """
    fake = PausedFirstIngest()
    # The setup write must not be the one that pauses; the PATCH is.
    fake.release.set()
    monkeypatch.setitem(app.dependency_overrides, get_creek_vault_client, lambda: fake)
    headers, email = await signup(concurrent_async_client, "patch_deadlock")
    created = await concurrent_async_client.post(
        "/journal/",
        json={"message": "The first body.", "classification": "personal"},
        headers=headers,
    )
    assert created.status_code == HTTPStatus.CREATED
    entry_id = int(created.json()["id"])

    fake.order.clear()
    fake.started.clear()
    fake.release.clear()
    patching = asyncio.create_task(
        concurrent_async_client.patch(
            f"/journal/{entry_id}", json={"message": "The second body."}, headers=headers
        )
    )
    await asyncio.wait_for(fake.started.wait(), timeout=_SETTLE_TIMEOUT_SECONDS)
    fake.order.append(DELETION_BEGIN)
    deleting = asyncio.create_task(
        delete_account_recording_order(concurrent_async_client, headers, email, fake.order)
    )
    await asyncio.wait({deleting}, timeout=_OVERTAKE_PROBE_SECONDS)
    fake.release.set()
    patched, deleted = await asyncio.wait_for(
        asyncio.gather(patching, deleting), timeout=_SETTLE_TIMEOUT_SECONDS
    )

    assert patched.status_code == HTTPStatus.OK
    assert deleted.status_code == HTTPStatus.OK
    assert INGEST_SENT not in fake.order[fake.order.index(DELETION_RESPONSE) :], (
        f"an entry body was handed to Creek after the account-deletion response: {fake.order}"
    )


@pytest.mark.asyncio
async def test_the_account_barrier_and_the_entry_serializer_do_not_share_a_lock_on_equal_keys(
    db_session: AsyncSession,
) -> None:
    """Account 7 and entry 7 are two keys, not one.

    Typed on the *equal* integer deliberately: a check using account 1 and entry
    2 passes even when both barriers are the same object, which is exactly the
    mistake -- one shared serializer -- that would self-deadlock every journal
    write, since each takes the account barrier outside the entry serializer.
    """
    shared_key = 7
    async with account_egress_barrier.hold(db_session, shared_key):
        await asyncio.wait_for(
            _enter_and_leave(journal_vault_mutations, db_session, shared_key),
            timeout=_SETTLE_TIMEOUT_SECONDS,
        )


async def _enter_and_leave(
    serializer: VoiceDraftPrivacySerializer, session: AsyncSession, key: int
) -> None:
    """Take and release one serializer's hold, so a blocked take times out."""
    async with serializer.hold(session, key):
        pass


@pytest.mark.asyncio
async def test_idle_accounts_leave_no_retained_lock(db_session: AsyncSession) -> None:
    """The per-account lock map is weak, so a finished account leaves nothing."""
    barrier = VoiceDraftPrivacySerializer(namespace=ACCOUNT_EGRESS_LOCK_NAMESPACE)
    assert barrier.retained_key_count() == 0

    async with barrier.hold(db_session, 4321):
        assert barrier.retained_key_count() == 1

    gc.collect()
    assert barrier.retained_key_count() == 0


class _UnopenableLockEngine:
    """A lock engine whose connection can never be established."""

    async def connect(self) -> object:
        """Fail the way a database that has run out of connections fails."""
        raise SQLAlchemyError("no connection is available for the advisory lock")

    async def dispose(self) -> None:
        """Nothing was opened, so there is nothing to give back."""


def _break_the_lock_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the request session look like PostgreSQL and its lock engine broken.

    The default lane is SQLite, where the cross-worker half short-circuits and
    the failure under test is unreachable. Both halves are faked at the module
    seam rather than by standing up a real database, because what is asserted is
    the *answer* to a failed acquire, not the failure itself.
    """
    pretend_postgres = SimpleNamespace(
        dialect=SimpleNamespace(name="postgresql"),
        url="postgresql+asyncpg://unused/unused",
    )
    monkeypatch.setattr(voice_draft_privacy, "_async_engine_for", lambda _session: pretend_postgres)
    monkeypatch.setattr(
        voice_draft_privacy,
        "create_async_engine",
        lambda *_args, **_kwargs: _UnopenableLockEngine(),
    )


@pytest.mark.asyncio
async def test_an_unavailable_lock_connection_suppresses_egress(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No ordering means no outbound write, and the caller is told so."""
    fake = SequencedVaultClient()
    monkeypatch.setitem(app.dependency_overrides, get_creek_vault_client, lambda: fake)
    headers, _email = await signup(async_client, "lock_refuses_egress")
    _break_the_lock_connection(monkeypatch)

    written = await async_client.post(
        "/journal/",
        json={"message": "Not without an ordering.", "classification": "personal"},
        headers=headers,
    )

    assert written.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert written.json()["detail"] == EGRESS_ORDERING_UNAVAILABLE
    # The status alone would pass for a path that dialled first and raised
    # afterwards, which is the whole failure this is about.
    assert fake.ingest_calls == [], "the vault was dialled with no ordering lock held"


@pytest.mark.asyncio
async def test_an_unavailable_lock_connection_does_not_block_erasure(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The twin of the test above, and deliberately the opposite answer.

    Erasure only ever reduces exposure, so the ordering mechanism must never be
    able to refuse it. A barrier that failed closed here would invent a new way
    to block somebody's deletion that no vault-reachability test can see.
    """
    headers, email = await signup(async_client, "lock_allows_erasure")
    _break_the_lock_connection(monkeypatch)

    deleted = await async_client.request(
        "DELETE", "/users/me", json={"confirm_email": email}, headers=headers
    )

    assert deleted.status_code == HTTPStatus.OK
    assert deleted.json()["recoverable"] is False


def test_the_rollout_is_on_by_default_and_ready_on_postgresql(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unset switch is on: the barrier is not something to remember to enable."""
    monkeypatch.delenv(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR, raising=False)

    rollout = load_egress_barrier_rollout("postgresql")

    assert rollout.state is EgressBarrierState.READY
    assert rollout.defects == ()
    assert rollout.orders_across_workers is True


def test_a_non_postgresql_deployment_is_incomplete_rather_than_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The cross-worker half is PostgreSQL-only, and says so by name."""
    monkeypatch.delenv(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR, raising=False)

    rollout = load_egress_barrier_rollout("sqlite")

    assert rollout.state is EgressBarrierState.INCOMPLETE
    assert rollout.defects == (NOT_POSTGRESQL_DEFECT,)
    assert rollout.orders_across_workers is False


def test_an_explicitly_disabled_barrier_is_distinguishable_from_a_broken_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DISABLED is a choice and INCOMPLETE is a fault; an operator must see which."""
    monkeypatch.setenv(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR, "false")

    rollout = load_egress_barrier_rollout("postgresql")

    assert rollout.state is EgressBarrierState.DISABLED
    assert rollout.defects == ()


def test_an_unreadable_switch_is_a_defect_and_not_silently_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A typo in the switch names itself rather than being read as either answer."""
    monkeypatch.setenv(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR, "sometimes")

    rollout = load_egress_barrier_rollout("postgresql")

    assert rollout.state is EgressBarrierState.INCOMPLETE
    assert rollout.defects == (ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR,)


@pytest.mark.asyncio
async def test_the_readiness_probe_reports_the_barrier_state(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An operator reading a failing deploy reads the probe, not the logs.

    Reported, never gated: a barrier that cannot order across workers still
    orders inside each one, which is a degraded deployment rather than an
    unready pod.
    """
    monkeypatch.delenv(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR, raising=False)

    ready = await async_client.get("/health/ready")

    assert ready.status_code == HTTPStatus.OK
    # The default lane is SQLite, so the honest answer here is "incomplete".
    assert ready.json()["egress_barrier"] == EgressBarrierState.INCOMPLETE.value


@pytest.mark.asyncio
async def test_a_disabled_barrier_still_orders_writes_inside_one_worker(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No operator setting can remove the in-process half of the ordering.

    The switch exists for a rolling deploy whose older workers do not take this
    lock at all. It suppresses the advisory statements; if it also suppressed
    the local lock it would be a switch that turns the defect back on.
    """
    monkeypatch.setenv(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR, "false")
    fake = PausedFirstIngest()
    monkeypatch.setitem(app.dependency_overrides, get_creek_vault_client, lambda: fake)
    headers, email = await signup(concurrent_async_client, "disabled_barrier")

    writing = asyncio.create_task(
        concurrent_async_client.post(
            "/journal/",
            json={"message": "Still ordered, in here.", "classification": "personal"},
            headers=headers,
        )
    )
    await fake.started.wait()
    fake.order.append(DELETION_BEGIN)
    deleting = asyncio.create_task(
        delete_account_recording_order(concurrent_async_client, headers, email, fake.order)
    )
    await asyncio.wait({deleting}, timeout=_OVERTAKE_PROBE_SECONDS)
    fake.release.set()
    _written, deleted = await asyncio.wait_for(
        asyncio.gather(writing, deleting), timeout=_SETTLE_TIMEOUT_SECONDS
    )

    assert deleted.status_code == HTTPStatus.OK
    assert INGEST_SENT not in fake.order[fake.order.index(DELETION_RESPONSE) :], (
        f"a disabled barrier stopped ordering inside its own worker: {fake.order}"
    )
