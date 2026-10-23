"""How much the app has spent classifying one account's writing today.

The bound itself is applied by :mod:`services.corpus_ingest`, on the one spine
both corpus sources run through, so no source can forget it. This module owns
only the two operations that bound needs — ask the count, record the attempt —
for the reason :mod:`services.usage` holds the cap arithmetic apart from the
router that enforces it: a policy with its own module can be read, and tested,
without standing up the thing it governs.

**Counted from rows, since 00:00 UTC.** The ratified daily ceiling on charged
generations is counted the same way
(:func:`services.wallet.net_charged_generations_since` over ``walletaudit``),
and for the reason given in
:mod:`models.corpus_classification_attempt`: a count taken from rows needs no
rollover, and the rollover is where the one documented bug of that class in
this codebase already lives.

**Best-effort under concurrency, deliberately.** Two requests for the same
account that both read a count of N-1 will both be admitted, so an account can
exceed its ceiling by as many classifications as it has requests genuinely in
flight. That is bounded and small: the sweep offers entries one at a time, a
journal save classifies one entry, and the ambient rate limit caps how many
requests an account can have in flight at once. The alternative is the
row-locking savepoint :func:`services.wallet.preflight_deduction` takes, which
is right for money that must never be double-spent and wrong here — this is a
cost ceiling whose job is to stop a runaway, not an allowance anybody bought,
and taking a per-account write lock around every provider call would serialise
the sweep this bound exists to let run.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import utc_day_start
from models.corpus_classification_attempt import CorpusClassificationAttempt


async def classifications_today(session: AsyncSession, user_id: int, now: datetime) -> int:
    """Count the server-paid classifications ``user_id`` has run since 00:00 UTC.

    One indexed aggregate. ``now`` is a parameter rather than read here so the
    caller's clock is the one the whole decision is made on, and so a test can
    place a row on another day without waiting for one.
    """
    result = await session.execute(
        select(func.count())
        .select_from(CorpusClassificationAttempt)
        .where(
            col(CorpusClassificationAttempt.user_id) == user_id,
            col(CorpusClassificationAttempt.attempted_at) >= utc_day_start(now),
        )
    )
    return int(result.scalar_one())


async def record_classification_attempt(session: AsyncSession, user_id: int, now: datetime) -> None:
    """Stage one attempt against ``user_id``'s allowance for the day.

    Staged, not committed: the row shares the caller's transaction, which on
    the ingest spine is the one ended immediately before the provider call. So
    the attempt is durable by the time the dial happens, which is the ordering
    the bound depends on — a call this deployment paid for is counted whatever
    the provider then says.
    """
    session.add(CorpusClassificationAttempt(user_id=user_id, attempted_at=now))
