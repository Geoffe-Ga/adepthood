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

**No pooled connection is held across the call.** The transaction is ended
immediately before the classifier is dialled, so the database connection an
ingest checked out is back in the pool while a language model is thinking. It
is a fact about capacity rather than about this writing --
:func:`_classify_and_record` carries the argument -- and it is what makes the
withdrawal above durable a few statements earlier than the caller's own commit
already made it.

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

**One spine, one writer today.** :func:`ingest_content` is the source-agnostic
spine -- the consent gate, the one-call ceiling, the tier refusal, the store --
and journal writing composed in this app is its only caller. A document brought
in from outside used to be its second caller; since #3016 a document goes to the
account's vault or nowhere (#3015), so nothing else reaches the local corpus.
What stays in the journal wrapper is only what is genuinely about a journal
*row* -- its id, its soft-delete, and the replacement of the fragment it had
before.

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
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from domain.privacy_tier import admits_egress
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.journal_entry import JournalClassification, JournalEntry
from security import sanitize_user_text
from services.botmason import LLMCreditExhaustedError
from services.classification_ceiling import (
    classifications_today,
    record_classification_attempt,
    release_classification_attempt,
)
from services.corpus_consent import load_consent
from services.corpus_store import FragmentDraft, delete_fragments_for_entry, record_fragment
from services.frequency_classification import (
    IntimateContentRefusedError,
    classify_frequencies,
)
from services.privacy_lineage import LineageOperation, observe_entry_lineage
from services.reflection_boundary import ReflectionBoundary
from services.usage import get_daily_classification_ceiling

logger = logging.getLogger(__name__)

#: The log line written when an account's day's allowance of server-paid
#: classifications is spent: the account and this word only, no writing. It is
#: a WARNING rather than INFO because it is the condition an operator wants to
#: see before a bill arrives, and the only signal that says so -- a refused
#: classification writes no usage row, so nothing downstream would report it.
CLASSIFICATION_CEILING_EVENT: Final[str] = "corpus_classification_ceiling_reached"

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

    Six outcomes and exactly one of them stores anything. They are named
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
    #: The writer's AI operations are bound to their vault, and the only
    #: classifier this spine can call is the app provider's (#3156). Not
    #: :attr:`UNCLASSIFIED`: nothing was asked, so nothing was found wanting.
    BOUNDARY_REFUSED = "boundary_refused"
    #: This account has already used its day's allowance of server-paid
    #: classifications (:func:`services.usage.get_daily_classification_ceiling`).
    #: Not :attr:`UNCLASSIFIED`, for the reason :attr:`BOUNDARY_REFUSED` is not:
    #: no provider was asked, so nothing was found wanting. The writing keeps no
    #: fragment and stays pending, so the next edit or sweep offers it again --
    #: tomorrow, against a fresh day's allowance.
    CEILING_REACHED = "ceiling_reached"


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


@dataclass(frozen=True)
class _StagedAttempt:
    """The allowance one ingest has reserved, named so it can be given back.

    Returned by :func:`_refusal_before_classifying` when every refusal has been
    ruled out. It carries the attempt row's id because the one compensation the
    spine makes -- for a call the provider refused to bill -- has to release
    exactly that row and no other.
    """

    attempt_id: int


# The three non-storing results are value-identical every time, so they are
# interned rather than rebuilt on each path.
_NO_CONSENT_RESULT = IngestResult(IngestOutcome.NO_CONSENT)
_TIER_REFUSED_RESULT = IngestResult(IngestOutcome.TIER_REFUSED)
_UNCLASSIFIED_RESULT = IngestResult(IngestOutcome.UNCLASSIFIED)
_BOUNDARY_REFUSED_RESULT = IngestResult(IngestOutcome.BOUNDARY_REFUSED)
_CEILING_REACHED_RESULT = IngestResult(IngestOutcome.CEILING_REACHED)

# What the journal path's log line calls each non-storing outcome. A mapping
# rather than a chain of branches so it is total by construction: an outcome
# added later fails here loudly instead of being logged under someone else's
# name.
_JOURNAL_LOG_OUTCOMES: Final[Mapping[IngestOutcome, str]] = MappingProxyType(
    {
        IngestOutcome.NO_CONSENT: "no_consent",
        IngestOutcome.TIER_REFUSED: "withdrawn",
        IngestOutcome.UNCLASSIFIED: "unclassified",
        IngestOutcome.BOUNDARY_REFUSED: "boundary_refused",
        IngestOutcome.CEILING_REACHED: "ceiling_reached",
    }
)


async def _classify_and_record(
    session: AsyncSession,
    *,
    user_id: int,
    request: IngestRequest,
    boundary: ReflectionBoundary,
    timeout_seconds: float | None,
) -> IngestResult:
    """Classify this writing and store it, or report that it recognised nothing.

    The single provider call :data:`CLASSIFICATION_CALLS_PER_INGEST` names is
    made here and nowhere else, which is what makes that constant assertable
    rather than aspirational. It is also why the commit below it is here rather
    than at any of the four callers: one statement in front of the one call
    closes the hold for all of them, and a fifth caller added later cannot
    forget it.

    **The commit is about the pool, not about durability.** A Session autobegins
    on its first statement and holds that transaction -- and therefore a
    checked-out connection -- across every later ``await``. Every caller arrives
    here with one already open and dirty: the journal router has just refreshed
    the row it committed, the import router has read the account's consent, and
    the sweep has flushed the consent event that authorised it. Left in place it
    would be held for the length of a provider climb, so pool capacity would be
    governed by a language model's latency rather than by our own query time --
    with the engine at SQLAlchemy's defaults, five plus ten overflow, fifteen
    concurrent ingests would spend the pool and the sixteenth request to *any*
    database-backed endpoint would block on checkout. It is the same invariant
    :func:`routers.journal._record_vault_outcome` commits before its own network
    call to protect, and :func:`services.creek_vault_pipeline._run_stage` after
    it.

    Unconditional, because everything the ingest reads or writes is already
    behind it and the provider call is directly in front. What lands early is
    therefore the consent read, and -- on an edit -- the withdrawal of the
    fragment the entry had before. Both are things this module has always
    performed before classifying, deliberately: see :func:`ingest_journal_entry`
    for why the withdrawal leads.

    Nothing needs rolling back if the classifier raises. The commit ended the
    transaction and no statement has been issued since, so a refusal, an outage
    or a spent balance leaves the session clean for the caller to carry on with.
    """
    await session.commit()
    classification = await classify_frequencies(
        request.content,
        classification=request.tier,
        boundary=boundary,
        timeout_seconds=timeout_seconds,
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


async def _afford_one_classification(session: AsyncSession, user_id: int) -> int | None:
    """Spend one of ``user_id``'s day's server-paid classifications, or refuse.

    Called after both of the spine's refusals and before the dial, so an
    account is charged for a call only once every reason not to make one has
    been ruled out, and is never charged for one that did not happen.

    **The attempt is recorded, not the outcome.** The provider call is what the
    deployment pays for, so a classification that fails or recognises nothing
    has still spent one. Recording successes only would leave a degraded
    provider free to retry against, which is the condition under which a bill
    runs away fastest.

    **Except a refusal to bill (release decision R1-2, #3516).** When the
    deployment's own provider balance is spent the provider raises
    :class:`services.botmason.LLMCreditExhaustedError`; the call cost nobody
    anything and the cause is the deployment's, not the account's, so
    :func:`ingest_content` releases the attempt staged here, by its id, and
    commits the release. The staging still precedes the dial -- the release is
    a compensating delete, never a reordering -- so every other failure, a
    degraded provider included, stays counted.

    The row is staged rather than committed: it lands in the commit
    :func:`_classify_and_record` makes immediately before the provider call, so
    it is durable by the time the dial happens and survives the caller rolling
    back whatever came after.

    Returns:
        The staged attempt's id when a classification may be made, so it can be
        released if the provider refuses to bill. ``None`` when the day's
        allowance is spent, having staged nothing.
    """
    now = datetime.now(UTC)
    if await classifications_today(session, user_id, now) >= get_daily_classification_ceiling():
        logger.warning(CLASSIFICATION_CEILING_EVENT, extra={"user_id": user_id})
        return None
    return await record_classification_attempt(session, user_id, now)


async def _refusal_before_classifying(
    session: AsyncSession,
    *,
    user_id: int,
    source: CorpusSource,
    tier: JournalClassification,
    boundary: ReflectionBoundary,
) -> IngestResult | _StagedAttempt:
    """Every reason not to classify this writing, or the call it has reserved.

    Four refusals in one place, because they are one question -- may this
    deployment ask the app provider about this writing, on this account's
    behalf, right now? They are ordered cheapest and most categorical first: a
    permission not given, then a writer whose AI operations are somebody else's
    to answer, then writing that never leaves this boundary at all, then an
    allowance already spent. An account must not spend its day's allowance on a
    call that any of the first three would have refused anyway, which is why
    the ceiling is asked last.

    Consent is read against *this request's own source*, so agreeing to
    ontologize journal entries is not agreement to ontologize imported
    documents -- ADR 0005 rejects reading one permission off another in as many
    words.

    **The tier is asked here as well as below, and that is not redundant.**
    :func:`services.frequency_classification.classify_frequencies` refuses an
    intimate tier before it constructs a provider call, and the store refuses
    one again before it writes; both still stand, and the ``except`` in
    :func:`ingest_content` still reports them. What this adds is only
    *ordering*: without it the ceiling is charged before either refusal is
    reached, so an account journalling privately would spend its day's
    allowance on calls that were never going to be made and find its later
    personal entries refused for it. Asking :func:`admits_egress` is not this
    module stating a tier rule of its own -- it is the one predicate that owns
    the rule, the same one the classifier and the store consult, and the same
    one :func:`_withheld_from_classifier`'s ``RETRIEVABLE_TIERS`` is read off.

    **It reserves as well as refuses.** Returning a :class:`_StagedAttempt` has staged one
    attempt against the account, because the only honest moment to record a
    call is the one after which it is going to be made. There is no separate
    "now actually spend it" step a caller could forget, and no path from here
    to the provider that skips the meter.

    Returns:
        The refusal to report, or the staged attempt when the classifier may be
        called.
    """
    consent = await load_consent(session, user_id=user_id, source=source)
    if not consent.granted:
        return _NO_CONSENT_RESULT
    if boundary is ReflectionBoundary.VAULT_BOUND:
        return _BOUNDARY_REFUSED_RESULT
    if not admits_egress(tier.value):
        return _TIER_REFUSED_RESULT
    attempt_id = await _afford_one_classification(session, user_id)
    if attempt_id is None:
        return _CEILING_REACHED_RESULT
    return _StagedAttempt(attempt_id)


async def ingest_content(
    session: AsyncSession,
    *,
    user_id: int,
    request: IngestRequest,
    boundary: ReflectionBoundary,
    timeout_seconds: float | None = None,
) -> IngestResult:
    """Put one piece of writing into ``user_id``'s corpus, or say why not.

    The shared spine both sources run through. Consent is checked first and
    against *this request's own source*, so agreeing to ontologize journal
    entries is not agreement to ontologize imported documents -- ADR 0005
    rejects reading one permission off another in as many words.

    One commit is made, and it is not a durability decision: the transaction is
    ended immediately before the provider call so that no pooled connection is
    held across the network, as :func:`_classify_and_record` sets out. Whatever
    the caller had open at that point lands there, and the fragment written
    afterwards is left to the caller as it always was.

    Raises for exactly one condition, and it is not a tier rule. The tier
    refusals raised by the classifier and by the store are caught here and
    reported, because a tier that cannot be ontologized is an ordinary answer to
    give a person rather than a fault to propagate at them -- and catching
    *both* is what keeps this module from stating a tier rule of its own.
    :class:`services.botmason.LLMCreditExhaustedError` is logged here, where the
    account is known, and re-raised, because it is a fact about the deployment
    rather than about this writing -- and, by release decision R1-2, not the
    account's to pay for either, so the attempt staged against its daily
    allowance is released before the raise. Reporting it as
    :attr:`IngestOutcome.UNCLASSIFIED` would tell a caller offering a hundred
    entries that the provider recognised nothing in any of them, and it would go
    on paying for that answer. Callers that offer one piece of writing catch it
    and carry on; the one that offers a batch stops.

    ``boundary`` is the writer's
    :class:`~services.reflection_boundary.ReflectionBoundary`, resolved by the
    caller from server state and required so that no caller can omit it
    (#3156). Under ``VAULT_BOUND`` this answers
    :attr:`IngestOutcome.BOUNDARY_REFUSED` after the consent gate and before the
    commit and the classifier: the only classifier this spine can call is the
    app provider, and a writer who connected a vault never has their writing
    answered by it. No vault classification is asked for instead -- no vault
    serves a classify adepthood may call yet (see
    :mod:`services.frequency_source`) -- so the honest answer is "not ingested",
    and the next edit or sweep offers the entry again.

    ``timeout_seconds`` is passed straight to the classifier and bounds only
    the provider call. It is stated at the call rather than carried on
    :class:`IngestRequest` because it is a fact about *this caller's patience*,
    not about the writing: one payload offered by a request somebody is waiting
    on and by a sweep with a deadline is the same payload with two different
    budgets. ``None`` -- the default -- leaves the provider layer's own timeout
    and retry budget in charge, which is what every interactive write wants.
    """
    reserved = await _refusal_before_classifying(
        session,
        user_id=user_id,
        source=request.source,
        tier=request.tier,
        boundary=boundary,
    )
    if isinstance(reserved, IngestResult):
        return reserved
    try:
        return await _classify_and_record(
            session,
            user_id=user_id,
            request=request,
            boundary=boundary,
            timeout_seconds=timeout_seconds,
        )
    except IntimateContentRefusedError:
        return _TIER_REFUSED_RESULT
    except LLMCreditExhaustedError as exc:
        _log_credit_exhausted(user_id, provider=exc.provider, source=request.source)
        await _release_unbilled_attempt(session, user_id=user_id, attempt=reserved)
        raise


async def ingest_journal_entry(
    session: AsyncSession,
    entry: JournalEntry,
    *,
    boundary: ReflectionBoundary,
    timeout_seconds: float | None = None,
) -> CorpusFragment | None:
    """Write ``entry`` into its account's corpus, replacing what it had there.

    Returns the fragment, or ``None`` when the entry did not become one — no
    consent, the intimate tier, a soft-deleted or legacy sanitized-empty row, a
    provider that was down, or a reply that recognised no frequency. Every one
    of those is an ordinary outcome; none of them raises, because classification
    enriches a corpus and is never why a journal write fails.

    The single carve-out is :func:`ingest_content`'s:
    :class:`services.botmason.LLMCreditExhaustedError` propagates, because it is
    not a fact about *this* entry and a caller offering many of them has to be
    able to stop. Callers offering one entry catch it and carry on, so a journal
    write still cannot fail on it.

    Consent is read here as well as inside :func:`ingest_content`, and the
    duplication is deliberate: it is what keeps the purge below from running
    for an account that has agreed to nothing. Since
    :data:`services.corpus_consent.CONSENT_GRANTED_BY_DEFAULT` is ``False``,
    that is the *majority* of journal writes, and they stay at exactly one
    query -- the second read happens only on the path that is about to make a
    provider call anyway. The authoritative gate is still the one in
    ``ingest_content``, so a third source added later cannot forget it.

    The withdrawal of the previous fragment lands before its replacement is
    attempted rather than beside it, because the ingest commits on its way to
    the provider -- see :func:`_classify_and_record` for why. That is the order
    this module already kept and the one the tier rules need: a re-tier to
    intimate refuses *inside* the classifier and a soft-deleted row returns
    before it, so on both of those paths the withdrawal is the only thing that
    happens, and classifying first would leave the corpus quoting writing the
    account has since marked unquotable. An edit the classifier cannot place
    therefore leaves no fragment rather than a stale one, durably; the entry
    stays a candidate and the next edit or sweep offers it again.

    ``boundary`` is the entry owner's resolved boundary. Under ``VAULT_BOUND``
    the previous fragment is still withdrawn -- the corpus must not go on
    quoting what the entry no longer says -- but nothing is classified and the
    outcome is logged as ``boundary_refused``: ids and that word only. The
    shadow lineage observation is skipped too, because no body is about to
    leave. See :func:`ingest_content`.

    ``timeout_seconds`` bounds the provider call and nothing else; see
    :func:`ingest_content`.
    """
    entry_id = entry.id
    if entry_id is None:
        return None
    body = sanitize_user_text(entry.message)
    if not body:
        # Rows written before the journal boundary rejected sanitized-empty
        # bodies may still be selected by a consent backfill. Remove any old
        # fragment first, then stop before consent or provider work: an empty
        # row has an explicit withdrawn disposition and can never become
        # reflection grounding.
        removed = await delete_fragments_for_entry(
            session, user_id=entry.user_id, entry_id=entry_id
        )
        _log_outcome(entry.user_id, entry_id, "empty_withdrawn", removed)
        return None
    consent = await load_consent(session, user_id=entry.user_id, source=INGEST_SOURCE)
    if not consent.granted:
        return None
    removed = await delete_fragments_for_entry(session, user_id=entry.user_id, entry_id=entry_id)
    withheld = _withheld_from_classifier(entry, boundary)
    if withheld is not None:
        _log_outcome(entry.user_id, entry_id, withheld, removed)
        return None
    # Shadow only (#3059): consent is granted and the entry is live, so its body
    # is about to go to the classifier. ``_classify_and_record`` commits before
    # it dials, so this read is released with the rest.
    await observe_entry_lineage(session, LineageOperation.CORPUS_INGEST, entry)
    result = await ingest_content(
        session,
        user_id=entry.user_id,
        request=IngestRequest(
            content=body,
            tier=JournalClassification(entry.classification),
            source=INGEST_SOURCE,
            source_entry_id=entry_id,
        ),
        boundary=boundary,
        timeout_seconds=timeout_seconds,
    )
    return _journal_fragment(result, user_id=entry.user_id, entry_id=entry_id, removed=removed)


def _withheld_from_classifier(entry: JournalEntry, boundary: ReflectionBoundary) -> str | None:
    """Why a consented entry's old fragment is withdrawn and nothing replaces it, if it is.

    ``"withdrawn"`` for a soft-deleted row: invisible to every other read path,
    it must not be classified back into view, and the deletion is read off the
    persisted row rather than off anything a client sent. ``"boundary_refused"``
    for a vault-bound owner (#3156): the classifier is the app provider, which
    never answers them. ``None`` when the entry may be offered.
    """
    if entry.deleted_at is not None:
        return "withdrawn"
    if boundary is ReflectionBoundary.VAULT_BOUND:
        return _JOURNAL_LOG_OUTCOMES[IngestOutcome.BOUNDARY_REFUSED]
    return None


def _journal_fragment(
    result: IngestResult, *, user_id: int, entry_id: int, removed: int
) -> CorpusFragment | None:
    """Return a stored fragment, logging every ordinary non-storage outcome."""
    if result.outcome is not IngestOutcome.STORED:
        _log_outcome(user_id, entry_id, _JOURNAL_LOG_OUTCOMES[result.outcome], removed)
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


async def _release_unbilled_attempt(
    session: AsyncSession, *, user_id: int, attempt: _StagedAttempt
) -> None:
    """Give back the attempt a refusal to bill staged, and make that durable.

    Release decision R1-2 (#3516): a classification the deployment's provider
    refused for lack of credit is absorbed as overhead and does not count
    against the account's daily allowance. Committed here rather than left to
    the callers, because the spine cannot know what each does next: the sweep
    stops its batch on this error without committing, and the journal save
    suppresses it and commits only as a matter of its own housekeeping. Nothing
    else is pending to land with it -- :func:`_classify_and_record` ended the
    transaction before it dialled and nothing has been written since.
    """
    await release_classification_attempt(session, user_id=user_id, attempt_id=attempt.attempt_id)
    await session.commit()


def _log_credit_exhausted(user_id: int, *, provider: str, source: CorpusSource) -> None:
    """Record that a provider refused to bill, in ids and a provider name only.

    The one line that names the account, and it sits on the shared spine rather
    than at each caller so that adding a third source cannot forget it.
    WARNING because nobody the writer is can act on it: this path never threads
    a caller's own key, so the balance that ran out is the deployment's and the
    remedy is an operator's. The same discipline :func:`_log_outcome` keeps --
    an operator has to be able to say which account stopped being ontologized,
    and by which provider, without reading a word of what was in it.
    """
    logger.warning(
        "corpus_ingest_credit_exhausted",
        extra={"user_id": user_id, "provider": provider, "source": source.value},
    )


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
