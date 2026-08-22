"""Choose the writing one reflection is grounded in.

The Higher Self speaks about an entry by reading other things the same person
wrote. This module decides *which* other things, and it is the only place that
decision is made.

**Two sources, never both.** A non-empty corpus answers, through
:func:`services.corpus_store.retrieve_fragments`; an empty one falls back to the
account's most recent other entries, which is what shipped before the corpus
existed. They are alternatives rather than layers: appending one to the other
would double what leaves the deployment for a third-party provider while every
count-based guard stayed green, since each source alone would still be inside
its own limit.

**The count is published.** :data:`GROUNDING_LIMIT` is the number
``docs/legal/privacy-policy.md`` states in words to somebody deciding whether to
write something down, and ``backend/tests/test_legal_documents.py`` pins the
document to this constant. Raising it widens what is shared with the provider,
so raising it fails the build in the file where the promise is written. It
bounds both sources; neither may hand back more.

**An empty corpus is a legitimate state.** Every account begins with one, and
today every account stays there — no surface in this deployment writes a
fragment yet. Answering an empty corpus with silence would ship a Higher Self
that has nothing to say to a new user, so the recency window is a documented
fallback rather than dead code.

**Position, not recency.** The retrieval is biased toward where the reader
currently stands on the ten-fold ontology, resolved from their course stage by
colour. That bias is the whole difference between this and the window it
replaces: NORTH-STAR §2 asks for a corpus "calibrated to where you are right
now", and the newest three things somebody wrote is not calibration. No stage,
or a stage whose colour names no position, is not an error — it is a retrieval
with no bias to apply, which the store documents as a supported mode.

**INTIMATE is not re-decided here.** The corpus cannot hold an intimate
fragment and cannot return one — three independent barriers in
:mod:`services.corpus_store` see to that — so this module calls through that
door rather than adding a fourth reading of the rule. The fallback carries the
one exclusion that is genuinely its own, because it reads the journal table
directly: an intimate entry is never gathered as context for a newer one
(issue #895).

**Cost.** At most :data:`GROUNDING_STATEMENT_BUDGET` statements and no network
call, on a request that is about to spend seconds inside an LLM. Nothing here
scales with the size of the corpus: the stage lookup is two indexed reads and
the retrieval is one bounded query.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.frequencies import Frequency
from domain.stage_progress import get_user_progress
from models.journal_entry import JournalClassification, JournalEntry
from services.corpus_store import resolve_stage_frequency, retrieve_fragments

# How many pieces of the reader's own writing may accompany their entry to the
# language-model provider. Published in ``docs/legal/privacy-policy.md`` and
# pinned to it by ``backend/tests/test_legal_documents.py``: this is the number
# a person uses to decide whether to write something down, so it is a promise
# before it is a parameter. It bounds both grounding sources.
GROUNDING_LIMIT = 3

# The most SQL statements one grounding may issue: the stage lookup, the colour
# lookup, the corpus retrieval, and — only when the corpus came back empty —
# the fallback window. Asserted as a count rather than a duration because a
# wall-clock budget fails under unrelated load, while a query that starts
# running per fragment shows up in a count immediately.
GROUNDING_STATEMENT_BUDGET = 4


class GroundingSource(StrEnum):
    """Which of the two sources answered.

    Recorded alongside the reflection so an operator can tell a corpus-grounded
    pass from a fallback one without reading a word of either.
    """

    CORPUS = "corpus"
    RECENT_ENTRIES = "recent_entries"


@dataclass(frozen=True)
class Grounding:
    """The writing one reflection was grounded in, and where it came from.

    ``fragment_ids`` is empty on the fallback path — the recency window returns
    journal entries, which are not fragments — so it is an attribution of the
    corpus path specifically rather than a general identifier list.
    """

    bodies: tuple[str, ...]
    source: GroundingSource
    fragment_ids: tuple[int, ...]


async def _current_frequency(session: AsyncSession, user_id: int) -> Frequency | None:
    """The position on the ontology the reader currently stands at, if any.

    ``None`` for an account with no progress row and for a stage whose colour
    names no frequency. Both are ordinary states rather than failures, and the
    store reads an absent bias as a retrieval that ranks on meaning and recency
    alone.
    """
    progress = await get_user_progress(session, user_id)
    if progress is None:
        return None
    return await resolve_stage_frequency(session, progress.current_stage)


async def _recent_entry_bodies(session: AsyncSession, user_id: int, exclude_id: int) -> list[str]:
    """The caller's most recent other entry bodies, for connection context.

    Intimate entries (issue #895) are excluded: these bodies are embedded in the
    resonance prompt and sent to the cloud LLM, so an intimate entry must never
    reach the cloud even as *prior context* for a newer non-intimate entry's
    pass. The classification is read off the persisted row (never client-supplied
    at resonance time), mirroring the per-entry privacy floor in ``run_resonance``.
    """
    result = await session.execute(
        select(JournalEntry.message)
        .where(
            JournalEntry.user_id == user_id,
            JournalEntry.id != exclude_id,
            col(JournalEntry.deleted_at).is_(None),
            col(JournalEntry.classification) != JournalClassification.INTIMATE,
        )
        .order_by(col(JournalEntry.id).desc())
        .limit(GROUNDING_LIMIT)
    )
    return list(result.scalars().all())


async def gather_grounding(
    session: AsyncSession, *, user_id: int, exclude_entry_id: int
) -> Grounding:
    """Gather what ``user_id``'s next reflection may read, best material first.

    The corpus answers when it holds anything at all; otherwise the recency
    window does. See the module docstring for why those are alternatives rather
    than layers, and for the published bound both of them obey.

    ``exclude_entry_id`` keeps the entry under reflection out of its own
    context. It applies to the recency window only: a corpus fragment carries no
    reference back to the entry it was derived from, so the corpus side cannot
    yet recognise the entry as its own. Nothing writes journal entries into the
    corpus today, which is why that is a gap to close alongside the writer
    rather than a leak to patch here.
    """
    bias = await _current_frequency(session, user_id)
    fragments = await retrieve_fragments(
        session, user_id=user_id, frequency_bias=bias, limit=GROUNDING_LIMIT
    )
    if fragments:
        return Grounding(
            bodies=tuple(fragment.content for fragment in fragments),
            source=GroundingSource.CORPUS,
            fragment_ids=tuple(fragment.fragment_id for fragment in fragments),
        )
    bodies = await _recent_entry_bodies(session, user_id, exclude_entry_id)
    return Grounding(bodies=tuple(bodies), source=GroundingSource.RECENT_ENTRIES, fragment_ids=())
