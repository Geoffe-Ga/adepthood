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
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from models.goal import Goal
from models.habit import Habit
from models.marginalia import Marginalia, MarginaliaKind, MarginaliaStatus
from models.user import User
from routers import journal
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from tests.test_account_egress_barrier import (
    DELETION_BEGIN,
    DELETION_RESPONSE,
    delete_account_recording_order,
    signup,
)

#: The journal body both routes transmit. Distinctive so an assertion about
#: "what went out" names the thing that went out.
_BODY = "I meditated by the river and the willow bent without breaking."

#: Markers appended to the shared order list, named once so the double and the
#: assertions cannot drift apart on a typo.
DIAL_START = "provider-dial-start"
DIAL_SENT = "provider-dial-sent"

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


async def _create_entry(client: AsyncClient, headers: dict[str, str]) -> int:
    """Write one personal entry and return its id."""
    created = await client.post(
        "/journal/", json={"message": _BODY, "classification": "personal"}, headers=headers
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
    provider = PausedProvider(json.dumps({"hits": []}))
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
        concurrent_async_client.post(f"/journal/marginalia/{note_id}/essay", headers=headers)
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
    provider = PausedProvider(json.dumps({"hits": []}))
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
        concurrent_async_client.post(f"/journal/marginalia/{note_id}/essay", headers=headers)
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
