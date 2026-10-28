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

**A refusal to bill is overhead, not the account's (release decision R1-2,
#3516).** The attempt is still recorded before the dial, so a degraded provider
is never free to retry against. But when the deployment's own provider balance
is spent -- :class:`services.botmason.LLMCreditExhaustedError` -- the call cost
nobody anything and the cause is the deployment's, so the spine releases the one
attempt it staged with :func:`release_classification_attempt`. Every other
provider failure still spends the allowance. The ceiling itself is unchanged.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Integer, delete, func, insert, type_coerce
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


async def record_classification_attempt(session: AsyncSession, user_id: int, now: datetime) -> int:
    """Record one attempt against ``user_id``'s allowance for the day, and return its id.

    Written into the caller's transaction, not committed: on the ingest spine
    that transaction is the one ended immediately before the provider call. So
    the attempt is durable by the time the dial happens, which is the ordering
    the bound depends on -- a call this deployment paid for is counted whatever
    the provider then says.

    The id is returned so that the one compensation the spine makes, for a call
    the provider refused to bill, can name exactly this row and no other; see
    :func:`release_classification_attempt`. It is read off the ``INSERT``'s own
    ``RETURNING`` rather than off an ORM object after a flush: a row just
    inserted always has its primary key, so the column is coerced to the
    non-optional integer it is, rather than to the model field's ``int | None``
    -- which describes a row not yet written.
    """
    result = await session.execute(
        insert(CorpusClassificationAttempt)
        .values(user_id=user_id, attempted_at=now)
        .returning(type_coerce(col(CorpusClassificationAttempt.id), Integer))
    )
    return int(result.scalar_one())


async def release_classification_attempt(
    session: AsyncSession, *, user_id: int, attempt_id: int
) -> None:
    """Give back the one attempt ``attempt_id`` named, if it is ``user_id``'s.

    The single deletion application code makes from this log, and only for
    release decision R1-2 (#3516): a classification the deployment's provider
    refused for lack of credit is absorbed as overhead rather than counted
    against the account. Matched on the id *and* the account, so it removes at
    most one row and never another account's -- a wrong id deletes nothing
    rather than somebody else's spending. Not committed here: the caller owns
    the transaction, as it does for the record above.
    """
    await session.execute(
        delete(CorpusClassificationAttempt).where(
            col(CorpusClassificationAttempt.id) == attempt_id,
            col(CorpusClassificationAttempt.user_id) == user_id,
        )
    )
