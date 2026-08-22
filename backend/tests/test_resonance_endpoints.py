"""Tests for the resonance + marginalia HTTP endpoints (journal-resonance-05)."""

from __future__ import annotations

import json
import logging
from http import HTTPStatus
from types import MappingProxyType

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.frequencies import Frequency
from models.corpus_fragment import CorpusSource
from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import Marginalia
from models.user import User
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMProviderError, LLMResponse
from services.corpus_store import FragmentDraft, record_fragment
from services.frequency_classification import ClassificationSource, FrequencyClassification
from services.higher_self_grounding import GroundingSource

_BODY = "I walked by the river and the willow bent without breaking."


async def _signup(client: AsyncClient, username: str = "reson") -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _create_entry(client: AsyncClient, headers: dict[str, str], body: str = _BODY) -> int:
    resp = await client.post("/journal/", json={"message": body}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


def _fake_llm(monkeypatch: pytest.MonkeyPatch, *notes: dict[str, str]) -> None:
    """Patch the resonance LLM seam to return canned JSON notes."""
    payload = json.dumps({"notes": list(notes)})

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return LLMResponse(
            text=payload,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)


def _raise_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> None:
        del prompt, history, system_prompt, api_key
        raise LLMProviderError("provider down")

    monkeypatch.setattr(marginalia_service, "generate_response", _boom)


@pytest.mark.asyncio
async def test_persisted_marginalia_user_id_matches_entry_owner(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Owner invariant: a note's user_id is derived from the entry owner server-side.

    The client never supplies it, so every persisted marginalia.user_id equals the
    entry's user_id.
    """
    _fake_llm(
        monkeypatch,
        {"kind": "theme", "quote": "I walked by the river", "note": "You return to water."},
    )
    headers = await _signup(async_client, "owner")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK

    entry = (
        await db_session.execute(select(JournalEntry).where(col(JournalEntry.id) == entry_id))
    ).scalar_one()
    rows = (
        (
            await db_session.execute(
                select(Marginalia).where(col(Marginalia.journal_entry_id) == entry_id)
            )
        )
        .scalars()
        .all()
    )
    assert rows
    assert all(note.user_id == entry.user_id for note in rows)


@pytest.mark.asyncio
async def test_resonance_persists_notes_and_charges_one(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A successful pass persists the anchored notes and charges one message."""
    _fake_llm(
        monkeypatch,
        {"kind": "symbol", "quote": "the willow bent without breaking", "note": "It holds."},
        {"kind": "theme", "quote": "I walked by the river", "note": "You return to water."},
    )
    headers = await _signup(async_client)
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert len(body["marginalia"]) == 2
    assert body["remaining_messages"] == 49  # DEFAULT_MONTHLY_CAP (50) - 1
    persisted = (
        await db_session.execute(select(func.count()).select_from(Marginalia))
    ).scalar_one()
    assert persisted == 2


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_resonance_insufficient_wallet_is_402_no_rows(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no wallet capacity the pass is 402 and persists nothing / no LLM call."""
    _fake_llm(monkeypatch, {"kind": "theme", "quote": _BODY, "note": "n"})
    headers = await _signup(async_client, "broke")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert resp.json()["detail"] == "insufficient_offerings"
    rows = (await db_session.execute(select(func.count()).select_from(Marginalia))).scalar_one()
    assert rows == 0


@pytest.mark.asyncio
async def test_resonance_other_users_entry_is_404(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Resonance on another user's entry is 404, not 403."""
    _fake_llm(monkeypatch, {"kind": "theme", "quote": _BODY, "note": "n"})
    alice = await _signup(async_client, "alice_r")
    bob = await _signup(async_client, "bob_r")
    entry_id = await _create_entry(async_client, alice)
    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=bob)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_resonance_llm_error_is_502_without_charge(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider error rolls back the deduction — 502 and nothing persisted/charged."""
    _raise_llm(monkeypatch)
    headers = await _signup(async_client, "err")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.BAD_GATEWAY
    rows = (await db_session.execute(select(func.count()).select_from(Marginalia))).scalar_one()
    assert rows == 0
    # The deduction was rolled back: the user's monthly usage is still zero.
    user = (
        await db_session.execute(select(User).where(col(User.email) == "err@example.com"))
    ).scalar_one()
    assert user.monthly_messages_used == 0


@pytest.mark.asyncio
async def test_list_marginalia_is_ordered_and_hides_user_id(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The marginalia list is ordered by anchor_start and omits user_id."""
    _fake_llm(
        monkeypatch,
        {"kind": "symbol", "quote": "the willow bent without breaking", "note": "later span"},
        {"kind": "theme", "quote": "I walked by the river", "note": "earlier span"},
    )
    headers = await _signup(async_client, "lister")
    entry_id = await _create_entry(async_client, headers)
    await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    resp = await async_client.get(f"/journal/{entry_id}/marginalia", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    items = resp.json()["items"]
    assert [i["note"] for i in items] == ["earlier span", "later span"]
    starts = [i["anchor_start"] for i in items]
    assert starts == sorted(starts)
    assert all("user_id" not in i for i in items)


# An entry body the acute-distress screen flags (see domain.safety) — used to
# exercise the care surface without depending on resonance LLM output.
_DISTRESS_BODY = "I keep thinking I want to kill myself and end my life tonight."


def _assert_care_routes_to_human_and_professional(care: dict[str, object]) -> None:
    """Assert the care payload carries the human + professional pointers + a warm note."""
    assert isinstance(care["message"], str)
    lowered = care["message"].lower()
    # Warm and non-shaming: names that distress is not a failure.
    assert "failure" in lowered
    blob = json.dumps(care).lower()
    assert "988" in blob  # immediate crisis line (human counselor)
    assert "741741" in blob  # crisis text line
    assert "trust" in blob  # someone you trust (human)
    assert "professional" in blob  # professional support
    resources = care["resources"]
    assert isinstance(resources, list)
    kinds = {r["kind"] for r in resources if isinstance(r, dict)}
    assert {"hotline", "text_line", "human", "professional"} <= kinds


@pytest.mark.asyncio
async def test_normal_entry_returns_no_care(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-distress entry is unchanged: care is None, marginalia intact."""
    _fake_llm(
        monkeypatch,
        {"kind": "theme", "quote": "I walked by the river", "note": "You return to water."},
    )
    headers = await _signup(async_client, "calm")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["care"] is None
    assert len(body["marginalia"]) == 1
    assert body["remaining_messages"] == 49


@pytest.mark.asyncio
async def test_denial_entry_returns_no_care(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An explicit denial of distress is unchanged: care is None, marginalia intact."""
    _fake_llm(
        monkeypatch,
        {"kind": "theme", "quote": "I would never kill myself", "note": "You are resolute."},
    )
    headers = await _signup(async_client, "denial")
    entry_id = await _create_entry(async_client, headers, body="I would never kill myself")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["care"] is None
    assert len(body["marginalia"]) == 1


@pytest.mark.asyncio
async def test_distress_entry_returns_care_alongside_reflection(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A flagged entry returns the care surface AND the reflection (never only AI)."""
    _fake_llm(
        monkeypatch,
        {"kind": "theme", "quote": "kill myself", "note": "You are not alone in this."},
    )
    headers = await _signup(async_client, "flagged")
    entry_id = await _create_entry(async_client, headers, body=_DISTRESS_BODY)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["care"] is not None
    _assert_care_routes_to_human_and_professional(body["care"])
    # Care accompanies the reflection — it is additive, not a replacement.
    assert len(body["marginalia"]) == 1


@pytest.mark.asyncio
async def test_distress_entry_returns_care_even_when_llm_fails(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Care must not depend on the LLM: a flagged entry surfaces care on an LLM error.

    The reflection is absent (marginalia empty) and the charge is rolled back, but
    the human + professional pointers are returned regardless (NORTH-STAR §10).
    """
    _raise_llm(monkeypatch)
    headers = await _signup(async_client, "flagged_err")
    entry_id = await _create_entry(async_client, headers, body=_DISTRESS_BODY)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["care"] is not None
    _assert_care_routes_to_human_and_professional(body["care"])
    assert body["marginalia"] == []
    # No reflection persisted, and the charge was rolled back.
    rows = (await db_session.execute(select(func.count()).select_from(Marginalia))).scalar_one()
    assert rows == 0
    user = (
        await db_session.execute(select(User).where(col(User.email) == "flagged_err@example.com"))
    ).scalar_one()
    assert user.monthly_messages_used == 0


@pytest.mark.asyncio
async def test_normal_entry_llm_error_is_502_no_care(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-flagged entry keeps today's behavior on an LLM error: 502, no care."""
    _raise_llm(monkeypatch)
    headers = await _signup(async_client, "calm_err")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.BAD_GATEWAY


@pytest.mark.asyncio
async def test_list_marginalia_other_users_entry_is_404(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Listing marginalia on another user's entry is 404 (ownership-scoped)."""
    _fake_llm(monkeypatch, {"kind": "theme", "quote": "I walked by the river", "note": "n"})
    alice = await _signup(async_client, "alice_l")
    bob = await _signup(async_client, "bob_l")
    entry_id = await _create_entry(async_client, alice)
    await async_client.post(f"/journal/{entry_id}/resonance", headers=alice)
    resp = await async_client.get(f"/journal/{entry_id}/marginalia", headers=bob)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ---------------------------------------------------------------------------
# What the reflection is grounded in, end to end through the endpoint
# ---------------------------------------------------------------------------

_CORPUS_SENTINEL = "the corpus remembers the willow"
_OLDER_ENTRY_SENTINEL = "an older entry about the far bank"


def _capturing_llm(monkeypatch: pytest.MonkeyPatch, prompts: list[str]) -> None:
    """Patch the resonance LLM seam to record every prompt it is handed."""
    payload = json.dumps(
        {"notes": [{"kind": "theme", "quote": "I walked by the river", "note": "You return."}]}
    )

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del history, system_prompt, api_key
        prompts.append(prompt)
        return LLMResponse(
            text=payload,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)


async def _user_id(session: AsyncSession, email: str) -> int:
    """The id of the account that signed up with ``email``."""
    user = (await session.execute(select(User).where(col(User.email) == email))).scalar_one()
    assert user.id is not None
    return user.id


async def _seed_fragment(session: AsyncSession, user_id: int, content: str) -> int:
    """Put one personal-tier fragment into ``user_id``'s corpus."""
    fragment = await record_fragment(
        session,
        user_id=user_id,
        draft=FragmentDraft(
            content=content,
            tier=JournalClassification.PERSONAL,
            source=CorpusSource.JOURNAL,
            classification=FrequencyClassification(
                weights=MappingProxyType({Frequency.F1: 0.9}),
                overall_confidence=0.9,
                source=ClassificationSource.OPERATOR,
            ),
        ),
    )
    await session.commit()
    assert fragment.id is not None
    return fragment.id


@pytest.mark.asyncio
async def test_the_prompt_is_grounded_in_the_corpus_when_the_account_has_one(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The endpoint sends corpus passages, and stops sending the recency window.

    Both halves matter and only together: asserting the fragment arrived would
    pass just as well if the older entry rode along beside it, which is the
    shape that would send strictly more of somebody's writing to the provider
    than the privacy policy says it does.
    """
    prompts: list[str] = []
    _capturing_llm(monkeypatch, prompts)
    headers = await _signup(async_client, "grounded")
    await _create_entry(async_client, headers, body=_OLDER_ENTRY_SENTINEL)
    entry_id = await _create_entry(async_client, headers)
    await _seed_fragment(
        db_session, await _user_id(db_session, "grounded@example.com"), _CORPUS_SENTINEL
    )

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    sent = "\n".join(prompts)
    assert _CORPUS_SENTINEL in sent
    assert _OLDER_ENTRY_SENTINEL not in sent


@pytest.mark.asyncio
async def test_an_account_with_no_corpus_still_gets_the_recency_window(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A new account is not silently given a Higher Self that has read nothing."""
    prompts: list[str] = []
    _capturing_llm(monkeypatch, prompts)
    headers = await _signup(async_client, "ungrounded")
    await _create_entry(async_client, headers, body=_OLDER_ENTRY_SENTINEL)
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert _OLDER_ENTRY_SENTINEL in "\n".join(prompts)


@pytest.mark.asyncio
async def test_the_grounding_is_recorded_by_id_and_never_by_content(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An operator can say what grounded a reflection without reading a word of it.

    The record is the only place grounding is visible at all, so it has to name
    the fragments; it is also a log file, outside every tier rule and the
    at-rest encryption, so it must not carry their text.
    """
    prompts: list[str] = []
    _capturing_llm(monkeypatch, prompts)
    headers = await _signup(async_client, "recorded")
    entry_id = await _create_entry(async_client, headers)
    fragment_id = await _seed_fragment(
        db_session, await _user_id(db_session, "recorded@example.com"), _CORPUS_SENTINEL
    )

    with caplog.at_level(logging.INFO):
        resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    grounded = [
        record for record in caplog.records if record.message == "journal_resonance_grounded"
    ]
    assert len(grounded) == 1
    fields = grounded[0].__dict__
    assert fields["grounding_source"] == GroundingSource.CORPUS.value
    assert fields["fragment_ids"] == [fragment_id]
    assert _CORPUS_SENTINEL not in str(fields)
