"""Granting consent reaches backwards, over the writing that was already there.

Revoking has always reached backwards: it deletes the fragments the source put
in the corpus, because a permission that can be withdrawn while the material
stays is a preference rather than a permission. Granting did not, so somebody
with weeks of journal history who said yes got a Higher Self grounded in
whatever they wrote *next*, and the recency window for everything they had
already written -- which is the behaviour the ontologized corpus exists to
replace.

The properties asserted here are the ones a sweep over somebody's whole history
is most likely to get wrong.

*INTIMATE is never swept up.* The tier is excluded in the query, so an intimate
entry is not merely unstored -- it is never loaded, never classified and never
sent anywhere.

*Only the person's own writing.* A resonance reply is a row in the same table.
Ontologizing those would ground the Higher Self in its own earlier answers.

*It cannot double.* Grant, revoke and grant again produces one fragment per
entry, because the sweep considers only entries that have none.

*It is bounded, and honest about the bound.* Every entry costs one provider
call on a request somebody is waiting on, so the sweep stops at a ceiling and
at a deadline, reports what it did not reach, and resumes from there. The
deadline is a bound rather than a note taken between entries: a classification
that retries can outlast the whole sweep's budget on its own, so each entry is
capped as well.

*It cannot get stuck on its own head.* Writing the classifier places nowhere
stays pending forever, so a queue that always offers the newest first would
offer the same stuck entries to every future grant and never reach the older
history the sweep exists for.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.frequencies import Frequency
from models.corpus_consent import CorpusConsentEvent
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.journal_entry import JournalClassification, JournalEntry
from services import corpus_backfill as cb
from services import frequency_classification as fc
from services.corpus_backfill import backfill_after_consent
from services.corpus_consent import set_consent

_OWNER = 1

_FIRST = "I sat with the thing I have been avoiding."
_SECOND = "This morning it was easier than yesterday."
_THIRD = "The same fear, wearing a different coat."
_UNSAYABLE = "The one I would not say aloud."
_RESONANCE = "What would it mean to stay with that?"
_DISCARDED = "A page I threw away."

# A reply the parser accepts, naming one position on the ten-fold ontology.
_CLASSIFIED_REPLY = json.dumps({"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9})

# A reply the parser accepts that recognises nothing. Distinct from a provider
# failure and treated the same way here: writing with no position on the
# ontology is not yet corpus material.
_UNCLASSIFIED_REPLY = json.dumps({"weights": {}, "overall_confidence": 0.0})


def _patch_provider(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """Route the classifier's provider call to a fake, returning the calls made."""
    calls: list[dict[str, object]] = []

    async def fake(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        return SimpleNamespace(text=_CLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", fake)
    return calls


def _forbid_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any provider call an outright test failure."""

    async def explode(**kwargs: object) -> SimpleNamespace:
        msg = f"a provider call was made when none was permitted: {sorted(kwargs)}"
        raise AssertionError(msg)

    monkeypatch.setattr(fc, "generate_response", explode)


async def _entry(
    session: AsyncSession,
    *,
    body: str,
    tier: JournalClassification = JournalClassification.PERSONAL,
    sender: str = "user",
    written_at: datetime | None = None,
) -> int:
    """Put one journal row in the owner's history and return its id."""
    entry = JournalEntry(
        message=body,
        sender=sender,
        user_id=_OWNER,
        classification=tier.value,
        timestamp=written_at if written_at is not None else datetime.now(UTC),
    )
    session.add(entry)
    await session.flush()
    assert entry.id is not None
    return entry.id


async def _discarded_entry(session: AsyncSession, *, body: str) -> int:
    """Put one soft-deleted row in the owner's history and return its id."""
    entry_id = await _entry(session, body=body)
    entry = await session.get(JournalEntry, entry_id)
    assert entry is not None
    entry.deleted_at = datetime.now(UTC)
    await session.flush()
    return entry_id


async def _decide(
    session: AsyncSession, *, granted: bool, source: CorpusSource = CorpusSource.JOURNAL
) -> cb.BackfillOutcome:
    """Record one decision and run whatever that decision reaches."""
    change = await set_consent(session, user_id=_OWNER, source=source, granted=granted)
    outcome = await backfill_after_consent(session, user_id=_OWNER, change=change)
    await session.commit()
    return outcome


async def _stored(session: AsyncSession) -> list[str]:
    """Every fragment body in the owner's corpus, oldest row first."""
    rows = await session.execute(
        select(CorpusFragment)
        .where(col(CorpusFragment.user_id) == _OWNER)
        .order_by(col(CorpusFragment.id))
    )
    return [fragment.content for fragment in rows.scalars().all()]


@pytest.mark.asyncio
async def test_saying_yes_ontologizes_the_writing_that_was_already_there(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point: history stops being invisible the moment consent exists."""
    _patch_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)

    outcome = await _decide(db_session, granted=True)

    assert outcome.fragments_added == 2
    assert sorted(await _stored(db_session)) == sorted([_FIRST, _SECOND])


@pytest.mark.asyncio
async def test_intimate_writing_is_not_swept_up_and_is_not_even_read(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An intimate entry never reaches a provider, so the count is the assertion.

    Storage is refused three times over by the store itself; what a sweep over
    a whole history can newly get wrong is *sending* the material, which is why
    this counts calls rather than rows.
    """
    calls = _patch_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_UNSAYABLE, tier=JournalClassification.INTIMATE)

    outcome = await _decide(db_session, granted=True)

    assert outcome.fragments_added == 1
    assert await _stored(db_session) == [_FIRST]
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_the_higher_selfs_own_replies_are_not_the_persons_writing(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A resonance reply shares the table and is not material for the corpus."""
    _patch_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_RESONANCE, sender="bot")

    outcome = await _decide(db_session, granted=True)

    assert outcome.fragments_added == 1
    assert await _stored(db_session) == [_FIRST]


@pytest.mark.asyncio
async def test_a_deleted_entry_is_not_resurrected_by_a_grant(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Soft-deleted rows are invisible everywhere else and stay invisible here."""
    _patch_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)
    await _discarded_entry(db_session, body=_DISCARDED)

    outcome = await _decide(db_session, granted=True)

    assert outcome.fragments_added == 1
    assert await _stored(db_session) == [_FIRST]


@pytest.mark.asyncio
async def test_granting_twice_over_does_not_double_the_corpus(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Grant, revoke, grant: one fragment per entry, not two."""
    _patch_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)

    await _decide(db_session, granted=True)
    await _decide(db_session, granted=False)
    await _decide(db_session, granted=True)

    assert sorted(await _stored(db_session)) == sorted([_FIRST, _SECOND])


@pytest.mark.asyncio
async def test_a_repeated_yes_sweeps_what_the_first_one_did_not_reach(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The bound is resumable: re-sending the same answer continues the sweep.

    And it stays a repeat rather than a decision -- the log holds decisions, so
    no second row is appended for an answer the account had already given.
    """
    _patch_provider(monkeypatch)
    monkeypatch.setattr(cb, "BACKFILL_ENTRY_CEILING", 1)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)
    await _entry(db_session, body=_THIRD)

    swept = [(await _decide(db_session, granted=True)).fragments_added for _ in range(3)]

    assert swept == [1, 1, 1]
    assert sorted(await _stored(db_session)) == sorted([_FIRST, _SECOND, _THIRD])
    events = await db_session.execute(select(CorpusConsentEvent))
    assert len(list(events.scalars().all())) == 1


@pytest.mark.asyncio
async def test_the_ceiling_reports_what_it_did_not_reach(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A truncated sweep says so in numbers rather than stopping silently."""
    _patch_provider(monkeypatch)
    monkeypatch.setattr(cb, "BACKFILL_ENTRY_CEILING", 2)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)
    await _entry(db_session, body=_THIRD)

    outcome = await _decide(db_session, granted=True)

    assert (outcome.fragments_added, outcome.entries_remaining) == (2, 1)


@pytest.mark.asyncio
async def test_the_deadline_stops_the_sweep_inside_the_callers_patience(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A request somebody is waiting on is bounded by time, not only by count.

    With no time at all to spend, one entry is still ontologized: a grant that
    could return having done nothing would be a permission with no reach.
    """
    _patch_provider(monkeypatch)
    monkeypatch.setattr(cb, "BACKFILL_DEADLINE_SECONDS", 0.0)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)

    outcome = await _decide(db_session, granted=True)

    assert (outcome.fragments_added, outcome.entries_remaining) == (1, 1)


@pytest.mark.asyncio
async def test_the_grant_records_what_its_reach_added(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The audit row is evidence the sweep ran, in the direction it ran.

    ``fragments_removed`` keeps meaning removed -- a grant removes nothing --
    and the count of what a grant *added* is its own column, so neither number
    has to be read as the other.
    """
    _patch_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)

    await _decide(db_session, granted=True)

    rows = await db_session.execute(select(CorpusConsentEvent).order_by(col(CorpusConsentEvent.id)))
    event = rows.scalars().one()
    assert (event.fragments_added, event.fragments_removed) == (2, 0)


@pytest.mark.asyncio
async def test_a_revocation_sweeps_nothing_in(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Saying no reaches a provider for nothing; the fake fails if it is asked."""
    _forbid_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)

    outcome = await _decide(db_session, granted=False)

    assert outcome.fragments_added == 0
    assert await _stored(db_session) == []


@pytest.mark.asyncio
async def test_consenting_to_one_source_does_not_sweep_another(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Agreeing to ontologize uploads is not agreeing to ontologize the journal."""
    _forbid_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)

    outcome = await _decide(db_session, granted=True, source=CorpusSource.UPLOAD)

    assert outcome.fragments_added == 0
    assert await _stored(db_session) == []


@pytest.mark.asyncio
async def test_writing_the_classifier_places_nowhere_stays_pending(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unpositioned entry is not corpus material, so it is not counted as swept.

    Reporting it as reached would make the remainder shrink for work that did
    not happen, and the next grant would never offer it again -- which is the
    difference between a bound and a silent loss.
    """

    async def unplaced(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(text=_UNCLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", unplaced)
    await _entry(db_session, body=_FIRST)

    outcome = await _decide(db_session, granted=True)

    assert (outcome.fragments_added, outcome.entries_remaining) == (0, 1)
    assert await _stored(db_session) == []


# --- the bound is a bound, not a note taken between entries -------------------

# Shrunk stand-ins for the two wall-clock bounds, so a test about a bound does
# not have to wait one out.
_A_MOMENT = 0.05
_A_FEW_MOMENTS = 0.2

# A provider that answers only after longer than anybody waits. It stands in
# for ``services.botmason``'s own worst case -- a 30s per-attempt timeout,
# retried twice with 1s and 2s of backoff -- shortened only so a failing run
# reports in seconds rather than in minutes.
_A_HANG_NOBODY_WAITS_OUT = 6.0

# What the whole sweep may take with both bounds shrunk to a moment. Generous
# against the ~0.2s it should cost, so a loaded machine cannot fail this, and
# far below the hang, so a sweep that waited the provider out cannot pass it.
_PATIENCE = 3.0


def _patch_choosy_provider(monkeypatch: pytest.MonkeyPatch, *, places: set[str]) -> None:
    """A classifier that can place ``places`` and recognises nothing else.

    Not an outage: every call answers, and the answers the sweep cannot use are
    well-formed replies naming no frequency -- which is the condition that
    leaves an entry pending forever.
    """

    async def choosy(**kwargs: object) -> SimpleNamespace:
        written = str(kwargs["user_message"])
        return SimpleNamespace(text=_CLASSIFIED_REPLY if written in places else _UNCLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", choosy)


@pytest.mark.asyncio
async def test_a_provider_that_never_answers_cannot_hold_the_grant_open(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One entry may not outlast the budget the whole sweep was given.

    A classification is retried on transient provider failures, on top of a
    per-attempt timeout longer than the sweep's entire deadline -- so a
    deadline sampled only between entries bounds nothing at all during the one
    condition it exists for. The caller abandons the request at its own
    ``FETCH_TIMEOUT_MS`` and takes the uncommitted transaction with it, so the
    work is paid for and thrown away.

    An entry that runs out of time is an ordinary unclassified one: nothing is
    stored, it stays pending, and the next grant offers it again.
    """
    monkeypatch.setattr(cb, "BACKFILL_ENTRY_SECONDS", _A_MOMENT)
    monkeypatch.setattr(cb, "BACKFILL_DEADLINE_SECONDS", _A_FEW_MOMENTS)

    async def never_answers(**_kwargs: object) -> SimpleNamespace:
        await asyncio.sleep(_A_HANG_NOBODY_WAITS_OUT)
        return SimpleNamespace(text=_CLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", never_answers)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)

    started = time.monotonic()
    outcome = await _decide(db_session, granted=True)
    elapsed = time.monotonic() - started

    assert elapsed < _PATIENCE
    assert (outcome.fragments_added, outcome.entries_remaining) == (0, 2)
    assert await _stored(db_session) == []


def test_one_entry_may_never_spend_the_whole_sweeps_budget() -> None:
    """The two bounds only compose while the per-entry one is the smaller.

    At or above the sweep's own deadline, a single entry could consume it
    entirely and the guarantee would be back where it started.
    """
    assert cb.BACKFILL_ENTRY_SECONDS < cb.BACKFILL_DEADLINE_SECONDS


# --- the sweep cannot get stuck on its own head ------------------------------


@pytest.mark.asyncio
async def test_writing_the_classifier_cannot_place_does_not_starve_what_is_older(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A head of unplaceable entries must not block the history behind it.

    An entry the classifier recognises nothing in stays pending, deliberately.
    Offer the pending set newest-first every time and that is a batch which
    never changes: an account whose most recent entries are short or ambiguous
    -- entirely ordinary journalling -- would have every later grant re-select
    the same stuck rows, pay a provider call for each, and never reach the
    older writing. That account is precisely the one the backfill exists for,
    so a grant that reached nothing has to leave the queue somewhere new.
    """
    monkeypatch.setattr(cb, "BACKFILL_ENTRY_CEILING", 2)
    _patch_choosy_provider(monkeypatch, places={_FIRST})
    now = datetime.now(UTC)
    await _entry(db_session, body=_FIRST, written_at=now - timedelta(days=14))
    await _entry(db_session, body=_SECOND, written_at=now - timedelta(days=7))
    await _entry(db_session, body=_THIRD, written_at=now)

    stuck = await _decide(db_session, granted=True)
    resumed = await _decide(db_session, granted=True)

    assert (stuck.fragments_added, resumed.fragments_added) == (0, 1)
    assert await _stored(db_session) == [_FIRST]


@pytest.mark.asyncio
async def test_an_outage_that_touched_everything_does_not_exclude_it_for_good(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Having been offered is not having been placed, and must not read as done.

    Moving past an entry nothing could be made of is what keeps the sweep
    advancing; dropping it from the candidates outright would turn one bad
    afternoon at a provider into a permanent hole in somebody's corpus.
    """
    _patch_choosy_provider(monkeypatch, places=set())
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)

    outage = await _decide(db_session, granted=True)
    _patch_choosy_provider(monkeypatch, places={_FIRST, _SECOND})
    recovered = await _decide(db_session, granted=True)

    assert (outage.fragments_added, recovered.fragments_added) == (0, 2)
    assert sorted(await _stored(db_session)) == sorted([_FIRST, _SECOND])


async def _last_written_at(session: AsyncSession, entry_id: int) -> datetime:
    """The entry's own ``updated_at``, read back from the row rather than cached."""
    session.expire_all()
    entry = await session.get(JournalEntry, entry_id)
    assert entry is not None
    return entry.updated_at


@pytest.mark.asyncio
async def test_being_swept_is_not_being_edited(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Recording that the sweep reached an entry must not restamp the entry.

    ``updated_at`` is on the journal's own response shape and means "when this
    was last written to". A backfill is not somebody editing their journal, so
    a sweep that bumped it would tell every account it had just rewritten its
    entire history.
    """
    _patch_choosy_provider(monkeypatch, places=set())
    entry_id = await _entry(db_session, body=_FIRST)
    before = await _last_written_at(db_session, entry_id)

    await _decide(db_session, granted=True)

    assert await _last_written_at(db_session, entry_id) == before
