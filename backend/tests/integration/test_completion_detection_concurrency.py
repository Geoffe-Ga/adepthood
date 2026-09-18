"""PostgreSQL proof that simultaneous completion checks cannot duplicate offers.

Two mechanisms now stand between two tabs and a duplicate offer, and they are
tested separately because they guard different things and one hides the other.

The **account egress barrier** (issue #2642) makes two of this account's
detection passes take turns: both routes transmit stored journal writing to a
cloud provider, so both hold the per-account barrier across the dial. The
route-level tests below therefore assert what is now true -- the passes do not
overlap, and the follower sees the leader's committed offer -- rather than the
overlap the earlier version of this file arranged, which the barrier has made
unreachable through these routes.

The **post-dial entry lock** inside ``_persist_detected_suggestions`` is what
would catch a duplicate if two passes ever *did* overlap. With the barrier in
front of it no route can produce that interleaving, so proving it through the
HTTP seam is no longer possible; the last test drives the persistence seam
directly instead. Deleting it would leave the lock certified by nothing.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from http import HTTPStatus

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlmodel import col

from database import get_session
from domain.detection import CompletionDetected
from main import app
from models.completion_suggestion import CompletionSuggestion
from models.habit import Habit
from models.user import User
from routers.journal import _persist_detected_suggestions as persist_detected_suggestions
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from services.marginalia import BotmasonResonanceLLM

pytestmark = pytest.mark.integration

#: How long a pass is held at the provider while the other one is given every
#: chance to overtake it. Generous, because a window too short would make a
#: serialized pair look like an overlapping one.
_OVERLAP_PROBE_SECONDS = 0.5


class _CountingProvider:
    """A ``generate_response`` stand-in that records how many dials overlap.

    ``maximum_overlap`` is the assertion the barrier is worth making: it is 2
    when two of this account's passes are in the provider at the same time, and
    1 when they take turns.
    """

    def __init__(self, hits_payload: str, notes_payload: str | None = None) -> None:
        """Answer detection with ``hits_payload`` and resonance with ``notes_payload``."""
        self._hits = hits_payload
        self._notes = notes_payload
        self.detection_calls = 0
        self.active = 0
        self.maximum_overlap = 0

    async def __call__(
        self,
        prompt: str,
        _history: object,
        *,
        system_prompt: str | None = None,
        api_key: object = None,
    ) -> LLMResponse:
        """Dwell in the provider long enough for an unordered twin to join."""
        del api_key
        task = f"{system_prompt or ''}\n{prompt}"
        if '"hits"' not in task and "COMPLETED" not in task:
            assert self._notes is not None, "the literary pass was dialled unexpectedly"
            return _stub(self._notes)
        self.detection_calls += 1
        self.active += 1
        self.maximum_overlap = max(self.maximum_overlap, self.active)
        try:
            await asyncio.sleep(_OVERLAP_PROBE_SECONDS)
            return _stub(self._hits)
        finally:
            self.active -= 1


def _stub(text: str) -> LLMResponse:
    """One zero-cost provider answer carrying ``text``."""
    return LLMResponse(
        text=text,
        provider="stub",
        model=STUB_MODEL_NAME,
        prompt_tokens=0,
        completion_tokens=0,
    )


_HITS = json.dumps({"hits": [{"index": 0, "quote": "I meditated"}]})
_NOTES = json.dumps(
    {"notes": [{"kind": "theme", "quote": "I meditated", "note": "You showed up."}]}
)


@pytest_asyncio.fixture
async def concurrent_pg_client(pg_engine: AsyncEngine) -> AsyncGenerator[AsyncClient, None]:
    """Drive the app with an independent transaction per concurrent request."""
    factory = async_sessionmaker(pg_engine, class_=AsyncSession, expire_on_commit=False)

    async def _session() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = _session
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.clear()


async def _signup(client: AsyncClient, username: str = "detect-race") -> dict[str, str]:
    response = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _seed_detectable_entry(client: AsyncClient, headers: dict[str, str]) -> int:
    habit = await client.post(
        "/habits/",
        headers=headers,
        json={
            "name": "Meditation",
            "icon": "🧘",
            "start_date": "2025-01-01",
            "energy_cost": 1,
            "energy_return": 2,
        },
    )
    assert habit.status_code == HTTPStatus.OK
    entry = await client.post("/journal/", headers=headers, json={"message": "I meditated"})
    assert entry.status_code == HTTPStatus.CREATED
    return int(entry.json()["id"])


async def _offer_count(engine: AsyncEngine, entry_id: int) -> int:
    """How many completion offers this entry currently carries."""
    async with AsyncSession(engine) as session:
        return int(
            (
                await session.execute(
                    select(func.count())
                    .select_from(CompletionSuggestion)
                    .where(col(CompletionSuggestion.journal_entry_id) == entry_id)
                )
            ).scalar_one()
        )


@pytest.mark.asyncio
async def test_two_detection_requests_persist_one_offer(
    concurrent_pg_client: AsyncClient,
    pg_engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The account barrier makes the second tab wait, then observe the first's offer."""
    provider = _CountingProvider(_HITS)
    monkeypatch.setattr(marginalia_service, "generate_response", provider)
    headers = await _signup(concurrent_pg_client)
    entry_id = await _seed_detectable_entry(concurrent_pg_client, headers)

    responses = await asyncio.gather(
        concurrent_pg_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers),
        concurrent_pg_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers),
    )

    assert [response.status_code for response in responses] == [HTTPStatus.OK, HTTPStatus.OK]
    assert sorted(len(response.json()["items"]) for response in responses) == [0, 1]
    assert provider.detection_calls == 2, "one of the two passes never reached the provider"
    assert provider.maximum_overlap == 1, (
        "two of one account's stored-content dials were in the provider at once, so "
        "the per-account egress barrier did not order this route"
    )
    assert await _offer_count(pg_engine, entry_id) == 1


@pytest.mark.asyncio
async def test_detection_and_resonance_requests_persist_one_offer(
    concurrent_pg_client: AsyncClient,
    pg_engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The independent and charged paths take the same per-account barrier."""
    provider = _CountingProvider(_HITS, notes_payload=_NOTES)
    monkeypatch.setattr(marginalia_service, "generate_response", provider)
    headers = await _signup(concurrent_pg_client, "cross-path-race")
    entry_id = await _seed_detectable_entry(concurrent_pg_client, headers)

    detected, reflected = await asyncio.gather(
        concurrent_pg_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers),
        concurrent_pg_client.post(f"/journal/{entry_id}/resonance", headers=headers),
    )

    assert detected.status_code == HTTPStatus.OK
    assert reflected.status_code == HTTPStatus.OK
    assert sorted([len(detected.json()["items"]), len(reflected.json()["suggestions"])]) == [0, 1]
    assert len(reflected.json()["marginalia"]) == 1
    assert provider.detection_calls == 2, "one of the two paths never reached detection"
    assert provider.maximum_overlap == 1, (
        "the uncharged and charged paths dialled the provider at the same time for "
        "one account, so they are not both behind the egress barrier"
    )
    assert await _offer_count(pg_engine, entry_id) == 1


@pytest.mark.asyncio
async def test_two_overlapping_persists_still_write_one_offer(
    concurrent_pg_client: AsyncClient,
    pg_engine: AsyncEngine,
) -> None:
    """The post-dial entry lock, driven where the barrier cannot hide it.

    No route can produce this interleaving any more -- the account barrier is in
    front of every one of them -- so the seam is driven directly. It is the
    mechanism that would still hold if a future caller reached the persistence
    without the barrier, and a property no test drives is a property nobody has.
    """
    headers = await _signup(concurrent_pg_client, "persist-race")
    entry_id = await _seed_detectable_entry(concurrent_pg_client, headers)
    async with AsyncSession(pg_engine) as session:
        user = (
            await session.execute(select(User).where(col(User.email) == "persist-race@example.com"))
        ).scalar_one()
        assert user.id is not None
        user_id = int(user.id)
        habit_id = await _only_habit_id(session, user_id)

    hits = [
        CompletionDetected(
            target_type="habit",
            target_id=habit_id,
            label="Meditation",
            anchor_start=0,
            anchor_end=len("I meditated"),
            anchor_text="I meditated",
        )
    ]
    factory = async_sessionmaker(pg_engine, class_=AsyncSession, expire_on_commit=False)

    async def _persist() -> int:
        async with factory() as session:
            answered = await persist_detected_suggestions(
                session,
                entry_id=entry_id,
                user_id=user_id,
                hits=hits,
                llm=BotmasonResonanceLLM(None),
            )
            return len(answered.items)

    first, second = await asyncio.gather(_persist(), _persist())

    assert sorted([first, second]) == [0, 1], (
        "two simultaneous persists both staged an offer for the same target"
    )
    assert await _offer_count(pg_engine, entry_id) == 1


async def _only_habit_id(session: AsyncSession, user_id: int) -> int:
    """The id of the single habit the seeding request created for ``user_id``."""
    habit = (await session.execute(select(Habit).where(col(Habit.user_id) == user_id))).scalar_one()
    assert habit.id is not None
    return int(habit.id)
