"""One server-paid classification this deployment was asked to pay for.

Every other server-paid generation is bounded per authenticated user. Corpus
classification was not: it reaches the wallet nowhere, so the monthly cap, the
per-minute limit, the concurrency lease and the daily charged-generation
ceiling all counted it as nothing, and the only brake left was the ambient
per-IP rate limit on whichever route happened to trigger it. This table is what
the per-account bound counts.

**Why a row and not a counter on ``user``.** The monthly cap keeps a counter
because it rolls over on a date the account carries. A *daily* bound has no
such date, and the deployment already answered this question once: the ratified
daily ceiling on charged generations counts rows in ``walletaudit`` since
00:00 UTC rather than keeping a counter
(:func:`services.wallet.net_charged_generations_since`). Counting rows needs no
reset to run, so there is no second rollover to get wrong -- and the rollover
is where this codebase's one documented bug of that class already lives
(BUG-BM-015).

**Why an attempt and not a fragment.** A classification that recognises
nothing in a fragment stores no fragment and still cost a provider call. Those
are not the rare case: an entry the classifier places nowhere stays pending
deliberately and is offered again by every later sweep, so counting stored
fragments would undercount precisely the writing that gets retried most. The
row is therefore written before the dial, and a dial that fails keeps it.

**The row is content-free.** An account and an instant. Nothing from the
writing, nothing a reader could reconstruct it from -- the discipline
``corpussweep`` and ``corpusconsentevent`` keep, and for the same reason: an
operator has to be able to say how much a deployment spent on somebody's
behalf without reading a word of what they wrote.

**The instant is declared zoned.** The only use of these rows is "how many
since 00:00 UTC", a comparison across rows written by different requests, so an
unzoned answer would leave a reader guessing which zone the deployment was in.
``DateTime(timezone=True)``, the same declaration ``corpussweep`` makes.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Index
from sqlmodel import Field, SQLModel


class CorpusClassificationAttempt(SQLModel, table=True):
    """One provider call the app paid for on an account's behalf.

    Append-only: never updated and never deleted by application code, like
    every other accounting log here. It is deleted with its account, which is
    what ``ondelete="CASCADE"`` says -- an erased account's spending is not
    evidence anybody is entitled to keep.
    """

    __tablename__ = "corpusclassificationattempt"

    # The read is always "this account's attempts since an instant", so one
    # composite index carries the filter and the range together and answers it
    # in a single scan. ``user_id`` deliberately carries no index of its own:
    # the composite covers it as a prefix, and a second index over the same
    # column would be paid for on every insert to serve a query the first one
    # already serves. Declared here as well as in the migration so
    # ``alembic check`` sees no drift.
    __table_args__ = (
        Index(
            "ix_corpusclassificationattempt_user_id_attempted_at",
            "user_id",
            "attempted_at",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    attempted_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
