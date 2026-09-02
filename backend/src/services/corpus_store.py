"""Write to and read from one account's ontologized corpus.

This is the storage layer epic day-1-ontology is built on: the place a user's
own writing lives once it has been classified into the ten frequencies, and the
only sanctioned way to get it back out.

**The retrieval contract, stated once.** :func:`retrieve_fragments` takes an
account and a :class:`RetrievalQuery` — an optional query embedding, an
optional frequency bias, an optional journal entry to exclude, and a limit —
and returns scored fragments best-first. The two ranking optionals are
independent axes and either may be omitted:

* **Neither.** The newest writing, bounded by the limit. This is the only mode
  that reduces to recency, and it is the documented fallback rather than a
  ranking.
* **Bias only.** The account's writing at that position on the ontology,
  strongest first. Works on a corpus with no embeddings at all.
* **Embedding only.** The writing nearest in meaning, with anything below
  :data:`domain.corpus.MIN_SIMILARITY` dropped.
* **Both.** The weighted blend of the two, at
  :data:`domain.corpus.SIMILARITY_WEIGHT` / :data:`domain.corpus.FREQUENCY_WEIGHT`.

A fragment with no stored embedding is excluded whenever a query embedding is
supplied. It cannot answer the question that was asked, and ranking it as
though it had scored zero would readmit exactly the recency-shaped grounding
this store replaces.

**INTIMATE is refused here and cannot be stored.** :func:`record_fragment`
tests an allowlist before a row is constructed — not before the flush, before
the object exists — mirroring :mod:`services.creek_vault_write` and
:mod:`services.frequency_classification`, whose ordering exists because a guard
placed after the request was built is correct today and one refactor away from
leaking. The table's own CHECK is the second barrier and
:func:`_candidate_pool`'s tier predicate the third. ADR 0005 Decision 2 asks
for the exclusion to be structural rather than advisory; three independent
barriers is what that means here.

**Writing can be taken back out.** :func:`delete_fragments_for_entry` and
:func:`delete_fragments_for_source` are the two withdrawals this store
supports, and both are statement-level and scoped to one account. The first is
what makes an edit *replace* a fragment rather than accumulate a second one,
and what lets a deleted journal entry take its corpus copy with it; the second
is what makes withdrawing consent for a source mean something, since a
permission that can be revoked while the material stays is a preference rather
than a permission.

**Cost.** One statement per retrieval, bounded by :data:`CANDIDATE_POOL_SIZE`.
The pool is ordered *in the database* by the biased frequency, so the fragments
that reach the Python scorer are the ones nearest the caller's position on the
ontology rather than merely the newest — on a corpus larger than the pool that
is the whole difference. Similarity is then computed in process, which is why
there is no ANN index and no pgvector extension: at per-account corpus sizes a
bounded pool costs less than the operational surface of an extension, and the
upgrade path when an account outgrows it is to push the similarity term into
the database, not to change this signature.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, cast

from sqlalchemy import ColumnElement, CursorResult, delete, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.corpus import MIN_SIMILARITY, blend_score, cosine_similarity, frequency_affinity
from domain.frequencies import Frequency, frequency_for_color
from models.corpus_fragment import RETRIEVABLE_TIERS, CorpusFragment, CorpusSource
from models.course_stage import CourseStage
from models.journal_entry import JournalClassification
from services.frequency_classification import FrequencyClassification, IntimateContentRefusedError

# How many fragments one retrieval may hand back by default. Small on purpose:
# these go into a grounding prompt, where more context past the point of
# relevance costs tokens and dilutes the material that earned its place.
DEFAULT_RETRIEVAL_LIMIT = 8

# The most any caller may ask for, whatever it passes. A limit is a request,
# not an instruction: without a ceiling one caller's bug becomes an unbounded
# prompt built from somebody's entire journal.
MAX_RETRIEVAL_LIMIT = 50

# How many rows the single query loads before scoring. Larger than the ceiling
# by enough that ranking is a real choice rather than a formality, and small
# enough that the whole pool fits comfortably in memory.
CANDIDATE_POOL_SIZE = 200

# The tier values as the column stores them.
_RETRIEVABLE_TIER_VALUES = tuple(tier.value for tier in RETRIEVABLE_TIERS)

logger = logging.getLogger(__name__)

# What a purge reports when the driver did not say how many rows it removed.
# Zero, because a caller writing this into an audit row needs a number, and
# reporting the driver's ``-1`` would put a sentinel where a count belongs --
# the log line above is where the ambiguity is recorded.
_ROW_COUNT_UNAVAILABLE = 0

# Weight assumed for a frequency a fragment does not carry, when the pool is
# ordered in SQL. Matches :func:`domain.corpus.frequency_affinity`, which reads
# an absent key and a zero weight as the same thing.
_ABSENT_WEIGHT = 0.0


@dataclass(frozen=True)
class RetrievedFragment:
    """One fragment a retrieval chose, with the reason it was chosen.

    Both axes are reported alongside the blended ``score`` so a caller can see
    *why* a fragment ranked — a grounding prompt that cannot explain its own
    selection is not debuggable, and grounding the Higher Self on this store
    is precisely a job of explaining itself.
    ``similarity`` is ``None`` when no query embedding was supplied, which is
    different from a similarity of zero.
    """

    fragment_id: int
    content: str
    tier: JournalClassification
    source: CorpusSource
    frequency_weights: dict[str, float]
    overall_confidence: float
    similarity: float | None
    frequency_affinity: float
    score: float
    created_at: datetime


@dataclass(frozen=True)
class RetrievalQuery:
    """What one retrieval is asking for, apart from whose corpus it asks of.

    A value rather than four parameters, for the reason :class:`FragmentDraft`
    is one on the write side: the account is supplied separately, at the call,
    where a scoping mistake is visible, and everything that is genuinely *the
    question* travels together. See the module docstring for the four modes the
    two optional ranking axes make.

    ``exclude_entry_id`` drops every fragment derived from one journal entry.
    It is how a caller gathering context *for* an entry keeps that entry from
    being handed back as its own earlier writing.
    """

    query_embedding: Sequence[float] | None = None
    frequency_bias: Frequency | None = None
    exclude_entry_id: int | None = None
    limit: int = DEFAULT_RETRIEVAL_LIMIT


#: The question a caller asks when it wants this account's newest writing and
#: has nothing else to say about it. Shared because it is immutable, and named
#: because a default argument that constructs a value is a defect waiting for a
#: mutable field.
WHOLE_CORPUS: Final[RetrievalQuery] = RetrievalQuery()


@dataclass(frozen=True)
class FragmentDraft:
    """Everything about one fragment except whose it is.

    A value rather than five parameters, because an import surface builds these
    in a loop, and because the account is deliberately *not* part of it:
    ownership is supplied at the write call, where a scoping mistake is visible,
    rather than buried in a payload that could be built once and reused.
    """

    content: str
    tier: JournalClassification
    source: CorpusSource
    classification: FrequencyClassification
    embedding: Sequence[float] | None = None
    # The journal row this fragment was derived from, when there was one. Left
    # ``None`` by an import surface, whose material never had one.
    source_entry_id: int | None = None


async def record_fragment(
    session: AsyncSession,
    *,
    user_id: int,
    draft: FragmentDraft,
) -> CorpusFragment:
    """Persist one classified fragment against ``user_id``.

    Raises :class:`IntimateContentRefusedError` before constructing the row for
    any tier outside :data:`models.corpus_fragment.RETRIEVABLE_TIERS`. The test
    is an allowlist rather than an equality against the intimate tier so that a
    tier added later is refused by default rather than admitted by default;
    intimate is the only member of the refused set today, which is why that is
    the exception raised.

    The row is flushed but not committed: a fragment is almost always written
    alongside the thing it was derived from, and the caller owns that
    transaction.
    """
    if draft.tier not in RETRIEVABLE_TIERS:
        raise IntimateContentRefusedError
    fragment = CorpusFragment(
        user_id=user_id,
        source_entry_id=draft.source_entry_id,
        source=draft.source.value,
        tier=draft.tier.value,
        content=draft.content,
        frequency_weights={
            code.value: weight for code, weight in draft.classification.weights.items()
        },
        overall_confidence=draft.classification.overall_confidence,
        embedding=None if draft.embedding is None else list(draft.embedding),
    )
    session.add(fragment)
    await session.flush()
    return fragment


def _affinity_ordering(bias: Frequency) -> ColumnElement[float]:
    """The biased frequency's weight, as a value the database can sort on.

    JSON extraction rather than a denormalised column: the weights map is the
    single source of truth for a fragment's position, and a derived column
    would be a second one to keep in step. SQLAlchemy renders this as
    ``json_extract`` on SQLite and ``->>`` with a cast on PostgreSQL, so the
    ordering the tests observe is the ordering production gets.
    """
    return func.coalesce(
        col(CorpusFragment.frequency_weights)[bias.value].as_float(),
        _ABSENT_WEIGHT,
    )


def _not_derived_from(entry_id: int) -> ColumnElement[bool]:
    """Match every fragment that did not come from ``entry_id``.

    Written as "NULL, or a different id" rather than as a plain inequality
    because SQL inequality is unknown against NULL and drops the row. Most of a
    mature corpus is expected to be imported material, whose ``source_entry_id``
    is NULL, so the obvious spelling would make one exclusion erase almost
    everything an account has.
    """
    return or_(
        col(CorpusFragment.source_entry_id).is_(None),
        col(CorpusFragment.source_entry_id) != entry_id,
    )


async def _candidate_pool(
    session: AsyncSession,
    user_id: int,
    query: RetrievalQuery,
) -> list[CorpusFragment]:
    """Load the bounded pool this retrieval will score, in one statement.

    The tier predicate here is the third of the three barriers described in the
    module docstring. It is an allowlist of the tiers this store may hold, so
    a row carrying any other tier — one that reached the table past a relaxed
    CHECK, or during a ``NOT VALID`` window in some future migration — is
    outside the query rather than filtered by it.

    The query's ``exclude_entry_id`` is applied here, in SQL, rather than to the
    scored results: a fragment filtered afterwards would still have consumed one
    of :data:`CANDIDATE_POOL_SIZE` slots, so on a large corpus excluding one
    entry would silently cost a fragment that had earned its place.
    """
    statement = select(CorpusFragment).where(
        col(CorpusFragment.user_id) == user_id,
        col(CorpusFragment.tier).in_(_RETRIEVABLE_TIER_VALUES),
    )
    if query.exclude_entry_id is not None:
        statement = statement.where(_not_derived_from(query.exclude_entry_id))
    if query.frequency_bias is not None:
        statement = statement.order_by(_affinity_ordering(query.frequency_bias).desc())
    result = await session.execute(
        statement.order_by(
            col(CorpusFragment.created_at).desc(),
            col(CorpusFragment.id).desc(),
        ).limit(CANDIDATE_POOL_SIZE)
    )
    return list(result.scalars().all())


def _similarity_of(
    fragment: CorpusFragment,
    query_embedding: Sequence[float] | None,
) -> tuple[bool, float | None]:
    """Score one fragment's similarity, as ``(keep?, similarity)``.

    Three outcomes rather than two. No query embedding: keep it, with no
    similarity to report. A query embedding the fragment cannot answer — it has
    none of its own, or one of a different width — drop it. A comparable pair:
    keep it only if it clears :data:`domain.corpus.MIN_SIMILARITY`.
    """
    if query_embedding is None:
        return True, None
    if fragment.embedding is None:
        return False, None
    similarity = cosine_similarity(query_embedding, fragment.embedding)
    if similarity is None or similarity < MIN_SIMILARITY:
        return False, None
    return True, similarity


def _score(
    fragment: CorpusFragment,
    query_embedding: Sequence[float] | None,
    bias: Frequency | None,
) -> RetrievedFragment | None:
    """Score one candidate, or ``None`` if it cannot answer this query."""
    keep, similarity = _similarity_of(fragment, query_embedding)
    if not keep:
        return None
    affinity = frequency_affinity(fragment.frequency_weights, bias)
    return RetrievedFragment(
        fragment_id=fragment.id if fragment.id is not None else 0,
        content=fragment.content,
        tier=JournalClassification(fragment.tier),
        source=CorpusSource(fragment.source),
        frequency_weights=dict(fragment.frequency_weights),
        overall_confidence=fragment.overall_confidence,
        similarity=similarity,
        frequency_affinity=affinity,
        score=blend_score(similarity=similarity, affinity=affinity),
        created_at=fragment.created_at,
    )


async def retrieve_fragments(
    session: AsyncSession,
    *,
    user_id: int,
    query: RetrievalQuery = WHOLE_CORPUS,
) -> list[RetrievedFragment]:
    """Return ``user_id``'s best-matching fragments, best first.

    See the module docstring for the four modes the query's two optional
    ranking axes make, and for why a fragment with no embedding is excluded
    from a semantic query. The limit is clamped to
    :data:`MAX_RETRIEVAL_LIMIT`; a non-positive limit is honoured as the empty
    request it is, without touching the database.

    Ordering is stable: fragments that score equally keep the order the
    database returned them in, which is newest first.
    """
    effective_limit = min(query.limit, MAX_RETRIEVAL_LIMIT)
    if effective_limit <= 0:
        return []
    candidates = await _candidate_pool(session, user_id, query)
    scored = [
        retrieved
        for retrieved in (
            _score(candidate, query.query_embedding, query.frequency_bias)
            for candidate in candidates
        )
        if retrieved is not None
    ]
    scored.sort(key=lambda retrieved: retrieved.score, reverse=True)
    return scored[:effective_limit]


async def count_retrievable_fragments(session: AsyncSession, *, user_id: int) -> int:
    """How many fragments this account holds that a retrieval could return.

    A separate statement rather than ``len(await retrieve_fragments(...))``,
    which cannot answer the question: retrieval clamps to
    :data:`MAX_RETRIEVAL_LIMIT` over a pool of :data:`CANDIDATE_POOL_SIZE`, so
    it reports the size of its own bounds long before it reports the size of a
    corpus. This is what a caller asking "how much of their own writing is
    there" has to use.

    The tier predicate is the same allowlist ``_candidate_pool`` applies, read
    off the same :data:`_RETRIEVABLE_TIER_VALUES`, so an intimate row that
    reached the table past a relaxed CHECK is outside this count exactly as it
    is outside a retrieval. A hand-written tier list here would be a second
    derivation of the store's central rule, free to drift from the one the
    reads use.

    One indexed ``COUNT`` — ``ix_corpusfragment_user_tier_created`` covers the
    two columns this filters on — and no rows are loaded, so the cost does not
    grow with the corpus it is measuring.
    """
    result = await session.execute(
        select(func.count())
        .select_from(CorpusFragment)
        .where(
            col(CorpusFragment.user_id) == user_id,
            col(CorpusFragment.tier).in_(_RETRIEVABLE_TIER_VALUES),
        )
    )
    return int(result.scalar_one())


async def _delete_where(
    session: AsyncSession, *, user_id: int, predicate: ColumnElement[bool]
) -> int:
    """Delete this account's fragments matching ``predicate``; return the count.

    The account scope is applied here rather than left to each caller, because
    every other key this store deletes on — a journal id, a source — is global
    and would reach into somebody else's corpus on its own.

    Statement-level rather than a load-then-delete loop: a purge is bounded by
    however much somebody has written, and reading all of it into memory to
    delete it would make the cost of withdrawing consent scale with how much
    the account had trusted the feature with. Nothing is committed; the caller
    owns the transaction, as it does for :func:`record_fragment`.

    A driver that declines to report a row count answers ``-1``. That is
    logged and returned as :data:`_ROW_COUNT_UNAVAILABLE`, because the count
    a caller gets is written into an audit row, and a sentinel sitting there
    would read as a real number to everything downstream.
    """
    # ``execute`` is typed ``Result``; a DELETE yields a ``CursorResult`` whose
    # ``rowcount`` is the number of rows removed.
    result = cast(
        "CursorResult[Any]",
        await session.execute(
            delete(CorpusFragment).where(col(CorpusFragment.user_id) == user_id, predicate)
        ),
    )
    removed = int(result.rowcount)
    if removed < _ROW_COUNT_UNAVAILABLE:
        logger.warning("corpus_purge_row_count_unavailable", extra={"user_id": user_id})
        return _ROW_COUNT_UNAVAILABLE
    return removed


async def delete_fragments_for_entry(session: AsyncSession, *, user_id: int, entry_id: int) -> int:
    """Remove every fragment derived from one journal entry; return the count.

    Called when the entry is edited (the replacement is written straight
    after), when it is re-tiered to intimate, and when it is deleted. The count
    is what a log line can report to show the withdrawal reached the corpus.
    """
    return await _delete_where(
        session, user_id=user_id, predicate=col(CorpusFragment.source_entry_id) == entry_id
    )


async def delete_fragments_for_source(
    session: AsyncSession, *, user_id: int, source: CorpusSource
) -> int:
    """Remove every fragment this account got from one source; return the count.

    Per source rather than wholesale, because consent is recorded per source:
    withdrawing permission to ontologize what somebody writes here must not
    erase documents they uploaded deliberately.
    """
    return await _delete_where(
        session, user_id=user_id, predicate=col(CorpusFragment.source) == source.value
    )


async def resolve_stage_frequency(session: AsyncSession, stage_number: int) -> Frequency | None:
    """Return the frequency a course stage sits at, joined on colour.

    Colour, never the aspect name. The two labelings of these ten positions
    agree on six and diverge on F5..F8 — the curriculum's "Intellectual
    Understanding / Achievist" against the frequency table's "Achievism", and
    likewise F6, F7, F8 — so a join on names mismatches exactly those four
    while looking correct. The colour is the one key every surface agrees on.

    ``None`` for a stage with no row, and for a row whose colour names no
    position; deciding what an absent position means belongs to the caller.
    """
    result = await session.execute(
        select(CourseStage.spiral_dynamics_color)
        .where(col(CourseStage.stage_number) == stage_number)
        .limit(1)
    )
    colour = result.scalars().first()
    return None if colour is None else frequency_for_color(colour)
