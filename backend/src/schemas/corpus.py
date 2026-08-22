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
