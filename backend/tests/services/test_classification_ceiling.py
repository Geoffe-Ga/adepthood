"""The daily ceiling on server-paid classifications, and what it refuses.

Every other server-paid generation in this deployment is bounded per
authenticated user — the economy record asks for limits "per authenticated
user, not only per IP" and for "One offering is a product unit, not permission
for unbounded compute". Corpus classification was the exception: it reaches the
wallet nowhere, so none of the four ratified guardrails counted it, and the
only brake was the ambient per-IP rate limit. A consented account on the app
provider could therefore drive tens of thousands of provider calls a day on the
app's key.

This module is the missing bound. Four properties are load-bearing.

**It counts attempts, not fragments.** A classification that recognises nothing
stores no fragment and still cost a provider call, so counting fragments would
undercount exactly the writing that is cheapest to generate and commonest to
retry. The attempt is recorded before the dial for the same reason.

**It counts only what the app pays for.** A vault-bound writer's entry is never
offered to the app provider at all, and an account that has not consented never
reaches one either. Neither may consume somebody's allowance.

**Nobody loses writing to it.** The refusal is an ordinary outcome, reported
like the other refusals rather than raised, so the entry stays pending and a
later sweep offers it again.

**Zero is an emergency brake.** A ceiling of ``0`` refuses every server-paid
classification, matching the daily generation ceiling's own documented
behaviour.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from domain.frequencies import Frequency
from models.journal_entry import JournalClassification, JournalEntry
from services import frequency_classification as fc
from services.classification_ceiling import (
    classifications_today,
    record_classification_attempt,
)
from services.corpus_consent import set_consent
from services.corpus_ingest import (
    INGEST_SOURCE,
    IngestOutcome,
    IngestRequest,
    ingest_content,
    ingest_journal_entry,
)
from services.reflection_boundary import ReflectionBoundary
from services.usage import DAILY_CLASSIFICATION_CEILING_ENV, get_daily_classification_ceiling

_OWNER = 1
_STRANGER = 2

_BODY = "I finished the thing I said I would finish."

_CLASSIFIED_REPLY = json.dumps({"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9})

# A ceiling above one, so an off-by-one cannot pass by coincidence.
_CEILING = 3

# Far enough back to be a different UTC day whatever time the suite runs.
_YESTERDAY = timedelta(days=1, hours=1)


def _patch_provider(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """Route the classifier's provider call to a fake, returning the calls made."""
    calls: list[dict[str, object]] = []

    async def fake(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        return SimpleNamespace(text=_CLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", fake)
    return calls


def _forbid_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any provider call an outright test failure."""

    async def explode(**kwargs: object) -> SimpleNamespace:
        msg = f"a provider call was made when none was permitted: {sorted(kwargs)}"
        raise AssertionError(msg)

    monkeypatch.setattr(fc, "generate_response", explode)


def _set_ceiling(monkeypatch: pytest.MonkeyPatch, value: int) -> None:
    """Configure the ceiling the way an operator would."""
    monkeypatch.setenv(DAILY_CLASSIFICATION_CEILING_ENV, str(value))


async def _consent(session: AsyncSession, user_id: int = _OWNER) -> None:
    """Record consent to ontologize what this account writes here."""
    await set_consent(session, user_id=user_id, source=INGEST_SOURCE, granted=True)
    await session.commit()


async def _entry(session: AsyncSession, *, user_id: int = _OWNER) -> JournalEntry:
    """Persist one journal entry and return it."""
    entry = JournalEntry(
        user_id=user_id,
        sender="user",
        message=_BODY,
        classification=JournalClassification.PERSONAL.value,
        timestamp=datetime.now(UTC),
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return entry


def _request() -> IngestRequest:
    """One piece of writing offered to the corpus, apart from whose it is."""
    return IngestRequest(
        content=_BODY,
        tier=JournalClassification.PERSONAL,
        source=INGEST_SOURCE,
        source_entry_id=None,
    )


async def _offer(session: AsyncSession, *, user_id: int = _OWNER) -> IngestOutcome:
    """Offer the owner's writing to the spine and report the outcome."""
    result = await ingest_content(
        session,
        user_id=user_id,
        request=_request(),
        boundary=ReflectionBoundary.APP_PROVIDER,
    )
    return result.outcome


# ── The counter ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_account_that_has_classified_nothing_has_used_nothing(
    db_session: AsyncSession,
) -> None:
    """No rows is zero, not an error."""
    assert await classifications_today(db_session, _OWNER, datetime.now(UTC)) == 0


@pytest.mark.asyncio
async def test_the_count_is_this_accounts_own(db_session: AsyncSession) -> None:
    """A stranger's spending may never consume somebody else's allowance."""
    now = datetime.now(UTC)
    await record_classification_attempt(db_session, _STRANGER, now)
    await db_session.commit()

    assert await classifications_today(db_session, _OWNER, now) == 0
    assert await classifications_today(db_session, _STRANGER, now) == 1


@pytest.mark.asyncio
async def test_yesterdays_attempts_are_not_todays(db_session: AsyncSession) -> None:
    """The ceiling is daily, counted from 00:00 UTC, so a new day is a fresh one.

    Counted from rows rather than a reset counter, which is why there is no
    rollover to get wrong -- the same shape ``net_charged_generations_since``
    uses for the charged-generation ceiling.
    """
    now = datetime.now(UTC)
    await record_classification_attempt(db_session, _OWNER, now - _YESTERDAY)
    await db_session.commit()

    assert await classifications_today(db_session, _OWNER, now) == 0


# ── The bound on the spine ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_one_offer_spends_one_of_the_allowance(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A server-paid classification is counted."""
    _set_ceiling(monkeypatch, _CEILING)
    _patch_provider(monkeypatch)
    await _consent(db_session)

    assert await _offer(db_session) is IngestOutcome.STORED

    assert await classifications_today(db_session, _OWNER, datetime.now(UTC)) == 1


@pytest.mark.asyncio
async def test_the_ceiling_refuses_the_offer_past_it_and_dials_nothing(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Past the ceiling the provider is not merely un-billed; it is not contacted.

    The fake raises rather than returns, so a guard moved below the dial cannot
    pass by producing something plausible.
    """
    _set_ceiling(monkeypatch, _CEILING)
    await _consent(db_session)
    now = datetime.now(UTC)
    for _ in range(_CEILING):
        await record_classification_attempt(db_session, _OWNER, now)
    await db_session.commit()
    _forbid_provider(monkeypatch)

    assert await _offer(db_session) is IngestOutcome.CEILING_REACHED


@pytest.mark.asyncio
async def test_a_refused_offer_spends_nothing_further(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A refusal is not an attempt: no provider was asked, so nothing was spent."""
    _set_ceiling(monkeypatch, _CEILING)
    await _consent(db_session)
    now = datetime.now(UTC)
    for _ in range(_CEILING):
        await record_classification_attempt(db_session, _OWNER, now)
    await db_session.commit()
    _forbid_provider(monkeypatch)

    await _offer(db_session)

    assert await classifications_today(db_session, _OWNER, now) == _CEILING


@pytest.mark.asyncio
async def test_a_provider_failure_still_spent_the_allowance(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The attempt is what costs money, so a dial that failed is still counted.

    Recording after a successful reply would make a degraded provider free to
    retry against, which is the condition under which a bill runs away fastest.
    """
    _set_ceiling(monkeypatch, _CEILING)
    await _consent(db_session)

    async def down(**_kwargs: object) -> SimpleNamespace:
        raise fc.LLMProviderError

    monkeypatch.setattr(fc, "generate_response", down)

    assert await _offer(db_session) is IngestOutcome.UNCLASSIFIED

    assert await classifications_today(db_session, _OWNER, datetime.now(UTC)) == 1


@pytest.mark.asyncio
async def test_a_ceiling_of_zero_refuses_every_server_paid_classification(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``0`` is the documented emergency brake, as it is for charged generations."""
    _set_ceiling(monkeypatch, 0)
    _forbid_provider(monkeypatch)
    await _consent(db_session)

    assert await _offer(db_session) is IngestOutcome.CEILING_REACHED


# ── What the ceiling may not charge for ─────────────────────────────────────


@pytest.mark.asyncio
async def test_a_vault_bound_writer_spends_none_of_the_allowance(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The app provider never answers a vault-bound writer, so it never bills for one."""
    _set_ceiling(monkeypatch, _CEILING)
    _forbid_provider(monkeypatch)
    await _consent(db_session)

    result = await ingest_content(
        db_session,
        user_id=_OWNER,
        request=_request(),
        boundary=ReflectionBoundary.VAULT_BOUND,
    )

    assert result.outcome is IngestOutcome.BOUNDARY_REFUSED
    assert await classifications_today(db_session, _OWNER, datetime.now(UTC)) == 0


@pytest.mark.asyncio
async def test_an_unconsented_account_spends_none_of_the_allowance(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No consent, no call — so no allowance either."""
    _set_ceiling(monkeypatch, _CEILING)
    _forbid_provider(monkeypatch)

    assert await _offer(db_session) is IngestOutcome.NO_CONSENT
    assert await classifications_today(db_session, _OWNER, datetime.now(UTC)) == 0


# ── Nobody loses writing to the ceiling ─────────────────────────────────────


@pytest.mark.asyncio
async def test_the_journal_path_keeps_the_entry_pending_rather_than_raising(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """At the ceiling a save stores no fragment, raises nothing, and loses nothing.

    ``_record_corpus_fragment`` relies on this: a classification that is slow,
    refused or unavailable "can cost latency but can never cost somebody their
    writing". The entry keeps no fragment, so the sweep's own pending predicate
    still sees it and a later pass picks it up.
    """
    _set_ceiling(monkeypatch, 0)
    _forbid_provider(monkeypatch)
    await _consent(db_session)
    entry = await _entry(db_session)

    fragment = await ingest_journal_entry(
        db_session, entry, boundary=ReflectionBoundary.APP_PROVIDER
    )

    assert fragment is None


# ── Configuration ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_ceiling_is_read_from_the_environment_on_every_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An operator can tighten the brake without a restart."""
    _set_ceiling(monkeypatch, 7)
    assert get_daily_classification_ceiling() == 7


@pytest.mark.asyncio
async def test_a_malformed_ceiling_falls_back_rather_than_unbounding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A typo must not hand an unlimited allowance to a deployment that tightened one."""
    monkeypatch.setenv(DAILY_CLASSIFICATION_CEILING_ENV, "not-a-number")
    assert get_daily_classification_ceiling() > 0
