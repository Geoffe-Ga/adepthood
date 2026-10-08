"""A DELETE that lands while a pass waits for the barrier stops the pass (#3098 review).

The deletion-in-progress refusal runs before a pass waits for the account
barrier. ``DELETE /journal/{entry_id}`` takes that same exclusive hold, so a
DELETE that queues first completes in full -- including, when its vault cannot
confirm, the ``pending_delete`` obligation it commits before answering 503 --
and only then lets the pass in. Every re-read made under the hold must
therefore check that obligation, not only ``deleted_at``: otherwise the body of
a page whose deletion is in progress still goes to a cloud model, or a fresh
essay still goes to the vault.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from main import app
from models.journal_entry import JournalEntry
from models.journal_withdrawal_obligation import (
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)
from models.voice_draft_retraction import VoiceDraftRetraction
from routers import journal
from services import marginalia as marginalia_service
from tests.test_account_egress_barrier import signup
from tests.test_account_egress_barrier_llm import (
    PausedProvider,
    _create_entry,
    _marginalia_count,
    _seed_detection_candidate,
    _seed_marginalia,
    _user_id,
    _wallet,
)
from tests.test_voice_draft_retraction_recovery import _DraftVault as DraftVault

_SETTLE_TIMEOUT_SECONDS = 20.0
_DELETION_PENDING = {"detail": "journal_entry_deletion_pending"}
_ESSAY_ASK = {"price_acknowledged": True}
#: A recorded destination no vault connected in these tests will ever match, so
#: the DELETE cannot confirm the copy and answers 503 with a pending_delete.
_UNREACHABLE_DESTINATION = "f" * 32
_FIRST_HOLD = 1
_SECOND_HOLD = 2
_HoldAccount = Callable[[AsyncSession, int], AbstractAsyncContextManager[None]]


@dataclass
class _Door:
    """Pause the ``nth`` barrier acquisition; every other one walks through."""

    nth: int
    reached: asyncio.Event = field(default_factory=asyncio.Event)
    opened: asyncio.Event = field(default_factory=asyncio.Event)
    seen: int = 0


def _pause_at(real: _HoldAccount, door: _Door) -> _HoldAccount:
    @asynccontextmanager
    async def _hold(session: AsyncSession, user_id: int) -> AsyncIterator[None]:
        door.seen += 1
        if door.seen == door.nth:
            door.reached.set()
            await door.opened.wait()
        async with real(session, user_id):
            yield

    return _hold


def _arm(monkeypatch: pytest.MonkeyPatch, nth: int) -> _Door:
    door = _Door(nth=nth)
    monkeypatch.setattr(journal, "hold_account", _pause_at(journal.hold_account, door))
    return door


def _released_provider(monkeypatch: pytest.MonkeyPatch, payload: str) -> PausedProvider:
    provider = PausedProvider(payload)
    provider.release.set()
    monkeypatch.setattr(marginalia_service, "generate_response", provider)
    return provider


async def _mark_mirrored(factory: async_sessionmaker[AsyncSession], entry_id: int) -> None:
    """Give the page a vault copy no connected vault can confirm."""
    async with factory() as session:
        entry = await session.get(JournalEntry, entry_id)
        assert entry is not None
        entry.vault_ref = "vault-ref-unreachable"
        entry.vault_destination = _UNREACHABLE_DESTINATION
        session.add(entry)
        await session.commit()


async def _obligation_state(factory: async_sessionmaker[AsyncSession], entry_id: int) -> str:
    async with factory() as session:
        row = (
            await session.execute(
                select(JournalWithdrawalObligation).where(
                    col(JournalWithdrawalObligation.journal_entry_id) == entry_id
                )
            )
        ).scalar_one()
        return row.state


async def _race(
    passing: asyncio.Task[Response],
    door: _Door,
    mutate: Callable[[], Awaitable[Response]],
) -> Response:
    """Hold ``passing`` at the door, let a DELETE that 503s win the barrier, let it in."""
    await asyncio.wait_for(door.reached.wait(), timeout=_SETTLE_TIMEOUT_SECONDS)
    deleted = await mutate()
    assert deleted.status_code == HTTPStatus.SERVICE_UNAVAILABLE, deleted.text
    door.opened.set()
    return await asyncio.wait_for(passing, timeout=_SETTLE_TIMEOUT_SECONDS)


@pytest.mark.asyncio
async def test_a_resonance_pass_stops_for_a_delete_that_landed_while_it_waited(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """409, no dial, the committed unit refunded, no marginalia written."""
    provider = _released_provider(monkeypatch, "[]")
    headers, email = await signup(concurrent_async_client, "race_pass_pending")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    await _mark_mirrored(concurrent_session_factory, entry_id)
    before = await _wallet(concurrent_session_factory, user_id)
    door = _arm(monkeypatch, _FIRST_HOLD)

    passing = asyncio.create_task(
        concurrent_async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    )
    answered = await _race(
        passing,
        door,
        lambda: concurrent_async_client.delete(f"/journal/{entry_id}", headers=headers),
    )

    assert answered.status_code == HTTPStatus.CONFLICT, answered.text
    assert answered.json() == _DELETION_PENDING
    assert provider.bodies == [], f"a page being deleted was dialled: {provider.bodies}"
    assert await _wallet(concurrent_session_factory, user_id) == before
    assert await _marginalia_count(concurrent_session_factory, entry_id) == 0
    assert (
        await _obligation_state(concurrent_session_factory, entry_id)
        == JournalWithdrawalState.PENDING_DELETE
    )


@pytest.mark.asyncio
async def test_detection_stops_for_a_delete_that_landed_while_it_waited(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Completion detection re-reads under the same hold: 409 and no dial."""
    provider = _released_provider(monkeypatch, '{"hits": []}')
    headers, email = await signup(concurrent_async_client, "race_detect_pending")
    user_id = await _user_id(concurrent_session_factory, email)
    await _seed_detection_candidate(concurrent_session_factory, user_id)
    entry_id = await _create_entry(concurrent_async_client, headers)
    await _mark_mirrored(concurrent_session_factory, entry_id)
    door = _arm(monkeypatch, _FIRST_HOLD)

    detecting = asyncio.create_task(
        concurrent_async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)
    )
    answered = await _race(
        detecting,
        door,
        lambda: concurrent_async_client.delete(f"/journal/{entry_id}", headers=headers),
    )

    assert answered.status_code == HTTPStatus.CONFLICT, answered.text
    assert answered.json() == _DELETION_PENDING
    assert provider.bodies == []


@pytest.mark.asyncio
async def test_an_essay_stops_for_a_delete_that_landed_before_it_composed(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The essay's first hold re-reads the obligation: 409, no dial, nothing charged."""
    provider = _released_provider(monkeypatch, "A letter.")
    headers, email = await signup(concurrent_async_client, "race_essay_pending")
    user_id = await _user_id(concurrent_session_factory, email)
    entry_id = await _create_entry(concurrent_async_client, headers)
    note_id = await _seed_marginalia(concurrent_session_factory, user_id, entry_id)
    await _mark_mirrored(concurrent_session_factory, entry_id)
    before = await _wallet(concurrent_session_factory, user_id)
    door = _arm(monkeypatch, _FIRST_HOLD)

    asking = asyncio.create_task(
        concurrent_async_client.post(
            f"/journal/marginalia/{note_id}/essay", json=_ESSAY_ASK, headers=headers
        )
    )
    answered = await _race(
        asking,
        door,
        lambda: concurrent_async_client.delete(f"/journal/{entry_id}", headers=headers),
    )

    assert answered.status_code == HTTPStatus.CONFLICT, answered.text
    assert answered.json() == _DELETION_PENDING
    assert provider.bodies == []
    assert await _wallet(concurrent_session_factory, user_id) == before


@pytest.mark.asyncio
async def test_an_essay_composed_before_the_delete_is_never_mirrored(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A DELETE that lands between composing and mirroring: no intent, nothing sent to the vault."""
    _released_provider(monkeypatch, "A letter about the river.")
    vault = DraftVault()
    monkeypatch.setitem(app.dependency_overrides, get_creek_vault_client, lambda: vault)
    headers, email = await signup(concurrent_async_client, "race_mirror_pending")
    user_id = await _user_id(concurrent_session_factory, email)
    entry_id = await _create_entry(concurrent_async_client, headers)
    note_id = await _seed_marginalia(concurrent_session_factory, user_id, entry_id)
    await _mark_mirrored(concurrent_session_factory, entry_id)
    door = _arm(monkeypatch, _SECOND_HOLD)

    asking = asyncio.create_task(
        concurrent_async_client.post(
            f"/journal/marginalia/{note_id}/essay", json=_ESSAY_ASK, headers=headers
        )
    )
    answered = await _race(
        asking,
        door,
        lambda: concurrent_async_client.delete(f"/journal/{entry_id}", headers=headers),
    )

    assert answered.status_code == HTTPStatus.OK, answered.text
    async with concurrent_session_factory() as session:
        intents = (
            await session.execute(
                select(VoiceDraftRetraction).where(
                    col(VoiceDraftRetraction.marginalia_id) == note_id
                )
            )
        ).all()
    assert intents == [], "an essay of a page being deleted was offered to the vault"
