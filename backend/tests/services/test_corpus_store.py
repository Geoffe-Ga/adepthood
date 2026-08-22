"""The per-user ontologized corpus: what may enter it, and what may leave it.

Three properties carry this module.

**INTIMATE cannot be in the store, and cannot come out of it.** Two independent
barriers, each tested on its own so neither can be mistaken for the other: the
write path refuses an intimate tier before a row is constructed, and the table's
own CHECK refuses one that reaches the database by any other route. The
retrieval filter is a third barrier and is tested against a row manufactured
past the CHECK, because a barrier that is only ever exercised behind another
barrier has not been tested at all.

**Every read is one user's.** A retrieval that can see another account's
fragments is the same defect as one that can see intimate ones, so it gets the
same kind of test rather than a weaker one.

**Retrieval is frequency-aware, not merely semantic.** A caller asks for
fragments near a *position* on the ten-fold ontology as well as near a meaning,
and the position is resolved by colour — the only key the course stages and the
frequency table agree on.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from types import MappingProxyType, SimpleNamespace
from typing import cast

import pytest
import sqlalchemy as sa
from cryptography.fernet import Fernet
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

import services.journal_encryption as je
from domain.frequencies import FREQUENCY_COLORS, FREQUENCY_NAMES, Frequency
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.course_stage import CourseStage
from models.journal_entry import JournalClassification
from services.corpus_store import (
    CANDIDATE_POOL_SIZE,
    DEFAULT_RETRIEVAL_LIMIT,
    MAX_RETRIEVAL_LIMIT,
    FragmentDraft,
    RetrievalQuery,
    delete_fragments_for_entry,
    delete_fragments_for_source,
    record_fragment,
    resolve_stage_frequency,
    retrieve_fragments,
)
from services.frequency_classification import FrequencyClassification, IntimateContentRefusedError

_OWNER = 1
_STRANGER = 2

# Two journal ids, so "the entry under reflection" and "some other entry" are
# never the same row by accident.
_ENTRY_UNDER_REFLECTION = 9_000
_OTHER_ENTRY = 9_001

# A two-dimensional embedding space is enough to make "same direction" and
# "perpendicular" unambiguous, and small enough to read.
_EAST: tuple[float, ...] = (1.0, 0.0)
_NORTH: tuple[float, ...] = (0.0, 1.0)


def _classified(**weights: float) -> FrequencyClassification:
    """A classifier result carrying the given per-frequency weights."""
    parsed = {Frequency(code): weight for code, weight in weights.items()}
    confidence = max(parsed.values(), default=0.0)
    return FrequencyClassification(
        weights=MappingProxyType(parsed),
        overall_confidence=confidence,
    )


async def _store(
    session: AsyncSession,
    content: str,
    *,
    user_id: int = _OWNER,
    tier: JournalClassification = JournalClassification.PERSONAL,
    embedding: Sequence[float] | None = None,
    **weights: float,
) -> CorpusFragment:
    """Record one fragment and commit it."""
    fragment = await record_fragment(
        session,
        user_id=user_id,
        draft=FragmentDraft(
            content=content,
            tier=tier,
            source=CorpusSource.JOURNAL,
            classification=_classified(**weights),
            embedding=embedding,
        ),
    )
    await session.commit()
    return fragment


async def _store_from_entry(
    session: AsyncSession,
    content: str,
    *,
    entry_id: int,
    user_id: int = _OWNER,
    **weights: float,
) -> CorpusFragment:
    """Record one fragment that remembers the journal entry it came from."""
    fragment = await record_fragment(
        session,
        user_id=user_id,
        draft=FragmentDraft(
            content=content,
            tier=JournalClassification.PERSONAL,
            source=CorpusSource.JOURNAL,
            classification=_classified(**weights),
            source_entry_id=entry_id,
        ),
    )
    await session.commit()
    return fragment


async def _bulk_store(session: AsyncSession, count: int, **weights: float) -> None:
    """Record ``count`` filler fragments in one commit, newest last."""
    for index in range(count):
        await record_fragment(
            session,
            user_id=_OWNER,
            draft=FragmentDraft(
                content=f"filler {index}",
                tier=JournalClassification.PERSONAL,
                source=CorpusSource.JOURNAL,
                classification=_classified(**weights),
            ),
        )
    await session.commit()


@contextmanager
def _counting_statements() -> Iterator[list[str]]:
    """Collect every SQL statement executed inside the block."""
    seen: list[str] = []

    def _record(
        _conn: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        seen.append(statement)

    sa.event.listen(Engine, "before_cursor_execute", _record)
    try:
        yield seen
    finally:
        sa.event.remove(Engine, "before_cursor_execute", _record)


async def _force_intimate_row(session: AsyncSession, content: str) -> None:
    """Insert an INTIMATE fragment past the CHECK that forbids one.

    The tier CHECK makes such a row impossible through every ordinary route,
    which is exactly why the retrieval filter needs one to be tested against:
    a filter that is only ever reached after an unbreakable barrier has already
    stopped the row is a filter nothing proves. SQLite's
    ``ignore_check_constraints`` manufactures the row a relaxed constraint — or
    a Postgres ``NOT VALID`` window during a future migration — would let
    through.
    """
    await session.execute(sa.text("PRAGMA ignore_check_constraints = ON"))
    await session.execute(
        sa.text(
            "INSERT INTO corpusfragment "
            "(user_id, source, tier, content, frequency_weights, overall_confidence, created_at) "
            "VALUES (:user_id, :source, :tier, :content, :weights, 1.0, :created_at)"
        ),
        {
            "user_id": _OWNER,
            "source": CorpusSource.JOURNAL.value,
            "tier": JournalClassification.INTIMATE.value,
            "content": content,
            "weights": json.dumps({Frequency.F5.value: 1.0}),
            "created_at": datetime.now(UTC),
        },
    )
    await session.commit()
    await session.execute(sa.text("PRAGMA ignore_check_constraints = OFF"))


# ---------------------------------------------------------------------------
# The exclusion, at each of its three barriers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_write_path_refuses_intimate_before_building_a_row(
    db_session: AsyncSession,
) -> None:
    """Intimate content is refused, and nothing is written on the way out.

    The refusal has to be *before* the row exists, not before the flush: a
    guard placed after construction is correct today and one refactor away
    from persisting the row it was meant to stop. Asserting an empty table
    after the exception is how that ordering is observed from outside.
    """
    with pytest.raises(IntimateContentRefusedError):
        await record_fragment(
            db_session,
            user_id=_OWNER,
            draft=FragmentDraft(
                content="the thing I have told nobody",
                tier=JournalClassification.INTIMATE,
                source=CorpusSource.JOURNAL,
                classification=_classified(F5=0.9),
            ),
        )

    rows = await db_session.execute(select(CorpusFragment))
    assert rows.scalars().all() == []


@pytest.mark.asyncio
async def test_the_table_itself_refuses_an_intimate_row(db_session: AsyncSession) -> None:
    """The database rejects the tier the write path is supposed to have stopped.

    Belt to the write path's braces: this is what holds if a second writer is
    ever added that forgets the guard.
    """
    db_session.add(
        CorpusFragment(
            user_id=_OWNER,
            source=CorpusSource.JOURNAL,
            tier=JournalClassification.INTIMATE,
            content="the thing I have told nobody",
            frequency_weights={},
            overall_confidence=0.0,
        )
    )

    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_retrieval_never_returns_an_intimate_fragment(db_session: AsyncSession) -> None:
    """Given an intimate row that exists anyway, retrieval still refuses it.

    The row is manufactured past the CHECK on purpose — see
    :func:`_force_intimate_row`. Without this, removing the tier predicate from
    the retrieval query would break no test at all.
    """
    await _force_intimate_row(db_session, "the thing I have told nobody")
    await _store(db_session, "an ordinary morning", F5=0.9)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(frequency_bias=Frequency.F5)
    )

    assert [fragment.content for fragment in found] == ["an ordinary morning"]


@pytest.mark.asyncio
async def test_retrieval_returns_both_permitted_tiers(db_session: AsyncSession) -> None:
    """Public and personal are both in scope — the exclusion is intimate alone.

    A filter narrowed to one tier would pass the intimate test above while
    quietly discarding most of the corpus.
    """
    await _store(db_session, "said out loud", tier=JournalClassification.PUBLIC, F5=0.9)
    await _store(db_session, "said quietly", tier=JournalClassification.PERSONAL, F5=0.9)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(frequency_bias=Frequency.F5)
    )

    assert {fragment.content for fragment in found} == {"said out loud", "said quietly"}


# ---------------------------------------------------------------------------
# One user's corpus
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retrieval_never_crosses_accounts(db_session: AsyncSession) -> None:
    """A stranger's fragment is invisible even when it is the better match."""
    await _store(db_session, "theirs", user_id=_STRANGER, embedding=_EAST, F5=1.0)
    await _store(db_session, "mine", user_id=_OWNER, embedding=_NORTH, F5=0.1)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(query_embedding=_EAST)
    )

    assert [fragment.content for fragment in found] == []


@pytest.mark.asyncio
async def test_a_stranger_sees_only_their_own(db_session: AsyncSession) -> None:
    """The scoping is symmetric — stated from the other side so it is not one-way."""
    await _store(db_session, "theirs", user_id=_STRANGER, embedding=_EAST, F5=1.0)
    await _store(db_session, "mine", user_id=_OWNER, embedding=_EAST, F5=1.0)

    found = await retrieve_fragments(
        db_session, user_id=_STRANGER, query=RetrievalQuery(query_embedding=_EAST)
    )

    assert [fragment.content for fragment in found] == ["theirs"]


# ---------------------------------------------------------------------------
# The two retrieval axes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_frequency_bias_reorders_equally_similar_fragments(
    db_session: AsyncSession,
) -> None:
    """Two fragments equally near in meaning; the bias decides which comes first.

    Both carry the same embedding, so similarity cannot break the tie. This is
    the whole of "calibrated to where you are right now": the ontology, not the
    topic, chooses.
    """
    await _store(db_session, "achieving", embedding=_EAST, F5=0.9)
    await _store(db_session, "belonging", embedding=_EAST, F4=0.9)

    toward_f5 = await retrieve_fragments(
        db_session,
        user_id=_OWNER,
        query=RetrievalQuery(query_embedding=_EAST, frequency_bias=Frequency.F5),
    )
    toward_f4 = await retrieve_fragments(
        db_session,
        user_id=_OWNER,
        query=RetrievalQuery(query_embedding=_EAST, frequency_bias=Frequency.F4),
    )

    assert next(fragment.content for fragment in toward_f5) == "achieving"
    assert next(fragment.content for fragment in toward_f4) == "belonging"


@pytest.mark.asyncio
async def test_similarity_orders_fragments_at_the_same_frequency(
    db_session: AsyncSession,
) -> None:
    """With the ontology tied, meaning decides — the other axis, on its own."""
    await _store(db_session, "near", embedding=_EAST, F5=0.5)
    await _store(db_session, "far", embedding=(1.0, 4.0), F5=0.5)

    found = await retrieve_fragments(
        db_session,
        user_id=_OWNER,
        query=RetrievalQuery(query_embedding=_EAST, frequency_bias=Frequency.F5),
    )

    assert [fragment.content for fragment in found] == ["near", "far"]


@pytest.mark.asyncio
async def test_a_fragment_below_the_similarity_threshold_is_dropped(
    db_session: AsyncSession,
) -> None:
    """Topically unrelated writing is not grounding, however confident it is."""
    await _store(db_session, "unrelated", embedding=_NORTH, F5=1.0)
    await _store(db_session, "related", embedding=_EAST, F5=0.1)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(query_embedding=_EAST)
    )

    assert [fragment.content for fragment in found] == ["related"]


@pytest.mark.asyncio
async def test_an_unembedded_fragment_cannot_answer_a_semantic_query(
    db_session: AsyncSession,
) -> None:
    """No embedding, no similarity — so it is excluded rather than guessed at.

    Returning it on the strength of recency is precisely the behaviour this
    store replaces; ranking it as if it had scored zero would be the same
    thing wearing a number.
    """
    await _store(db_session, "unembedded", F5=1.0)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(query_embedding=_EAST)
    )

    assert found == []


@pytest.mark.asyncio
async def test_an_unembedded_fragment_still_answers_a_frequency_query(
    db_session: AsyncSession,
) -> None:
    """The ontology axis stands alone — a corpus with no embeddings still retrieves."""
    await _store(db_session, "unembedded", F5=1.0)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(frequency_bias=Frequency.F5)
    )

    assert [fragment.content for fragment in found] == ["unembedded"]


@pytest.mark.asyncio
async def test_an_embedding_of_the_wrong_width_is_not_scored(db_session: AsyncSession) -> None:
    """Dimensionality drift excludes a fragment; it never fabricates a score."""
    await _store(db_session, "three dimensions", embedding=(1.0, 0.0, 0.0), F5=1.0)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(query_embedding=_EAST)
    )

    assert found == []


@pytest.mark.asyncio
async def test_the_scored_axes_are_reported_with_each_fragment(
    db_session: AsyncSession,
) -> None:
    """A caller can see *why* a fragment ranked, not only that it did."""
    await _store(db_session, "achieving", embedding=_EAST, F5=0.9)

    found = await retrieve_fragments(
        db_session,
        user_id=_OWNER,
        query=RetrievalQuery(query_embedding=_EAST, frequency_bias=Frequency.F5),
    )

    assert found[0].similarity == pytest.approx(1.0)
    assert found[0].frequency_affinity == pytest.approx(0.9)
    assert found[0].tier is JournalClassification.PERSONAL
    assert found[0].source is CorpusSource.JOURNAL


# ---------------------------------------------------------------------------
# Limits and cost
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retrieval_returns_at_most_the_requested_limit(db_session: AsyncSession) -> None:
    """The limit is honoured exactly, not approximately."""
    for index in range(5):
        await _store(db_session, f"fragment {index}", F5=0.5)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(frequency_bias=Frequency.F5, limit=2)
    )

    assert len(found) == 2


@pytest.mark.asyncio
async def test_a_limit_beyond_the_ceiling_is_clamped(db_session: AsyncSession) -> None:
    """A caller cannot ask for an unbounded prompt's worth of corpus."""
    await _bulk_store(db_session, MAX_RETRIEVAL_LIMIT + 2, F5=0.5)

    found = await retrieve_fragments(
        db_session,
        user_id=_OWNER,
        query=RetrievalQuery(frequency_bias=Frequency.F5, limit=MAX_RETRIEVAL_LIMIT * 10),
    )

    assert len(found) == MAX_RETRIEVAL_LIMIT


@pytest.mark.asyncio
async def test_a_nonpositive_limit_returns_nothing(db_session: AsyncSession) -> None:
    """Zero is a legitimate ask; it must not fall through to the default."""
    await _store(db_session, "present", F5=0.5)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(frequency_bias=Frequency.F5, limit=0)
    )

    assert found == []


@pytest.mark.asyncio
async def test_retrieval_costs_one_query(db_session: AsyncSession) -> None:
    """One statement for the whole retrieval, whatever the corpus holds.

    The N+1 this forbids is the obvious one — score each row, then fetch its
    neighbours — and it does not show up in a correctness assertion.
    """
    for index in range(4):
        await _store(db_session, f"fragment {index}", embedding=_EAST, F5=0.5)

    with _counting_statements() as statements:
        await retrieve_fragments(
            db_session,
            user_id=_OWNER,
            query=RetrievalQuery(query_embedding=_EAST, frequency_bias=Frequency.F5),
        )

    assert len(statements) == 1


@pytest.mark.asyncio
async def test_the_default_limit_applies_when_none_is_given(db_session: AsyncSession) -> None:
    """The default is the constant, not whatever the corpus happens to hold."""
    await _bulk_store(db_session, DEFAULT_RETRIEVAL_LIMIT + 3, F5=0.5)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(frequency_bias=Frequency.F5)
    )

    assert len(found) == DEFAULT_RETRIEVAL_LIMIT


def test_the_candidate_pool_is_larger_than_anything_it_can_return() -> None:
    """A pool no larger than the ceiling would make ranking a formality."""
    assert CANDIDATE_POOL_SIZE > MAX_RETRIEVAL_LIMIT


# ---------------------------------------------------------------------------
# What is written
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_recorded_fragment_keeps_its_ontology(db_session: AsyncSession) -> None:
    """Weights and confidence survive the round trip under their own codes."""
    await _store(db_session, "achieving", F5=0.9, F3=0.2)

    stored = (await db_session.execute(select(CorpusFragment))).scalars().one()

    assert stored.frequency_weights == {"F5": 0.9, "F3": 0.2}
    assert stored.overall_confidence == pytest.approx(0.9)


@pytest.mark.asyncio
async def test_content_is_encrypted_at_rest(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With a key configured, the raw column holds ciphertext and the read gives it back.

    Not operator-blindness — the operator holds the key (ADR 0005) — but the
    same at-rest protection the journal row it derives from already has. A
    fragment stored in the clear beside an encrypted journal would be a
    downgrade nobody chose.
    """
    monkeypatch.setenv("JOURNAL_ENCRYPTION_KEYS", Fernet.generate_key().decode())
    je.reset_cache()
    try:
        await _store(db_session, "an ordinary morning", F5=0.5)
        db_session.expunge_all()

        on_disk = (
            await db_session.execute(sa.text("SELECT content FROM corpusfragment"))
        ).scalar_one()
        round_tripped = (await db_session.execute(select(CorpusFragment))).scalars().one()

        assert "ordinary" not in on_disk
        assert round_tripped.content == "an ordinary morning"
    finally:
        je.reset_cache()


# ---------------------------------------------------------------------------
# The colour join
# ---------------------------------------------------------------------------


async def _seed_stage(session: AsyncSession, number: int, aspect: str, colour: str) -> None:
    """Insert one curriculum stage row carrying its own aspect name and colour."""
    session.add(
        CourseStage(
            title=f"Stage {number}",
            subtitle="",
            stage_number=number,
            overview_url="",
            category="",
            aspect=aspect,
            spiral_dynamics_color=colour,
            growing_up_stage="",
            divine_gender_polarity="",
            relationship_to_free_will="",
            free_will_description="",
        )
    )
    await session.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize("code", [Frequency.F5, Frequency.F6, Frequency.F7, Frequency.F8])
async def test_a_stage_resolves_to_its_frequency_by_colour(
    db_session: AsyncSession, code: Frequency
) -> None:
    """The four positions whose two labelings disagree still resolve correctly.

    F5..F8 are exactly the middle four where the frequency name and the
    curriculum's aspect diverge — ``Achievism`` against ``Intellectual
    Understanding``, and so on. The stage rows here carry the curriculum's
    words, so a resolver that joined on the name would find nothing and this
    would fail; the colour is the key that holds.
    """
    number = int(code.value[1:])
    await _seed_stage(
        db_session, number, aspect=f"Curriculum wording {number}", colour=FREQUENCY_COLORS[code]
    )

    assert await resolve_stage_frequency(db_session, number) is code


@pytest.mark.asyncio
async def test_a_stage_whose_colour_is_unknown_resolves_to_nothing(
    db_session: AsyncSession,
) -> None:
    """An unrecognised colour is not silently coerced onto a position."""
    await _seed_stage(db_session, 1, aspect="Agency", colour="Chartreuse")

    assert await resolve_stage_frequency(db_session, 1) is None


@pytest.mark.asyncio
async def test_an_absent_stage_resolves_to_nothing(db_session: AsyncSession) -> None:
    """No row, no position — the caller decides what an absent stage means."""
    assert await resolve_stage_frequency(db_session, 1) is None


@pytest.mark.asyncio
async def test_the_stage_aspect_name_is_not_what_resolves_the_position(
    db_session: AsyncSession,
) -> None:
    """A stage labelled with the *frequency's* name but the wrong colour resolves wrong.

    Stated as a test because it is the failure a name join produces and a
    colour join cannot: here the row's aspect reads ``Achievism`` — F5's own
    name — while its colour is Blue, which is F4's. The colour wins.
    """
    await _seed_stage(
        db_session, 5, aspect=FREQUENCY_NAMES[Frequency.F5], colour=FREQUENCY_COLORS[Frequency.F4]
    )

    assert await resolve_stage_frequency(db_session, 5) is Frequency.F4


@pytest.mark.asyncio
async def test_retrieval_can_be_biased_to_a_stage_resolved_by_colour(
    db_session: AsyncSession,
) -> None:
    """End to end: a caller holding a stage number gets that position's writing."""
    await _seed_stage(db_session, 5, aspect="Intellectual Understanding", colour="Orange")
    await _store(db_session, "achieving", F5=0.9)
    await _store(db_session, "belonging", F4=0.9)

    bias = await resolve_stage_frequency(db_session, 5)
    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(frequency_bias=bias)
    )

    assert next(fragment.content for fragment in found) == "achieving"


@pytest.mark.asyncio
async def test_ordering_is_stable_when_nothing_distinguishes_two_fragments(
    db_session: AsyncSession,
) -> None:
    """With no query at all, the newest writing leads — the documented fallback."""
    await _store(db_session, "older", F5=0.0)
    await _store(db_session, "newer", F5=0.0)

    found = await retrieve_fragments(db_session, user_id=_OWNER)

    assert [fragment.content for fragment in found] == ["newer", "older"]


@pytest.mark.asyncio
async def test_the_corpus_of_an_account_with_nothing_in_it_is_empty(
    db_session: AsyncSession,
) -> None:
    """An empty corpus retrieves nothing rather than failing."""
    assert (
        await retrieve_fragments(
            db_session, user_id=_OWNER, query=RetrievalQuery(query_embedding=_EAST)
        )
        == []
    )


@pytest.mark.asyncio
async def test_only_the_candidate_pool_is_loaded(db_session: AsyncSession) -> None:
    """The single query is bounded, so a large corpus cannot be read into memory.

    Asserted on the emitted SQL because the bound is the point: without it,
    "one query" would still mean "every row this account has ever written".
    """
    await _store(db_session, "present", F5=0.5)

    with _counting_statements() as statements:
        await retrieve_fragments(
            db_session, user_id=_OWNER, query=RetrievalQuery(frequency_bias=Frequency.F5)
        )

    assert "LIMIT" in statements[0].upper()


@pytest.mark.asyncio
async def test_the_pool_is_ordered_by_the_biased_frequency_in_sql(
    db_session: AsyncSession,
) -> None:
    """The bias reaches the database, so the pool is not merely the newest rows.

    A corpus larger than ``CANDIDATE_POOL_SIZE`` is where this matters: if the
    pool were cut by recency, the on-frequency writing from a year ago could
    never be ranked at all.
    """
    await _store(db_session, "on frequency", F5=0.9)
    await _bulk_store(db_session, CANDIDATE_POOL_SIZE, F4=0.9)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(frequency_bias=Frequency.F5)
    )

    assert next(fragment.content for fragment in found) == "on frequency"


@pytest.mark.asyncio
async def test_a_fragments_own_columns_come_back_scoped_to_its_owner(
    db_session: AsyncSession,
) -> None:
    """The row the store wrote is the row it reads back, ids included."""
    written = await _store(db_session, "achieving", F5=0.9)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(frequency_bias=Frequency.F5)
    )

    assert found[0].fragment_id == written.id


@pytest.mark.asyncio
async def test_the_store_holds_no_fragment_for_an_untouched_account(
    db_session: AsyncSession,
) -> None:
    """Nothing is created implicitly; a corpus exists only once written to."""
    await _store(db_session, "mine", F5=0.5)

    strangers = await db_session.execute(
        select(CorpusFragment).where(col(CorpusFragment.user_id) == _STRANGER)
    )

    assert strangers.scalars().all() == []


# ---------------------------------------------------------------------------
# Provenance: which row a fragment came from, and what that makes possible
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_fragment_remembers_the_entry_it_was_derived_from(
    db_session: AsyncSession,
) -> None:
    """The row reference is persisted, not merely accepted and dropped.

    Read back off a fresh query rather than off the instance the write
    returned: an attribute that never reached a column would satisfy the
    second and not the first.
    """
    await _store_from_entry(db_session, "derived", entry_id=_ENTRY_UNDER_REFLECTION, F5=0.5)

    stored = await db_session.execute(select(CorpusFragment.source_entry_id))

    assert stored.scalars().all() == [_ENTRY_UNDER_REFLECTION]


@pytest.mark.asyncio
async def test_a_retrieval_can_refuse_the_entry_it_is_gathering_context_for(
    db_session: AsyncSession,
) -> None:
    """Excluding an entry drops every fragment derived from it.

    This is the whole reason provenance exists: without it a reflection can be
    handed the passage it is reflecting on as its own "earlier writing", and
    asked to draw a connection between a sentence and itself.
    """
    await _store_from_entry(
        db_session, "the entry itself", entry_id=_ENTRY_UNDER_REFLECTION, F5=0.9
    )
    await _store_from_entry(db_session, "something else", entry_id=_OTHER_ENTRY, F5=0.9)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(exclude_entry_id=_ENTRY_UNDER_REFLECTION)
    )

    assert [fragment.content for fragment in found] == ["something else"]


@pytest.mark.asyncio
async def test_excluding_an_entry_keeps_fragments_that_came_from_nowhere_in_particular(
    db_session: AsyncSession,
) -> None:
    """A fragment with no provenance is not silently dropped by an exclusion.

    ``source_entry_id`` is NULL for anything not derived from a journal row —
    an upload, an import. Plain SQL inequality drops NULLs, so writing the
    filter the obvious way would make one exclusion erase every imported
    fragment an account has.
    """
    await _store(db_session, "uploaded", F5=0.9)

    found = await retrieve_fragments(
        db_session, user_id=_OWNER, query=RetrievalQuery(exclude_entry_id=_ENTRY_UNDER_REFLECTION)
    )

    assert [fragment.content for fragment in found] == ["uploaded"]


@pytest.mark.asyncio
async def test_the_exclusion_is_applied_in_the_database(db_session: AsyncSession) -> None:
    """The excluded entry never enters the candidate pool.

    Filtering in Python after the pool was loaded would let an account's own
    entry consume one of :data:`CANDIDATE_POOL_SIZE` slots, so on a large
    corpus the exclusion would quietly cost a fragment that had earned its
    place.
    """
    await _store_from_entry(db_session, "present", entry_id=_OTHER_ENTRY, F5=0.5)

    with _counting_statements() as statements:
        await retrieve_fragments(
            db_session,
            user_id=_OWNER,
            query=RetrievalQuery(exclude_entry_id=_ENTRY_UNDER_REFLECTION),
        )

    assert "source_entry_id" in statements[0]


@pytest.mark.asyncio
async def test_dropping_one_entrys_fragments_leaves_every_other_entry_alone(
    db_session: AsyncSession,
) -> None:
    """Withdrawing one entry's writing is surgical, and reports what it removed.

    The count is the evidence a withdrawal reached the corpus at all — a
    delete that matched nothing and a delete that matched everything are
    indistinguishable from a return of ``None``.
    """
    await _store_from_entry(
        db_session, "the entry itself", entry_id=_ENTRY_UNDER_REFLECTION, F5=0.9
    )
    await _store_from_entry(db_session, "something else", entry_id=_OTHER_ENTRY, F5=0.9)

    removed = await delete_fragments_for_entry(
        db_session, user_id=_OWNER, entry_id=_ENTRY_UNDER_REFLECTION
    )
    await db_session.commit()
    found = await retrieve_fragments(db_session, user_id=_OWNER)

    assert removed == 1
    assert [fragment.content for fragment in found] == ["something else"]


@pytest.mark.asyncio
async def test_one_account_cannot_drop_another_accounts_fragments(
    db_session: AsyncSession,
) -> None:
    """A withdrawal is scoped to its owner even when the entry id is not.

    Journal ids are global, so a delete keyed on the entry alone would let one
    account's withdrawal reach into another's corpus.
    """
    await _store_from_entry(
        db_session,
        "the stranger's",
        entry_id=_ENTRY_UNDER_REFLECTION,
        user_id=_STRANGER,
        F5=0.9,
    )

    removed = await delete_fragments_for_entry(
        db_session, user_id=_OWNER, entry_id=_ENTRY_UNDER_REFLECTION
    )
    await db_session.commit()

    assert removed == 0
    assert await retrieve_fragments(db_session, user_id=_STRANGER) != []


@pytest.mark.asyncio
async def test_dropping_a_source_clears_that_source_and_nothing_else(
    db_session: AsyncSession,
) -> None:
    """Withdrawing consent for one source leaves the other sources standing.

    Consent is recorded per source, so the purge that follows a revocation has
    to be per source too — otherwise turning off journal ingestion would erase
    documents somebody uploaded deliberately.
    """
    await _store_from_entry(db_session, "from the journal", entry_id=_OTHER_ENTRY, F5=0.9)
    await record_fragment(
        db_session,
        user_id=_OWNER,
        draft=FragmentDraft(
            content="from an upload",
            tier=JournalClassification.PERSONAL,
            source=CorpusSource.UPLOAD,
            classification=_classified(F5=0.9),
        ),
    )
    await db_session.commit()

    removed = await delete_fragments_for_source(
        db_session, user_id=_OWNER, source=CorpusSource.JOURNAL
    )
    await db_session.commit()
    found = await retrieve_fragments(db_session, user_id=_OWNER)

    assert removed == 1
    assert [fragment.content for fragment in found] == ["from an upload"]


@pytest.mark.asyncio
async def test_a_driver_that_reports_no_row_count_is_reported_as_none_removed(
    db_session: AsyncSession,
) -> None:
    """A ``-1`` from the driver becomes a count, not a sentinel in an audit row.

    ``corpusconsentevent.fragments_removed`` carries a ``>= 0`` CHECK, so
    passing the driver's own answer through would turn a purge that worked
    into an IntegrityError on the receipt for it. Driven through a stand-in
    rather than a real session because every driver this deployment uses does
    report the count — a degrade only some future driver reaches is one no
    real session can be made to produce.
    """

    class _SilentDriver:
        """A session whose DELETE succeeds without saying how much it removed."""

        async def execute(self, _statement: object) -> SimpleNamespace:
            """Answer the way a driver with no row-count support does."""
            return SimpleNamespace(rowcount=-1)

    removed = await delete_fragments_for_entry(
        cast("AsyncSession", _SilentDriver()), user_id=_OWNER, entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert removed == 0
    assert await retrieve_fragments(db_session, user_id=_OWNER) == []
