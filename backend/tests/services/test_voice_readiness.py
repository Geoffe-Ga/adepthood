"""What the voice-readiness derivation must answer, and the one it must not.

The load-bearing test here is the first one. An account that has not agreed to
have its journal sorted is *not* an account that is merely early: writing more
entries moves it nowhere, because
:func:`services.corpus_ingest.ingest_journal_entry` returns before it classifies
anything when consent is absent, and
:data:`services.corpus_consent.CONSENT_GRANTED_BY_DEFAULT` is ``False``. A
two-state readiness — ready, or gathering — would tell that account to keep
writing forever, and the band built on it would never clear. So the derivation
is three-state, and the test that pins it asserts the copy does not carry an
accelerator that account cannot act on.

There is deliberately **no** "the corpus answers at the boundary" test.
``gather_grounding`` retrieves with no query embedding, and
:func:`services.corpus_store._similarity_of` keeps every fragment in that case,
so a non-empty retrievable corpus always yields
:attr:`services.higher_self_grounding.GroundingSource.CORPUS`. A count at or
above the threshold therefore *implies* the corpus source: asserting both would
be one real assertion and one that cannot fail. What is tested instead is the
premise itself — :func:`test_the_reported_source_stops_being_exact_if_grounding_starts_embedding`
fails loudly the day ``gather_grounding`` starts supplying an embedding, which
is the day the reported source would quietly begin to lie.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from types import MappingProxyType

import pytest
import sqlalchemy as sa
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import AsyncSession

import services.higher_self_grounding as grounding_module
from domain.frequencies import Frequency
from models.corpus_consent import ConsentDecision, CorpusConsentEvent
from models.corpus_fragment import CorpusSource
from models.journal_entry import JournalClassification
from schemas.voice_readiness import VOICE_READINESS_MESSAGES, VoiceReadinessState
from services.corpus_store import FragmentDraft, RetrievalQuery, record_fragment
from services.frequency_classification import ClassificationSource, FrequencyClassification
from services.higher_self_grounding import GroundingSource, gather_grounding
from services.voice_readiness import (
    VOICE_READINESS_STATEMENT_BUDGET,
    VOICE_READY_FRAGMENT_THRESHOLD,
    derive_voice_readiness,
    load_voice_readiness,
)

_OWNER = 1
_STRANGER = 2

# Some entry id for the grounding drift guard; nothing is written under it.
_ENTRY_UNDER_REFLECTION = 9_000

# Imperative accelerators an account that has not consented cannot act on. The
# ban is a curated phrase list rather than a bare vocabulary word: an honest
# sentence about sorting what you write necessarily says "writing", and banning
# that word would forbid the truthful copy along with the false one.
_FALSE_ACCELERATORS = (
    "write a few more",
    "keep writing",
    "more entries",
    "write more",
    "as you write",
)


def _classified(**weights: float) -> FrequencyClassification:
    """A classifier result carrying the given per-frequency weights."""
    parsed = {Frequency(code): weight for code, weight in weights.items()}
    return FrequencyClassification(
        weights=MappingProxyType(parsed),
        overall_confidence=max(parsed.values(), default=0.0),
        source=ClassificationSource.OPERATOR,
    )


async def _store_fragments(
    session: AsyncSession, count: int, *, user_id: int = _OWNER, content: str = "a morning"
) -> None:
    """Record ``count`` personal-tier journal fragments against ``user_id``."""
    for index in range(count):
        await record_fragment(
            session,
            user_id=user_id,
            draft=FragmentDraft(
                content=f"{content} {index}",
                tier=JournalClassification.PERSONAL,
                source=CorpusSource.JOURNAL,
                classification=_classified(F5=1.0),
            ),
        )
    await session.commit()


async def _grant_journal_consent(session: AsyncSession, *, user_id: int = _OWNER) -> None:
    """Put a standing GRANTED decision for the journal source on the record."""
    session.add(
        CorpusConsentEvent(
            user_id=user_id,
            source=CorpusSource.JOURNAL.value,
            decision=ConsentDecision.GRANTED.value,
            fragments_removed=0,
        )
    )
    await session.commit()


async def _force_intimate_row(session: AsyncSession, content: str) -> None:
    """Insert an INTIMATE fragment past the CHECK that forbids one.

    Borrowed from ``tests/services/test_corpus_store.py``: the count's own tier
    predicate is the barrier under test, and a barrier only ever reached behind
    an unbreakable one has not been tested at all.
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


# ---------------------------------------------------------------------------
# The consent axis — the reason this is three-state
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_account_that_has_not_consented_is_not_merely_gathering(
    db_session: AsyncSession,
) -> None:
    """A default account is told about the decision, never told to write more.

    The defect this whole issue turns on: with consent ungranted by default,
    ingest returns before it classifies anything, so for *this* account writing
    more entries produces no fragments, ever. Copy that says otherwise is a
    falsehood the band would repeat until it was dismissed.
    """
    readiness = await load_voice_readiness(db_session, user_id=_OWNER)

    assert readiness.state is VoiceReadinessState.NOT_CONSENTED
    assert readiness.ready is False
    assert readiness.classified_fragment_count == 0
    assert readiness.grounding_source is GroundingSource.RECENT_ENTRIES

    message = VOICE_READINESS_MESSAGES[readiness.state]
    assert message is not None
    lowered = message.lower()
    for accelerator in _FALSE_ACCELERATORS:
        assert accelerator not in lowered


@pytest.mark.asyncio
async def test_consent_outranks_a_corpus_that_would_otherwise_be_ready(
    db_session: AsyncSession,
) -> None:
    """Fragments from an earlier grant do not make a revoked account ready.

    Consent is read as the standing decision, not as "was anything ever
    sorted". An account that agreed, accumulated a corpus and then withdrew is
    back to being asked, whatever rows survived the withdrawal.
    """
    await _store_fragments(db_session, VOICE_READY_FRAGMENT_THRESHOLD + 1)

    readiness = await load_voice_readiness(db_session, user_id=_OWNER)

    assert readiness.state is VoiceReadinessState.NOT_CONSENTED
    assert readiness.ready is False
    # The count is still reported honestly — it is the state that is decided by
    # consent, not the arithmetic.
    assert readiness.classified_fragment_count == VOICE_READY_FRAGMENT_THRESHOLD + 1


@pytest.mark.asyncio
async def test_a_consented_account_with_nothing_sorted_yet_is_gathering(
    db_session: AsyncSession,
) -> None:
    """Having agreed and having a corpus are different things."""
    await _grant_journal_consent(db_session)

    readiness = await load_voice_readiness(db_session, user_id=_OWNER)

    assert readiness.state is VoiceReadinessState.GATHERING
    assert readiness.ready is False
    assert readiness.classified_fragment_count == 0
    assert readiness.grounding_source is GroundingSource.RECENT_ENTRIES
    assert VOICE_READINESS_MESSAGES[VoiceReadinessState.GATHERING] is not None


# ---------------------------------------------------------------------------
# The threshold, at its boundary
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("fragment_count", "expected"),
    [
        (VOICE_READY_FRAGMENT_THRESHOLD - 1, VoiceReadinessState.GATHERING),
        (VOICE_READY_FRAGMENT_THRESHOLD, VoiceReadinessState.READY),
        (VOICE_READY_FRAGMENT_THRESHOLD + 1, VoiceReadinessState.READY),
    ],
)
@pytest.mark.asyncio
async def test_the_threshold_is_inclusive_at_its_own_boundary(
    db_session: AsyncSession, fragment_count: int, expected: VoiceReadinessState
) -> None:
    """One below gathers; exactly the threshold, and above it, is ready."""
    await _grant_journal_consent(db_session)
    await _store_fragments(db_session, fragment_count)

    readiness = await load_voice_readiness(db_session, user_id=_OWNER)

    assert readiness.state is expected
    assert readiness.classified_fragment_count == fragment_count


@pytest.mark.asyncio
async def test_the_ready_flag_is_a_projection_of_the_state_and_never_a_second_rule(
    db_session: AsyncSession,
) -> None:
    """``ready`` agrees with ``state`` in all three states, by construction."""
    for consented in (False, True):
        for count in (0, VOICE_READY_FRAGMENT_THRESHOLD):
            readiness = derive_voice_readiness(consented=consented, fragment_count=count)
            assert readiness.ready == (readiness.state is VoiceReadinessState.READY)
    # And the same invariant through the loading path, so the projection is not
    # only true of the pure function.
    await _grant_journal_consent(db_session)
    await _store_fragments(db_session, VOICE_READY_FRAGMENT_THRESHOLD)
    loaded = await load_voice_readiness(db_session, user_id=_OWNER)
    assert loaded.ready is True
    assert loaded.state is VoiceReadinessState.READY


@pytest.mark.asyncio
async def test_the_ready_state_says_nothing_at_all(db_session: AsyncSession) -> None:
    """An arrived account gets silence, not congratulation.

    An absent signal is the norm rather than a deficiency
    (:mod:`domain.invitations`), and the inverse — a band that appeared to
    announce success — is the gamification NORTH-STAR §5 forbids.
    """
    await _grant_journal_consent(db_session)
    await _store_fragments(db_session, VOICE_READY_FRAGMENT_THRESHOLD)

    readiness = await load_voice_readiness(db_session, user_id=_OWNER)

    assert VOICE_READINESS_MESSAGES[readiness.state] is None


# ---------------------------------------------------------------------------
# What the count may and may not see
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_intimate_row_is_uncountable_even_past_the_check(
    db_session: AsyncSession,
) -> None:
    """The count applies the same tier allowlist a retrieval applies.

    Intimate writing is not merely unranked; it is outside the query. An
    account whose only rows are intimate is gathering, not ready, and the count
    it is told is zero.
    """
    await _grant_journal_consent(db_session)
    await _force_intimate_row(db_session, "the thing I have told nobody")

    readiness = await load_voice_readiness(db_session, user_id=_OWNER)

    assert readiness.classified_fragment_count == 0
    assert readiness.state is VoiceReadinessState.GATHERING


@pytest.mark.asyncio
async def test_one_accounts_readiness_never_reflects_anothers_corpus(
    db_session: AsyncSession,
) -> None:
    """A well-stocked stranger leaves this account exactly where it was."""
    await _grant_journal_consent(db_session)
    await _grant_journal_consent(db_session, user_id=_STRANGER)
    await _store_fragments(
        db_session, VOICE_READY_FRAGMENT_THRESHOLD + 5, user_id=_STRANGER, content="not mine"
    )

    readiness = await load_voice_readiness(db_session, user_id=_OWNER)

    assert readiness.classified_fragment_count == 0
    assert readiness.state is VoiceReadinessState.GATHERING


# ---------------------------------------------------------------------------
# Cost, and the premise the reported source rests on
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_readiness_costs_one_consent_read_and_one_indexed_count(
    db_session: AsyncSession,
) -> None:
    """Two statements, and exactly one of them counts.

    A count is the one shape here that could quietly become a per-fragment
    load, which is why this is asserted as a statement count rather than a
    duration: a wall-clock budget fails under unrelated load, while a query
    that started running per row would show up here immediately.
    """
    await _grant_journal_consent(db_session)
    await _store_fragments(db_session, VOICE_READY_FRAGMENT_THRESHOLD + 3)

    with _counting_statements() as statements:
        await load_voice_readiness(db_session, user_id=_OWNER)

    assert len(statements) <= VOICE_READINESS_STATEMENT_BUDGET
    counting = [statement for statement in statements if "count(" in statement.lower()]
    assert len(counting) == 1


@pytest.mark.asyncio
async def test_the_reported_source_stops_being_exact_if_grounding_starts_embedding(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Guard the premise that makes a non-empty corpus always answer.

    ``grounding_source`` is derived from a count alone. That is exact only
    because :func:`services.higher_self_grounding.gather_grounding` retrieves
    with no query embedding, which makes
    :func:`services.corpus_store._similarity_of` keep every fragment. The day a
    query embedding is supplied, a non-empty corpus can come back empty and the
    reported source would begin to lie — so that day this fails here, loudly,
    rather than silently in a band somebody is reading.
    """
    seen: list[RetrievalQuery] = []

    async def _capture(
        _session: AsyncSession, *, user_id: int, query: RetrievalQuery
    ) -> list[object]:
        assert user_id == _OWNER
        seen.append(query)
        return []

    monkeypatch.setattr(grounding_module, "retrieve_fragments", _capture)
    await gather_grounding(db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION)

    # Non-emptiness first: an observation-based assertion that recorded nothing
    # would pass for the wrong reason, in precisely the case it exists to catch.
    assert len(seen) == 1
    assert seen[0].query_embedding is None
