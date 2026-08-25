"""Turn one piece of a person's writing into a corpus fragment, or decline to.

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

**INTIMATE is not re-decided here.** The tier is refused by *calling through*
to :func:`services.frequency_classification.classify_frequencies`, which raises
before a provider call is even constructed, and to
:func:`services.corpus_store.record_fragment`, whose allowlist refuses before a
row object exists. Both refusals are caught and reported as
:attr:`IngestOutcome.TIER_REFUSED`. That is deliberately not a fourth reading of
the rule: this module states no tier predicate of its own, so a tier the store
stops admitting is a tier this module stops offering, with no edit here.
Re-tiering an entry to intimate withdraws whatever it had already put in the
corpus, mirroring the vault path's clearing of a ref an entry no longer consents
to expose.

**Two sources, one writer.** Journal writing composed in this app and a document
imported from outside it are the same act as far as the corpus is concerned:
the same consent gate, the same one-call ceiling, the same tier refusal, the
same store. :func:`ingest_content` is that shared spine and
:mod:`services.corpus_import` is its second caller. What stays here is only
what is genuinely about a journal *row* -- its id, its soft-delete, and the
replacement of the fragment it had before.

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

import enum
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from models.corpus_fragment import CorpusFragment, CorpusSource
from models.journal_entry import JournalClassification, JournalEntry
from services.corpus_consent import load_consent
from services.corpus_store import FragmentDraft, delete_fragments_for_entry, record_fragment
from services.frequency_classification import (
    IntimateContentRefusedError,
    classify_frequencies,
)

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


class IngestOutcome(enum.StrEnum):
    """What became of one attempt to put writing into a corpus.

    Four outcomes and exactly one of them stores anything. They are named
    rather than collapsed into ``fragment is None`` because a *caller with a
    user in front of it* has to say which of them happened: "you have not
    agreed to this yet", "that tier never enters the corpus" and "nothing in
    this recognised a frequency" are three different sentences with three
    different next steps, and a bare ``None`` is none of them.
    """

    STORED = "stored"
    NO_CONSENT = "no_consent"
    TIER_REFUSED = "tier_refused"
    UNCLASSIFIED = "unclassified"


@dataclass(frozen=True)
class IngestRequest:
    """One piece of writing offered to a corpus, apart from whose it is.

    A value rather than four parameters, for the reason
    :class:`services.corpus_store.FragmentDraft` is one: the account is
    supplied at the call, where a scoping mistake is visible, rather than
    buried in a payload that could be built once and reused.

    ``source_entry_id`` names the journal row this writing came from when there
    was one. An imported document has none, which is exactly the difference
    between the two sources.
    """

    content: str
    tier: JournalClassification
    source: CorpusSource
    source_entry_id: int | None = None


@dataclass(frozen=True)
class IngestResult:
    """What one ingest did, and the fragment if it made one.

    ``fragment`` is populated only for :attr:`IngestOutcome.STORED`, so a
    caller reads the outcome and never has to infer it from a field's presence.
    """

    outcome: IngestOutcome
    fragment: CorpusFragment | None = None


# The three non-storing results are value-identical every time, so they are
# interned rather than rebuilt on each path.
_NO_CONSENT_RESULT = IngestResult(IngestOutcome.NO_CONSENT)
_TIER_REFUSED_RESULT = IngestResult(IngestOutcome.TIER_REFUSED)
_UNCLASSIFIED_RESULT = IngestResult(IngestOutcome.UNCLASSIFIED)

# What the journal path's log line calls each non-storing outcome. A mapping
# rather than a chain of branches so it is total by construction: an outcome
# added later fails here loudly instead of being logged under someone else's
# name.
_JOURNAL_LOG_OUTCOMES: Final[Mapping[IngestOutcome, str]] = MappingProxyType(
    {
        IngestOutcome.NO_CONSENT: "no_consent",
        IngestOutcome.TIER_REFUSED: "withdrawn",
        IngestOutcome.UNCLASSIFIED: "unclassified",
    }
)


async def _classify_and_record(
    session: AsyncSession,
    *,
    user_id: int,
    request: IngestRequest,
    timeout_seconds: float | None,
) -> IngestResult:
    """Classify this writing and store it, or report that it recognised nothing.

    The single provider call :data:`CLASSIFICATION_CALLS_PER_INGEST` names is
    made here and nowhere else, which is what makes that constant assertable
    rather than aspirational.
    """
    classification = await classify_frequencies(
        request.content, classification=request.tier, timeout_seconds=timeout_seconds
    )
    if not classification.is_classified():
        return _UNCLASSIFIED_RESULT
    fragment = await record_fragment(
        session,
        user_id=user_id,
        draft=FragmentDraft(
            content=request.content,
            tier=request.tier,
            source=request.source,
            classification=classification,
            source_entry_id=request.source_entry_id,
        ),
    )
    return IngestResult(IngestOutcome.STORED, fragment)


async def ingest_content(
    session: AsyncSession,
    *,
    user_id: int,
    request: IngestRequest,
    timeout_seconds: float | None = None,
) -> IngestResult:
    """Put one piece of writing into ``user_id``'s corpus, or say why not.

    The shared spine both sources run through. Consent is checked first and
    against *this request's own source*, so agreeing to ontologize journal
    entries is not agreement to ontologize imported documents -- ADR 0005
    rejects reading one permission off another in as many words.

    Nothing is committed: a fragment is almost always written alongside the
    thing it was derived from, and the caller owns that transaction.

    Never raises. The tier refusals raised by the classifier and by the store
    are caught here and reported, because a tier that cannot be ontologized is
    an ordinary answer to give a person rather than a fault to propagate at
    them -- and catching *both* is what keeps this module from stating a tier
    rule of its own.

    ``timeout_seconds`` is passed straight to the classifier and bounds only
    the provider call. It is stated at the call rather than carried on
    :class:`IngestRequest` because it is a fact about *this caller's patience*,
    not about the writing: one payload offered by a request somebody is waiting
    on and by a sweep with a deadline is the same payload with two different
    budgets. ``None`` -- the default -- leaves the provider layer's own timeout
    and retry budget in charge, which is what every interactive write wants.
    """
    consent = await load_consent(session, user_id=user_id, source=request.source)
    if not consent.granted:
        return _NO_CONSENT_RESULT
    try:
        return await _classify_and_record(
            session, user_id=user_id, request=request, timeout_seconds=timeout_seconds
        )
    except IntimateContentRefusedError:
        return _TIER_REFUSED_RESULT


async def ingest_journal_entry(
    session: AsyncSession, entry: JournalEntry, *, timeout_seconds: float | None = None
) -> CorpusFragment | None:
    """Write ``entry`` into its account's corpus, replacing what it had there.

    Returns the fragment, or ``None`` when the entry did not become one — no
    consent, the intimate tier, a soft-deleted row, a provider that was down,
    or a reply that recognised no frequency. Every one of those is an ordinary
    outcome; none of them raises, because classification enriches a corpus and
    is never why a journal write fails.

    Consent is read here as well as inside :func:`ingest_content`, and the
    duplication is deliberate: it is what keeps the purge below from running
    for an account that has agreed to nothing. Since
    :data:`services.corpus_consent.CONSENT_GRANTED_BY_DEFAULT` is ``False``,
    that is the *majority* of journal writes, and they stay at exactly one
    query -- the second read happens only on the path that is about to make a
    provider call anyway. The authoritative gate is still the one in
    ``ingest_content``, so a third source added later cannot forget it.

    Nothing is committed. The caller owns the transaction, so the withdrawal of
    the previous fragment and the arrival of its replacement land together.

    ``timeout_seconds`` bounds the provider call and nothing else; see
    :func:`ingest_content`.
    """
    entry_id = entry.id
    if entry_id is None:
        return None
    consent = await load_consent(session, user_id=entry.user_id, source=INGEST_SOURCE)
    if not consent.granted:
        return None
    removed = await delete_fragments_for_entry(session, user_id=entry.user_id, entry_id=entry_id)
    if entry.deleted_at is not None:
        # A soft-deleted row is invisible to every other read path and must not
        # be classified back into view. Read off the persisted row rather than
        # off anything a client sent.
        _log_outcome(entry.user_id, entry_id, "withdrawn", removed)
        return None
    result = await ingest_content(
        session,
        user_id=entry.user_id,
        request=IngestRequest(
            content=entry.message,
            tier=JournalClassification(entry.classification),
            source=INGEST_SOURCE,
            source_entry_id=entry_id,
        ),
        timeout_seconds=timeout_seconds,
    )
    if result.outcome is not IngestOutcome.STORED:
        _log_outcome(entry.user_id, entry_id, _JOURNAL_LOG_OUTCOMES[result.outcome], removed)
    return result.fragment


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
