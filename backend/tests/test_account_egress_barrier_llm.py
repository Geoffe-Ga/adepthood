"""The model dials are egress too, and they are ordered against erasure.

The route walk that produced this lane's first site list keyed on
``get_creek_vault_client``, so it could only ever find *vault* egress. Two
routes hand this account's stored journal body to a cloud language model and
resolve no vault client at all -- ``POST /journal/{entry_id}/suggestions/detect``
and ``POST /journal/marginalia/{marginalia_id}/essay``. Both were invisible to
the walk, and both transmitted stored plaintext after the erasure receipt.

These tests drive each route concurrently with ``DELETE /users/me`` against a
paused provider double and assert the same property the vault tests assert: no
body reaches a provider after the receipt. They are written at the HTTP seam
because the defect is an ordering between two requests, which no unit test of
either one can see.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import CreekCapability, VaultReflection, VaultTierCeiling
from main import app
from models.completion_suggestion import CompletionSuggestion
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalClassification, JournalEntry
from models.llm_usage_log import LLMUsageLog
from models.marginalia import Marginalia, MarginaliaKind, MarginaliaStatus
from models.user import User
from models.wallet_audit import (
    REASON_REFUND_FAILED_RESONANCE,
    REASON_SPEND_MONTHLY,
    WalletAudit,
)
from routers import journal
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from services.reflection_boundary import ReflectionBoundary
from tests.helpers.log_lines import records_for
from tests.test_account_egress_barrier import (
    DELETION_BEGIN,
    DELETION_RESPONSE,
    delete_account_recording_order,
    signup,
)
from tests.test_journal_vault_write import SequencedVaultClient

# A server-paid first letter must say the writer saw its price (#623); without
# it the route answers 409 before it charges or dials anything.
_ESSAY_ASK = {"price_acknowledged": True}

#: The journal body both routes transmit. Distinctive so an assertion about
#: "what went out" names the thing that went out.
_BODY = "I meditated by the river and the willow bent without breaking."

#: A detection answer naming no completed habit: a checked, empty pass.
_NO_HITS = json.dumps({"hits": []})

#: Markers appended to the shared order list, named once so the double and the
#: assertions cannot drift apart on a typo.
DIAL_START = "provider-dial-start"
DIAL_SENT = "provider-dial-sent"

#: The settlement and refund log events, and the loggers that write them (#623 PR3).
_SETTLED = "llm_generation_settled"
_REFUND_APPLIED = "wallet_refund_applied"
_SETTLEMENT_LOGGERS = ("routers.journal", "services.llm_usage", "services.wallet")

_SETTLE_TIMEOUT_SECONDS = 20.0
_OVERTAKE_PROBE_SECONDS = 1.0


class PausedProvider:
    """A ``generate_response`` stand-in that holds the first dial open.

    Instance-local, like the vault doubles: nothing here is module state, so the
    result does not depend on the order pytest happens to run the file in.

    ``bodies`` records what was actually transmitted, because "a dial happened"
    and "this account's stored writing left the process" are different claims
    and only the second one is the defect.
    """

    def __init__(self, payload: str) -> None:
        """Answer every dial with ``payload`` and start with nothing recorded."""
        self._payload = payload
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.order: list[str] = []
        self.bodies: list[str] = []

    async def __call__(
        self,
        user_message: str,
        _history: object,
        *,
        system_prompt: str | None = None,
        api_key: object = None,
    ) -> LLMResponse:
        """Announce arrival, wait to be released, then record the transmission."""
        del system_prompt, api_key
        if not self.started.is_set():
            self.order.append(DIAL_START)
            self.started.set()
            await self.release.wait()
        self.order.append(DIAL_SENT)
        self.bodies.append(user_message)
        return LLMResponse(
            text=self._payload,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


async def _user_id(factory: async_sessionmaker[AsyncSession], email: str) -> int:
    """The id of the account that just signed up under ``email``."""
    async with factory() as session:
        user = (await session.execute(select(User).where(col(User.email) == email))).scalar_one()
        assert user.id is not None
        return int(user.id)


async def _seed_detection_candidate(
    factory: async_sessionmaker[AsyncSession], user_id: int
) -> None:
    """Give the account one habit goal, so detection has something to ask about.

    Without a candidate ``detect_entry_suggestions`` returns before constructing
    the provider, and "nothing was dialled" would be true for a reason that has
    nothing to do with the barrier.
    """
    async with factory() as session:
        habit = Habit(
            name="Meditation",
            icon="M",
            start_date=date(2025, 1, 1),
            energy_cost=1,
            energy_return=2,
            user_id=user_id,
        )
        session.add(habit)
        await session.commit()
        await session.refresh(habit)
        session.add(
            Goal(
                habit_id=habit.id,
                title="clear",
                tier="clear",
                target=1.0,
                target_unit="x",
                frequency=1.0,
                frequency_unit="per_day",
                is_additive=True,
            )
        )
        await session.commit()


async def _seed_marginalia(
    factory: async_sessionmaker[AsyncSession], user_id: int, entry_id: int
) -> int:
    """Attach one essay-less margin note to ``entry_id`` and return its id."""
    async with factory() as session:
        note = Marginalia(
            journal_entry_id=entry_id,
            user_id=user_id,
            kind=MarginaliaKind.THEME,
            anchor_start=0,
            anchor_end=len("I meditated"),
            anchor_text="I meditated",
            note="It holds.",
            status=MarginaliaStatus.ACTIVE,
            created_at=datetime.now(UTC),
        )
        session.add(note)
        await session.commit()
        await session.refresh(note)
        assert note.id is not None
        return int(note.id)


async def _create_entry(
    client: AsyncClient,
    headers: dict[str, str],
    *,
    body: str = _BODY,
    classification: str = "personal",
) -> int:
    """Write one entry (personal unless told otherwise) and return its id."""
    created = await client.post(
        "/journal/", json={"message": body, "classification": classification}, headers=headers
    )
    assert created.status_code == HTTPStatus.CREATED
    return int(created.json()["id"])


async def _race_against_deletion(
    client: AsyncClient,
    headers: dict[str, str],
    email: str,
    provider: PausedProvider,
    request: asyncio.Task[object],
) -> None:
    """Hold ``request`` at its provider dial, let a deletion try to overtake it.

    The deletion is released while the dial is still held open and given a
    window to finish, so an unordered implementation provably wins the race
    rather than merely maybe winning it.
    """
    await asyncio.wait_for(provider.started.wait(), timeout=_SETTLE_TIMEOUT_SECONDS)
    provider.order.append(DELETION_BEGIN)
    deleting = asyncio.create_task(
        delete_account_recording_order(client, headers, email, provider.order)
    )
    await asyncio.wait({deleting}, timeout=_OVERTAKE_PROBE_SECONDS)
    provider.release.set()
    await asyncio.wait_for(asyncio.gather(request, deleting), timeout=_SETTLE_TIMEOUT_SECONDS)


def _after_the_receipt(order: list[str]) -> list[str]:
    """Everything recorded from the deletion response onward."""
    assert DELETION_RESPONSE in order, f"the deletion never answered 200: {order}"
    return order[order.index(DELETION_RESPONSE) :]


@pytest.mark.asyncio
async def test_completion_detection_never_dials_after_the_deletion_response(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``POST /journal/{id}/suggestions/detect`` transmits stored writing, so it waits."""
    provider = PausedProvider(_NO_HITS)
    monkeypatch.setattr(marginalia_service, "generate_response", provider)
    headers, email = await signup(concurrent_async_client, "detect_egress")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)

    detecting = asyncio.create_task(
        concurrent_async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)
    )
    await _race_against_deletion(concurrent_async_client, headers, email, provider, detecting)

    assert DIAL_SENT not in _after_the_receipt(provider.order), (
        f"a journal body was handed to a language model after the account-deletion "
        f"response: {provider.order}"
    )


@pytest.mark.asyncio
async def test_marginalia_essay_never_dials_after_the_deletion_response(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The essay's *model* dial is ordered, not only the vault mirror behind it.

    The barrier this route already took wrapped the Creek mirror, which happens
    after ``_cache_essay`` has committed and dialled the cloud. Ordering the
    mirror orders the smaller half.
    """
    provider = PausedProvider("Dear friend, the willow.")
    monkeypatch.setattr(marginalia_service, "generate_response", provider)
    headers, email = await signup(concurrent_async_client, "essay_egress")
    user_id = await _user_id(concurrent_session_factory, email)
    entry_id = await _create_entry(concurrent_async_client, headers)
    note_id = await _seed_marginalia(concurrent_session_factory, user_id, entry_id)

    expanding = asyncio.create_task(
        concurrent_async_client.post(
            f"/journal/marginalia/{note_id}/essay", headers=headers, json=_ESSAY_ASK
        )
    )
    await _race_against_deletion(concurrent_async_client, headers, email, provider, expanding)

    assert DIAL_SENT not in _after_the_receipt(provider.order), (
        f"a journal body and its prior letters were handed to a language model after "
        f"the account-deletion response: {provider.order}"
    )


@pytest.mark.asyncio
async def test_completion_detection_refuses_an_erased_account_with_the_uniform_401(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The refusal vocabulary matches every other barriered route: 401.

    The pause is installed on the timezone read inside ``_detection_inputs`` --
    an await this route makes between ``get_current_user`` and the barrier, and
    one the erasure path provably never makes, so holding it cannot deadlock the
    ``DELETE``. That makes the erasure win the race rather than probably win it.

    Unbarriered, this route answered the erased account **200 with a checked
    result** -- and, on a pass whose provider returns hits, an HTTP 500 out of
    the persistence that follows the dial. Both are answers to somebody who no
    longer exists, given after their writing has already gone out.
    """
    provider = PausedProvider(_NO_HITS)
    # Unblocked deliberately, although the passing run never reaches it. The
    # claim here is that the refusal happens *instead of* a dial, so a provider
    # that would also block turns "the liveness read was deleted" into a
    # twenty-second timeout rather than into ``assert 200 == 401``. The mutation
    # this test exists to catch must fail it by answering wrongly, not by hanging.
    provider.release.set()
    monkeypatch.setattr(marginalia_service, "generate_response", provider)
    real_get_user_timezone = journal.get_user_timezone
    entered = asyncio.Event()
    release = asyncio.Event()

    async def _pause_before_the_barrier(session: AsyncSession, user_id: int) -> str:
        """Hold the pass between authentication and the account barrier."""
        timezone = await real_get_user_timezone(session, user_id)
        entered.set()
        await release.wait()
        return timezone

    headers, email = await signup(concurrent_async_client, "detect_401")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    monkeypatch.setattr(journal, "get_user_timezone", _pause_before_the_barrier)

    detecting = asyncio.create_task(
        concurrent_async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)
    )
    await asyncio.wait_for(entered.wait(), timeout=_SETTLE_TIMEOUT_SECONDS)
    deleted = await concurrent_async_client.request(
        "DELETE", "/users/me", json={"confirm_email": email}, headers=headers
    )
    assert deleted.status_code == HTTPStatus.OK
    release.set()
    detected = await asyncio.wait_for(detecting, timeout=_SETTLE_TIMEOUT_SECONDS)

    assert detected.status_code == HTTPStatus.UNAUTHORIZED
    assert provider.bodies == [], (
        f"an erased account's writing was still transmitted: {provider.bodies}"
    )


#: The barrier as every journal site spells it: two positional arguments, and a
#: keyword this router never passes.
_HoldAccount = Callable[[AsyncSession, int], AbstractAsyncContextManager[None]]


@dataclass(frozen=True, slots=True)
class _BarrierDoor:
    """Where one request is held at the barrier while another overtakes it.

    Instance-local, like every double in this file: nothing here is module state,
    so the result cannot depend on the order pytest runs the file in.
    """

    reached: asyncio.Event = field(default_factory=asyncio.Event)
    opened: asyncio.Event = field(default_factory=asyncio.Event)


def _pause_at_the_first_hold(real: _HoldAccount, door: _BarrierDoor) -> _HoldAccount:
    """Wrap the barrier so the *first* acquisition waits, and later ones walk through.

    Pausing at the door rather than inside the hold is what makes the competing
    request provably win the barrier: it arrives while the holder is still
    queuing for it, takes it uncontended, and finishes before the paused request
    is let through.
    """

    @asynccontextmanager
    async def _hold(session: AsyncSession, user_id: int) -> AsyncIterator[None]:
        """Wait once at the door, then take the real barrier."""
        if not door.reached.is_set():
            door.reached.set()
            await door.opened.wait()
        async with real(session, user_id):
            yield

    return _hold


@pytest.mark.asyncio
async def test_the_essay_never_dials_a_body_the_patch_already_made_intimate(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The barrier must not reorder the essay's dial behind the PATCH that forbids it.

    The route reads the INTIMATE privacy floor off the persisted row *before* it
    waits for the barrier, and the hold that follows re-reads only whether the
    *account* still exists. ``PATCH /journal/{entry_id}`` carrying
    ``classification`` takes the same exclusive hold, so a PATCH that queues
    first is not merely delayed by the barrier -- it is guaranteed to complete in
    full, answer 200, and only then release the dial that hands the now-intimate
    body to the cloud.

    The pause is installed on the barrier's own door, so the PATCH provably wins
    it rather than probably winning it: the first hold taken after the pause is
    armed is the essay's, and the PATCH's own hold is the second and runs
    straight through. The provider is released up front because the claim here is
    that the dial does not happen -- a double that also blocked would turn the
    defect into a twenty-second timeout instead of an assertion.
    """
    provider = PausedProvider("Dear friend, the willow.")
    provider.release.set()
    monkeypatch.setattr(marginalia_service, "generate_response", provider)
    headers, email = await signup(concurrent_async_client, "essay_tier")
    user_id = await _user_id(concurrent_session_factory, email)
    entry_id = await _create_entry(concurrent_async_client, headers)
    note_id = await _seed_marginalia(concurrent_session_factory, user_id, entry_id)
    door = _BarrierDoor()
    monkeypatch.setattr(
        journal, "hold_account", _pause_at_the_first_hold(journal.hold_account, door)
    )

    expanding = asyncio.create_task(
        concurrent_async_client.post(
            f"/journal/marginalia/{note_id}/essay", headers=headers, json=_ESSAY_ASK
        )
    )
    await asyncio.wait_for(door.reached.wait(), timeout=_SETTLE_TIMEOUT_SECONDS)
    patched = await concurrent_async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK, patched.text
    door.opened.set()
    answered = await asyncio.wait_for(expanding, timeout=_SETTLE_TIMEOUT_SECONDS)

    assert provider.bodies == [], (
        f"a body the writer had already marked intimate -- in a PATCH that answered "
        f"200 before this dial -- was handed to a cloud model anyway: {provider.bodies}"
    )
    assert answered.status_code == HTTPStatus.OK
    assert answered.json()["essay"] is None, "an intimate entry came back with a cloud letter"


#: How long the slow provider composes each letter: long enough that a second
#: ask for the same note arrives while the first one is still being written.
_SLOW_DIAL_SECONDS = 0.3


class SlowNumberedProvider:
    """A ``generate_response`` stand-in that is slow and numbers its letters.

    Each dial answers a distinct letter, so a second dial that overwrote the
    first is visible in the stored row as well as in the call count.
    """

    def __init__(self) -> None:
        """Start with no dials recorded."""
        self.calls = 0

    async def __call__(
        self,
        user_message: str,
        _history: object,
        *,
        system_prompt: str | None = None,
        api_key: object = None,
    ) -> LLMResponse:
        """Take a while, then answer this dial's own numbered letter."""
        del user_message, system_prompt, api_key
        self.calls += 1
        number = self.calls
        await asyncio.sleep(_SLOW_DIAL_SECONDS)
        return LLMResponse(
            text=f"Dear friend, this is letter number {number}.",
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


@pytest.mark.asyncio
async def test_two_concurrent_first_asks_charge_and_dial_exactly_once(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A double-tapped first ask buys one letter, not two (#623).

    The cached-letter check before the barrier is only the cheap half: the
    second ask passes it while the first is still composing, then waits on the
    barrier. Unless the note is read again inside the hold, that second ask
    charges a unit, dials again, and overwrites the first letter.
    """
    provider = SlowNumberedProvider()
    monkeypatch.setattr(marginalia_service, "generate_response", provider)
    headers, email = await signup(concurrent_async_client, "essay_double_tap")
    user_id = await _user_id(concurrent_session_factory, email)
    entry_id = await _create_entry(concurrent_async_client, headers)
    note_id = await _seed_marginalia(concurrent_session_factory, user_id, entry_id)
    url = f"/journal/marginalia/{note_id}/essay"

    first, second = await asyncio.gather(
        concurrent_async_client.post(url, headers=headers, json=_ESSAY_ASK),
        concurrent_async_client.post(url, headers=headers, json=_ESSAY_ASK),
    )

    assert first.status_code == HTTPStatus.OK, first.text
    assert second.status_code == HTTPStatus.OK, second.text
    letter = first.json()["essay"]
    assert letter is not None
    assert second.json()["essay"] == letter
    assert provider.calls == 1
    async with concurrent_session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        assert user.monthly_messages_used == 1
        reasons = (
            await session.execute(
                select(WalletAudit.reason).where(col(WalletAudit.user_id) == user_id)
            )
        ).scalars()
        assert list(reasons) == [REASON_SPEND_MONTHLY]
        stored = await session.get(Marginalia, note_id)
        assert stored is not None
        assert stored.essay == letter


# ---------------------------------------------------------------------------
# The resonance pass re-reads the tier under its own hold (#2998)
# ---------------------------------------------------------------------------

#: A caller-owned key, so the race can be run with nobody but the writer paying.
_BYOK_HEADER = "X-LLM-API-Key"
_BYOK_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret

#: A body the local care screen flags, so the bail must still surface care.
_DISTRESS_BODY = "I keep thinking I want to kill myself and end my life tonight."

#: What every in-hold refusal leaves the provider: nothing at all.
_NOTHING_SENT: list[str] = []

#: The completion-detection route's suffix under ``/journal/{entry_id}``.
_DETECT_ROUTE = "suggestions/detect"


class _RecordingReflectVault(SequencedVaultClient):
    """A connected vault that can withdraw a copy *and* reflect, recording each reflect.

    It extends the write-path double rather than the read-path one because the
    intimate PATCH must withdraw the remote copy to answer 200: a vault without
    ``JOURNAL_WITHDRAW`` answers 503 and the race this file stages never happens.
    """

    def __init__(self) -> None:
        """Advertise journal, withdrawal, classification and reflection."""
        super().__init__(
            capabilities=frozenset(
                {
                    CreekCapability.JOURNAL,
                    CreekCapability.JOURNAL_WITHDRAW,
                    CreekCapability.CLASSIFY,
                    CreekCapability.REFLECT,
                }
            )
        )
        self.reflect_calls: list[tuple[str, VaultTierCeiling]] = []

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Record what the vault was asked to read, at what tier, and say nothing."""
        self.reflect_calls.append((body, tier_ceiling))
        return await super().reflect(body, tier_ceiling)


async def _race_against(
    passing: asyncio.Task[Response],
    door: _BarrierDoor,
    mutate: Callable[[], Awaitable[Response]],
) -> Response:
    """Hold ``passing`` at the barrier's door, let ``mutate`` win it, then let it in.

    Returns the pass's response; ``mutate``'s own status is asserted here, so a
    competing request that never succeeded cannot pass for a race that happened.
    """
    await asyncio.wait_for(door.reached.wait(), timeout=_SETTLE_TIMEOUT_SECONDS)
    mutated = await mutate()
    assert mutated.is_success, mutated.text
    door.opened.set()
    return await asyncio.wait_for(passing, timeout=_SETTLE_TIMEOUT_SECONDS)


async def _race_the_pass_against(
    client: AsyncClient,
    pass_headers: dict[str, str],
    entry_id: int,
    door: _BarrierDoor,
    mutate: Callable[[], Awaitable[Response]],
) -> Response:
    """Race the resonance pass against ``mutate`` at the barrier's door."""
    passing = asyncio.create_task(
        client.post(f"/journal/{entry_id}/resonance", headers=pass_headers)
    )
    return await _race_against(passing, door, mutate)


async def _race_detection_against(
    client: AsyncClient,
    detect_headers: dict[str, str],
    entry_id: int,
    door: _BarrierDoor,
    mutate: Callable[[], Awaitable[Response]],
) -> Response:
    """Race completion detection against ``mutate`` at the barrier's door (#3008)."""
    detecting = asyncio.create_task(
        client.post(f"/journal/{entry_id}/{_DETECT_ROUTE}", headers=detect_headers)
    )
    return await _race_against(detecting, door, mutate)


def _arm_the_door(monkeypatch: pytest.MonkeyPatch) -> _BarrierDoor:
    """Pause the first barrier acquisition taken after this call."""
    door = _BarrierDoor()
    monkeypatch.setattr(
        journal, "hold_account", _pause_at_the_first_hold(journal.hold_account, door)
    )
    return door


def _released_provider(monkeypatch: pytest.MonkeyPatch) -> PausedProvider:
    """A provider double that never blocks, so a wrong dial fails an assert, not a timeout."""
    provider = PausedProvider("[]")
    provider.release.set()
    monkeypatch.setattr(marginalia_service, "generate_response", provider)
    return provider


def _connect_vault(monkeypatch: pytest.MonkeyPatch) -> _RecordingReflectVault:
    """Connect a recording vault, and bind the caller's AI operations to it, for this test.

    The boundary is what routes a pass to the vault (#3061); serving the client
    alone would leave the caller app-provider-bound and the vault never asked.
    """
    vault = _RecordingReflectVault()
    monkeypatch.setitem(app.dependency_overrides, get_creek_vault_client, lambda: vault)
    monkeypatch.setitem(
        app.dependency_overrides,
        get_reflection_boundary,
        lambda: ReflectionBoundary.VAULT_BOUND,
    )
    return vault


def _make_intimate(
    client: AsyncClient, headers: dict[str, str], entry_id: int
) -> Callable[[], Awaitable[Response]]:
    """The PATCH that makes the entry intimate."""
    return lambda: client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )


async def _wallet(factory: async_sessionmaker[AsyncSession], user_id: int) -> tuple[int, int]:
    """The account's (monthly messages used, offering balance)."""
    async with factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        return user.monthly_messages_used, user.offering_balance


async def _audit_reasons(factory: async_sessionmaker[AsyncSession], user_id: int) -> list[str]:
    """Every wallet-audit reason recorded for the account, oldest first."""
    async with factory() as session:
        rows = await session.execute(
            select(WalletAudit.reason)
            .where(col(WalletAudit.user_id) == user_id)
            .order_by(col(WalletAudit.id))
        )
        return list(rows.scalars())


async def _marginalia_count(factory: async_sessionmaker[AsyncSession], entry_id: int) -> int:
    """How many margin notes the entry holds."""
    async with factory() as session:
        rows = await session.execute(
            select(Marginalia.id).where(col(Marginalia.journal_entry_id) == entry_id)
        )
        return len(list(rows.scalars()))


def _assert_private_and_unspent(answered: Response) -> None:
    """The pass answered with the private floor's shape: 200, private, nothing produced."""
    assert answered.status_code == HTTPStatus.OK, answered.text
    payload = answered.json()
    assert payload["private"] is True
    assert payload["marginalia"] == []
    assert payload["suggestions"] == []


@pytest.mark.asyncio
async def test_the_resonance_pass_never_dials_a_body_the_patch_already_made_intimate(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A PATCH to intimate that wins the pass's barrier stops the whole pass (#2998).

    The pass reads the INTIMATE floor before it charges and before it waits for
    the barrier. ``PATCH /journal/{entry_id}`` takes the same exclusive hold, so a
    PATCH that queues first completes, answers 200, and only then lets the pass
    through. Neither the reflection nor completion detection may then carry the
    now-intimate body, and the BotMason unit the pass already committed comes back.
    """
    provider = _released_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "pass_tier")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    before = await _wallet(concurrent_session_factory, user_id)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _make_intimate(concurrent_async_client, headers, entry_id),
    )

    assert provider.bodies == _NOTHING_SENT, (
        f"a body the writer had already marked intimate -- in a PATCH that answered "
        f"200 before this dial -- was handed to a model anyway: {provider.bodies}"
    )
    _assert_private_and_unspent(answered)
    assert answered.json()["care"] is None
    assert await _marginalia_count(concurrent_session_factory, entry_id) == 0
    assert await _wallet(concurrent_session_factory, user_id) == before
    assert await _audit_reasons(concurrent_session_factory, user_id) == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_FAILED_RESONANCE,
    ]


@pytest.mark.asyncio
async def test_a_writer_paid_pass_never_dials_a_body_the_patch_already_made_intimate(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The floor is about the body, not the payer: a BYOK pass stops too.

    An intimate entry is never sent to a language model *whoever pays*. With the
    writer's own key there is no BotMason unit to reverse, so the wallet is never
    touched at all -- not even by a spend-and-refund pair.
    """
    provider = _released_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "pass_tier_byok")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    before = await _wallet(concurrent_session_factory, user_id)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        {**headers, _BYOK_HEADER: _BYOK_KEY},
        entry_id,
        door,
        _make_intimate(concurrent_async_client, headers, entry_id),
    )

    assert provider.bodies == _NOTHING_SENT, (
        f"a writer-paid pass sent a now-intimate body to a model: {provider.bodies}"
    )
    _assert_private_and_unspent(answered)
    assert await _wallet(concurrent_session_factory, user_id) == before
    assert await _audit_reasons(concurrent_session_factory, user_id) == []


@pytest.mark.asyncio
async def test_a_connected_vault_is_never_asked_to_reflect_a_body_made_intimate_mid_pass(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The vault is a model too: under the vault boundary neither it nor the app is dialled.

    ``select_reflection_llm`` has no intimate gate of its own -- it would bind an
    intimate-tier vault reflection -- so the pass must stop before it is ever
    asked. The caller is vault-bound (#3061), so this also pins the PATCH that
    wins the hold for a writer whose pass could never fall back to the cloud.
    """
    provider = _released_provider(monkeypatch)
    vault = _connect_vault(monkeypatch)
    headers, email = await signup(concurrent_async_client, "pass_tier_vault")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _make_intimate(concurrent_async_client, headers, entry_id),
    )

    assert vault.withdraw_calls == [entry_id], "the PATCH never withdrew the vault copy"
    assert vault.reflect_calls == [], f"the vault was asked to reflect: {vault.reflect_calls}"
    assert provider.bodies == _NOTHING_SENT
    _assert_private_and_unspent(answered)


@pytest.mark.asyncio
async def test_care_still_surfaces_when_the_pass_stops_for_a_mid_pass_intimate_patch(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The in-hold bail is a privacy floor, and the floor never suppresses care."""
    provider = _released_provider(monkeypatch)
    headers, _email = await signup(concurrent_async_client, "pass_tier_care")
    entry_id = await _create_entry(concurrent_async_client, headers, body=_DISTRESS_BODY)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _make_intimate(concurrent_async_client, headers, entry_id),
    )

    assert provider.bodies == _NOTHING_SENT
    _assert_private_and_unspent(answered)
    assert answered.json()["care"] is not None, "the bail dropped the care surface"


@pytest.mark.asyncio
async def test_a_pass_whose_entry_was_deleted_while_it_waited_answers_404_and_refunds(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A deleted entry is gone, not private: 404, no dial, and the unit comes back."""
    provider = _released_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "pass_deleted")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    before = await _wallet(concurrent_session_factory, user_id)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        lambda: concurrent_async_client.delete(f"/journal/{entry_id}", headers=headers),
    )

    assert provider.bodies == _NOTHING_SENT, f"a deleted entry was dialled: {provider.bodies}"
    assert answered.status_code == HTTPStatus.NOT_FOUND, answered.text
    assert await _wallet(concurrent_session_factory, user_id) == before
    assert await _marginalia_count(concurrent_session_factory, entry_id) == 0


@pytest.mark.parametrize(
    ("admitted", "fresh", "bound"),
    [
        ("public", "personal", VaultTierCeiling.PERSONAL),
        ("personal", "public", VaultTierCeiling.OPEN),
    ],
)
@pytest.mark.asyncio
async def test_a_mid_pass_reclassification_binds_the_tier_the_writer_now_allows(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    admitted: str,
    fresh: str,
    bound: VaultTierCeiling,
) -> None:
    """The fresh read is bound as-is: never the stale tier, never the wider of the two.

    A writer who narrows PERSONAL to PUBLIC mid-pass gets an OPEN-ceiling vault
    read, not the PERSONAL one their earlier choice allowed; a writer who moves
    PUBLIC to PERSONAL still gets a reflection, at the PERSONAL ceiling.
    """
    _released_provider(monkeypatch)
    vault = _connect_vault(monkeypatch)
    headers, _email = await signup(concurrent_async_client, f"pass_{admitted}_{fresh}")
    entry_id = await _create_entry(concurrent_async_client, headers, classification=admitted)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        lambda: concurrent_async_client.patch(
            f"/journal/{entry_id}", json={"classification": fresh}, headers=headers
        ),
    )

    assert answered.status_code == HTTPStatus.OK, answered.text
    assert answered.json()["private"] is False
    assert vault.reflect_calls, "the reclassified entry was never reflected at all"
    assert {tier for _body, tier in vault.reflect_calls} == {bound}


#: Markers for the *other* writing a pass may carry as context. Distinctive, so
#: "did it go out" is a substring check on what the provider actually received.
_OTHER_ENTRY_MARKER = "zebra-quartz: the secret about my brother nobody may read."
_OTHER_LETTER_MARKER = "okapi-violet: a letter about the brother nobody may read."
_UPLOAD_MARKER = "heron-slate: an uploaded essay with no journal entry behind it."
_KEPT_MARKER = "lynx-amber: a journal page nobody withdrew while the pass waited."


def _make_deleted(
    client: AsyncClient, headers: dict[str, str], entry_id: int
) -> Callable[[], Awaitable[Response]]:
    """The DELETE that soft-deletes the entry."""
    return lambda: client.delete(f"/journal/{entry_id}", headers=headers)


#: The two mutations that withdraw *another* entry from what a pass may send.
_WITHDRAWALS = {"intimate": _make_intimate, "deleted": _make_deleted}


def _sent(provider: PausedProvider, marker: str) -> bool:
    """Whether ``marker`` reached the provider in any dial."""
    return any(marker in body for body in provider.bodies)


async def _seed_prior_letter(
    factory: async_sessionmaker[AsyncSession], user_id: int, entry_id: int
) -> None:
    """Give ``entry_id`` one expanded letter, the kind a later pass reads as prior context."""
    note_id = await _seed_marginalia(factory, user_id, entry_id)
    async with factory() as session:
        note = await session.get(Marginalia, note_id)
        assert note is not None
        note.essay = _OTHER_LETTER_MARKER
        note.essay_generated_at = datetime.now(UTC)
        session.add(note)
        await session.commit()


async def _seed_fragment(
    factory: async_sessionmaker[AsyncSession],
    user_id: int,
    *,
    content: str,
    source: CorpusSource,
    source_entry_id: int | None = None,
) -> None:
    """Put one personal-tier fragment into the account's corpus."""
    async with factory() as session:
        session.add(
            CorpusFragment(
                user_id=user_id,
                source_entry_id=source_entry_id,
                source=source,
                tier=JournalClassification.PERSONAL,
                content=content,
                frequency_weights={},
                overall_confidence=0.0,
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_without_a_race_the_other_entry_and_its_letter_ride_along(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The control for the races below: unwithdrawn, both markers really are sent.

    Without it, "the marker never went out" could pass because the seeding never
    reached the prompt at all.
    """
    provider = _released_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "ctx_control")
    user_id = await _user_id(concurrent_session_factory, email)
    other_id = await _create_entry(concurrent_async_client, headers, body=_OTHER_ENTRY_MARKER)
    await _seed_prior_letter(concurrent_session_factory, user_id, other_id)
    entry_id = await _create_entry(concurrent_async_client, headers)

    answered = await concurrent_async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert answered.status_code == HTTPStatus.OK, answered.text
    assert _sent(provider, _OTHER_ENTRY_MARKER)
    assert _sent(provider, _OTHER_LETTER_MARKER)


@pytest.mark.parametrize("withdrawal", sorted(_WITHDRAWALS))
@pytest.mark.asyncio
async def test_another_entry_withdrawn_while_the_pass_waited_is_not_sent_as_grounding(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    withdrawal: str,
) -> None:
    """Grounding is gathered under the hold, so a withdrawal that won it is honoured.

    The pass's own entry is re-read under the hold (#2998), but the *other*
    writing it carries as ``<prior>`` context is just as much a body handed to a
    model. A PATCH to intimate, or a DELETE, of another entry that wins the
    barrier completes and answers 200 first; a grounding read taken before the
    wait would then still send that entry's body, breaking the #895 floor.
    """
    provider = _released_provider(monkeypatch)
    headers, _email = await signup(concurrent_async_client, f"ctx_grounding_{withdrawal}")
    other_id = await _create_entry(concurrent_async_client, headers, body=_OTHER_ENTRY_MARKER)
    entry_id = await _create_entry(concurrent_async_client, headers)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _WITHDRAWALS[withdrawal](concurrent_async_client, headers, other_id),
    )

    assert answered.status_code == HTTPStatus.OK, answered.text
    assert provider.bodies, "the pass never dialled, so the assertion below proves nothing"
    assert not _sent(provider, _OTHER_ENTRY_MARKER), (
        f"an entry {withdrawal} before this dial was sent as grounding: {provider.bodies}"
    )


@pytest.mark.parametrize("withdrawal", sorted(_WITHDRAWALS))
@pytest.mark.asyncio
async def test_a_corpus_copy_withdrawn_while_the_pass_waited_is_not_sent(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    withdrawal: str,
) -> None:
    """The corpus path too: the withdrawn entry's fragment goes, an untouched one stays.

    PATCH-to-intimate and DELETE both withdraw the entry's local corpus copy under
    the same hold. A third entry's fragment is untouched by the withdrawal, so it
    is still legitimate context -- which pins that the fix re-gathers rather than
    simply dropping the corpus. (This used to be an upload; since #3016 a legacy
    upload is never sent at all, which the last assertion pins on this path too.)
    """
    provider = _released_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, f"ctx_corpus_{withdrawal}")
    user_id = await _user_id(concurrent_session_factory, email)
    other_id = await _create_entry(concurrent_async_client, headers, body="An ordinary day.")
    kept_id = await _create_entry(concurrent_async_client, headers, body="A quiet afternoon.")
    await _seed_fragment(
        concurrent_session_factory,
        user_id,
        content=_OTHER_ENTRY_MARKER,
        source=CorpusSource.JOURNAL,
        source_entry_id=other_id,
    )
    await _seed_fragment(
        concurrent_session_factory,
        user_id,
        content=_KEPT_MARKER,
        source=CorpusSource.JOURNAL,
        source_entry_id=kept_id,
    )
    await _seed_fragment(
        concurrent_session_factory, user_id, content=_UPLOAD_MARKER, source=CorpusSource.UPLOAD
    )
    entry_id = await _create_entry(concurrent_async_client, headers)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _WITHDRAWALS[withdrawal](concurrent_async_client, headers, other_id),
    )

    assert answered.status_code == HTTPStatus.OK, answered.text
    assert not _sent(provider, _OTHER_ENTRY_MARKER), (
        f"a corpus copy withdrawn before this dial was sent: {provider.bodies}"
    )
    assert _sent(provider, _KEPT_MARKER), "a corpus copy nothing withdrew was dropped"
    assert not _sent(provider, _UPLOAD_MARKER), (
        f"a legacy upload fragment was sent to the provider: {provider.bodies}"
    )


@pytest.mark.asyncio
async def test_a_legacy_upload_fragment_is_never_sent_to_the_provider(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No race: a document the retired import sorted is stored, but no prompt carries it.

    The journal fragment beside it is the control -- it really is sent -- so the
    upload's absence cannot be explained by the corpus never reaching the prompt.
    """
    provider = _released_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "ctx_legacy_upload")
    user_id = await _user_id(concurrent_session_factory, email)
    kept_id = await _create_entry(concurrent_async_client, headers, body="A quiet afternoon.")
    await _seed_fragment(
        concurrent_session_factory,
        user_id,
        content=_KEPT_MARKER,
        source=CorpusSource.JOURNAL,
        source_entry_id=kept_id,
    )
    await _seed_fragment(
        concurrent_session_factory, user_id, content=_UPLOAD_MARKER, source=CorpusSource.UPLOAD
    )
    entry_id = await _create_entry(concurrent_async_client, headers)

    answered = await concurrent_async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert answered.status_code == HTTPStatus.OK, answered.text
    assert _sent(provider, _KEPT_MARKER), "the control fragment never reached the provider"
    assert not _sent(provider, _UPLOAD_MARKER), (
        f"a legacy upload fragment was sent to the provider: {provider.bodies}"
    )


@pytest.mark.parametrize("withdrawal", sorted(_WITHDRAWALS))
@pytest.mark.asyncio
async def test_a_prior_letter_whose_entry_was_withdrawn_mid_wait_is_not_sent(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    withdrawal: str,
) -> None:
    """A letter about an entry made intimate, or deleted, while the pass waited stays home.

    ``_prior_letters_query`` excludes intimate and deleted parents, but only for
    the state it reads; read before the wait, it hands the model an excerpt of a
    letter whose parent the writer withdrew in a request that already answered.
    """
    provider = _released_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, f"ctx_letter_{withdrawal}")
    user_id = await _user_id(concurrent_session_factory, email)
    other_id = await _create_entry(concurrent_async_client, headers, body="An ordinary day.")
    await _seed_prior_letter(concurrent_session_factory, user_id, other_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _WITHDRAWALS[withdrawal](concurrent_async_client, headers, other_id),
    )

    assert answered.status_code == HTTPStatus.OK, answered.text
    assert provider.bodies, "the pass never dialled, so the assertion below proves nothing"
    assert not _sent(provider, _OTHER_LETTER_MARKER), (
        f"a letter whose entry was {withdrawal} before this dial was sent: {provider.bodies}"
    )


# ---------------------------------------------------------------------------
# Completion detection re-reads the tier under its own hold (#3008)
# ---------------------------------------------------------------------------

#: A body a mid-wait PATCH writes. Shares nothing with ``_BODY``, so "which body
#: went out" is a substring check on what the provider actually received.
_FRESH_MARKER = "kestrel-amber: the edit the writer made while detection waited."


def _detected_provider(monkeypatch: pytest.MonkeyPatch) -> PausedProvider:
    """A never-blocking detection provider that answers with no hits."""
    provider = PausedProvider(_NO_HITS)
    provider.release.set()
    monkeypatch.setattr(marginalia_service, "generate_response", provider)
    return provider


async def _suggestion_count(factory: async_sessionmaker[AsyncSession], entry_id: int) -> int:
    """How many completion suggestions the entry holds."""
    async with factory() as session:
        rows = await session.execute(
            select(CompletionSuggestion.id).where(
                col(CompletionSuggestion.journal_entry_id) == entry_id
            )
        )
        return len(list(rows.scalars()))


async def _usage_log_count(factory: async_sessionmaker[AsyncSession], entry_id: int) -> int:
    """How many LLM usage rows were recorded against the entry."""
    async with factory() as session:
        rows = await session.execute(
            select(LLMUsageLog.id).where(col(LLMUsageLog.journal_entry_id) == entry_id)
        )
        return len(list(rows.scalars()))


def _assert_detect_withheld(answered: Response) -> None:
    """Detection answered with the intimate floor's shape: 200, nothing, unchecked."""
    assert answered.status_code == HTTPStatus.OK, answered.text
    assert answered.json() == {"items": [], "checked": False}


@pytest.mark.asyncio
async def test_completion_detection_never_dials_a_body_the_patch_already_made_intimate(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A PATCH to intimate that wins detection's barrier stops the dial (#3008).

    Detection reads the INTIMATE floor before it waits for the barrier, and
    ``PATCH /journal/{entry_id}`` takes the same exclusive hold. A PATCH that
    queues first answers 200 before detection gets in, so neither the body nor
    the names of the writer's habits may then reach a model. The route is
    uncharged, so the wallet and its audit trail must not move at all.
    """
    provider = _detected_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "detect_tier")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    before = await _wallet(concurrent_session_factory, user_id)
    reasons = await _audit_reasons(concurrent_session_factory, user_id)
    door = _arm_the_door(monkeypatch)

    answered = await _race_detection_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _make_intimate(concurrent_async_client, headers, entry_id),
    )

    assert provider.bodies == _NOTHING_SENT, (
        f"a body the writer had already marked intimate -- in a PATCH that answered "
        f"200 before this dial -- was handed to a model anyway: {provider.bodies}"
    )
    _assert_detect_withheld(answered)
    assert await _suggestion_count(concurrent_session_factory, entry_id) == 0
    assert await _usage_log_count(concurrent_session_factory, entry_id) == 0
    assert await _wallet(concurrent_session_factory, user_id) == before
    assert await _audit_reasons(concurrent_session_factory, user_id) == reasons


@pytest.mark.asyncio
async def test_a_writer_paid_completion_detection_never_dials_a_body_made_intimate_mid_wait(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The floor is about the body, not the payer: BYOK detection stops too."""
    provider = _detected_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "detect_tier_byok")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    before = await _wallet(concurrent_session_factory, user_id)
    door = _arm_the_door(monkeypatch)

    answered = await _race_detection_against(
        concurrent_async_client,
        {**headers, _BYOK_HEADER: _BYOK_KEY},
        entry_id,
        door,
        _make_intimate(concurrent_async_client, headers, entry_id),
    )

    assert provider.bodies == _NOTHING_SENT, (
        f"writer-paid detection sent a now-intimate body to a model: {provider.bodies}"
    )
    _assert_detect_withheld(answered)
    assert await _suggestion_count(concurrent_session_factory, entry_id) == 0
    assert await _usage_log_count(concurrent_session_factory, entry_id) == 0
    assert await _wallet(concurrent_session_factory, user_id) == before
    assert await _audit_reasons(concurrent_session_factory, user_id) == []


@pytest.mark.asyncio
async def test_completion_detection_whose_entry_was_deleted_while_it_waited_answers_404(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A deleted entry is gone, not private: the uniform 404, and nothing dialled."""
    provider = _detected_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "detect_deleted")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    before = await _wallet(concurrent_session_factory, user_id)
    reasons = await _audit_reasons(concurrent_session_factory, user_id)
    door = _arm_the_door(monkeypatch)

    answered = await _race_detection_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _make_deleted(concurrent_async_client, headers, entry_id),
    )

    assert provider.bodies == _NOTHING_SENT, f"a deleted entry was dialled: {provider.bodies}"
    assert answered.status_code == HTTPStatus.NOT_FOUND, answered.text
    unraced = await concurrent_async_client.post(
        f"/journal/{entry_id}/{_DETECT_ROUTE}", headers=headers
    )
    assert answered.json() == unraced.json(), "the in-hold 404 is not the uniform one"
    assert await _suggestion_count(concurrent_session_factory, entry_id) == 0
    assert await _usage_log_count(concurrent_session_factory, entry_id) == 0
    assert await _wallet(concurrent_session_factory, user_id) == before
    assert await _audit_reasons(concurrent_session_factory, user_id) == reasons


@pytest.mark.asyncio
async def test_completion_detection_after_a_mid_wait_edit_dials_the_body_the_patch_left(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A narrowing short of intimate still detects, on the body the PATCH left.

    PUBLIC narrowed to PERSONAL is still a tier a model may read, so the dial
    goes ahead -- but on the refreshed row's body, never the copy read before
    the wait, which the writer had already replaced.
    """
    provider = _detected_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "detect_fresh")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers, classification="public")
    door = _arm_the_door(monkeypatch)

    answered = await _race_detection_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        lambda: concurrent_async_client.patch(
            f"/journal/{entry_id}",
            json={"classification": "personal", "message": _FRESH_MARKER},
            headers=headers,
        ),
    )

    assert answered.status_code == HTTPStatus.OK, answered.text
    assert answered.json() == {"items": [], "checked": True}
    assert len(provider.bodies) == 1, f"expected exactly one dial: {provider.bodies}"
    assert _FRESH_MARKER in provider.bodies[0]
    assert _BODY not in provider.bodies[0], "the pre-wait body was dialled, not the edit"


#: How each dial's prompt opens: the reflection wraps the body in ``<entry>``;
#: completion detection lists its candidates first. Telling them apart lets the
#: test require that *both* dials happened, not merely that something was sent.
_REFLECTION_PROMPT = "<entry>"
_DETECTION_PROMPT = "Candidates:"


def _edit_body(
    client: AsyncClient, headers: dict[str, str], entry_id: int, body: str
) -> Callable[[], Awaitable[Response]]:
    """The body-only PATCH a writer sends to replace what the entry says."""
    return lambda: client.patch(f"/journal/{entry_id}", json={"message": body}, headers=headers)


@pytest.mark.asyncio
async def test_a_mid_wait_body_edit_is_the_body_every_resonance_dial_carries(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reflection and the detection both carry the body the PATCH left (#3008).

    A writer who redacts a sentence while the pass waits for the barrier gets a
    200 for the edit first. Re-reading only the tier under the hold would still
    dial the copy taken before the wait -- the unredacted sentence -- so the
    body itself is re-derived from the refreshed row, for every dial.
    """
    provider = _released_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "pass_fresh_body")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _edit_body(concurrent_async_client, headers, entry_id, _FRESH_MARKER),
    )

    assert answered.status_code == HTTPStatus.OK, answered.text
    reflections = [body for body in provider.bodies if body.startswith(_REFLECTION_PROMPT)]
    detections = [body for body in provider.bodies if body.startswith(_DETECTION_PROMPT)]
    assert reflections, f"the reflection was never dialled: {provider.bodies}"
    assert detections, f"completion detection was never dialled: {provider.bodies}"
    assert all(_FRESH_MARKER in body for body in provider.bodies), provider.bodies
    assert not _sent(provider, _BODY), "the pre-wait body was dialled, not the edit"


@pytest.mark.asyncio
async def test_a_connected_vault_reflects_the_body_a_mid_wait_edit_left(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The vault is a dial too: it is asked to read the refreshed body, never the stale one."""
    _released_provider(monkeypatch)
    vault = _connect_vault(monkeypatch)
    headers, _email = await signup(concurrent_async_client, "pass_fresh_vault")
    entry_id = await _create_entry(concurrent_async_client, headers)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _edit_body(concurrent_async_client, headers, entry_id, _FRESH_MARKER),
    )

    assert answered.status_code == HTTPStatus.OK, answered.text
    assert vault.reflect_calls, "the vault was never asked to reflect"
    assert {body for body, _tier in vault.reflect_calls} == {_FRESH_MARKER}


@pytest.mark.asyncio
async def test_a_mid_wait_edit_into_distress_surfaces_care_and_skips_the_vault(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Care is screened on the body actually reflected, so an edit into distress is cared for.

    The local screen ran on the pre-wait body, which was calm. A care verdict
    kept from that reading would answer a writer in crisis with no care surface
    and would route their distressed writing to the vault, which a flagged entry
    never reaches. The screen is pure and local, so it re-runs under the hold.
    """
    _released_provider(monkeypatch)
    vault = _connect_vault(monkeypatch)
    headers, _email = await signup(concurrent_async_client, "pass_fresh_care")
    entry_id = await _create_entry(concurrent_async_client, headers)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _edit_body(concurrent_async_client, headers, entry_id, _DISTRESS_BODY),
    )

    assert answered.status_code == HTTPStatus.OK, answered.text
    assert answered.json()["care"] is not None, "the edit into distress got no care surface"
    assert vault.reflect_calls == [], f"a flagged body reached the vault: {vault.reflect_calls}"


#: A body that sanitizes to nothing: zero-width spaces only.
_BLANK_BODY = "\u200b\u200b\u200b"


def _blank_the_row(
    factory: async_sessionmaker[AsyncSession], entry_id: int
) -> Callable[[], Awaitable[Response]]:
    """Blank the row's body behind the API's back, the way a legacy writer could.

    ``PATCH`` refuses a body that sanitizes to nothing, so only a non-API writer
    can leave one; the pass must still answer it with the route's own 422.
    """

    async def _blank() -> Response:
        async with factory() as session:
            entry = await session.get(JournalEntry, entry_id)
            assert entry is not None
            entry.message = _BLANK_BODY
            session.add(entry)
            await session.commit()
        return Response(HTTPStatus.OK)

    return _blank


@pytest.mark.asyncio
async def test_a_body_blanked_while_the_pass_waited_answers_422_and_refunds(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refreshed body with nothing left is the route's 422, unspent and undialled -- never 500."""
    provider = _released_provider(monkeypatch)
    headers, email = await signup(concurrent_async_client, "pass_blanked")
    user_id = await _user_id(concurrent_session_factory, email)
    entry_id = await _create_entry(concurrent_async_client, headers)
    before = await _wallet(concurrent_session_factory, user_id)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _blank_the_row(concurrent_session_factory, entry_id),
    )

    assert answered.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, answered.text
    assert answered.json() == {"detail": "journal_message_empty"}
    assert provider.bodies == _NOTHING_SENT
    assert await _wallet(concurrent_session_factory, user_id) == before
    assert await _audit_reasons(concurrent_session_factory, user_id) == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_FAILED_RESONANCE,
    ]
    assert await _marginalia_count(concurrent_session_factory, entry_id) == 0


@pytest.mark.asyncio
async def test_a_body_blanked_while_the_pass_waited_settles_once_with_its_refund_line(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The in-hold 422 refund carries the pass's trace: one settled line, one refund line."""
    _released_provider(monkeypatch)
    headers, _email = await signup(concurrent_async_client, "pass_blanked_settled")
    entry_id = await _create_entry(concurrent_async_client, headers)
    door = _arm_the_door(monkeypatch)
    for name in _SETTLEMENT_LOGGERS:
        caplog.set_level(logging.INFO, logger=name)
    caplog.clear()

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        _blank_the_row(concurrent_session_factory, entry_id),
    )

    assert answered.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, answered.text
    settled = records_for(caplog.records, _SETTLED)
    assert len(settled) == 1, [r.getMessage() for r in settled]
    extra = settled[0].__dict__
    assert extra["feature"] == "resonance"
    assert extra["outcome"] == "refunded_failed"
    assert extra["charged"] is True
    assert extra["calls"] == 0
    refunds = records_for(caplog.records, _REFUND_APPLIED)
    assert [r.__dict__["refund_reason"] for r in refunds] == [REASON_REFUND_FAILED_RESONANCE]


@pytest.mark.asyncio
async def test_an_edit_into_distress_that_also_makes_the_entry_intimate_still_gets_care(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The in-hold private answer screens the body the PATCH left, not the calm pre-wait one."""
    provider = _released_provider(monkeypatch)
    headers, _email = await signup(concurrent_async_client, "pass_fresh_intimate_care")
    entry_id = await _create_entry(concurrent_async_client, headers)
    door = _arm_the_door(monkeypatch)

    answered = await _race_the_pass_against(
        concurrent_async_client,
        headers,
        entry_id,
        door,
        lambda: concurrent_async_client.patch(
            f"/journal/{entry_id}",
            json={"classification": "intimate", "message": _DISTRESS_BODY},
            headers=headers,
        ),
    )

    assert provider.bodies == _NOTHING_SENT
    _assert_private_and_unspent(answered)
    assert answered.json()["care"] is not None, "the private answer dropped the edit's care"
