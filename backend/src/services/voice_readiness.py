"""Whether an account's reflections are drawn from its own corpus yet.

The Higher Self already knows which of two sources answered a given pass —
:class:`services.higher_self_grounding.GroundingSource` records it — and until
now it told only the operator log. This module is the reader-facing half of the
same fact: it says whether the voice speaking back is built from the account's
ontologized corpus or from the last few days of writing, so that an early
reflection is understood as early rather than mistaken for a portrait.

**Three states, because there are two different ways to not be ready.**
Consent is the axis the shape turns on.
:data:`services.corpus_consent.CONSENT_GRANTED_BY_DEFAULT` is ``False``, and
:func:`services.corpus_ingest.ingest_journal_entry` returns before it
classifies anything when the standing decision is not a grant — its own
docstring calls that "the *majority* of journal writes". So an account that has
not agreed holds a corpus of nothing no matter how much it writes, and a
two-state readiness would offer it an accelerator that does not work, forever.
That account is offered the decision instead; granting it also sweeps the
writing already there (:mod:`services.corpus_backfill`), which is the one action
that can carry a long-standing journaller to ready at once.

**Readiness is one condition, not two.** The issue this was built from asked
for "the corpus would answer AND the count clears the threshold". The
conjunction is redundant: :func:`services.higher_self_grounding.gather_grounding`
builds its :class:`services.corpus_store.RetrievalQuery` with no query
embedding, and :func:`services.corpus_store._similarity_of` keeps every
fragment in that case, so a non-empty retrievable corpus always yields
``CORPUS``. A count at or above the threshold therefore *implies* the corpus
source, and the second half of the conjunction could never fail. Readiness is
derived from the count alone; the source travels alongside as reporting.

**Cost.** :data:`VOICE_READINESS_STATEMENT_BUDGET` statements: the standing
consent decision, and one indexed ``COUNT``. Neither loads a row of anybody's
writing, nothing here calls out to a provider, and no session is held across a
remote await — this is two round trips to the same database the request already
holds a connection to, so the pooled connection is released on exactly the
schedule every other read on this router releases it.

**It reports, it never gates.** Nothing in this module is consulted by the
resonance path. A reflection is produced for an account at zero fragments
exactly as it is at a thousand; what changes is only whether the person is told
where it came from.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from models.corpus_fragment import CorpusSource
from schemas.voice_readiness import VoiceReadinessState
from services.corpus_consent import load_consent
from services.corpus_store import count_retrievable_fragments
from services.higher_self_grounding import GroundingSource

#: How many of an account's own classified fragments make the corpus a fair
#: portrait rather than an echo of one week's mood. Twelve — roughly a
#: fortnight of journalling — because the failure this signal exists to name is
#: overfitting: at three or four fragments every retrieval returns nearly the
#: whole corpus, and the voice speaking back is this week's weather.
#:
#: Emphatically **not** :data:`services.higher_self_grounding.GROUNDING_LIMIT`,
#: which is 3. That number is how much writing may accompany one entry to a
#: language-model provider; it is published in ``docs/legal/privacy-policy.md``
#: and pinned to it by ``backend/tests/test_legal_documents.py``. It is a
#: promise about disclosure. This is an editorial judgement about when a corpus
#: is representative, and the two are free to move independently.
VOICE_READY_FRAGMENT_THRESHOLD: Final[int] = 12

#: The most SQL statements one readiness answer may issue: the standing consent
#: decision, and the indexed count. Asserted as a count rather than a duration
#: because a wall-clock budget fails under unrelated load, while a query that
#: starts running per fragment shows up in a count immediately. Mirrors
#: :data:`services.higher_self_grounding.GROUNDING_STATEMENT_BUDGET`.
VOICE_READINESS_STATEMENT_BUDGET: Final[int] = 2


@dataclass(frozen=True)
class VoiceReadiness:
    """How far along one account's corpus is, and what would answer right now.

    ``ready`` is not stored independently — see :func:`derive_voice_readiness`,
    which projects it from ``state`` in the one place that is allowed to decide
    it.
    """

    state: VoiceReadinessState
    ready: bool
    grounding_source: GroundingSource
    classified_fragment_count: int


def _grounding_source_for(fragment_count: int) -> GroundingSource:
    """Which source a reflection would draw on with this many fragments.

    Exact only while :func:`services.higher_self_grounding.gather_grounding`
    retrieves with no query embedding — the condition that makes any non-empty
    corpus answer. It also ignores ``exclude_entry_id``, so for the one account
    whose entire corpus derives from the single entry under reflection the
    reported source can differ from that request's actual source. Both limits
    are acceptable here and nowhere else: this field is reporting, and
    ``tests/services/test_voice_readiness.py`` carries a guard that fails loudly
    the day the first condition stops holding.
    """
    return GroundingSource.CORPUS if fragment_count > 0 else GroundingSource.RECENT_ENTRIES


def derive_voice_readiness(*, consented: bool, fragment_count: int) -> VoiceReadiness:
    """Decide the state from the two facts it depends on, and nothing else.

    Pure, so the three-way rule can be tested at its boundaries without a
    database. Consent is checked first because it is not a smaller version of
    being early: an account that has not agreed is not on the way to the
    threshold at all.
    """
    if not consented:
        state = VoiceReadinessState.NOT_CONSENTED
    elif fragment_count >= VOICE_READY_FRAGMENT_THRESHOLD:
        state = VoiceReadinessState.READY
    else:
        state = VoiceReadinessState.GATHERING
    return VoiceReadiness(
        state=state,
        # The single projection. Every other surface reads this boolean rather
        # than re-deciding which states count as ready, so the rule cannot come
        # to mean two different things in two places.
        ready=state is VoiceReadinessState.READY,
        grounding_source=_grounding_source_for(fragment_count),
        classified_fragment_count=fragment_count,
    )


async def load_voice_readiness(session: AsyncSession, *, user_id: int) -> VoiceReadiness:
    """Read the two facts for ``user_id`` and derive their readiness.

    Consent is read through :func:`services.corpus_consent.load_consent` rather
    than by consulting the event table here: that function owns what an
    unanswered account has agreed to, and a second reading of the same rule is
    a second place for it to drift away from the promise the privacy policy
    makes.
    """
    consent = await load_consent(session, user_id=user_id, source=CorpusSource.JOURNAL)
    fragment_count = await count_retrievable_fragments(session, user_id=user_id)
    return derive_voice_readiness(consented=consent.granted, fragment_count=fragment_count)
