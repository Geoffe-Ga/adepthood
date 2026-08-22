"""What the Higher Self is allowed to read before it speaks.

Four properties carry this module, and each is the reason a test here exists
rather than a comment somewhere.

**The corpus replaces the recency window; it does not widen it.** A grounding
that appended retrieved fragments to the newest entries would send strictly
more of somebody's writing to a third-party provider than the published privacy
policy says it does. So the two sources are alternatives, and the test that
pins that is written as an absence — no journal body in a corpus-grounded
result — because "replaces" is only observable as something missing.

**Whatever the source, the count is the published one.** ``GROUNDING_LIMIT`` is
the number ``docs/legal/privacy-policy.md`` states to a reader deciding whether
to write something down. It bounds both paths, and it is tested against a
corpus and a journal both far larger than it.

**An empty corpus is a legitimate state, not an error.** Every account starts
there, and today every account stays there — nothing in the deployment writes a
fragment yet. A new user must still get a reflection, so the recency window
survives as the documented fallback.

**Retrieval is positioned, not merely recent.** The bias is where the user
currently stands on the ten-fold ontology, resolved through their course stage.
The test for it is built so that recency and position disagree: without the
bias the newest fragment wins, with it the on-position one does.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import MappingProxyType

import pytest
import sqlalchemy as sa
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.frequencies import FREQUENCY_COLORS, Frequency
from domain.resonance import MAX_PRIOR_ENTRIES
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.course_stage import CourseStage
from models.journal_entry import JournalClassification, JournalEntry
from models.stage_progress import StageProgress
from services.corpus_store import FragmentDraft, record_fragment
from services.frequency_classification import ClassificationSource, FrequencyClassification
from services.higher_self_grounding import (
    GROUNDING_LIMIT,
    GROUNDING_STATEMENT_BUDGET,
    GroundingSource,
    gather_grounding,
)

_OWNER = 1
_STRANGER = 2

# The entry the reflection is about. It is excluded from its own context, so it
# never appears in any assertion about what was gathered.
_ENTRY_UNDER_REFLECTION = 9_000

# Four 21-day stages have closed by day 84, so day 90 sits inside stage 5.
_DAYS_INTO_THE_FIFTH_STAGE = 90

# Some other entry of the same account's, so "the entry itself" and "an earlier
# morning" can never be the same row by accident.
_OTHER_ENTRY = 9_001

_INTIMATE_SENTINEL = "the thing I have told nobody"


def _classified(**weights: float) -> FrequencyClassification:
    """A classifier result carrying the given per-frequency weights."""
    parsed = {Frequency(code): weight for code, weight in weights.items()}
    return FrequencyClassification(
        weights=MappingProxyType(parsed),
        overall_confidence=max(parsed.values(), default=0.0),
        source=ClassificationSource.OPERATOR,
    )


async def _store_fragment(
    session: AsyncSession,
    content: str,
    *,
    user_id: int = _OWNER,
    source_entry_id: int | None = None,
    **weights: float,
) -> CorpusFragment:
    """Record one personal-tier fragment against ``user_id`` and commit it."""
    fragment = await record_fragment(
        session,
        user_id=user_id,
        draft=FragmentDraft(
            content=content,
            tier=JournalClassification.PERSONAL,
            source=CorpusSource.JOURNAL,
            classification=_classified(**weights),
            source_entry_id=source_entry_id,
        ),
    )
    await session.commit()
    return fragment


async def _write_entry(
    session: AsyncSession,
    body: str,
    *,
    entry_id: int,
    user_id: int = _OWNER,
    classification: JournalClassification = JournalClassification.PERSONAL,
) -> None:
    """Write one journal entry with an explicit id, so ordering is unambiguous."""
    session.add(
        JournalEntry(
            id=entry_id,
            message=body,
            sender="user",
            user_id=user_id,
            classification=classification,
        )
    )
    await session.commit()


async def _seed_stage_position(
    session: AsyncSession, *, stage_number: int, code: Frequency, user_id: int = _OWNER
) -> None:
    """Put ``user_id`` on a course stage whose colour names ``code``."""
    session.add(
        CourseStage(
            title=f"Stage {stage_number}",
            subtitle="",
            stage_number=stage_number,
            overview_url="",
            category="",
            aspect=f"Curriculum wording {stage_number}",
            spiral_dynamics_color=FREQUENCY_COLORS[code],
            growing_up_stage="",
            divine_gender_polarity="",
            relationship_to_free_will="",
            free_will_description="",
        )
    )
    session.add(StageProgress(user_id=user_id, current_stage=stage_number, completed_stages=[]))
    await session.commit()


async def _force_intimate_fragment(session: AsyncSession, content: str) -> None:
    """Insert an INTIMATE fragment past the CHECK that forbids one.

    Borrowed from ``tests/services/test_corpus_store.py``: the store's own tier
    predicate is the barrier under test here, and a barrier only ever reached
    behind an unbreakable one has not been tested at all. This is the row a
    relaxed CHECK, or a Postgres ``NOT VALID`` window in some future migration,
    would let through.
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
# Which source answers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_corpus_answers_when_it_holds_anything(db_session: AsyncSession) -> None:
    """A non-empty corpus grounds the reflection, and says so."""
    await _store_fragment(db_session, "what I learned about saying no", F1=0.8)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.source is GroundingSource.CORPUS
    assert grounding.bodies == ("what I learned about saying no",)


@pytest.mark.asyncio
async def test_corpus_grounding_replaces_the_recency_window_rather_than_widening_it(
    db_session: AsyncSession,
) -> None:
    """A journal body must not ride along beside the fragments.

    This is the assertion the published count depends on. Appending the two
    sources would double what leaves the deployment while every count-based
    guard stayed green, because each source on its own would still be within
    its limit.
    """
    await _store_fragment(db_session, "a fragment of my own writing", F1=0.8)
    await _write_entry(db_session, "yesterday I went to the river", entry_id=1)
    await _write_entry(db_session, "the day before I did not", entry_id=2)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.source is GroundingSource.CORPUS
    joined = "\n".join(grounding.bodies)
    assert "river" not in joined
    assert "the day before" not in joined


@pytest.mark.asyncio
async def test_an_empty_corpus_falls_back_to_the_recency_window(
    db_session: AsyncSession,
) -> None:
    """A new account still gets a Higher Self that has read something.

    Nothing in the deployment writes a fragment yet, so this is the path every
    live reflection takes today. Degrading to silence here would ship a Higher
    Self that says nothing at all to a new user.
    """
    await _write_entry(db_session, "yesterday I went to the river", entry_id=1)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.source is GroundingSource.RECENT_ENTRIES
    assert grounding.bodies == ("yesterday I went to the river",)
    assert grounding.fragment_ids == ()


@pytest.mark.asyncio
async def test_an_account_with_neither_grounds_on_nothing_rather_than_failing(
    db_session: AsyncSession,
) -> None:
    """The very first entry an account ever writes has no context, and that is fine."""
    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.bodies == ()
    assert grounding.source is GroundingSource.RECENT_ENTRIES


# ---------------------------------------------------------------------------
# The published bound
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_corpus_path_hands_back_no_more_than_the_published_limit(
    db_session: AsyncSession,
) -> None:
    """The count in the privacy policy bounds a corpus of any size.

    ``GROUNDING_LIMIT`` is the number a reader of ``docs/legal/privacy-policy.md``
    uses to decide whether to write something down. Ten fragments is
    comfortably more than the limit, so a retrieval that forwarded its own
    default would fail here.
    """
    for index in range(10):
        await _store_fragment(db_session, f"fragment {index}", F1=0.5)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert len(grounding.bodies) == GROUNDING_LIMIT
    assert len(grounding.fragment_ids) == GROUNDING_LIMIT


@pytest.mark.asyncio
async def test_the_recency_path_hands_back_no_more_than_the_published_limit(
    db_session: AsyncSession,
) -> None:
    """The same number bounds the fallback, so the policy is true either way."""
    for index in range(10):
        await _write_entry(db_session, f"entry {index}", entry_id=index + 1)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert len(grounding.bodies) == GROUNDING_LIMIT


# ---------------------------------------------------------------------------
# Position, not recency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retrieval_is_biased_to_where_the_user_currently_stands(
    db_session: AsyncSession,
) -> None:
    """The user's stage decides which fragment leads, against the newer one.

    Built so the two orderings disagree: the F1 fragment is written second and
    would lead on recency alone, while the reader is standing at the stage
    whose colour names F5. Position winning is the whole difference between
    this and the window it replaces.
    """
    await _seed_stage_position(db_session, stage_number=5, code=Frequency.F5)
    await _store_fragment(db_session, "on position", F5=0.9)
    await _store_fragment(db_session, "merely newer", F1=0.9)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.bodies[0] == "on position"


@pytest.mark.asyncio
async def test_retrieval_follows_the_calendar_when_the_record_lags_behind_it(
    db_session: AsyncSession,
) -> None:
    """Position is what the program *offers*, so the calendar paces it.

    This reader's record still says stage 1 -- they have not opened the Map
    since -- but the schedule has carried them to the stage whose colour names
    F5. Reading ``current_stage`` here would ground the reflection three
    stages behind the writing it is reflecting on.
    """
    anchor = datetime.now(UTC) - timedelta(days=_DAYS_INTO_THE_FIFTH_STAGE)
    db_session.add(
        CourseStage(
            title="Stage 5",
            subtitle="",
            stage_number=5,
            overview_url="",
            category="",
            aspect="Curriculum wording 5",
            spiral_dynamics_color=FREQUENCY_COLORS[Frequency.F5],
            growing_up_stage="",
            divine_gender_polarity="",
            relationship_to_free_will="",
            free_will_description="",
        )
    )
    db_session.add(
        StageProgress(
            user_id=_OWNER,
            current_stage=1,
            completed_stages=[],
            stage_started_at=anchor,
            program_started_at=anchor,
        )
    )
    await db_session.commit()
    await _store_fragment(db_session, "on position", F5=0.9)
    await _store_fragment(db_session, "merely newer", F1=0.9)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.bodies[0] == "on position"


@pytest.mark.asyncio
async def test_an_account_with_no_stage_progress_is_still_grounded(
    db_session: AsyncSession,
) -> None:
    """No position is not an error; it is a retrieval with no bias to apply."""
    await _store_fragment(db_session, "written before any stage began", F1=0.8)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.source is GroundingSource.CORPUS
    assert grounding.bodies == ("written before any stage began",)


@pytest.mark.asyncio
async def test_a_stage_with_no_curriculum_row_is_still_grounded(
    db_session: AsyncSession,
) -> None:
    """A progress row pointing at an unseeded stage resolves to no bias, not a crash."""
    db_session.add(StageProgress(user_id=_OWNER, current_stage=5, completed_stages=[]))
    await db_session.commit()
    await _store_fragment(db_session, "written against an unseeded curriculum", F1=0.8)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.source is GroundingSource.CORPUS


# ---------------------------------------------------------------------------
# What may never be gathered
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_intimate_entry_is_never_gathered_as_context(
    db_session: AsyncSession,
) -> None:
    """The recency window's intimate filter survives the move out of the router.

    This is the guard issue #895 shipped, re-pinned at its new home: these
    bodies are embedded in the prompt sent to the cloud, so an intimate entry
    must not reach it even as context for a newer non-intimate one.
    """
    await _write_entry(
        db_session,
        _INTIMATE_SENTINEL,
        entry_id=1,
        classification=JournalClassification.INTIMATE,
    )
    await _write_entry(db_session, "an ordinary day", entry_id=2)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert _INTIMATE_SENTINEL not in "\n".join(grounding.bodies)


@pytest.mark.asyncio
async def test_an_intimate_fragment_forced_into_the_store_is_never_gathered(
    db_session: AsyncSession,
) -> None:
    """Grounding inherits the store's tier predicate rather than re-deriving it.

    The row here cannot exist through any ordinary route; it is manufactured
    past the CHECK precisely so the predicate that would stop it is exercised
    on its own. Gathering must call through the store's own door, not open a
    fourth reading of the intimate rule.
    """
    await _force_intimate_fragment(db_session, _INTIMATE_SENTINEL)
    await _store_fragment(db_session, "an ordinary fragment", F1=0.8)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert _INTIMATE_SENTINEL not in "\n".join(grounding.bodies)


@pytest.mark.asyncio
async def test_the_entry_under_reflection_is_not_its_own_context(
    db_session: AsyncSession,
) -> None:
    """Quoting the entry back at itself is not a connection."""
    await _write_entry(db_session, "the entry being reflected on", entry_id=_ENTRY_UNDER_REFLECTION)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.bodies == ()


@pytest.mark.asyncio
async def test_a_deleted_entry_is_not_gathered(db_session: AsyncSession) -> None:
    """A soft-deleted entry is gone from every read, this one included."""
    await _write_entry(db_session, "withdrawn", entry_id=1)
    await db_session.execute(
        sa.update(JournalEntry)
        .where(col(JournalEntry.id) == 1)
        .values(deleted_at=datetime.now(UTC))
    )
    await db_session.commit()

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.bodies == ()


@pytest.mark.asyncio
async def test_grounding_never_crosses_accounts(db_session: AsyncSession) -> None:
    """Another account's corpus and another account's entries are both invisible."""
    await _store_fragment(db_session, "the stranger's fragment", user_id=_STRANGER, F1=0.8)
    await _write_entry(db_session, "the stranger's entry", entry_id=1, user_id=_STRANGER)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.bodies == ()


# ---------------------------------------------------------------------------
# What it costs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_corpus_path_stays_within_its_statement_budget(
    db_session: AsyncSession,
) -> None:
    """Grounding is a bounded number of statements on a user-facing path.

    A count rather than a clock: wall-clock assertions fail under load for
    reasons that have nothing to do with the code, while a query that starts
    running per fragment shows up here immediately.
    """
    await _seed_stage_position(db_session, stage_number=5, code=Frequency.F5)
    for index in range(10):
        await _store_fragment(db_session, f"fragment {index}", F5=0.5)

    with _counting_statements() as statements:
        await gather_grounding(db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION)

    assert len(statements) <= GROUNDING_STATEMENT_BUDGET, statements


@pytest.mark.asyncio
async def test_the_fallback_path_stays_within_its_statement_budget(
    db_session: AsyncSession,
) -> None:
    """The fallback pays for the retrieval that came back empty, and nothing more."""
    await _seed_stage_position(db_session, stage_number=5, code=Frequency.F5)
    for index in range(10):
        await _write_entry(db_session, f"entry {index}", entry_id=index + 1)

    with _counting_statements() as statements:
        await gather_grounding(db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION)

    assert len(statements) <= GROUNDING_STATEMENT_BUDGET, statements


# ---------------------------------------------------------------------------
# Saying what it read
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_gathered_fragments_are_identified_by_id(db_session: AsyncSession) -> None:
    """A reflection's grounding is attributable without logging a word of it.

    Ids rather than contents: the point of the record is that an operator
    reading the log can say which fragments grounded a given reflection, and
    the point of the corpus is that they do not have to read them to do it.
    """
    first = await _store_fragment(db_session, "the first", F1=0.9)
    second = await _store_fragment(db_session, "the second", F1=0.8)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert set(grounding.fragment_ids) == {first.id, second.id}


def test_the_published_limit_fits_inside_the_prompt_builder_cap() -> None:
    """The policy's number is the binding one, not a number the prompt overrides.

    ``domain.resonance.build_prompt`` applies its own ceiling to whatever it is
    handed. If the published limit ever rose above it the policy would overstate
    what is sent — harmless — but the two numbers would have silently swapped
    which one is load-bearing, and the next person to raise the prompt cap would
    widen the real exposure without touching the document.
    """
    assert GROUNDING_LIMIT <= MAX_PRIOR_ENTRIES


# ---------------------------------------------------------------------------
# Not reading itself
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_entry_under_reflection_is_not_returned_as_its_own_context(
    db_session: AsyncSession,
) -> None:
    """A reflection is never grounded in the passage it is reflecting on.

    Before the corpus had a writer this was unreachable, because nothing put a
    journal entry into the corpus. It became reachable the moment one existed:
    the entry would be classified, stored, retrieved by its own reflection, and
    the model asked to draw a connection between a sentence and itself. The
    exclusion is the same one the recency window has always applied; it now has
    a ``source_entry_id`` to apply it through.
    """
    await _store_fragment(
        db_session, "the entry itself", source_entry_id=_ENTRY_UNDER_REFLECTION, F1=0.9
    )
    await _store_fragment(db_session, "an earlier morning", source_entry_id=_OTHER_ENTRY, F1=0.8)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.bodies == ("an earlier morning",)


@pytest.mark.asyncio
async def test_an_account_whose_only_fragment_is_the_entry_falls_back(
    db_session: AsyncSession,
) -> None:
    """Excluding the last fragment leaves an empty corpus, not an empty grounding.

    The fallback exists for an account with nothing in the corpus yet, and an
    account whose only fragment has just been excluded is in that state for
    this request. Answering with silence would give somebody's very first
    reflection nothing to read.
    """
    await _store_fragment(
        db_session, "the entry itself", source_entry_id=_ENTRY_UNDER_REFLECTION, F1=0.9
    )
    await _write_entry(db_session, "an earlier morning", entry_id=_OTHER_ENTRY)

    grounding = await gather_grounding(
        db_session, user_id=_OWNER, exclude_entry_id=_ENTRY_UNDER_REFLECTION
    )

    assert grounding.source is GroundingSource.RECENT_ENTRIES
    assert grounding.bodies == ("an earlier morning",)
