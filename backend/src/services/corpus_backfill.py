"""Ontologize the writing an account already had, once it says the corpus may.

Consent used to be read at write time only, so saying yes changed the future
and nothing else: somebody with weeks of journal history got a Higher Self
grounded in whatever they wrote from that moment on, while
:func:`services.higher_self_grounding.gather_grounding` fell back to its recency
window for everything they had actually written. That fallback is the behaviour
the ontologized corpus exists to replace, so for the population the corpus was
built for -- every account that predates it -- the corpus was not yet reaching.

**Symmetry with revocation is the argument.** Revoking already reaches
backwards: it deletes the fragments the source put there, because a permission
that can be withdrawn while the material stays is a preference rather than a
permission. A grant that cannot reach the material it is a permission *for* is
the same defect facing the other way.

**It states no rules of its own.** Every entry it finds goes through
:func:`services.corpus_ingest.ingest_journal_entry`, the same writer the live
journal path uses, so the consent gate, the tier refusal and the one-call
ceiling are the ones already ratified and tested. What this module owns is
only *which rows are candidates*, and the three predicates that answer it are
each about a row rather than about a policy:

* **Never intimate.** ``RETRIEVABLE_TIERS`` is the same constant that generates
  the table's CHECK and the store's allowlist, applied here so an intimate
  entry is not merely refused at the end of the sweep -- it is never loaded,
  never classified, and never leaves the deployment. A sweep over somebody's
  whole history is exactly where that would otherwise get missed.
* **Only the person's own writing.** A resonance reply is a row in the same
  table with ``sender = 'bot'``. Ontologizing those would ground the Higher
  Self in its own earlier answers, which is a feedback loop rather than a
  corpus.
* **Nothing already there, nothing deleted.** A candidate is a live entry with
  no fragment of its own, which is what makes the sweep idempotent: grant,
  revoke and grant again writes one fragment per entry, because the second
  grant sees only what the purge left with none.

**Inline, and bounded three ways.** There is no scheduler in this deployment,
so "later" is not a thing that can be promised -- a deferred pass would need a
queue, a worker and a delivery guarantee, and an audit row written before the
work ran would be a claim rather than evidence. So the sweep runs on the
request that granted, which makes its cost the caller's latency, which is why
it stops at a count and at two clocks:

* :data:`BACKFILL_ENTRY_CEILING` bounds the provider bill one grant can run up.
* :data:`BACKFILL_ENTRY_SECONDS` bounds what any *one* entry may cost in wall
  time, and it is the bound that makes the next one true.
* :data:`BACKFILL_DEADLINE_SECONDS` bounds the sweep's wall time, and it is a
  bound rather than a note taken between entries: the loop stops as soon as
  another entry could not finish inside it, so the provider time a grant can
  spend never exceeds it. Without the per-entry cap it would bound nothing
  during the one condition it exists for -- ``services.botmason`` retries a
  transient failure twice, with backoff, on top of a per-attempt timeout
  already longer than this whole budget, so a single degraded classification
  could hold the request, and its uncommitted transaction, for several times
  the deadline and well past the point the mobile client abandons it.

**Retrying inside the sweep buys nothing.** Which is why the per-entry cap is
allowed to cut a retry ladder short rather than waiting one out: an entry that
fails is left pending and offered again by the next grant, so the resumability
below is already the retry, and it is one that costs the caller nothing.

**Past the bound nothing is silently dropped.** The sweep reports how many
entries it did not reach, logs it, and picks up somewhere new next time: a
repeated ``PUT`` of an answer the account has already given appends no second
decision but does re-run the sweep, so the reach is resumable through the
surface that already exists rather than through a route nothing calls. What no
surface does yet is *tell* somebody a remainder is waiting; that is a client
change, and until it lands the remainder is visible to an operator in the log
line and in the audit row rather than to the person.

**"Somewhere new" is the whole of it.** An entry the classifier places nowhere
stays pending, deliberately, so the order the pending set is offered in is what
decides whether the sweep can advance at all. Offer it newest-first every time
and an account whose most recent entries are short or ambiguous -- ordinary
journalling -- gets the same stuck batch selected by every future grant,
re-billed every time, with the older, richer material behind it never reached:
starvation of exactly the population this module was written for. So each row
carries ``JournalEntry.corpus_attempted_at``, the sweep orders never-offered
first and least-recently-offered next, and the head of the queue therefore
moves whether or not anything came of it. Ordering rather than excluding, so
one bad afternoon at a provider is not a permanent hole. Reversing the order
instead -- oldest first -- would not have fixed this: it relocates the stuck
head to the other end of the history and starves the recent writing in its
place.

**Only the journal source has a history to sweep.** Uploads and imports are not
kept: ``POST /journal/upload`` forwards a document and stores no row, and
``POST /corpus/import`` writes its fragment under the consent in force at the
time and keeps nothing when there was none. There is no un-ontologized upload
sitting anywhere for a later grant to find, so a grant for those sources
correctly reaches nothing rather than pretending to.

**Cost.** One indexed count to see whether there is anything to do, a second
read for the batch when there is, then per candidate one small UPDATE marking
it offered plus what one ordinary journal ingest costs -- a consent read, a
no-op withdrawal of the fragment it does not have, and the single provider call
``services.corpus_ingest.CLASSIFICATION_CALLS_PER_INGEST`` names -- up to the
ceiling. An account with nothing pending pays the one count and stops, which is
what every grant after a completed sweep costs. The provider call is the whole
bill in practice; the marking UPDATE is local and is what buys the sweep the
ability to finish at all.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

from sqlalchemy import ColumnElement, func, nulls_first, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.corpus_fragment import RETRIEVABLE_TIERS, CorpusFragment
from models.journal_entry import JournalEntry
from services.corpus_consent import ConsentChange
from services.corpus_ingest import INGEST_SOURCE, ingest_journal_entry

logger = logging.getLogger(__name__)

#: How many of an account's existing entries one grant may ontologize. The
#: sweep costs one provider call per entry on a request somebody is waiting on,
#: so this is the bill a single "yes" can run up; the rest is reached by the
#: next one.
BACKFILL_ENTRY_CEILING: Final[int] = 40

#: How long one grant may spend sweeping, in seconds. Comfortably inside the
#: 30s the mobile client gives a request (``FETCH_TIMEOUT_MS``), because a
#: sweep the caller abandons is a transaction that never commits -- the work
#: would be paid for and thrown away. The loop stops once another entry could
#: not finish inside it, rather than once it has already been exceeded, which
#: is what makes this a bound on the sweep instead of a reading taken after the
#: damage. The first entry is attempted regardless, bounded by
#: :data:`BACKFILL_ENTRY_SECONDS` alone: a permission whose reach can be zero
#: is not reaching.
BACKFILL_DEADLINE_SECONDS: Final[float] = 20.0

#: How long one entry's classification may take before the sweep gives up on
#: it, in seconds. A hard ceiling passed down to
#: :func:`services.frequency_classification.classify_frequencies`, which
#: cancels the provider call outright -- retries and backoff sleeps included,
#: since that ladder is where the time actually goes. Generous against a
#: classification's real cost (a small JSON reply to a fragment capped at
#: ``MAX_FRAGMENT_CHARS``) and strictly smaller than the sweep's own deadline,
#: which is what lets the two bounds compose; a test pins that inequality,
#: because at or above it a single entry could consume the whole budget and the
#: guarantee would be back where it started. An entry that runs out of time is
#: an ordinary unclassified one: nothing stored, still pending, offered again.
#:
#: The sweep declines to *start* an entry it cannot afford, so a grant may stop
#: short of :data:`BACKFILL_ENTRY_CEILING` with time still on the clock. That
#: is the trade the bound costs, and it is the right way round: beginning a
#: classification the deadline will cut off means paying a provider for an
#: answer nobody reads, and the entry is left pending for the next grant either
#: way.
BACKFILL_ENTRY_SECONDS: Final[float] = 8.0

#: The ``sender`` value marking a row somebody wrote themselves, as the column
#: stores it. ``'bot'`` marks a resonance reply, which is this app's writing
#: rather than theirs.
_HUMAN_SENDER: Final[str] = "user"

# The tiers a fragment may carry, as the entry column stores them. Read off the
# store's own constant so this sweep cannot come to disagree with the CHECK.
_RETRIEVABLE_TIER_VALUES = tuple(tier.value for tier in RETRIEVABLE_TIERS)


@dataclass(frozen=True)
class BackfillOutcome:
    """What one grant's reach into the past actually did.

    ``entries_remaining`` counts the candidates still without a fragment when
    the sweep stopped -- those past a bound, and those the classifier
    recognised nothing in. Both are genuinely still pending: an unclassified
    entry has no position on the ontology, so it is not corpus material yet and
    a later sweep will offer it again. *Later* rather than *next*: an entry
    already offered goes to the back of the queue behind everything no sweep
    has reached for yet, which is what keeps a batch that produced nothing from
    being the batch every future grant gets.
    """

    fragments_added: int
    entries_remaining: int


#: What a decision that swept nothing reports. Interned because it is
#: value-identical every time and is the answer on the common path.
_NOTHING_SWEPT: Final[BackfillOutcome] = BackfillOutcome(fragments_added=0, entries_remaining=0)


def _pending_conditions(user_id: int) -> list[ColumnElement[bool]]:
    """Everything that makes a journal row a candidate for this sweep.

    Written once and used by both the count and the batch, so the number an
    account is told is pending is the number over the same rows the sweep would
    actually take -- two spellings of one predicate is how those come apart.

    The "no fragment yet" test is a correlated ``NOT EXISTS`` on the fragment's
    own provenance column rather than a ``NOT IN`` over collected ids: the
    latter loads the whole corpus to filter the whole journal, which is the
    shape that gets expensive precisely for the accounts this sweep exists for.
    """
    already_ontologized = (
        select(CorpusFragment.id)
        .where(col(CorpusFragment.source_entry_id) == col(JournalEntry.id))
        .exists()
    )
    return [
        col(JournalEntry.user_id) == user_id,
        col(JournalEntry.deleted_at).is_(None),
        col(JournalEntry.sender) == _HUMAN_SENDER,
        col(JournalEntry.classification).in_(_RETRIEVABLE_TIER_VALUES),
        ~already_ontologized,
    ]


async def _count_pending(session: AsyncSession, user_id: int) -> int:
    """How much of this account's writing is not in its corpus."""
    result = await session.execute(
        select(func.count()).select_from(JournalEntry).where(*_pending_conditions(user_id))
    )
    return int(result.scalar_one())


async def _pending_batch(session: AsyncSession, user_id: int) -> list[JournalEntry]:
    """The entries this grant will offer the writer: unoffered first, newest first.

    Two keys, and the order between them is the whole point. ``NULLS FIRST`` on
    ``corpus_attempted_at`` puts the writing no sweep has reached for yet ahead
    of the writing a previous sweep already tried, so a batch that produced
    nothing is not the batch the next grant gets. Without that, an entry the
    classifier places nowhere -- which stays pending on purpose -- would sit at
    the head of a newest-first queue permanently and no later grant could ever
    advance past it.

    Newest first *within* that, because recency is the writing the fallback was
    already serving: an account whose sweep is bounded gets a corpus at least as
    good as the window it replaces, from the first grant rather than the last.
    An entry offered before and still pending comes back round once the
    never-offered ones are exhausted, oldest attempt first, which is what keeps
    a provider outage from excluding anything for good.
    """
    result = await session.execute(
        select(JournalEntry)
        .where(*_pending_conditions(user_id))
        .order_by(
            nulls_first(col(JournalEntry.corpus_attempted_at).asc()),
            col(JournalEntry.timestamp).desc(),
            col(JournalEntry.id).desc(),
        )
        .limit(BACKFILL_ENTRY_CEILING)
    )
    return list(result.scalars().all())


async def _mark_attempted(session: AsyncSession, entry: JournalEntry) -> None:
    """Record that the sweep reached this entry, without restamping it.

    ``updated_at`` carries its own ``onupdate``, and it is on the journal's
    response shape meaning "when this was last written to". A sweep is not
    somebody editing their journal, so it is set here to the value it already
    holds: naming the column in the statement is what suppresses the automatic
    bump, and the alternative would tell every account it had just rewritten
    its entire history.

    A statement rather than an attribute assignment for the same reason -- the
    ORM flush would carry the ``onupdate`` with it.
    """
    await session.execute(
        update(JournalEntry)
        .where(col(JournalEntry.id) == entry.id)
        .values(
            corpus_attempted_at=datetime.now(UTC),
            updated_at=col(JournalEntry.updated_at),
        )
    )


def _log_sweep(user_id: int, considered: int, outcome: BackfillOutcome) -> None:
    """Record what the sweep did, in ids and counts and never in content.

    The same discipline :func:`services.corpus_ingest._log_outcome` keeps: an
    operator has to be able to say whether a grant reached an account's history
    -- and how much of it is still waiting -- without reading a word of it.
    """
    logger.info(
        "corpus_backfill",
        extra={
            "user_id": user_id,
            "entries_considered": considered,
            "fragments_added": outcome.fragments_added,
            "entries_remaining": outcome.entries_remaining,
        },
    )


async def _sweep_journal(session: AsyncSession, *, user_id: int) -> BackfillOutcome:
    """Offer this account's un-ontologized writing to the ordinary corpus writer.

    Each entry is offered under :data:`BACKFILL_ENTRY_SECONDS` and the loop
    stops as soon as another one could not finish inside
    :data:`BACKFILL_DEADLINE_SECONDS`, so the provider time a grant spends is
    bounded by the deadline rather than merely measured against it. Testing
    after the entry rather than before is what keeps the first one always
    attempted -- it is bounded by the per-entry cap alone, which is smaller.

    Every entry offered is marked as offered, whatever came of it, because that
    mark is the sweep's place in the queue. The count that comes back is still
    what the writer actually stored: an entry the classifier recognised nothing
    in stays pending, which is true rather than convenient, since a fragment
    with no position on the ontology is not corpus material.
    """
    pending = await _count_pending(session, user_id)
    if pending == 0:
        return _NOTHING_SWEPT
    candidates = await _pending_batch(session, user_id)
    deadline = time.monotonic() + BACKFILL_DEADLINE_SECONDS
    added = 0
    for entry in candidates:
        await _mark_attempted(session, entry)
        fragment = await ingest_journal_entry(
            session, entry, timeout_seconds=BACKFILL_ENTRY_SECONDS
        )
        if fragment is not None:
            added += 1
        if time.monotonic() + BACKFILL_ENTRY_SECONDS > deadline:
            break
    outcome = BackfillOutcome(fragments_added=added, entries_remaining=pending - added)
    _log_sweep(user_id, len(candidates), outcome)
    return outcome


async def backfill_after_consent(
    session: AsyncSession, *, user_id: int, change: ConsentChange
) -> BackfillOutcome:
    """Run whatever ``change`` reaches backwards over, and record that it ran.

    Nothing happens unless the resulting state is a grant, so a revocation and
    a refusal both reach a provider for nothing. Nothing is committed: the
    caller owns the transaction, so the decision, the fragments it authorised
    and the count on its receipt all land together or none of them does.
    """
    if not change.state.granted or change.state.source is not INGEST_SOURCE:
        return _NOTHING_SWEPT
    outcome = await _sweep_journal(session, user_id=user_id)
    if change.event is not None:
        # Attributed to the decision that authorised it, on the row appended
        # moments ago in this same open transaction -- not an edit to an audit
        # record that has landed, which this log does not permit.
        change.event.fragments_added = outcome.fragments_added
    return outcome
