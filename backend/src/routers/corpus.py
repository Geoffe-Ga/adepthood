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

``GET /voice-readiness`` is the fourth verb and the only read here that is
about the corpus rather than about permission to have one. It reports whether
this account's reflections are drawn from its own sorted writing yet, and
carries the server's own sentence for each way the answer can be "not yet" --
see :mod:`services.voice_readiness` for why that is three states rather than a
boolean, and :mod:`schemas.voice_readiness` for why the copy is the server's.

It lives here, on its own route, deliberately. It is **not** computed inside
``POST /journal/`` or ``PATCH /journal/{id}``: those handlers already commit,
fan out to the vault and call a classifier, and a signal that only tells
somebody where their reflections come from has no business lengthening a write.
Nor is it folded onto ``JournalMessageResponse``, which both of those return.
It is also unrated and uncommitted -- two indexed reads, no provider call, no
transaction -- so it needs neither :data:`schemas.corpus.CONSENT_RATE_LIMIT`,
which exists because a grant fans out, nor the import route's.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.creek_vault import get_creek_vault_client
from dependencies.document_payload import guard_document_payload
from domain.corpus_import import ImportDestination
from domain.creek_vault import CreekVaultClient
from error_responses import build_router
from models.corpus_fragment import CorpusSource
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.corpus import (
    CONSENT_RATE_LIMIT,
    CorpusConsentListResponse,
    CorpusConsentResponse,
    CorpusConsentUpdate,
)
from schemas.corpus_import import CORPUS_IMPORT_MESSAGES, DocumentImportResponse
from schemas.journal_upload import UPLOAD_MESSAGES, UPLOAD_RATE_LIMIT, UploadDocumentRequest
from schemas.voice_readiness import VOICE_READINESS_MESSAGES, VoiceReadinessResponse
from services.corpus_backfill import backfill_after_consent
from services.corpus_consent import ConsentState, load_every_consent, set_consent
from services.corpus_import import (
    CorpusImportResult,
    DocumentImportResult,
    VaultImportResult,
    import_document,
)
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline
from services.creek_vault_upload import UploadedDocument
from services.voice_readiness import VoiceReadiness, load_voice_readiness

router = build_router(
    prefix="/corpus",
    tags=["corpus"],
    # ``guard_document_payload`` refuses an oversized import before it is decoded.
    extra_statuses=(status.HTTP_413_CONTENT_TOO_LARGE,),
)


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
@limiter.limit(CONSENT_RATE_LIMIT)
async def put_corpus_consent(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
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

    Rate-limited more tightly than ``POST /import`` despite carrying the
    smallest body in the API: a grant is the most expensive request here, since
    the sweep it authorises costs a provider call per entry it reaches, where
    an import costs one in total. See :data:`schemas.corpus.CONSENT_RATE_LIMIT`.

    The response is still the *state*. What the grant's sweep reached is a fact
    about the sweep rather than about the decision -- a bounded sweep resumes
    under a decision already standing -- so it goes where sweeps are kept, the
    append-only :class:`models.corpus_sweep.CorpusSweep` log and the log line,
    rather than onto a shape that also answers ``GET``.
    """
    change = await set_consent(session, user_id=user_id, source=source, granted=payload.granted)
    await backfill_after_consent(session, user_id=user_id, change=change)
    await session.commit()
    return _to_response(change.state)


def _voice_readiness_response(readiness: VoiceReadiness) -> VoiceReadinessResponse:
    """Project one readiness onto its response DTO.

    ``ready`` is carried straight through from the derivation rather than
    recomputed against the state here: the projection lives in exactly one
    place (:func:`services.voice_readiness.derive_voice_readiness`), so a rule
    about which states count as ready cannot come to mean two things.

    Nothing about the fragments themselves crosses this boundary -- no
    content, no ids, no titles. A readiness signal is a fact *about* a corpus,
    and there is no version of this answer that quotes somebody's writing back
    at them.
    """
    return VoiceReadinessResponse(
        ready=readiness.ready,
        state=readiness.state,
        message=VOICE_READINESS_MESSAGES[readiness.state],
        grounding_source=readiness.grounding_source,
        classified_fragment_count=readiness.classified_fragment_count,
    )


@router.get("/voice-readiness", response_model=VoiceReadinessResponse)
async def get_voice_readiness(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> VoiceReadinessResponse:
    """Report whether this account's reflections come from its own corpus yet.

    Never a 404 and never an error state: every account has an answer to this,
    including the one that has decided nothing and stored nothing. That is the
    most common answer, not a missing resource.

    The account comes from the token, so no request can ask about a corpus that
    is not the caller's own. Two indexed reads, no commit, no provider call,
    and no session held across a remote await -- the pooled connection is
    released on the same schedule as every other read on this router.
    """
    readiness = await load_voice_readiness(session, user_id=user_id)
    return _voice_readiness_response(readiness)


def _vault_response(result: VaultImportResult) -> DocumentImportResponse:
    """Render a vault answer, in the vault path's own shipped copy.

    The sentence is not rewritten for this surface: it is the vault's own
    account of what it did, and telling somebody two different things about one
    outcome would be worse than telling them nothing.
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

    202 for every outcome, including the ones that stored nothing: adepthood
    accepted the request and acted on it, and what became of the document is in
    the body where a client can render a specific sentence rather than infer one
    from a status code. A vault that is missing, unreachable or unable to take files is a
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

    The vault ontologization pass is driven from here, after that commit, and
    not from inside :func:`services.corpus_import.import_document` -- which
    states that it commits nothing and that the caller owns the transaction, and
    would have to break that promise to schedule anything. The router is also the
    layer that can tell the two destinations apart without asking anything twice:
    the import's result *type* already says which one it reached, so a document
    that went to the account's own corpus never consults a vault it does not
    have. Bounded and synchronous, like everything else on this route: the pass
    stands down inside its own per-stage intervals, starts no stage it cannot
    afford, and never raises.
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
    if isinstance(result, VaultImportResult) and result.stored:
        await drive_vault_pipeline(
            session,
            vault_client,
            user_id=user_id,
            trigger=VaultPipelineTrigger.DOCUMENT_IMPORT,
        )
    return _to_import_response(result)
