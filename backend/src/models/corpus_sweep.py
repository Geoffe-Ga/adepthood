"""How far one grant's reach into an account's own writing actually got.

A decision about a source is recorded once: re-sending an answer the account
has already given appends no second row to ``corpusconsentevent``, because that
log holds decisions rather than requests. The sweep that a grant authorises is
not once. It is bounded — by a count of entries, by a per-entry clock and by a
deadline the caller's patience sets — so it stops with a remainder, and the
next repeated yes under the *same* standing decision picks the remainder up.

**Which is why a sweep is a row and not a log line.** What a permission
eventually reached is a running total across every sweep it authorised, and a
total needs addends that outlive the request that produced them. A log line
outlives nothing that can be summed: it is retained for a window, it cannot be
joined to the decision it ran under, and no client surface can read it. The
question this table exists to answer — "how much of my writing is still waiting,
and under whose permission was the rest of it reached?" — is a query, so its
evidence has to be rows.

**The row is content-free.** Three counts, the decision that authorised the
sweep, and an instant. Nothing from any entry, nothing from any fragment, and
nothing a reader could reconstruct one from — the same discipline
``corpusconsentevent`` keeps, and for the same reason: an operator has to be
able to say whether a grant reached somebody's history without reading a word
of it.

**A sweep writes a row when a number moved, and not otherwise.** Every repeated
yes runs the sweep, five a minute for as long as the account exists, so what
matters is which of them is worth recording. A sweep that offered nothing writes
nothing; so does one that comes back saying exactly what the last sweep under
the same decision said.

The second rule is the one that binds, and it is not the obvious one. Testing
only for an empty backlog looks sufficient and is not: an entry the classifier
places nowhere stays pending *deliberately*, so an account holding one is never
exhausted — and that account, the one whose journalling is short or ambiguous,
is precisely the population the sweep's ordering was written for. A
backlog-only valve would never close for them, and this table would fill with
identical rows reporting one unchanging stall: a log of requests, which is what
the consent log one table over refuses to be. So the absence of a row means
here what the absence of a decision means there — nothing happened that this
log exists to hold.

**The instant is declared zoned.** Ordering these rows is the whole use of them
-- a remainder is chased by the sweeps that come after it -- so "when did this
one run?" is a question asked across rows written by different requests, and an
unzoned answer would leave a reader to guess which zone the deployment was in.
``DateTime(timezone=True)``, the same declaration ``corpusconsentevent`` makes,
so the two logs can be read against each other.

It says when this row's counts were reached, which is not the same as when the
account last asked. Repeats that reached nothing new leave no row, so a sweep
can run without moving the newest instant -- deliberately, since a date that
advanced on every request would be a record of asking rather than of reaching.
A surface reporting "last reached" is reading the right number; one reporting
"last checked" is not, and should read the request rather than this log.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, SQLModel

# A sweep reaches rows or it reaches none; it cannot reach a negative number of
# them, and a negative count would read as a sentinel nobody defined.
_MIN_ENTRIES_REACHED = 0


def _entries_considered_check() -> CheckConstraint:
    """CHECK that the number of entries a sweep offered is a count."""
    return CheckConstraint(
        f"entries_considered >= {_MIN_ENTRIES_REACHED}",
        name="ck_corpussweep_entries_considered_range",
    )


def _fragments_added_check() -> CheckConstraint:
    """CHECK that the number of fragments a sweep wrote is a count."""
    return CheckConstraint(
        f"fragments_added >= {_MIN_ENTRIES_REACHED}",
        name="ck_corpussweep_fragments_added_range",
    )


def _entries_remaining_check() -> CheckConstraint:
    """CHECK that the remainder a sweep left behind is a count."""
    return CheckConstraint(
        f"entries_remaining >= {_MIN_ENTRIES_REACHED}",
        name="ck_corpussweep_entries_remaining_range",
    )


class CorpusSweep(SQLModel, table=True):
    """One pass over an account's un-ontologized writing, and what it reached.

    ``entries_considered`` is how many entries the sweep actually offered the
    corpus writer -- fewer than the batch it fetched when a bound cut the pass
    short, which is the case this count would otherwise flatter --
    ``fragments_added`` how many of them the writer stored, and
    ``entries_remaining`` how much of the account's writing was still without a
    fragment when the sweep stopped. The three are not redundant: a batch can be
    smaller than the backlog because the sweep is bounded, and an entry the
    classifier recognises nothing in is considered without being added and stays
    in the remainder.

    ``consent_event_id`` is NOT NULL because a reach with no permission to name
    is not a record of anything. It is the row the decision appended, which for
    every sweep after the first is a row appended by an earlier request: the
    standing yes, re-affirmed rather than re-decided.
    """

    __tablename__ = "corpussweep"

    # The read is always "this account's sweeps, in the order they ran", so the
    # index carries the ordering key as well as the filter and answers it in one
    # scan. ``user_id`` deliberately carries no index of its own: the composite
    # covers it as a prefix, and a second index over the same column would be
    # paid for on every insert to serve a query the first one already serves.
    # Declared here as well as in the migration so ``alembic check`` sees no
    # drift.
    __table_args__ = (
        Index("ix_corpussweep_user_id_id", "user_id", "id"),
        Index("ix_corpussweep_consent_event_id", "consent_event_id"),
        _entries_considered_check(),
        _fragments_added_check(),
        _entries_remaining_check(),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    consent_event_id: int = Field(foreign_key="corpusconsentevent.id", ondelete="CASCADE")
    entries_considered: int = Field(nullable=False)
    fragments_added: int = Field(nullable=False)
    entries_remaining: int = Field(nullable=False)
    swept_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
