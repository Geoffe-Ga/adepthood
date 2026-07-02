"""Completion detection wired into the resonance endpoint + list + re-anchor (#817)."""

from __future__ import annotations

import json
from datetime import date
from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.completion_suggestion import CompletionSuggestion, SuggestionStatus
from models.goal import Goal
from models.habit import Habit
from models.marginalia import Marginalia
from models.user import User
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMProviderError, LLMResponse

_BODY = "I meditated by the river and the willow bent without breaking."
_NOTE = {"kind": "theme", "quote": "the willow bent without breaking", "note": "It holds."}


async def _signup(client: AsyncClient, username: str = "det") -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _user_id(session: AsyncSession, username: str = "det") -> int:
    user = (
        await session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()
    assert user.id is not None
    return user.id


async def _create_entry(client: AsyncClient, headers: dict[str, str], body: str = _BODY) -> int:
    resp = await client.post("/journal/", json={"message": body}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


async def _seed_habit(session: AsyncSession, user_id: int, name: str = "Meditation") -> None:
    habit = Habit(
        name=name,
        icon="🧘",
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


def _fake(
    monkeypatch: pytest.MonkeyPatch,
    *,
    hits: list[dict[str, Any]],
    detection_calls: list[str] | None = None,
    detection_raises: bool = False,
) -> None:
    """Patch the shared LLM seam: marginalia JSON for the literary prompt, hits for detection."""
    notes_payload = json.dumps({"notes": [_NOTE]})
    hits_payload = json.dumps({"hits": hits})

    def _stub(text: str) -> LLMResponse:
        return LLMResponse(
            text=text,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del history, system_prompt, api_key
        # Routes by prompt content: the detection prompt asks for a JSON ``{"hits": ...}``
        # payload and labels resolved spans ``COMPLETED``, while the literary/marginalia
        # prompt asks for ``{"notes": ...}``. Keying on either of those detection-only
        # markers lets one seam serve both passes without inspecting the domain module.
        if '"hits"' in prompt or "COMPLETED" in prompt:  # the detection prompt
            if detection_calls is not None:
                detection_calls.append(prompt)
            if detection_raises:
                raise LLMProviderError("detector down")
            return _stub(hits_payload)
        return _stub(notes_payload)

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)


@pytest.mark.asyncio
async def test_one_press_returns_marginalia_and_suggestions_on_one_charge(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake(monkeypatch, hits=[{"index": 0, "quote": "I meditated"}])
    headers = await _signup(async_client)
    await _seed_habit(db_session, await _user_id(db_session))
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert len(body["marginalia"]) == 1
    assert len(body["suggestions"]) == 1
    s = body["suggestions"][0]
    assert s["status"] == SuggestionStatus.PENDING.value
    assert s["label"] == "I meditated"
    assert s["target_type"] == "habit"
    assert s["goal_id"] is not None
    assert "user_id" not in s  # enumeration-safe
    assert body["remaining_messages"] == 49  # exactly one charge (50 cap - 1)
    persisted = (
        await db_session.execute(select(func.count()).select_from(CompletionSuggestion))
    ).scalar_one()
    assert persisted == 1


@pytest.mark.asyncio
async def test_no_candidates_skips_detection_llm(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    _fake(monkeypatch, hits=[{"index": 0, "quote": "I meditated"}], detection_calls=calls)
    headers = await _signup(async_client, "nohab")  # no habit seeded → no candidates
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["suggestions"] == []
    assert len(resp.json()["marginalia"]) == 1  # literary pass still ran
    assert calls == []  # the detection LLM was never called (cost guard)


@pytest.mark.asyncio
async def test_detection_failure_is_best_effort(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake(monkeypatch, hits=[], detection_raises=True)
    headers = await _signup(async_client, "detfail")
    await _seed_habit(db_session, await _user_id(db_session, "detfail"))
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK  # NOT 502 — detection is additive
    body = resp.json()
    assert body["suggestions"] == []
    assert len(body["marginalia"]) == 1  # literary notes intact
    assert body["remaining_messages"] == 49  # charged; no rollback
    marg = (await db_session.execute(select(func.count()).select_from(Marginalia))).scalar_one()
    assert marg == 1  # the resonance pass was not rolled back


@pytest.mark.asyncio
async def test_list_suggestions_scoped_ordered_no_user_id(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two habits → two candidates; two hits whose quotes sit at different offsets.
    _fake(
        monkeypatch,
        hits=[
            {"index": 0, "quote": "willow bent"},  # later in the body
            {"index": 1, "quote": "I meditated"},  # earlier in the body
        ],
    )
    headers = await _signup(async_client)
    uid = await _user_id(db_session)
    await _seed_habit(db_session, uid, "Meditation")
    await _seed_habit(db_session, uid, "Stillness")
    entry_id = await _create_entry(async_client, headers)
    await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    resp = await async_client.get(f"/journal/{entry_id}/suggestions", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    items = resp.json()["items"]
    assert len(items) == 2
    starts = [i["anchor_start"] for i in items]
    assert starts == sorted(starts)  # ordered by anchor position
    assert all("user_id" not in i for i in items)


@pytest.mark.asyncio
async def test_list_suggestions_foreign_entry_is_404(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake(monkeypatch, hits=[{"index": 0, "quote": "I meditated"}])
    alice = await _signup(async_client, "alice")
    await _seed_habit(db_session, await _user_id(db_session, "alice"))
    entry_id = await _create_entry(async_client, alice)
    await async_client.post(f"/journal/{entry_id}/resonance", headers=alice)

    bob = await _signup(async_client, "bob")
    resp = await async_client.get(f"/journal/{entry_id}/suggestions", headers=bob)
    assert resp.status_code == HTTPStatus.NOT_FOUND


async def _seed_mixed_statuses(session: AsyncSession, *, entry_id: int, user_id: int) -> None:
    """Persist one pending, one accepted, and one dismissed suggestion on the entry."""
    goal_id = (await session.execute(select(col(Goal.id)))).scalars().first()
    assert goal_id is not None
    for offset, status in enumerate(SuggestionStatus):  # PENDING, ACCEPTED, DISMISSED
        session.add(
            CompletionSuggestion(
                journal_entry_id=entry_id,
                user_id=user_id,
                target_type="habit",
                goal_id=goal_id,
                label="seeded",
                anchor_start=offset,
                anchor_end=offset + 1,
                anchor_text="x",
                status=status,
            )
        )
    await session.commit()


@pytest.mark.parametrize(
    "wanted",
    [SuggestionStatus.PENDING, SuggestionStatus.ACCEPTED, SuggestionStatus.DISMISSED],
)
@pytest.mark.asyncio
async def test_list_suggestions_status_filter_returns_only_that_status(
    async_client: AsyncClient,
    db_session: AsyncSession,
    wanted: SuggestionStatus,
) -> None:
    headers = await _signup(async_client, "filt")
    uid = await _user_id(db_session, "filt")
    await _seed_habit(db_session, uid)
    entry_id = await _create_entry(async_client, headers)
    await _seed_mixed_statuses(db_session, entry_id=entry_id, user_id=uid)

    resp = await async_client.get(
        f"/journal/{entry_id}/suggestions",
        params={"status": wanted.value},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    items = resp.json()["items"]
    assert len(items) == 1
    assert items[0]["status"] == wanted.value
    assert "user_id" not in items[0]


@pytest.mark.asyncio
async def test_list_suggestions_no_status_returns_all(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await _signup(async_client, "allst")
    uid = await _user_id(db_session, "allst")
    await _seed_habit(db_session, uid)
    entry_id = await _create_entry(async_client, headers)
    await _seed_mixed_statuses(db_session, entry_id=entry_id, user_id=uid)

    resp = await async_client.get(f"/journal/{entry_id}/suggestions", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    items = resp.json()["items"]
    assert len(items) == 3  # every lifecycle state, unchanged behaviour
    assert {i["status"] for i in items} == {s.value for s in SuggestionStatus}
    assert all("user_id" not in i for i in items)


@pytest.mark.asyncio
async def test_list_suggestions_invalid_status_is_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await _signup(async_client, "badst")
    uid = await _user_id(db_session, "badst")
    await _seed_habit(db_session, uid)
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.get(
        f"/journal/{entry_id}/suggestions",
        params={"status": "nonsense"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_list_suggestions_status_filter_foreign_entry_is_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await _signup(async_client, "carol")
    uid = await _user_id(db_session, "carol")
    await _seed_habit(db_session, uid)
    entry_id = await _create_entry(async_client, headers)
    await _seed_mixed_statuses(db_session, entry_id=entry_id, user_id=uid)

    dave = await _signup(async_client, "dave")
    resp = await async_client.get(
        f"/journal/{entry_id}/suggestions",
        params={"status": SuggestionStatus.PENDING.value},
        headers=dave,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_edit_reanchors_pending_and_auto_dismisses_deleted_mention(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake(monkeypatch, hits=[{"index": 0, "quote": "I meditated"}])
    headers = await _signup(async_client, "editor")
    await _seed_habit(db_session, await _user_id(db_session, "editor"))
    entry_id = await _create_entry(async_client, headers)
    await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    # Edit the body so the "I meditated" mention is gone → auto-dismiss the pending suggestion.
    patched = await async_client.patch(
        f"/journal/{entry_id}",
        json={"message": "I rested quietly by the river today."},
        headers=headers,
    )
    assert patched.status_code == HTTPStatus.OK
    row = (await db_session.execute(select(CompletionSuggestion))).scalars().one()
    await db_session.refresh(row)
    assert row.status == SuggestionStatus.DISMISSED


@pytest.mark.asyncio
async def test_edit_keeping_mention_reanchors_without_dismiss(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake(monkeypatch, hits=[{"index": 0, "quote": "I meditated"}])
    headers = await _signup(async_client, "keeper")
    await _seed_habit(db_session, await _user_id(db_session, "keeper"))
    entry_id = await _create_entry(async_client, headers)
    await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    # Prepend text so "I meditated" survives but shifts position → re-anchored, still pending.
    patched = await async_client.patch(
        f"/journal/{entry_id}",
        json={"message": "Today, after a long walk, I meditated by the river."},
        headers=headers,
    )
    assert patched.status_code == HTTPStatus.OK
    row = (await db_session.execute(select(CompletionSuggestion))).scalars().one()
    await db_session.refresh(row)
    assert row.status == SuggestionStatus.PENDING
    assert row.anchor_text == "I meditated"
    assert row.anchor_start > 0  # shifted to the new offset
