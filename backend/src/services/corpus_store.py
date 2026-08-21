"""Write to and read from one account's ontologized corpus.

This is the storage layer epic day-1-ontology is built on: the place a user's
own writing lives once it has been classified into the ten frequencies, and the
only sanctioned way to get it back out.

**The retrieval contract, stated once.** :func:`retrieve_fragments` takes an
account, an optional query embedding, an optional frequency bias and a limit,
and returns scored fragments best-first. The two optionals are independent
axes and either may be omitted:

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

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import ColumnElement, func
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


async def _candidate_pool(
    session: AsyncSession,
    user_id: int,
    bias: Frequency | None,
) -> list[CorpusFragment]:
    """Load the bounded pool this retrieval will score, in one statement.

    The tier predicate here is the third of the three barriers described in the
    module docstring. It is an allowlist of the tiers this store may hold, so
    a row carrying any other tier — one that reached the table past a relaxed
    CHECK, or during a ``NOT VALID`` window in some future migration — is
    outside the query rather than filtered by it.
    """
    statement = select(CorpusFragment).where(
        col(CorpusFragment.user_id) == user_id,
        col(CorpusFragment.tier).in_(_RETRIEVABLE_TIER_VALUES),
    )
    if bias is not None:
        statement = statement.order_by(_affinity_ordering(bias).desc())
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
    query_embedding: Sequence[float] | None = None,
    frequency_bias: Frequency | None = None,
    limit: int = DEFAULT_RETRIEVAL_LIMIT,
) -> list[RetrievedFragment]:
    """Return ``user_id``'s best-matching fragments, best first.

    See the module docstring for the four modes the two optional axes make, and
    for why a fragment with no embedding is excluded from a semantic query. The
    limit is clamped to :data:`MAX_RETRIEVAL_LIMIT`; a non-positive limit is
    honoured as the empty request it is, without touching the database.

    Ordering is stable: fragments that score equally keep the order the
    database returned them in, which is newest first.
    """
    effective_limit = min(limit, MAX_RETRIEVAL_LIMIT)
    if effective_limit <= 0:
        return []
    candidates = await _candidate_pool(session, user_id, frequency_bias)
    scored = [
        retrieved
        for retrieved in (
            _score(candidate, query_embedding, frequency_bias) for candidate in candidates
        )
        if retrieved is not None
    ]
    scored.sort(key=lambda retrieved: retrieved.score, reverse=True)
    return scored[:effective_limit]


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
