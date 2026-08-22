"""Endpoints for deciding what may enter one account's ontologized corpus.

Two verbs against a resource that exists for every account whether or not it
has ever been answered: ``GET`` lists every source and what the caller has
currently decided about each, ``PUT`` records a decision about one of them. The
caller is resolved from their JWT, so no account identifier is accepted from a
path or a body and no request can name a corpus that is not the caller's own.

The source is a path parameter typed as
:class:`models.corpus_fragment.CorpusSource`, so a value outside the ontology's
own vocabulary is refused by the framework before this module runs. That
matters more here than it looks: a free-text source would be a permission for
something no fragment could ever carry, stored indefinitely and readable as
consent by whatever was built next.

``PUT`` rather than ``POST`` because the operation is idempotent in the way
that word actually means here — sending the same decision twice leaves one
decision on the record, not two. The audit log holds decisions, not requests;
:func:`services.corpus_consent.set_consent` is where that is enforced.

A revocation is not only a change of state: it deletes the fragments that
source put in the corpus. That happens inside the service, in the same
transaction as the event that records it, so a purge and its receipt land
together or neither does.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from models.corpus_fragment import CorpusSource
from routers.auth import get_current_user
from schemas.corpus import CorpusConsentListResponse, CorpusConsentResponse, CorpusConsentUpdate
from services.corpus_consent import ConsentState, load_every_consent, set_consent

router = APIRouter(prefix="/corpus", tags=["corpus"])


def _to_response(state: ConsentState) -> CorpusConsentResponse:
    """Project one consent state onto its response DTO."""
    return CorpusConsentResponse(
        source=state.source, granted=state.granted, decided_at=state.decided_at
    )


@router.get("/consent", response_model=CorpusConsentListResponse)
async def list_corpus_consent(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CorpusConsentListResponse:
    """Report what this account has decided about each source, decided or not.

    Never a 404 for an account that has answered nothing: "you have not been
    asked yet" is an answer about a resource every account has, not a missing
    resource, and answering it plainly is what lets a client render the
    question without first handling an error.
    """
    states = await load_every_consent(session, user_id=user_id)
    return CorpusConsentListResponse(sources=[_to_response(state) for state in states])


@router.put("/consent/{source}", response_model=CorpusConsentResponse)
async def put_corpus_consent(
    source: CorpusSource,
    payload: CorpusConsentUpdate,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CorpusConsentResponse:
    """Record this account's decision about one source and report the result.

    Committed here rather than left to a caller: this is the whole transaction,
    and on a revocation it is the purge as well as the event. Leaving either
    uncommitted would be a permission withdrawn on screen and not in the
    database.
    """
    state = await set_consent(session, user_id=user_id, source=source, granted=payload.granted)
    await session.commit()
    return _to_response(state)
