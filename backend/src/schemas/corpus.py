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

from pydantic import BaseModel

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
