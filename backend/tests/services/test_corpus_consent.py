"""Consent to ontologize a source, recorded as events rather than as a flag.

ADR 0005 Decision 5 requires consent for a source to be an auditable event.
That is a claim about the *shape* of the record, so the tests here are about
shape as much as behaviour.

**The default is no.** An account that has decided nothing has consented to
nothing, and the corpus writer reads that as a refusal. A default of yes would
turn every journal entry ever written into material for an operator-readable
store on the strength of a deploy, which is precisely the implicit state the
ADR refuses.

**A decision is appended, never overwritten.** Revoking does not erase the
grant that preceded it; it lands after it. So "when did this account agree to
this?" survives the account changing its mind, which is the only question an
audit record exists to answer.

**Revoking reaches the corpus.** Consent that can be withdrawn without the
writing going with it is a setting, not a permission. The revocation records
how many fragments it removed, for the same reason
``AccountDeletionAudit.row_counts`` records what erasure reached: a count is
evidence a sweep ran and says nothing about what it swept.
"""

from __future__ import annotations

from types import MappingProxyType

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.frequencies import Frequency
from models.corpus_consent import ConsentDecision, CorpusConsentEvent
from models.corpus_fragment import CorpusSource
from models.journal_entry import JournalClassification
from services.corpus_consent import (
    CONSENT_GRANTED_BY_DEFAULT,
    load_consent,
    load_every_consent,
    set_consent,
)
from services.corpus_store import FragmentDraft, record_fragment, retrieve_fragments
from services.frequency_classification import FrequencyClassification

_OWNER = 1
_STRANGER = 2


async def _fragment(session: AsyncSession, content: str, source: CorpusSource) -> None:
    """Put one fragment of ``source`` into the owner's corpus."""
    await record_fragment(
        session,
        user_id=_OWNER,
        draft=FragmentDraft(
            content=content,
            tier=JournalClassification.PERSONAL,
            source=source,
            classification=FrequencyClassification(
                weights=MappingProxyType({Frequency.F5: 0.9}),
                overall_confidence=0.9,
            ),
        ),
    )
    await session.commit()


@pytest.mark.asyncio
async def test_an_account_that_decided_nothing_has_consented_to_nothing(
    db_session: AsyncSession,
) -> None:
    """No row means no permission, and the constant says so out loud.

    Pinned to :data:`CONSENT_GRANTED_BY_DEFAULT` rather than to a literal
    ``False`` so that flipping the default is a change to a named, documented
    constant that this assertion and the published privacy policy both read.
    """
    state = await load_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL)

    assert CONSENT_GRANTED_BY_DEFAULT is False
    assert state.granted is False
    assert state.decided_at is None


@pytest.mark.asyncio
async def test_granting_consent_writes_an_event_that_names_the_source(
    db_session: AsyncSession,
) -> None:
    """The record is per source, so one decision cannot stand in for another."""
    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=True)
    await db_session.commit()

    journal = await load_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL)
    uploads = await load_consent(db_session, user_id=_OWNER, source=CorpusSource.UPLOAD)

    assert journal.granted is True
    assert journal.decided_at is not None
    assert uploads.granted is False


@pytest.mark.asyncio
async def test_changing_your_mind_appends_rather_than_overwrites(
    db_session: AsyncSession,
) -> None:
    """Both decisions survive, in the order they were made.

    An audit record that keeps only the current answer cannot say when the
    account agreed, which is the one thing it is for.
    """
    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=True)
    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=False)
    await db_session.commit()

    rows = await db_session.execute(
        select(CorpusConsentEvent.decision).order_by(col(CorpusConsentEvent.id))
    )

    assert list(rows.scalars().all()) == [
        ConsentDecision.GRANTED.value,
        ConsentDecision.REVOKED.value,
    ]


@pytest.mark.asyncio
async def test_repeating_a_decision_does_not_repeat_the_event(
    db_session: AsyncSession,
) -> None:
    """A client that sends the same answer twice does not fabricate a decision.

    The log holds decisions, not requests. A retried save appending a second
    identical row would make "how many times did they agree?" unanswerable
    from the record it exists to answer it from.
    """
    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=True)
    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=True)
    await db_session.commit()

    rows = await db_session.execute(select(CorpusConsentEvent))

    assert len(list(rows.scalars().all())) == 1


@pytest.mark.asyncio
async def test_revoking_consent_removes_the_writing_it_admitted(
    db_session: AsyncSession,
) -> None:
    """Withdrawal reaches the corpus, and only the revoked source's part of it."""
    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=True)
    await _fragment(db_session, "from the journal", CorpusSource.JOURNAL)
    await _fragment(db_session, "from an upload", CorpusSource.UPLOAD)

    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=False)
    await db_session.commit()
    remaining = await retrieve_fragments(db_session, user_id=_OWNER)

    assert [fragment.content for fragment in remaining] == ["from an upload"]


@pytest.mark.asyncio
async def test_a_revocation_records_how_much_it_removed(db_session: AsyncSession) -> None:
    """The count is the evidence the purge ran; a grant records zero."""
    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=True)
    await _fragment(db_session, "one", CorpusSource.JOURNAL)
    await _fragment(db_session, "two", CorpusSource.JOURNAL)

    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=False)
    await db_session.commit()
    rows = await db_session.execute(
        select(CorpusConsentEvent.fragments_removed).order_by(col(CorpusConsentEvent.id))
    )

    assert list(rows.scalars().all()) == [0, 2]


@pytest.mark.asyncio
async def test_one_accounts_decision_says_nothing_about_another(
    db_session: AsyncSession,
) -> None:
    """Consent is per account; nothing about it is deployment-wide."""
    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=True)
    await db_session.commit()

    stranger = await load_consent(db_session, user_id=_STRANGER, source=CorpusSource.JOURNAL)

    assert stranger.granted is False


@pytest.mark.asyncio
async def test_every_source_is_reported_whether_decided_or_not(
    db_session: AsyncSession,
) -> None:
    """The account is shown the whole question, not only the parts it answered.

    A surface listing only the sources somebody has already decided about
    cannot offer them the one they have not, which is how a consent screen
    ends up unable to collect consent.
    """
    await set_consent(db_session, user_id=_OWNER, source=CorpusSource.JOURNAL, granted=True)
    await db_session.commit()

    states = await load_every_consent(db_session, user_id=_OWNER)

    assert [state.source for state in states] == list(CorpusSource)
    assert [state.granted for state in states] == [
        source is CorpusSource.JOURNAL for source in CorpusSource
    ]
