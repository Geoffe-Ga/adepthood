"""Completion detection wired into the resonance endpoint + list + re-anchor (#817)."""

from __future__ import annotations

import json
import logging
from datetime import date, timedelta
from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.dates import today_in_tz
from models.completion_suggestion import CompletionSuggestion, SuggestionStatus
from models.goal import Goal
from models.habit import Habit
from models.llm_usage_log import LLMUsageLog
from models.marginalia import Marginalia
from models.practice import Practice
from models.user import User
from models.user_practice import UserPractice
from services import marginalia as marginalia_service
from services.botmason import (
    STUB_MODEL_NAME,
    LLMCreditExhaustedError,
    LLMProviderError,
    LLMResponse,
)

_BODY = "I meditated by the river and the willow bent without breaking."
_NOTE = {"kind": "theme", "quote": "the willow bent without breaking", "note": "It holds."}

# Far enough back that the entry's own "yesterday" cannot be mistaken for the
# clock's, and well inside the backfill window so the clamp is not what is
# being measured.
_BACKDATE_DAYS = 5


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
    detection_error: LLMProviderError | None = None,
    provider: str = "stub",
) -> None:
    """Patch the shared LLM seam: marginalia JSON for the literary prompt, hits for detection."""
    notes_payload = json.dumps({"notes": [_NOTE]})
    hits_payload = json.dumps({"hits": hits})

    def _stub(text: str) -> LLMResponse:
        return LLMResponse(
            text=text,
            provider=provider,
            model=STUB_MODEL_NAME if provider == "stub" else "gpt-4o-mini",
            prompt_tokens=0 if provider == "stub" else 12,
            completion_tokens=0 if provider == "stub" else 4,
        )

    async def _complete(
        prompt: str, history: object, *, system_prompt: str | None, api_key: object
    ) -> LLMResponse:
        del history, api_key
        # Routes by task content across provider roles: the detection task now
        # belongs to the system prompt while the candidate list and entry stay
        # in the user prompt. One fake still serves both passes without
        # inspecting the domain module.
        task = f"{system_prompt or ''}\n{prompt}"
        if '"hits"' in task or "COMPLETED" in task:  # the detection prompt
            if detection_calls is not None:
                detection_calls.append(prompt)
            if detection_error is not None:
                raise detection_error
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
async def test_short_entry_can_check_completions_without_a_resonance_pass(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Habit offers are not gated by whether literary resonance accepts the body."""
    _fake(monkeypatch, hits=[{"index": 0, "quote": "I meditated"}])
    headers = await _signup(async_client, "short-detect")
    await _seed_habit(db_session, await _user_id(db_session, "short-detect"))
    entry_id = await _create_entry(async_client, headers, body="I meditated")

    resp = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["checked"] is True
    assert [item["anchor_text"] for item in body["items"]] == ["I meditated"]
    user = await db_session.get(User, await _user_id(db_session, "short-detect"))
    assert user is not None
    assert user.monthly_messages_used == 0


@pytest.mark.asyncio
async def test_independent_completion_check_does_not_duplicate_an_existing_offer(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    _fake(
        monkeypatch,
        hits=[{"index": 0, "quote": "I meditated"}],
        detection_calls=calls,
        provider="openai",
    )
    headers = await _signup(async_client, "dedupe-detect")
    await _seed_habit(db_session, await _user_id(db_session, "dedupe-detect"))
    entry_id = await _create_entry(async_client, headers, body="I meditated")

    first = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)
    second = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)

    assert len(first.json()["items"]) == 1
    assert second.json()["items"] == []
    persisted = (
        await db_session.execute(select(func.count()).select_from(CompletionSuggestion))
    ).scalar_one()
    usage = (await db_session.execute(select(func.count()).select_from(LLMUsageLog))).scalar_one()
    assert persisted == 1
    assert len(calls) == 1
    assert usage == 1


@pytest.mark.asyncio
async def test_resonance_does_not_duplicate_an_independently_detected_offer(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A later full reflection reuses the offer already made by the fallback check."""
    calls: list[str] = []
    _fake(
        monkeypatch,
        hits=[{"index": 0, "quote": "I meditated"}],
        detection_calls=calls,
        provider="openai",
    )
    headers = await _signup(async_client, "detect-then-resonate")
    await _seed_habit(db_session, await _user_id(db_session, "detect-then-resonate"))
    entry_id = await _create_entry(async_client, headers)

    detected = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)
    reflected = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert len(detected.json()["items"]) == 1
    assert reflected.status_code == HTTPStatus.OK
    assert len(reflected.json()["marginalia"]) == 1
    assert reflected.json()["suggestions"] == []
    assert reflected.json()["remaining_messages"] == 49
    persisted = (
        await db_session.execute(select(func.count()).select_from(CompletionSuggestion))
    ).scalar_one()
    usage = (await db_session.execute(select(func.count()).select_from(LLMUsageLog))).scalar_one()
    assert persisted == 1
    assert len(calls) == 1  # the known offered target is not sent to detection again
    assert usage == 2  # one independent detection plus the later literary reflection


@pytest.mark.asyncio
async def test_independent_completion_check_reports_provider_failure_honestly(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake(monkeypatch, hits=[], detection_error=LLMProviderError("detector down"))
    headers = await _signup(async_client, "independent-fail")
    await _seed_habit(db_session, await _user_id(db_session, "independent-fail"))
    entry_id = await _create_entry(async_client, headers, body="I meditated")

    resp = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"items": [], "checked": False}


@pytest.mark.asyncio
async def test_independent_completion_check_keeps_intimate_entries_off_the_provider(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    _fake(
        monkeypatch,
        hits=[{"index": 0, "quote": "I meditated"}],
        detection_calls=calls,
    )
    headers = await _signup(async_client, "independent-private")
    await _seed_habit(db_session, await _user_id(db_session, "independent-private"))
    created = await async_client.post(
        "/journal/",
        json={"message": "I meditated", "classification": "intimate"},
        headers=headers,
    )

    resp = await async_client.post(
        f"/journal/{created.json()['id']}/suggestions/detect", headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"items": [], "checked": False}
    assert calls == []


@pytest.mark.asyncio
async def test_independent_completion_check_masks_a_foreign_entry(
    async_client: AsyncClient,
) -> None:
    alice = await _signup(async_client, "detect-owner")
    entry_id = await _create_entry(async_client, alice, body="I meditated")
    bob = await _signup(async_client, "detect-stranger")

    resp = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=bob)

    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_independent_completion_check_with_no_candidates_needs_no_provider(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    _fake(monkeypatch, hits=[], detection_calls=calls)
    headers = await _signup(async_client, "independent-nohab")
    entry_id = await _create_entry(async_client, headers, body="I walked")

    resp = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"items": [], "checked": True}
    assert calls == []


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


def _detection_warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return the records the detection-failure handler emitted, newest last."""
    return [
        record for record in caplog.records if record.getMessage() == "journal_detection_failed"
    ]


@pytest.mark.asyncio
async def test_detection_failure_is_best_effort(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _fake(monkeypatch, hits=[], detection_error=LLMProviderError("detector down"))
    headers = await _signup(async_client, "detfail")
    await _seed_habit(db_session, await _user_id(db_session, "detfail"))
    entry_id = await _create_entry(async_client, headers)

    with caplog.at_level(logging.WARNING, logger="routers.journal"):
        resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK  # NOT 502 — detection is additive
    body = resp.json()
    assert body["suggestions"] == []
    assert len(body["marginalia"]) == 1  # literary notes intact
    assert body["remaining_messages"] == 49  # charged; no rollback
    marg = (await db_session.execute(select(func.count()).select_from(Marginalia))).scalar_one()
    assert marg == 1  # the resonance pass was not rolled back
    records = _detection_warnings(caplog)
    assert len(records) == 1
    # A transient failure names no account: the ABSENCE of ``provider`` is what
    # separates a dropped socket from a balance that will never refill on its own.
    assert getattr(records[0], "provider", None) is None


@pytest.mark.asyncio
async def test_detection_credit_exhaustion_names_the_provider(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A billing refusal stays additive but records the account an operator can settle."""
    _fake(
        monkeypatch,
        hits=[],
        detection_error=LLMCreditExhaustedError("no credit", provider="anthropic"),
    )
    headers = await _signup(async_client, "detcredit")
    await _seed_habit(db_session, await _user_id(db_session, "detcredit"))
    entry_id = await _create_entry(async_client, headers)

    with caplog.at_level(logging.WARNING, logger="routers.journal"):
        resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK  # NOT 402/503 — detection is additive
    body = resp.json()
    assert body["suggestions"] == []
    assert len(body["marginalia"]) == 1  # literary notes intact
    assert body["remaining_messages"] == 49  # charged; no rollback
    marg = (await db_session.execute(select(func.count()).select_from(Marginalia))).scalar_one()
    assert marg == 1  # the resonance pass was not rolled back
    records = _detection_warnings(caplog)
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    assert getattr(records[0], "provider", None) == "anthropic"
    assert _BODY not in "".join(str(record.__dict__) for record in caplog.records)


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


async def _seed_habit_with_unit(
    session: AsyncSession, user_id: int, *, name: str, target_unit: str
) -> None:
    """Seed a habit whose clear-tier goal is denominated in ``target_unit``.

    Deliberately NOT ``_seed_habit``, which uses ``target_unit="x"``: a test
    built on a unit no writer types can pass while production stores nothing.
    """
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
            target=3.0,
            target_unit=target_unit,
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=True,
        )
    )
    await session.commit()


async def _stored_facts(session: AsyncSession) -> list[tuple[float | None, date | None]]:
    """Every persisted suggestion's ``(completed_units, completed_on)`` pair."""
    session.expire_all()
    rows = (
        (await session.execute(select(CompletionSuggestion).order_by(col(CompletionSuggestion.id))))
        .scalars()
        .all()
    )
    return [(row.completed_units, row.completed_on) for row in rows]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("target_unit", "written_unit"),
    [("units", "times"), ("oz", "ounces")],
)
async def test_detected_facts_reach_the_row_and_the_response(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    target_unit: str,
    written_unit: str,
) -> None:
    """Non-vacuity: the facts survive to storage AND to the wire.

    The ``units``/``times`` case is the one that matters most: ``POST /habits/``
    seeds ``target_unit="units"`` on every default goal and no writer types
    "3 units of water", so without a canonical count group the whole feature is
    dormant for every habit in the default configuration.
    """
    _fake(
        monkeypatch,
        hits=[
            {
                "index": 0,
                "quote": "I meditated",
                "amount": 3,
                "unit": written_unit,
                "when": "yesterday",
            }
        ],
    )
    user = f"facts-{target_unit}"
    headers = await _signup(async_client, user)
    await _seed_habit_with_unit(
        db_session, await _user_id(db_session, user), name="Meditation", target_unit=target_unit
    )
    entry_id = await _create_entry(async_client, headers, body="I meditated by the river.")
    yesterday = today_in_tz("UTC") - timedelta(days=1)

    resp = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    item = resp.json()["items"][0]
    assert item["completed_units"] == 3.0
    assert item["completed_on"] == yesterday.isoformat()
    assert await _stored_facts(db_session) == [(3.0, yesterday)]


@pytest.mark.asyncio
async def test_both_detection_paths_yield_the_same_facts(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The standalone check and the combined resonance pass must not disagree.

    The clock is plumbed through two separate call chains; if only one carries
    it, the same entry yields facts or no facts depending on which button the
    writer pressed.
    """
    hit = {
        "index": 0,
        "quote": "I meditated",
        "amount": 3,
        "unit": "times",
        "when": "yesterday",
    }
    yesterday = today_in_tz("UTC") - timedelta(days=1)

    _fake(monkeypatch, hits=[hit])
    standalone = await _signup(async_client, "paths-detect")
    await _seed_habit_with_unit(
        db_session,
        await _user_id(db_session, "paths-detect"),
        name="Meditation",
        target_unit="units",
    )
    entry_a = await _create_entry(async_client, standalone, body="I meditated by the river.")
    detect_resp = await async_client.post(
        f"/journal/{entry_a}/suggestions/detect", headers=standalone
    )
    assert detect_resp.status_code == HTTPStatus.OK
    via_detect = detect_resp.json()["items"][0]

    combined = await _signup(async_client, "paths-resonance")
    await _seed_habit_with_unit(
        db_session,
        await _user_id(db_session, "paths-resonance"),
        name="Meditation",
        target_unit="units",
    )
    entry_b = await _create_entry(async_client, combined, body="I meditated by the river.")
    resonance_resp = await async_client.post(f"/journal/{entry_b}/resonance", headers=combined)
    assert resonance_resp.status_code == HTTPStatus.OK
    via_resonance = resonance_resp.json()["suggestions"][0]

    assert (via_detect["completed_units"], via_detect["completed_on"]) == (
        3.0,
        yesterday.isoformat(),
    )
    assert (via_resonance["completed_units"], via_resonance["completed_on"]) == (
        via_detect["completed_units"],
        via_detect["completed_on"],
    )


@pytest.mark.asyncio
async def test_a_default_seeded_habit_is_still_found_over_the_real_stub_provider(
    async_client: AsyncClient,
) -> None:
    """The whole offer path over the DEFAULT provider, with no LLM fake at all.

    This is the seam ``journal-short-habit-offer.browser.e2e.test.ts`` exists
    to defend, asked here at the HTTP boundary: a habit created through
    ``POST /habits/`` (so ``target_unit="units"``, like every default goal),
    an entry that attests to it, and the stub provider the e2e lane actually
    runs against. Break the renderer/parser agreement and this answers with an
    empty list -- the exact shape of a green backend suite beside a dead
    browser journey.
    """
    headers = await _signup(async_client, "stubwire")
    created = await async_client.post(
        "/habits/",
        json={
            "name": "Morning walk",
            "icon": "🚶",
            "start_date": "2025-01-01",
            "energy_cost": 1,
            "energy_return": 2,
        },
        headers=headers,
    )
    assert created.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}
    entry_id = await _create_entry(
        async_client, headers, body="I completed Morning walk before breakfast."
    )

    resp = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["checked"] is True
    assert [item["anchor_text"] for item in body["items"]] == ["completed Morning walk"]


@pytest.mark.asyncio
async def test_a_backdated_entrys_yesterday_is_the_day_before_that_entry(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The clock's ``entry_day`` must come from the ENTRY, not from now.

    This is the whole point of the day feature: a writer catching up on a week
    means the day their entry describes, not the day they typed it. The two
    coincide for every same-day entry, so only a backdated one can tell the
    wiring in ``_detection_inputs`` from a hard-coded ``today``.
    """
    _fake(
        monkeypatch,
        hits=[
            {
                "index": 0,
                "quote": "I meditated",
                "amount": 3,
                "unit": "times",
                "when": "yesterday",
            }
        ],
    )
    headers = await _signup(async_client, "backdated")
    await _seed_habit_with_unit(
        db_session, await _user_id(db_session, "backdated"), name="Meditation", target_unit="units"
    )
    entry_day = today_in_tz("UTC") - timedelta(days=_BACKDATE_DAYS)
    created = await async_client.post(
        "/journal/",
        json={"message": "I meditated by the river.", "entry_date": entry_day.isoformat()},
        headers=headers,
    )
    assert created.status_code == HTTPStatus.CREATED
    entry_id = int(created.json()["id"])

    resp = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    completed_on = resp.json()["items"][0]["completed_on"]
    assert completed_on == (entry_day - timedelta(days=1)).isoformat()
    # Stated as its own assertion so the failure names the confusion directly.
    assert completed_on != (today_in_tz("UTC") - timedelta(days=1)).isoformat()
    assert await _stored_facts(db_session) == [(3.0, entry_day - timedelta(days=1))]


@pytest.mark.asyncio
async def test_a_practice_hit_never_carries_a_day_and_never_500s(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A practice hit stating a day is stored without one, not rejected by the DB.

    ``normalise_unit`` refuses every practice amount because a practice tracks
    no unit -- but the DAY is resolved without consulting the unit at all, so
    detection really does hand a practice hit a ``completed_on``. The
    ``is_habit`` guard in ``_suggestion_from_hit`` is the only thing between
    that value and ``ck_completion_suggestion_facts_habit_only``, which would
    raise inside the settle commit and turn a best-effort extra into a 500 on
    the writer's reflection.
    """
    _fake(
        monkeypatch,
        hits=[
            {
                "index": 0,
                "quote": "I meditated",
                "amount": 20,
                "unit": "minutes",
                "when": "yesterday",
            }
        ],
    )
    headers = await _signup(async_client, "practicefacts")
    user_id = await _user_id(db_session, "practicefacts")
    practice = Practice(
        stage_number=1,
        name="Meditation",
        description="A sit.",
        instructions="Sit and breathe.",
        default_duration_minutes=10.0,
        mode="meditation_timer",
        mode_config={"mode": "meditation_timer", "duration_minutes": 10},
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    db_session.add(
        UserPractice(
            user_id=user_id,
            practice_id=practice.id,
            stage_number=1,
            start_date=date(2025, 1, 1),
        )
    )
    await db_session.commit()
    entry_id = await _create_entry(async_client, headers, body="I meditated by the river.")

    resp = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)

    assert resp.status_code == HTTPStatus.OK  # never 500
    item = resp.json()["items"][0]
    assert item["target_type"] == "practice"
    assert item["completed_units"] is None
    assert item["completed_on"] is None
    assert await _stored_facts(db_session) == [(None, None)]
