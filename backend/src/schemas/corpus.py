"""Request and response shapes for consenting to ontologize a source.

The request carries one boolean and nothing else. In particular it carries no
account and no source: the account comes from the caller's token and the source
from the path, so there is no field on the wire that could name somebody else's
corpus or a source outside :class:`models.corpus_fragment.CorpusSource`.

The response reports the *state*, not the event. An account is entitled to know
what it has currently agreed to and when it decided; the log behind that answer
is the operator's audit trail, and returning its rows would put a history on
a screen that exists to ask one question.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from models.corpus_fragment import CorpusSource

#: How often one caller may record a decision about a source.
#:
#: Deliberately tighter than the import route's, and for the opposite reason to
#: the usual one: this endpoint carries the smallest body in the API and is by
#: far the most expensive request in it. A grant runs
#: :mod:`services.corpus_backfill`, so a single "yes" can cost up to
#: ``BACKFILL_ENTRY_CEILING`` provider calls, where an import costs one -- and
#: a repeated "yes" is not a no-op, because resuming an unfinished sweep is
#: what a repeat is *for*. Relying on the app-wide default would have permitted
#: sixty of those a minute.
#:
#: Five rather than one because resumption goes through this door: a person
#: decides this a handful of times in their life, but an account with a
#: backlog reaches the rest of it by asking again. The sustained cost is
#: bounded by their own journal either way -- once the backlog is swept, a
#: repeat costs one indexed count and stops -- so what this bounds is the
#: burst.
CONSENT_RATE_LIMIT = "5/minute"


class CorpusConsentUpdate(BaseModel):
    """The decision an account is making about one source.

    ``granted`` is required rather than defaulted. A consent request whose
    meaning depends on a default is a consent request that can be sent by
    accident, and the direction the default would have to pick is the one this
    endpoint exists to make explicit.
    """

    granted: bool


class CorpusConsentResponse(BaseModel):
    """What an account has currently decided about one source.

    ``decided_at`` is ``null`` for a source never answered about, which is a
    different state from one answered "no": one is a question still open, the
    other is a refusal on the record, and a client rendering them the same way
    cannot tell a new account from one that has already declined.
    """

    source: CorpusSource
    granted: bool
    decided_at: datetime | None


class CorpusConsentListResponse(BaseModel):
    """Every source, decided or not.

    A list rather than a map, so the order the ontology's own enum declares is
    the order a client renders — and so a source added later appears in the
    surface without a client change.
    """

    sources: list[CorpusConsentResponse]


class CorpusInvitationUpdate(BaseModel):
    """The account setting the corpus invitation aside, at the Resonance moment.

    ``do_not_ask_again`` is required rather than defaulted, for the reason
    :class:`CorpusConsentUpdate` gives about ``granted``: a decline whose
    meaning depends on a default is a decline that can be sent by accident, and
    the two meanings here -- "not now" and "never" -- are exactly what the
    request exists to distinguish.
    """

    do_not_ask_again: bool


class CorpusInvitationResponse(BaseModel):
    """Whether to offer the corpus decision now, and what the account last chose.

    Three fields and no count. The server computes the cooldown from how many
    Resonance passes the account has completed, and that number stays on the
    server: a client that could render it would be one edit away from turning a
    declinable invitation into a meter (NORTH-STAR §5, §6).

    ``dismissed_at`` is ``null`` for an account that has never set the
    invitation aside; ``do_not_ask_again`` is the standing answer, never
    softened by a later "not now".
    """

    offer: bool
    dismissed_at: datetime | None
    do_not_ask_again: bool


class CorpusSweepEstimateResponse(BaseModel):
    """What sorting the rest of this account's writing would reach, and cost.

    Counts and a price. Nothing from any entry, for the reason
    :class:`CorpusConsentResponse` gives about the audit log: an account is
    entitled to know how much of its writing is waiting, and a surface that
    could render the writing itself would be describing egress this read does
    not perform.

    ``estimated_price_units`` is the whole backlog's price, not one pass's: a
    pass is bounded, so a client that showed only the next pass's cost would be
    disclosing a fraction of what finishing actually costs. It is derived
    server-side from ``entries_pending * price_units`` so the two cannot drift.

    ``wallet_covers`` is the projection every client branches on, derived once
    here for the reason
    :class:`~schemas.voice_readiness.VoiceReadinessResponse` derives ``ready``:
    three surfaces each re-deciding which balances count is how they come to
    disagree. It answers the whole backlog, so it is ``false`` for an account
    that could afford the next pass but not the finish -- which is the honest
    answer to "can I get this done", and the one a disclosure owes.

    ``monthly_remaining`` and ``offering_balance`` are reported alongside it so
    a client can say *why* the wallet falls short without a second request.
    """

    entries_pending: int = Field(ge=0)
    price_units: int = Field(ge=0)
    estimated_price_units: int = Field(ge=0)
    wallet_covers: bool
    monthly_remaining: int = Field(ge=0)
    offering_balance: int = Field(ge=0)
