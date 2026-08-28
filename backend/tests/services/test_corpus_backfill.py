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

*What a sweep reached is a record of its own.* A repeated yes resumes the
bounded sweep without appending a second decision, so every sweep a permission
authorises -- the first one and the ones that finish what it could not --
writes its own row, naming the decision it ran under.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import DateTime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel, col, select

from domain.frequencies import Frequency
from models.corpus_consent import CorpusConsentEvent
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.corpus_sweep import CorpusSweep
from models.journal_entry import JournalClassification, JournalEntry
from services import corpus_backfill as cb
from services import frequency_classification as fc
from services.corpus_backfill import backfill_after_consent
from services.corpus_consent import ConsentChange, ConsentState, set_consent

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

    And the sweep says it considered the one entry it offered rather than the
    two it fetched. The batch is read before the clock is consulted, so a
    degraded provider would otherwise have every truncated sweep claim credit
    for writing it never reached -- durably, and in the account's own export.
    """
    _patch_provider(monkeypatch)
    monkeypatch.setattr(cb, "BACKFILL_DEADLINE_SECONDS", 0.0)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)

    outcome = await _decide(db_session, granted=True)

    assert (outcome.fragments_added, outcome.entries_remaining) == (1, 1)
    assert outcome.entries_considered == 1


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


# --- what a sweep reached is a record of its own ------------------------------


async def _sweeps(session: AsyncSession) -> list[CorpusSweep]:
    """Every sweep the owner's decisions logged, oldest row first."""
    rows = await session.execute(select(CorpusSweep).order_by(col(CorpusSweep.id)))
    return list(rows.scalars().all())


async def _reaches(session: AsyncSession) -> list[tuple[int, int, int]]:
    """What each of those sweeps considered, added and left behind."""
    return [
        (row.entries_considered, row.fragments_added, row.entries_remaining)
        for row in await _sweeps(session)
    ]


@pytest.mark.asyncio
async def test_a_grant_logs_the_sweep_under_the_decision_that_authorised_it(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One appended row per sweep, carrying what it reached and whose permission it ran on.

    The counts belong here rather than on the consent event because the two
    records count different things: a decision is recorded once, and the sweeps
    that decision authorises can happen many times.
    """
    _patch_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)

    await _decide(db_session, granted=True)

    events = await db_session.execute(select(CorpusConsentEvent))
    event = events.scalars().one()
    assert await _reaches(db_session) == [(2, 2, 0)]
    assert [row.consent_event_id for row in await _sweeps(db_session)] == [event.id]


@pytest.mark.asyncio
async def test_a_resumed_sweep_is_logged_under_the_yes_that_was_already_standing(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Three sweeps, three rows, one decision -- and a remainder that falls to zero.

    A repeated yes appends no second decision but does run the sweep again, so
    without a record of its own the reach of every sweep after the first would
    survive nowhere. Attributing all three to the standing decision is what
    makes the log answer "how far has this permission got?" rather than only
    "how far did the request that granted it get?".

    Each row considered one entry rather than the three, two and one still
    outstanding: what a sweep considered is the batch it actually offered the
    writer, bounded by the ceiling, and the backlog behind that batch is what
    ``entries_remaining`` is for. Two numbers for two questions.
    """
    _patch_provider(monkeypatch)
    monkeypatch.setattr(cb, "BACKFILL_ENTRY_CEILING", 1)
    await _entry(db_session, body=_FIRST)
    await _entry(db_session, body=_SECOND)
    await _entry(db_session, body=_THIRD)

    for _ in range(3):
        await _decide(db_session, granted=True)

    swept = await _sweeps(db_session)
    assert await _reaches(db_session) == [(1, 1, 2), (1, 1, 1), (1, 1, 0)]
    events = await db_session.execute(select(CorpusConsentEvent))
    event = events.scalars().one()
    assert [row.consent_event_id for row in swept] == [event.id] * 3


@pytest.mark.asyncio
async def test_a_sweep_that_found_nothing_pending_logs_nothing(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An append-only log of reaches must not fill up with reaches of nothing.

    Every repeated yes runs the sweep, and once the backlog is exhausted that
    is every repeat forever; a row each time would grow without bound and say
    nothing.
    """
    _patch_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)

    await _decide(db_session, granted=True)
    first = await _reaches(db_session)
    await _decide(db_session, granted=True)
    await _decide(db_session, granted=True)

    assert first == [(1, 1, 0)]
    assert await _reaches(db_session) == first


@pytest.mark.asyncio
async def test_a_revocation_logs_no_sweep(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Saying no reaches no writing, so there is no reach to record."""
    _forbid_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)

    await _decide(db_session, granted=False)

    assert await _sweeps(db_session) == []


@pytest.mark.asyncio
async def test_a_grant_for_a_source_with_no_history_logs_no_sweep(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Uploads are not kept, so agreeing to ontologize them sweeps nothing to log."""
    _forbid_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)

    await _decide(db_session, granted=True, source=CorpusSource.UPLOAD)

    assert await _sweeps(db_session) == []


@pytest.mark.asyncio
async def test_a_grant_with_no_decision_behind_it_sweeps_nothing(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A permission the consent log cannot name is not one the sweep will act on.

    A granted state with no decision behind it is not a state the consent log
    can produce -- every grant it reports is a row it appended or a row it
    re-affirmed. Handed one anyway, the sweep declines rather than reaching an
    account's history under a permission it could not attribute the reach to.
    """
    _forbid_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)
    unattributable = ConsentChange(
        state=ConsentState(source=CorpusSource.JOURNAL, granted=True, decided_at=None),
        event=None,
    )

    outcome = await backfill_after_consent(db_session, user_id=_OWNER, change=unattributable)
    await db_session.commit()

    assert (outcome.entries_considered, outcome.fragments_added, outcome.entries_remaining) == (
        0,
        0,
        0,
    )
    assert await _sweeps(db_session) == []


@pytest.mark.asyncio
async def test_a_backlog_that_never_empties_still_stops_logging(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Writing the classifier places nowhere must not turn the log into a faucet.

    An unpositioned entry stays pending on purpose, so an account holding one
    has a backlog that is never exhausted. A valve that closed only on an empty
    backlog would therefore never close for exactly the accounts this sweep was
    written for, and every repeated yes -- five a minute, for as long as the
    account exists -- would append another row saying what the last one said.
    The first outage is worth recording once; the fortieth identical report of
    it is a log of requests.
    """

    async def unplaced(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(text=_UNCLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", unplaced)
    await _entry(db_session, body=_FIRST)

    for _ in range(4):
        await _decide(db_session, granted=True)

    assert await _reaches(db_session) == [(1, 0, 1)]


@pytest.mark.asyncio
async def test_new_writing_under_a_stalled_grant_is_still_logged(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Suppressing a repeat must not suppress a remainder that actually changed.

    The surface that tells somebody how much of their writing is still waiting
    reads the newest row, so a sweep that reaches nothing new but finds more
    waiting than the last one did has moved a number and has to say so.
    """

    async def unplaced(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(text=_UNCLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", unplaced)
    await _entry(db_session, body=_FIRST)
    await _decide(db_session, granted=True)

    await _entry(db_session, body=_SECOND)
    await _decide(db_session, granted=True)

    assert await _reaches(db_session) == [(1, 0, 1), (2, 0, 2)]


@pytest.mark.asyncio
async def test_writing_that_arrives_mid_sweep_is_counted_as_still_waiting(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The remainder is counted when the sweep stops, not inferred from its start.

    What is pending is read once to decide whether to sweep and again to build
    the batch, and those are separate statements: a database that gives each its
    own snapshot can hand the batch an entry the opening count never saw. Infer
    the remainder by subtracting instead, and it goes negative -- which the
    remainder's own CHECK refuses, so the commit fails and the decision the
    caller came to record is lost behind an error.

    The entry written here while the classifier is working stands for that
    entry. Subtracting would report nothing left; counting again reports the one
    thing that is.
    """

    async def writes_while_classifying(**_kwargs: object) -> SimpleNamespace:
        db_session.add(
            JournalEntry(
                message=_SECOND,
                sender="user",
                user_id=_OWNER,
                classification=JournalClassification.PERSONAL.value,
                timestamp=datetime.now(UTC),
            )
        )
        await db_session.flush()
        return SimpleNamespace(text=_CLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", writes_while_classifying)
    await _entry(db_session, body=_FIRST)

    outcome = await _decide(db_session, granted=True)

    assert (outcome.fragments_added, outcome.entries_remaining) == (1, 1)


@pytest.mark.asyncio
async def test_a_decision_belonging_to_somebody_else_authorises_nothing(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reach is filed under a permission the same account holds, or not at all.

    ``user_id`` and ``consent_event_id`` are independent columns, so nothing in
    the schema would stop one account's writing being swept under another
    account's decision. The refusal is here because that is the only place it
    can be. No caller produces this today -- the consent read is already
    filtered by the account asking -- which is why it is asserted rather than
    assumed.
    """
    _forbid_provider(monkeypatch)
    stranger = _OWNER + 1
    db_session.add(
        JournalEntry(
            message=_FIRST,
            sender="user",
            user_id=stranger,
            classification=JournalClassification.PERSONAL.value,
            timestamp=datetime.now(UTC),
        )
    )
    await db_session.flush()
    change = await set_consent(
        db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=True
    )

    outcome = await backfill_after_consent(db_session, user_id=stranger, change=change)
    await db_session.commit()

    assert outcome.entries_considered == 0
    assert await _sweeps(db_session) == []


@pytest.mark.asyncio
async def test_a_logged_sweep_says_when_it_ran(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The instant is real and the column keeps its offset.

    The remainder a sweep leaves is chased by the sweeps that come after it, so
    "when did this one run?" is a question asked across rows written by
    different requests, and an unzoned answer makes their order a guess.

    The offset is asserted against the declaration rather than against a row
    read back, because SQLite has no zoned type and hands every timestamp back
    naive: a round-trip assertion would fail on the fixture while passing on
    the deployment, which is the wrong way round for a guard. What the row
    itself is asked is that the instant is the one the sweep ran at, bracketed
    rather than measured so a loaded machine cannot make it flake.
    """
    _patch_provider(monkeypatch)
    await _entry(db_session, body=_FIRST)

    before = datetime.now(UTC).replace(tzinfo=None)
    await _decide(db_session, granted=True)
    after = datetime.now(UTC).replace(tzinfo=None)

    swept = await _sweeps(db_session)
    assert len(swept) == 1
    assert before <= swept[0].swept_at.replace(tzinfo=None) <= after
    stored = SQLModel.metadata.tables["corpussweep"].c.swept_at
    assert isinstance(stored.type, DateTime)
    assert stored.type.timezone is True
