"""The corpus-invitation record, as the router and the resonance pass use it (#2407).

Three contracts. ``record_completed_pass`` stages one increment and commits
nothing -- the resonance settlement owns that commit, so a failed pass that is
refunded also leaves no count behind. ``load_invitation`` reads and never
writes: an account that has asked for nothing has no row, and asking whether
to offer must not provision one. ``dismiss_invitation`` records a "Not now" at
the current pass count and, when asked, a "Do not ask again" that no later
softer decline can clear.

Consent is read through :func:`services.corpus_consent.load_consent`, so the
one rule about what an undecided account has agreed to has one home.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.corpus_invitation import REOFFER_MIN_DAYS, REOFFER_MIN_PASSES
from models.corpus_fragment import CorpusSource
from models.corpus_invitation_state import CorpusInvitationState
from models.user import User
from services.corpus_consent import set_consent
from services.corpus_invitation import (
    dismiss_invitation,
    load_invitation,
    record_completed_pass,
)

_NOW = datetime(2026, 9, 7, 12, 0, tzinfo=UTC)


async def _user(session: AsyncSession, email: str) -> int:
    """Insert a bare User, commit, and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    assert user.id is not None
    return user.id


async def _row_count(session: AsyncSession) -> int:
    """How many invitation-state rows exist at all."""
    count: int = (
        await session.execute(select(func.count()).select_from(CorpusInvitationState))
    ).scalar_one()
    return count


async def _passes(session: AsyncSession, user_id: int) -> int:
    """The persisted pass count for ``user_id``, read fresh."""
    passes: int = (
        await session.execute(
            select(col(CorpusInvitationState.completed_passes))
            .where(col(CorpusInvitationState.user_id) == user_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return passes


@pytest.mark.asyncio
async def test_asking_whether_to_offer_never_provisions_a_row(db_session: AsyncSession) -> None:
    """A read is a read: no pass yet means no offer and no row."""
    user_id = await _user(db_session, "read-only@example.com")

    offer = await load_invitation(db_session, user_id=user_id, now=_NOW)

    assert offer.offer is False
    assert offer.dismissed_at is None
    assert offer.do_not_ask_again is False
    assert await _row_count(db_session) == 0


@pytest.mark.asyncio
async def test_a_completed_pass_provisions_then_increments(db_session: AsyncSession) -> None:
    """First call creates the row at one; the second takes it to two."""
    user_id = await _user(db_session, "counter@example.com")

    await record_completed_pass(db_session, user_id=user_id)
    assert await _passes(db_session, user_id) == 1
    await record_completed_pass(db_session, user_id=user_id)
    assert await _passes(db_session, user_id) == 2


@pytest.mark.asyncio
async def test_recording_a_pass_commits_nothing_of_its_own(db_session: AsyncSession) -> None:
    """The caller owns the commit, so a rolled-back settlement leaves no count."""
    user_id = await _user(db_session, "uncommitted@example.com")

    await record_completed_pass(db_session, user_id=user_id)
    await db_session.rollback()

    assert await _row_count(db_session) == 0


@pytest.mark.asyncio
async def test_the_first_pass_on_an_undecided_account_is_offered(
    db_session: AsyncSession,
) -> None:
    """The ruling's trigger, through the service."""
    user_id = await _user(db_session, "first@example.com")
    await record_completed_pass(db_session, user_id=user_id)
    await db_session.commit()

    assert (await load_invitation(db_session, user_id=user_id, now=_NOW)).offer is True


@pytest.mark.asyncio
async def test_a_grant_ends_the_offer(db_session: AsyncSession) -> None:
    """Consent given: nothing to invite."""
    user_id = await _user(db_session, "granted@example.com")
    await record_completed_pass(db_session, user_id=user_id)
    await set_consent(db_session, user_id=user_id, source=CorpusSource.JOURNAL, granted=True)
    await db_session.commit()

    assert (await load_invitation(db_session, user_id=user_id, now=_NOW)).offer is False


@pytest.mark.asyncio
async def test_a_revocation_on_the_record_is_a_decision_too(db_session: AsyncSession) -> None:
    """Granted then revoked reads ``granted=False`` -- and is still never re-asked."""
    user_id = await _user(db_session, "revoked@example.com")
    await record_completed_pass(db_session, user_id=user_id)
    await set_consent(db_session, user_id=user_id, source=CorpusSource.JOURNAL, granted=True)
    await set_consent(db_session, user_id=user_id, source=CorpusSource.JOURNAL, granted=False)
    await db_session.commit()

    assert (await load_invitation(db_session, user_id=user_id, now=_NOW)).offer is False


@pytest.mark.asyncio
async def test_not_now_records_the_instant_and_the_count(db_session: AsyncSession) -> None:
    """A plain decline stamps when, and how many passes had been completed."""
    user_id = await _user(db_session, "not-now@example.com")
    await record_completed_pass(db_session, user_id=user_id)
    await record_completed_pass(db_session, user_id=user_id)

    offer = await dismiss_invitation(db_session, user_id=user_id, do_not_ask_again=False, now=_NOW)
    await db_session.commit()

    assert offer.offer is False
    assert offer.dismissed_at is not None
    assert offer.dismissed_at.tzinfo is not None
    assert offer.dismissed_at == _NOW
    assert offer.do_not_ask_again is False
    row = (
        await db_session.execute(
            select(CorpusInvitationState)
            .where(col(CorpusInvitationState.user_id) == user_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert row.passes_at_dismissal == row.completed_passes == 2


@pytest.mark.asyncio
async def test_not_now_reopens_only_after_both_floors(db_session: AsyncSession) -> None:
    """Days and passes together, through the persisted counters."""
    user_id = await _user(db_session, "cooldown@example.com")
    await record_completed_pass(db_session, user_id=user_id)
    await dismiss_invitation(db_session, user_id=user_id, do_not_ask_again=False, now=_NOW)
    for _ in range(REOFFER_MIN_PASSES):
        await record_completed_pass(db_session, user_id=user_id)
    await db_session.commit()

    too_soon = _NOW + timedelta(days=REOFFER_MIN_DAYS - 1)
    assert (await load_invitation(db_session, user_id=user_id, now=too_soon)).offer is False
    ready = _NOW + timedelta(days=REOFFER_MIN_DAYS)
    assert (await load_invitation(db_session, user_id=user_id, now=ready)).offer is True


@pytest.mark.asyncio
async def test_do_not_ask_again_survives_a_later_not_now(db_session: AsyncSession) -> None:
    """Monotonic: the firmer answer is never softened by a later, softer one."""
    user_id = await _user(db_session, "final@example.com")
    await record_completed_pass(db_session, user_id=user_id)

    await dismiss_invitation(db_session, user_id=user_id, do_not_ask_again=True, now=_NOW)
    offer = await dismiss_invitation(db_session, user_id=user_id, do_not_ask_again=False, now=_NOW)
    await db_session.commit()

    assert offer.do_not_ask_again is True
    far = _NOW + timedelta(days=REOFFER_MIN_DAYS * 10)
    for _ in range(REOFFER_MIN_PASSES * 2):
        await record_completed_pass(db_session, user_id=user_id)
    assert (await load_invitation(db_session, user_id=user_id, now=far)).offer is False


@pytest.mark.asyncio
async def test_a_decline_before_any_pass_still_lands(db_session: AsyncSession) -> None:
    """Settings could route here first; a decline with no row provisions one."""
    user_id = await _user(db_session, "early@example.com")

    offer = await dismiss_invitation(db_session, user_id=user_id, do_not_ask_again=True, now=_NOW)

    assert offer.do_not_ask_again is True
    assert await _row_count(db_session) == 1


@pytest.mark.asyncio
async def test_a_strangers_row_is_untouched(db_session: AsyncSession) -> None:
    """Every write is keyed on the caller; the neighbour's state does not move."""
    owner = await _user(db_session, "owner-inv@example.com")
    stranger = await _user(db_session, "stranger-inv@example.com")
    await record_completed_pass(db_session, user_id=stranger)

    await record_completed_pass(db_session, user_id=owner)
    await dismiss_invitation(db_session, user_id=owner, do_not_ask_again=True, now=_NOW)
    await db_session.commit()

    assert await _passes(db_session, stranger) == 1
    theirs = await load_invitation(db_session, user_id=stranger, now=_NOW)
    assert theirs.offer is True
    assert theirs.do_not_ask_again is False
