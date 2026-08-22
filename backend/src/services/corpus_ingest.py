"""Turn a journal entry into a corpus fragment, or decline to.

This is the writer the ontologized corpus did not have. Until it existed
:func:`services.corpus_store.record_fragment` had no production caller at all,
so :func:`services.higher_self_grounding.gather_grounding` resolved to its
recency-window fallback for every account in every deployment, permanently.
The corpus branch was correct, tested, and unreachable.

**When.** On the write, immediately after the entry has been committed, and
again on an edit that changes the body or the tier. Two properties follow from
that ordering and neither is incidental. The row is durable before a provider
is contacted, so a slow or failing classification can never be why somebody
loses what they wrote. And the corpus holds what the entry says *now*: the
withdrawal of the old fragment happens before the new one is attempted, so a
classification that fails on edited text leaves no fragment rather than a stale
one the Higher Self would go on quoting.

There is no scheduler in this deployment, so "later" is not an option that
exists — a deferred pass would be a queue, a worker and a delivery guarantee,
none of which is here. Doing it inline is the honest spelling of what the
deployment can actually do, and it is what the vault write path at
:func:`routers.journal._record_vault_outcome` already does with a thirty-second
network dependency on the same request.

**Cost.** :data:`CLASSIFICATION_CALLS_PER_INGEST` — one provider call per
ingest, and an ingest happens on a create and on an edit that changes the body
or the tier. A title, a status or a chord edit costs nothing. Nothing else in
the deployment classifies, so an account's whole classification bill is one
call per thing they wrote plus one per time they rewrote it. The per-call input
is bounded by the classifier's own ``MAX_FRAGMENT_CHARS``.

**One entry is one fragment, and it is the whole entry.** No chunking: a
journal entry is already a bounded unit somebody wrote in one sitting, and the
body is capped at ``schemas.journal.JOURNAL_MESSAGE_MAX_LENGTH`` before it is
ever a row. The classifier truncates its own *input* at ``MAX_FRAGMENT_CHARS``,
which is smaller — a long entry is classified on its opening rather than
refused — but what is stored is the entry as written, because a fragment that
held only the part the classifier read would quote somebody back a truncated
version of their own sentence.

**Consent gates the call, not the storage.** An account that has not agreed has
its writing sent nowhere — the provider is never contacted, rather than
contacted and its answer discarded. Sending the body to a cloud provider and
then declining to keep the result would already have done the thing consent
exists to permit. See :mod:`services.corpus_consent` for why the default is no.

**INTIMATE is not re-decided here.** An intimate entry is dropped before the
classifier, which is the ordering :mod:`services.frequency_classification` and
:mod:`services.creek_vault_write` both use and for the reason they both give.
That is not a fourth reading of the rule: the store's three barriers are what
would refuse the tier if this module offered it, and this module simply never
does. Re-tiering an entry to intimate withdraws whatever it had already put in
the corpus, mirroring the vault path's clearing of a ref an entry no longer
consents to expose.

**An unclassified entry is not corpus material.** A provider outage and a reply
that recognises no frequency both leave the corpus untouched. The corpus earns
its place by being *ontologized*: retrieval ranks on where a fragment sits among
the ten frequencies, so a fragment with no position could only ever be retrieved
by recency — which would make the corpus the very thing it replaced, while the
grounding source still reported ``corpus``. Backfilling entries that were
written before consent, or during an outage, is separate work that ADR 0005
already scopes out of the writer.
"""

from __future__ import annotations

import logging
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from models.corpus_fragment import CorpusFragment, CorpusSource
from models.journal_entry import JournalClassification, JournalEntry
from services.corpus_consent import load_consent
from services.corpus_store import FragmentDraft, delete_fragments_for_entry, record_fragment
from services.frequency_classification import classify_frequencies

logger = logging.getLogger(__name__)

#: The source every fragment this module writes carries, and the source whose
#: consent it reads. Journal writing is what an account composes here, as
#: distinct from what an import surface brings in from elsewhere.
INGEST_SOURCE: Final[CorpusSource] = CorpusSource.JOURNAL

#: Provider calls one ingest may make. One, and the constant exists so the
#: ceiling is asserted rather than assumed: this cost is multiplied by the size
#: of somebody's journal, so a second call slipping in is a doubling of the
#: bill for every account at once.
CLASSIFICATION_CALLS_PER_INGEST: Final[int] = 1


def _is_ingestable(entry: JournalEntry) -> bool:
    """Whether this entry is one the corpus may hold a fragment of.

    Both tests read the persisted row rather than anything a client sent. A
    soft-deleted entry is invisible to every other read path and must not be
    classified back into view, and an intimate entry is refused before a
    provider is reached at all.
    """
    return entry.deleted_at is None and entry.classification != JournalClassification.INTIMATE.value


async def ingest_journal_entry(session: AsyncSession, entry: JournalEntry) -> CorpusFragment | None:
    """Write ``entry`` into its account's corpus, replacing what it had there.

    Returns the fragment, or ``None`` when the entry did not become one — no
    consent, the intimate tier, a soft-deleted row, a provider that was down,
    or a reply that recognised no frequency. Every one of those is an ordinary
    outcome; none of them raises, because classification enriches a corpus and
    is never why a journal write fails.

    Nothing is committed. The caller owns the transaction, so the withdrawal of
    the previous fragment and the arrival of its replacement land together.
    """
    entry_id = entry.id
    if entry_id is None:
        return None
    consent = await load_consent(session, user_id=entry.user_id, source=INGEST_SOURCE)
    if not consent.granted:
        return None
    removed = await delete_fragments_for_entry(session, user_id=entry.user_id, entry_id=entry_id)
    if not _is_ingestable(entry):
        _log_outcome(entry.user_id, entry_id, "withdrawn", removed)
        return None
    classification = await classify_frequencies(
        entry.message,
        classification=JournalClassification(entry.classification),
    )
    if not classification.is_classified():
        _log_outcome(entry.user_id, entry_id, "unclassified", removed)
        return None
    return await record_fragment(
        session,
        user_id=entry.user_id,
        draft=FragmentDraft(
            content=entry.message,
            tier=JournalClassification(entry.classification),
            source=INGEST_SOURCE,
            classification=classification,
            source_entry_id=entry_id,
        ),
    )


async def withdraw_journal_entry(session: AsyncSession, *, user_id: int, entry_id: int) -> int:
    """Take one entry's writing back out of the corpus; return what was removed.

    Called when an entry is deleted. ADR 0005 leaves the lifetime of a fragment
    open; it does not leave open whether writing an account has deleted may go
    on being sent to a language model as context for a newer entry, and a
    corpus copy that outlived the delete would do exactly that.
    """
    removed = await delete_fragments_for_entry(session, user_id=user_id, entry_id=entry_id)
    _log_outcome(user_id, entry_id, "withdrawn", removed)
    return removed


def _log_outcome(user_id: int, entry_id: int, outcome: str, removed: int) -> None:
    """Record what an ingest did, in ids and counts and never in content.

    The same discipline the grounding log keeps: an operator has to be able to
    say whether an account's corpus is being written to, without reading a word
    of what is in it.
    """
    logger.info(
        "corpus_ingest",
        extra={
            "user_id": user_id,
            "entry_id": entry_id,
            "outcome": outcome,
            "fragments_removed": removed,
        },
    )
