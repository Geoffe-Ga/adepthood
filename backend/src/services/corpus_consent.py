"""Whether an account has agreed to ontologize a source, and the record of it.

ADR 0005 Decision 5 requires consent per source to be an auditable event rather
than an implicit state, and leaves the *shape* of that event to an ADR that has
not been written. This module chooses the conservative shape, which is the only
direction an unratified question may be settled in:

**Nothing is ontologized until somebody says so.** :data:`CONSENT_GRANTED_BY_DEFAULT`
is ``False``, so an account that has decided nothing has agreed to nothing and
:mod:`services.corpus_ingest` writes no fragment for it. ADR 0005's own open
question — "whether ontologizing an entry the user wrote in this app is itself
a consented act" — is answered here as *yes, it needs its own record*. Reading
it the other way would put every journal entry every existing account has ever
written into an operator-readable store on the strength of a deploy, and no
part of the ratified record authorises that.

**Withdrawal takes the writing with it.** A permission that can be revoked
while the material stays is a preference, not a permission. Revoking deletes
that source's fragments and records how many went, so the audit row is evidence
the purge ran rather than a claim that it did. This is deliberately narrower
than ADR 0005's open question about retention, which asks how long a fragment
kept under a *live* consent may live: that stays open, and nothing here
answers it.

**A grant reaches backwards too, and not from here.** Permission that only
changes the future would leave somebody who has been journaling for weeks with
a corpus of what they wrote after the switch and a recency window for
everything before it. :mod:`services.corpus_backfill` is what closes that, and
it lives outside this module because it goes through the ordinary corpus writer
and the writer reads its consent from here — so the sweep cannot be invoked
from inside the state it depends on. :func:`set_consent` therefore returns the
event it appended as well as the state, and the caller that owns the
transaction runs the sweep and records its count on that event.

**A decision is recorded once.** A client that re-sends the answer it already
gave has not made a decision, so no row is appended. The log holds decisions,
not requests, and a retry storm must not be able to make an account look as
though it agreed forty times.

**Cost.** One statement to read a source's state, and at most three to change
it — the read, the purge on a revocation, the append. Nothing scales with the
size of the log, because only its newest row per source is ever consulted.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.corpus_consent import ConsentDecision, CorpusConsentEvent
from models.corpus_fragment import CorpusSource
from services.corpus_store import delete_fragments_for_source

#: What an account that has decided nothing has agreed to. ``False``, and named
#: rather than implied, because the published privacy policy tells a reader the
#: corpus is filled only if they turn it on and
#: ``backend/tests/test_legal_documents.py`` holds that sentence to this
#: constant. Flipping it is a change to a promise, which is why it fails there.
CONSENT_GRANTED_BY_DEFAULT: Final[bool] = False

#: How many fragments a grant removes. A grant is not a purge; the column is
#: shared with revocations, and this is what a grant writes into it.
_NOTHING_REMOVED: Final[int] = 0


@dataclass(frozen=True)
class ConsentState:
    """What one account has currently decided about one source.

    ``decided_at`` is ``None`` for a source the account has never answered
    about, which is a different thing from a source it answered "no" to — one
    is a question still open and the other is a refusal on the record.
    """

    source: CorpusSource
    granted: bool
    decided_at: datetime | None


@dataclass(frozen=True)
class ConsentChange:
    """What one call to :func:`set_consent` produced.

    ``event`` is the row this call appended, and it is ``None`` when the client
    re-sent an answer the account had already given — the log holds decisions,
    not requests, so a repeat appends nothing to attach a count to. A caller
    with work to attribute to *this* decision writes the count onto ``event``
    before the commit; a caller looking at ``None`` is looking at a request
    that decided nothing.
    """

    state: ConsentState
    event: CorpusConsentEvent | None


async def _newest_event(
    session: AsyncSession, user_id: int, source: CorpusSource
) -> CorpusConsentEvent | None:
    """The account's most recent decision about ``source``, if it made one.

    Ordered by ``id`` rather than by ``recorded_at``: two decisions made inside
    the same clock tick are ordered by the sequence that assigned their ids,
    and a timestamp tie would otherwise resolve arbitrarily — on the one query
    whose answer is "may we?".
    """
    result = await session.execute(
        select(CorpusConsentEvent)
        .where(
            col(CorpusConsentEvent.user_id) == user_id,
            col(CorpusConsentEvent.source) == source.value,
        )
        .order_by(col(CorpusConsentEvent.id).desc())
        .limit(1)
    )
    return result.scalars().first()


def _state_of(source: CorpusSource, event: CorpusConsentEvent | None) -> ConsentState:
    """Project the newest event, or its absence, onto the current state."""
    if event is None:
        return ConsentState(source=source, granted=CONSENT_GRANTED_BY_DEFAULT, decided_at=None)
    return ConsentState(
        source=source,
        granted=event.decision == ConsentDecision.GRANTED.value,
        decided_at=event.recorded_at,
    )


async def load_consent(
    session: AsyncSession, *, user_id: int, source: CorpusSource
) -> ConsentState:
    """What ``user_id`` has currently decided about ``source``."""
    return _state_of(source, await _newest_event(session, user_id, source))


async def load_every_consent(session: AsyncSession, *, user_id: int) -> list[ConsentState]:
    """One state per source, in the enum's own order, decided or not.

    Every source is reported rather than only the answered ones: a surface that
    listed only past decisions could never offer the account the question it
    has not yet been asked, which is how a consent screen ends up unable to
    collect consent.
    """
    return [await load_consent(session, user_id=user_id, source=source) for source in CorpusSource]


async def set_consent(
    session: AsyncSession, *, user_id: int, source: CorpusSource, granted: bool
) -> ConsentChange:
    """Record ``user_id``'s decision about ``source`` and return what it produced.

    A decision that repeats the current state appends nothing and reports the
    state that was already there, with no event to attribute anything to. A
    revocation purges that source's fragments *before* the event is appended,
    so the count the row carries is the count that actually went; the caller
    owns the commit, so the purge and its receipt land together or not at all.

    A grant's own reach runs *after* this returns rather than inside it: the
    sweep goes through the corpus writer, and the writer reads the consent this
    function has just appended, so the event has to exist and be flushed before
    the first fragment can be written. See :mod:`services.corpus_backfill`.
    """
    current = await load_consent(session, user_id=user_id, source=source)
    if current.granted == granted:
        return ConsentChange(state=current, event=None)
    removed = (
        _NOTHING_REMOVED
        if granted
        else await delete_fragments_for_source(session, user_id=user_id, source=source)
    )
    event = CorpusConsentEvent(
        user_id=user_id,
        source=source.value,
        decision=(ConsentDecision.GRANTED if granted else ConsentDecision.REVOKED).value,
        fragments_removed=removed,
    )
    session.add(event)
    await session.flush()
    return ConsentChange(state=_state_of(source, event), event=event)
