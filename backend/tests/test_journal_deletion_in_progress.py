"""A page with an open ``pending_delete`` obligation is a deletion in progress (#3098 review).

Once a DELETE has answered 503 and recorded its durable obligation, the
background sweep will finish that deletion without the writer asking again. So
the page must not keep changing underneath it: every edit, and every pass that
derives new content from it, is refused with a stable 409. And because a write
could still have slipped in (or a fragment been left behind) before the sweep
runs, the sweep repeats the local half of the deletion -- the corpus withdrawal
and the essay retraction marking -- and stamps ``deleted_at`` only once every
essay withdrawal, including any it just marked, is confirmed.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CreekVaultUnavailableError,
    VaultTierCeiling,
    VaultVoiceDraftDeleteResult,
)
from main import app
from models.completion_suggestion import CompletionSuggestion
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.journal_entry import JournalClassification
from models.journal_withdrawal_obligation import JournalWithdrawalState
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from services import marginalia as marginalia_service
from tests.test_account_egress_barrier_llm import _seed_detection_candidate
from tests.test_journal_delete_completion import (
    _entry,
    _factory,
    _failed_delete,
    _mirrored_entry,
    _obligation,
    _sweep,
)
from tests.test_voice_draft_retraction_recovery import _DraftVault as DraftVault

_T0 = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)
_PAST_BACKOFF = timedelta(hours=2)
_DELETION_PENDING = {"detail": "journal_entry_deletion_pending"}
_ESSAY = "SENTINEL_IN_PROGRESS_ESSAY a letter"


class _EssayRefusingVault(DraftVault):
    """Confirms the journal copy withdrawn but refuses every essay DELETE."""

    async def delete_voice_draft(
        self, external_id: str, _tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        self.deletes.append(external_id)
        raise CreekVaultUnavailableError("synthetic essay outage")


async def _fragments(session: AsyncSession, entry_id: int) -> list[CorpusFragment]:
    result = await session.execute(
        select(CorpusFragment).where(col(CorpusFragment.source_entry_id) == entry_id)
    )
    rows = list(result.scalars().all())
    await session.commit()
    return rows


async def _seed_fragment(session: AsyncSession, user_id: int, entry_id: int) -> None:
    session.add(
        CorpusFragment(
            user_id=user_id,
            source_entry_id=entry_id,
            source=CorpusSource.JOURNAL,
            tier=JournalClassification.PERSONAL,
            content="SENTINEL_IN_PROGRESS_FRAGMENT",
            frequency_weights={},
            overall_confidence=0.0,
        )
    )
    await session.commit()


async def _seed_essay(
    session: AsyncSession,
    user_id: int,
    entry_id: int,
    *,
    state: VoiceDraftRetractionState,
    destination: str,
) -> int:
    """An expanded note on the page and its mirror obligation in ``state``; returns the note id."""
    note = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=8,
        anchor_text="SENTINEL",
        note="A note.",
        essay=_ESSAY,
        essay_generated_at=_T0,
    )
    session.add(note)
    await session.flush()
    assert note.id is not None
    session.add(
        VoiceDraftRetraction(
            user_id=user_id,
            journal_entry_id=entry_id,
            marginalia_id=note.id,
            state=state.value,
            destination=destination,
        )
    )
    await session.commit()
    return note.id


async def _essay_row(session: AsyncSession, note_id: int) -> VoiceDraftRetraction:
    result = await session.execute(
        select(VoiceDraftRetraction)
        .where(col(VoiceDraftRetraction.marginalia_id) == note_id)
        .execution_options(populate_existing=True)
    )
    row = result.scalar_one()
    await session.commit()
    return row


# --- Edits are refused while a deletion is in progress ------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "patch",
    [
        {"message": "SENTINEL edited after the 503"},
        {"title": "A new title"},
        {"classification": "public"},
    ],
)
async def test_a_page_awaiting_deletion_refuses_every_edit(
    async_client: AsyncClient, db_session: AsyncSession, patch: dict[str, str]
) -> None:
    """A PATCH of any field answers 409 and changes nothing; nothing is re-ingested."""
    headers, _user_id, entry_id, _destination = await _mirrored_entry(
        async_client,
        db_session,
        f"in_progress_patch_{next(iter(patch))}",
        JournalClassification.PERSONAL,
    )
    await _failed_delete(async_client, headers, entry_id)
    before = await _entry(db_session, entry_id)

    response = await async_client.patch(f"/journal/{entry_id}", json=patch, headers=headers)

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json() == _DELETION_PENDING
    after = await _entry(db_session, entry_id)
    assert (after.message, after.title, after.classification) == (
        before.message,
        before.title,
        before.classification,
    )
    assert await _fragments(db_session, entry_id) == []


@pytest.mark.asyncio
async def test_a_page_awaiting_deletion_refuses_a_new_reflection(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No new derived content (marginalia, essays) is generated from a page being deleted."""
    headers, _user_id, entry_id, _destination = await _mirrored_entry(
        async_client, db_session, "in_progress_resonance", JournalClassification.PERSONAL
    )
    await _failed_delete(async_client, headers, entry_id)

    response = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json() == _DELETION_PENDING


class _ProviderSpy:
    """A ``generate_response`` stand-in that records every dial; none may happen here."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(self, user_message: str, *_args: object, **_kwargs: object) -> object:
        self.calls.append(user_message)
        raise AssertionError("a provider was dialled for a page being deleted")


def _spy_on_the_provider(monkeypatch: pytest.MonkeyPatch) -> _ProviderSpy:
    spy = _ProviderSpy()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)
    return spy


async def _wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    user = (
        await session.execute(
            select(User).where(col(User.id) == user_id).execution_options(populate_existing=True)
        )
    ).scalar_one()
    await session.commit()
    return user.monthly_messages_used, user.offering_balance


async def _seed_unexpanded_note(session: AsyncSession, user_id: int, entry_id: int) -> int:
    note = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.THEME,
        anchor_start=0,
        anchor_end=8,
        anchor_text="SENTINEL",
        note="It holds.",
    )
    session.add(note)
    await session.commit()
    assert note.id is not None
    return note.id


@pytest.mark.asyncio
async def test_a_page_awaiting_deletion_refuses_suggestion_detection(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Detection would send the body to a provider: 409, no dial, no suggestion row."""
    headers, user_id, entry_id, _destination = await _mirrored_entry(
        async_client, db_session, "in_progress_detect", JournalClassification.PERSONAL
    )
    await _seed_detection_candidate(_factory(db_session), user_id)
    await _failed_delete(async_client, headers, entry_id)
    spy = _spy_on_the_provider(monkeypatch)
    before = await _wallet(db_session, user_id)

    response = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json() == _DELETION_PENDING
    assert spy.calls == []
    assert await _wallet(db_session, user_id) == before
    suggestions = (
        await db_session.execute(
            select(CompletionSuggestion).where(
                col(CompletionSuggestion.journal_entry_id) == entry_id
            )
        )
    ).all()
    await db_session.commit()
    assert suggestions == []


@pytest.mark.asyncio
@pytest.mark.parametrize("ask", [{"price_acknowledged": True}, {}])
async def test_a_page_awaiting_deletion_refuses_essay_generation(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    ask: dict[str, bool],
) -> None:
    """409 before the price gate: unacknowledged or not, nothing is charged, dialled or mirrored."""
    headers, user_id, entry_id, _destination = await _mirrored_entry(
        async_client, db_session, f"in_progress_essay_{len(ask)}", JournalClassification.PERSONAL
    )
    note_id = await _seed_unexpanded_note(db_session, user_id, entry_id)
    await _failed_delete(async_client, headers, entry_id)
    spy = _spy_on_the_provider(monkeypatch)
    before = await _wallet(db_session, user_id)

    response = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", json=ask, headers=headers
    )

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json() == _DELETION_PENDING
    assert spy.calls == []
    assert await _wallet(db_session, user_id) == before
    note = (
        await db_session.execute(
            select(Marginalia)
            .where(col(Marginalia.id) == note_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    await db_session.commit()
    assert note.essay is None
    intents = (
        await db_session.execute(
            select(VoiceDraftRetraction).where(col(VoiceDraftRetraction.marginalia_id) == note_id)
        )
    ).all()
    await db_session.commit()
    assert intents == []


@pytest.mark.asyncio
async def test_essay_refusal_comes_before_the_intimate_early_return(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An Intimate page being deleted answers 409, not the private floor's quiet 200."""
    headers, user_id, entry_id, _destination = await _mirrored_entry(
        async_client, db_session, "in_progress_essay_intimate", JournalClassification.INTIMATE
    )
    note_id = await _seed_unexpanded_note(db_session, user_id, entry_id)
    await _failed_delete(async_client, headers, entry_id)
    spy = _spy_on_the_provider(monkeypatch)

    response = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", json={"price_acknowledged": True}, headers=headers
    )

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json() == _DELETION_PENDING
    assert spy.calls == []


@pytest.mark.asyncio
async def test_a_page_awaiting_deletion_refuses_a_new_promoted_quote(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Promoting a quote is a new derived copy of the page's words; it is refused too."""
    headers, _user_id, entry_id, _destination = await _mirrored_entry(
        async_client, db_session, "in_progress_promote", JournalClassification.PERSONAL
    )
    await _failed_delete(async_client, headers, entry_id)

    response = await async_client.post(
        f"/journal/{entry_id}/promote",
        json={"anchor_start": 0, "anchor_end": 8},
        headers=headers,
    )

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json() == _DELETION_PENDING


@pytest.mark.asyncio
async def test_a_live_page_without_an_obligation_still_edits(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The control: the refusal is about the obligation, not about the vault marker."""
    headers, _user_id, entry_id, _destination = await _mirrored_entry(
        async_client, db_session, "in_progress_control", JournalClassification.PERSONAL
    )
    app.dependency_overrides[get_creek_vault_client] = DraftVault

    response = await async_client.patch(
        f"/journal/{entry_id}", json={"title": "Still mine"}, headers=headers
    )

    assert response.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_retrying_the_delete_is_still_allowed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The deletion in progress can always be retried; a confirmed retry finishes it."""
    headers, _user_id, entry_id, _destination = await _mirrored_entry(
        async_client, db_session, "in_progress_retry", JournalClassification.PERSONAL
    )
    await _failed_delete(async_client, headers, entry_id)
    app.dependency_overrides[get_creek_vault_client] = DraftVault

    retried = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert retried.status_code == HTTPStatus.NO_CONTENT


# --- The sweep repeats the local half before it stamps ------------------------


@pytest.mark.asyncio
async def test_delete_503_then_refused_patch_then_sweep_leaves_no_corpus_copy(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The reviewer's sequence: DELETE 503, PATCH (refused), sweep -- nothing left behind."""
    headers, _user_id, entry_id, destination = await _mirrored_entry(
        async_client, db_session, "in_progress_sequence", JournalClassification.PERSONAL
    )
    await _failed_delete(async_client, headers, entry_id)
    refused = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "SENTINEL edited after the 503"}, headers=headers
    )
    assert refused.status_code == HTTPStatus.CONFLICT

    await _sweep(db_session, DraftVault(), _T0, destination=destination)

    assert (await _entry(db_session, entry_id)).deleted_at is not None
    assert await _fragments(db_session, entry_id) == []


@pytest.mark.asyncio
async def test_sweep_removes_a_corpus_copy_that_reappeared_after_the_503(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Defense in depth: a fragment written after the DELETE is withdrawn before the stamp."""
    headers, user_id, entry_id, destination = await _mirrored_entry(
        async_client, db_session, "in_progress_fragment", JournalClassification.PERSONAL
    )
    await _failed_delete(async_client, headers, entry_id)
    await _seed_fragment(db_session, user_id, entry_id)
    assert len(await _fragments(db_session, entry_id)) == 1

    await _sweep(db_session, DraftVault(), _T0, destination=destination)

    assert (await _entry(db_session, entry_id)).deleted_at is not None
    assert await _fragments(db_session, entry_id) == []


@pytest.mark.asyncio
async def test_sweep_marks_an_essay_mirrored_after_the_503_and_waits_for_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An essay offered after the DELETE is marked owed, and the stamp waits for its withdrawal."""
    headers, user_id, entry_id, destination = await _mirrored_entry(
        async_client, db_session, "in_progress_late_essay", JournalClassification.PERSONAL
    )
    await _failed_delete(async_client, headers, entry_id)
    note_id = await _seed_essay(
        db_session,
        user_id,
        entry_id,
        state=VoiceDraftRetractionState.MIRROR_INTENT,
        destination=destination,
    )

    await _sweep(db_session, _EssayRefusingVault(), _T0, destination=destination)

    assert (await _essay_row(db_session, note_id)).state == VoiceDraftRetractionState.PENDING
    assert (await _entry(db_session, entry_id)).deleted_at is None
    owed = await _obligation(db_session, entry_id)
    assert owed is not None
    assert owed.state == JournalWithdrawalState.PENDING_DELETE

    healthy = DraftVault()
    await _sweep(db_session, healthy, _T0 + _PAST_BACKOFF, destination=destination)

    assert healthy.deletes, "the late essay's withdrawal was sent"
    assert (await _essay_row(db_session, note_id)).state == VoiceDraftRetractionState.CONFIRMED
    assert (await _entry(db_session, entry_id)).deleted_at is not None


# --- Settle CONFIRMED only after every essay withdrawal is confirmed ----------


@pytest.mark.asyncio
async def test_sweep_never_settles_while_an_essay_withdrawal_is_still_owed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Journal copy confirmed but an essay refused: no stamp, obligation stays pending_delete.

    Pins that the stamp requires the essays' answer, not only the journal
    copy's: dropping the essay condition from ``_finish_pending_delete``
    (stamping on ``journal_withdrawn`` alone) turns this red, because the
    refusing vault confirms the journal copy on every pass.
    """
    headers, user_id, entry_id, destination = await _mirrored_entry(
        async_client, db_session, "in_progress_owed_essay", JournalClassification.PERSONAL
    )
    note_id = await _seed_essay(
        db_session,
        user_id,
        entry_id,
        state=VoiceDraftRetractionState.MIRROR_INTENT,
        destination=destination,
    )
    refusing = _EssayRefusingVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: refusing
    failed = await async_client.delete(f"/journal/{entry_id}", headers=headers)
    assert failed.status_code == HTTPStatus.SERVICE_UNAVAILABLE

    await _sweep(db_session, refusing, _T0 + _PAST_BACKOFF, destination=destination)

    assert entry_id in refusing.withdrawals, "the journal copy itself was confirmed"
    assert (await _entry(db_session, entry_id)).deleted_at is None
    owed = await _obligation(db_session, entry_id)
    assert owed is not None
    assert owed.state == JournalWithdrawalState.PENDING_DELETE
    assert (await _essay_row(db_session, note_id)).state == VoiceDraftRetractionState.PENDING

    await _sweep(db_session, DraftVault(), _T0 + 2 * _PAST_BACKOFF, destination=destination)

    assert (await _entry(db_session, entry_id)).deleted_at is not None
    settled = await _obligation(db_session, entry_id)
    assert settled is not None
    assert settled.state == JournalWithdrawalState.CONFIRMED
    assert (await _essay_row(db_session, note_id)).state == VoiceDraftRetractionState.CONFIRMED
