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

Neither decision is only a change of state, and they reach the corpus in
opposite directions. A revocation deletes the fragments that source put there.
A grant ontologizes the writing the account already had, so that saying yes
after weeks of journalling is not an agreement about the future only. Both
happen in the same transaction as the event that records them, so a sweep and
its receipt land together or neither does.

``POST /import`` is the third verb and the reason the other two now have
something to gate. It takes one document a person chose -- exported journal
history, a blog post, notes, an AI conversation saved as Markdown -- and routes
it to whichever corpus that account actually has: their vault if they have
connected one, their own ontologized corpus if they have not.
:mod:`services.corpus_import` owns the routing rule and the reasons for it. The
endpoint itself only decodes, calls, commits, and picks the sentence.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.creek_vault import get_creek_vault_client
from dependencies.document_payload import guard_document_payload
from domain.corpus_import import ImportDestination
from domain.creek_vault import CreekVaultClient
from models.corpus_fragment import CorpusSource
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.corpus import CorpusConsentListResponse, CorpusConsentResponse, CorpusConsentUpdate
from schemas.corpus_import import CORPUS_IMPORT_MESSAGES, DocumentImportResponse
from schemas.journal_upload import UPLOAD_MESSAGES, UPLOAD_RATE_LIMIT, UploadDocumentRequest
from services.corpus_backfill import backfill_after_consent
from services.corpus_consent import ConsentState, load_every_consent, set_consent
from services.corpus_import import (
    CorpusImportResult,
    DocumentImportResult,
    VaultImportResult,
    import_document,
)
from services.creek_vault_upload import UploadedDocument

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
    and a decision is never only the event. On a revocation it is the purge; on
    a grant it is the sweep back over the writing the account already had,
    bounded and reported by :mod:`services.corpus_backfill`. Leaving any of it
    uncommitted would be a permission changed on screen and not in the
    database.

    The response is still the *state*. What the decision reached is a fact
    about the event, and it goes where events are kept -- the audit row and the
    log -- rather than onto a shape that also answers ``GET``.
    """
    change = await set_consent(session, user_id=user_id, source=source, granted=payload.granted)
    await backfill_after_consent(session, user_id=user_id, change=change)
    await session.commit()
    return _to_response(change.state)


def _vault_response(result: VaultImportResult) -> DocumentImportResponse:
    """Render a vault answer, in the vault path's own shipped copy.

    The sentence is not rewritten for this surface. The person is in exactly
    the situation ``POST /journal/upload`` would have put them in, and telling
    them two different things about one outcome would be worse than telling
    them nothing.
    """
    return DocumentImportResponse(
        destination=ImportDestination.VAULT,
        stored=result.stored,
        vault_status=result.status,
        vault_ref=result.vault_ref,
        tags=list(result.tags),
        message=UPLOAD_MESSAGES[result.status],
    )


def _corpus_response(result: CorpusImportResult) -> DocumentImportResponse:
    """Render a local-corpus answer, leaving the vault fields unset.

    ``null`` rather than absent, and that is the stronger statement: it says
    the vault vocabulary did not apply to this document, rather than that
    nobody filled it in.
    """
    return DocumentImportResponse(
        destination=ImportDestination.CORPUS,
        stored=result.stored,
        corpus_status=result.status,
        fragment_id=result.fragment_id,
        message=CORPUS_IMPORT_MESSAGES[result.status],
    )


def _to_import_response(result: DocumentImportResult) -> DocumentImportResponse:
    """Render whichever of the two answers this import produced.

    Dispatched on the result's own type rather than on a nullable field, so the
    two vocabularies cannot be mixed and there is no fourth case to leave
    unhandled.
    """
    if isinstance(result, VaultImportResult):
        return _vault_response(result)
    return _corpus_response(result)


@router.post(
    "/import",
    response_model=DocumentImportResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
@limiter.limit(UPLOAD_RATE_LIMIT)
async def import_corpus_document(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: UploadDocumentRequest,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    vault_client: Annotated[CreekVaultClient, Depends(get_creek_vault_client)],
) -> DocumentImportResponse:
    """Import one document into whichever corpus this account has.

    202 for every outcome, including the ones that stored nothing, for the
    reason ``POST /journal/upload`` answers 202: adepthood accepted the request
    and acted on it, and what became of the document is in the body where a
    client can render a specific sentence rather than infer one from a status
    code. A vault that is missing, unreachable or unable to take files is a
    normal condition of an optional integration, and so is an account that has
    not yet agreed to ontologize uploads.

    Bounded and synchronous, and it stays that way honestly: one request is one
    document, one document is one fragment, and one fragment is one
    classification call. Nothing here needs backgrounding because nothing here
    fans out -- an import that *did* fan out, over a whole-account archive,
    would need a queue and observable progress, which is why
    :mod:`domain.document_text` refuses a document too long for one fragment
    rather than quietly splitting it into a job nobody can watch.

    The commit is here rather than in the service because this is the whole
    transaction: the fragment, and nothing else, land together or not at all.
    """
    raw = guard_document_payload(payload.content_base64)
    result = await import_document(
        session,
        vault_client,
        UploadedDocument(
            owner_user_id=user_id,
            filename=payload.filename,
            content_base64=payload.content_base64,
            classification=payload.classification,
            created_at=datetime.now(UTC),
        ),
        raw,
    )
    await session.commit()
    return _to_import_response(result)
