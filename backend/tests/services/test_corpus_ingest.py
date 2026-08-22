"""The writer: how a journal entry becomes a fragment, and when it does not.

This is the module that makes the corpus reachable at all — before it, every
account in every deployment fell through to the recency window forever. So the
tests here are mostly about the four ways an entry is *refused*, because each
refusal is a promise made somewhere else.

**No consent, no call.** The provider is not merely un-recorded for an account
that has not agreed; it is not contacted. The fake raises rather than returns,
so a guard moved below request construction cannot pass by producing something
plausible — the pattern ``test_frequency_classification`` established for the
intimate refusal.

**INTIMATE is refused through the existing barriers.** This module never asks
whether a tier is intimate in order to decide what the corpus may hold; it
declines to offer the tier at all, and the three barriers in
:mod:`services.corpus_store` are what would stop it if it did.

**A failed classification is not a failed write.** A provider that is down, and
a reply that carries no frequency at all, both leave the journal entry exactly
as it was and the corpus empty. Nothing here may raise.

**One entry has one fragment.** Editing an entry replaces its fragment rather
than adding a second, so the corpus never holds two versions of the same
writing and cannot quote back a sentence the account has since deleted.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from domain.frequencies import Frequency
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.journal_entry import JournalClassification, JournalEntry
from services import frequency_classification as fc
from services.botmason import LLMProviderError
from services.corpus_consent import set_consent
from services.corpus_ingest import (
    CLASSIFICATION_CALLS_PER_INGEST,
    INGEST_SOURCE,
    ingest_journal_entry,
    withdraw_journal_entry,
)
from services.corpus_store import retrieve_fragments

_OWNER = 1

_BODY = "I finished the thing I said I would finish."
_EDITED_BODY = "I did not finish it, and I am sitting with that."

# A reply the parser accepts, naming one position on the ten-fold ontology.
_CLASSIFIED_REPLY = json.dumps({"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9})

# A reply the parser accepts that recognises nothing. Distinct from a provider
# failure, and treated the same way: an unpositioned fragment is not
# ontologized writing, so it is not corpus material.
_UNCLASSIFIED_REPLY = json.dumps({"weights": {}, "overall_confidence": 0.0})


def _patch_provider(monkeypatch: pytest.MonkeyPatch, text: str) -> list[dict[str, object]]:
    """Route the classifier's provider call to a fake, returning the calls made."""
    calls: list[dict[str, object]] = []

    async def fake(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        return SimpleNamespace(text=text)

    monkeypatch.setattr(fc, "generate_response", fake)
    return calls


def _forbid_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any provider call an outright test failure."""

    async def explode(**kwargs: object) -> SimpleNamespace:
        msg = f"a provider call was made when none was permitted: {sorted(kwargs)}"
        raise AssertionError(msg)

    monkeypatch.setattr(fc, "generate_response", explode)


def _break_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every provider call fail the way an outage does."""

    async def down(**_kwargs: object) -> SimpleNamespace:
        raise LLMProviderError

    monkeypatch.setattr(fc, "generate_response", down)


async def _entry(
    session: AsyncSession,
    *,
    body: str = _BODY,
    tier: JournalClassification = JournalClassification.PERSONAL,
) -> JournalEntry:
    """Persist one of the owner's journal entries and return it."""
    entry = JournalEntry(
        user_id=_OWNER,
        sender="user",
        message=body,
        classification=tier.value,
        timestamp=datetime.now(UTC),
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return entry


def _id_of(entry: JournalEntry) -> int:
    """The id of an entry that has been flushed, as the ``int`` it is by then."""
    assert entry.id is not None, "the entry under test was never flushed"
    return entry.id


async def _consent(session: AsyncSession) -> None:
    """Record the owner's consent to ontologize what they write here."""
    await set_consent(session, user_id=_OWNER, source=INGEST_SOURCE, granted=True)
    await session.commit()


@pytest.mark.asyncio
async def test_a_consented_entry_becomes_a_fragment_that_names_it(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The writer records the body, the tier, the source and the row it came from."""
    _patch_provider(monkeypatch, _CLASSIFIED_REPLY)
    await _consent(db_session)
    entry = await _entry(db_session)

    fragment = await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    assert fragment is not None
    assert fragment.content == _BODY
    assert fragment.source == CorpusSource.JOURNAL.value
    assert fragment.tier == JournalClassification.PERSONAL.value
    assert fragment.source_entry_id == entry.id


@pytest.mark.asyncio
async def test_one_entry_costs_at_most_one_classification_call(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The per-entry ceiling is one call, and it is a named constant.

    Cost is multiplied by the size of somebody's journal, so "how many provider
    calls does saving an entry cost?" has to have an answer that is checked
    rather than assumed.
    """
    calls = _patch_provider(monkeypatch, _CLASSIFIED_REPLY)
    await _consent(db_session)
    entry = await _entry(db_session)

    await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    assert len(calls) == CLASSIFICATION_CALLS_PER_INGEST == 1


@pytest.mark.asyncio
async def test_without_consent_no_provider_is_contacted_at_all(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An account that agreed to nothing has its writing sent nowhere.

    Not "no fragment is written" — no call is made. Sending the body to a cloud
    provider and then declining to store the answer would have already done the
    thing consent exists to permit.
    """
    _forbid_provider(monkeypatch)
    entry = await _entry(db_session)

    fragment = await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    assert fragment is None
    assert await retrieve_fragments(db_session, user_id=_OWNER) == []


@pytest.mark.asyncio
async def test_an_intimate_entry_is_never_offered_to_the_classifier(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Consent to ontologize is not consent to ontologize the intimate tier.

    The tier is read off the persisted row and the entry is dropped before the
    classifier is reached, so the refusal cannot be undone by an account
    agreeing to something.
    """
    _forbid_provider(monkeypatch)
    await _consent(db_session)
    entry = await _entry(db_session, tier=JournalClassification.INTIMATE)

    fragment = await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    assert fragment is None
    assert await retrieve_fragments(db_session, user_id=_OWNER) == []


@pytest.mark.asyncio
async def test_re_tiering_an_entry_to_intimate_takes_it_out_of_the_corpus(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tier change is retroactive, the way the vault's ref-clearing already is.

    An account that decides a passage was more private than they first thought
    must not find it still being read back to them out of the corpus.
    """
    _patch_provider(monkeypatch, _CLASSIFIED_REPLY)
    await _consent(db_session)
    entry = await _entry(db_session)
    await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    entry.classification = JournalClassification.INTIMATE.value
    await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    assert await retrieve_fragments(db_session, user_id=_OWNER) == []


@pytest.mark.asyncio
async def test_editing_an_entry_replaces_its_fragment_rather_than_adding_one(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The corpus holds what the entry says now, once."""
    _patch_provider(monkeypatch, _CLASSIFIED_REPLY)
    await _consent(db_session)
    entry = await _entry(db_session)
    await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    entry.message = _EDITED_BODY
    await ingest_journal_entry(db_session, entry)
    await db_session.commit()
    found = await retrieve_fragments(db_session, user_id=_OWNER)

    assert [fragment.content for fragment in found] == [_EDITED_BODY]


@pytest.mark.asyncio
async def test_a_provider_outage_leaves_the_entry_saved_and_the_corpus_empty(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Classification enriches a corpus; it is never why a write fails.

    The entry is still there afterwards, read back off the database rather than
    off the instance in hand, because "the write survived" is a claim about the
    row and not about the object.
    """
    _break_provider(monkeypatch)
    await _consent(db_session)
    entry = await _entry(db_session)

    fragment = await ingest_journal_entry(db_session, entry)
    await db_session.commit()
    saved = await db_session.execute(select(JournalEntry.message))

    assert fragment is None
    assert list(saved.scalars().all()) == [_BODY]


@pytest.mark.asyncio
async def test_writing_no_frequency_recognised_is_not_worth_a_fragment(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unpositioned fragment would make the corpus a second recency window.

    The corpus earns its place by being ontologized: retrieval ranks on where a
    fragment sits among the ten. A row with no position at all cannot be ranked
    that way, so it would be retrieved by recency and would displace writing
    that had a position — turning the corpus into exactly the thing it replaced,
    while the grounding source reported ``corpus``.
    """
    _patch_provider(monkeypatch, _UNCLASSIFIED_REPLY)
    await _consent(db_session)
    entry = await _entry(db_session)

    fragment = await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    assert fragment is None
    assert await retrieve_fragments(db_session, user_id=_OWNER) == []


@pytest.mark.asyncio
async def test_a_failed_re_ingest_does_not_leave_the_old_fragment_behind(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A body edit withdraws the old fragment before the new one is attempted.

    The other order is the dangerous one: if classification of the new text
    failed and the old fragment stayed, the corpus would keep quoting a
    sentence the account has since rewritten, indefinitely.
    """
    _patch_provider(monkeypatch, _CLASSIFIED_REPLY)
    await _consent(db_session)
    entry = await _entry(db_session)
    await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    _break_provider(monkeypatch)
    entry.message = _EDITED_BODY
    await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    assert await retrieve_fragments(db_session, user_id=_OWNER) == []


@pytest.mark.asyncio
async def test_withdrawing_an_entry_clears_what_it_put_in_the_corpus(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Deleting an entry deletes the copy of it the corpus was reading from.

    ADR 0005 leaves the lifetime of a fragment open. It does not leave open
    whether writing an account has deleted may keep being sent to a language
    model as context, and a corpus copy that outlived the delete would do
    exactly that.
    """
    _patch_provider(monkeypatch, _CLASSIFIED_REPLY)
    await _consent(db_session)
    entry = await _entry(db_session)
    await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    removed = await withdraw_journal_entry(db_session, user_id=_OWNER, entry_id=_id_of(entry))
    await db_session.commit()

    assert removed == 1
    assert await retrieve_fragments(db_session, user_id=_OWNER) == []


@pytest.mark.asyncio
async def test_a_soft_deleted_entry_is_not_re_ingested(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An entry hidden from every read path is not classified back into view."""
    _forbid_provider(monkeypatch)
    await _consent(db_session)
    entry = await _entry(db_session)
    entry.deleted_at = datetime.now(UTC)

    fragment = await ingest_journal_entry(db_session, entry)
    await db_session.commit()

    assert fragment is None
    assert (await db_session.execute(select(CorpusFragment))).scalars().all() == []


@pytest.mark.asyncio
async def test_an_unsaved_entry_has_nothing_to_be_provenance_for(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An entry with no id yet is declined before anything else is read.

    A fragment's whole reason for carrying ``source_entry_id`` is that the id
    is stable and refers to a row. Classifying a draft that has not been
    flushed would spend a provider call to produce a fragment pointing at
    nothing, and there would be no way to replace or withdraw it later.
    """
    _forbid_provider(monkeypatch)
    await _consent(db_session)

    fragment = await ingest_journal_entry(
        db_session,
        JournalEntry(
            user_id=_OWNER,
            sender="user",
            message=_BODY,
            classification=JournalClassification.PERSONAL.value,
            timestamp=datetime.now(UTC),
        ),
    )

    assert fragment is None
    assert (await db_session.execute(select(CorpusFragment))).scalars().all() == []
