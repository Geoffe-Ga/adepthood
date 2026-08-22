"""Route one document a person chose to whichever corpus is actually theirs.

The gap this closes is small to describe and large to live with: until it
existed, a document had exactly one destination, and an account that had
connected no vault sent one and was told their vault had not answered. That was
untrue of a vault they never had, and it left a new account's corpus holding
only what they had typed into this app.

**Nothing here is a second upload path, and nothing here is a second ingest.**
The vault branch is :func:`services.creek_vault_upload.store_upload`, called
with the same :class:`~services.creek_vault_upload.UploadedDocument` the
shipped endpoint builds and answered in the same
:class:`~domain.creek_vault.VaultUploadStatus` vocabulary. The corpus branch is
:func:`services.corpus_ingest.ingest_content`, the same spine a journal entry
goes through -- the same consent gate, the same single classification call, the
same tier refusal, the same store. What this module adds is the *routing rule*
and the reading of a document into text, and nothing else.

**The routing rule is about configuration, not weather.** The question is "does
this account reach a vault at all", and the answer is already computed once per
request by :func:`dependencies.creek_vault.get_creek_vault_client`, which
resolves the account's own connection first and the deployment binding second.
:class:`~services.creek_vault_client.LocalFallbackCreekVaultClient` is precisely
what that resolver hands back when the answer is no, so asking whether the
client *is* one is reading the resolver's own conclusion rather than
re-deriving it from a second lookup that could come to disagree.

It is deliberately not "did the vault answer". An account whose vault is
momentarily unreachable has a vault, and quietly diverting their document into
a different store -- one their vault exists to keep writing out of -- would be
a privacy decision made on their behalf by a timeout. They are told the vault
did not answer, exactly as today, and their document goes nowhere.

**Consent and cost are unchanged from the journal path.** An account that has
agreed to nothing has its document sent nowhere: the provider is never
contacted. An account that has agreed pays exactly one classification call,
because one document becomes one fragment -- see
:mod:`domain.document_text` for why a document too long for one fragment is
refused rather than split.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from domain.corpus_import import CorpusImportStatus
from domain.creek_vault import CreekVaultClient, VaultUploadStatus
from domain.document_text import DocumentReadFailure, read_document
from models.corpus_fragment import CorpusSource
from models.journal_entry import JournalClassification
from services.corpus_ingest import IngestOutcome, IngestRequest, ingest_content
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_upload import UploadedDocument, store_upload

#: The source an imported document's fragment carries, and the source whose
#: consent gates it. ``UPLOAD`` rather than ``IMPORT``: the enum reserves
#: ``import`` for material pulled from a service the account writes on
#: elsewhere, which is the live-connector work this issue puts out of scope.
IMPORT_SOURCE: Final[CorpusSource] = CorpusSource.UPLOAD

# Why a document yielded no writing, in the vocabulary the answer is given in.
# A mapping rather than a chain of branches so it is total by construction: a
# read failure added later fails loudly here instead of being reported as
# somebody else's outcome.
_READ_FAILURE_STATUS: Final[Mapping[DocumentReadFailure, CorpusImportStatus]] = MappingProxyType(
    {
        DocumentReadFailure.FORMAT_UNREADABLE: CorpusImportStatus.FORMAT_UNREADABLE,
        DocumentReadFailure.NOT_TEXT: CorpusImportStatus.NOT_TEXT,
        DocumentReadFailure.EMPTY: CorpusImportStatus.EMPTY_DOCUMENT,
        DocumentReadFailure.TOO_LONG: CorpusImportStatus.DOCUMENT_TOO_LONG,
    }
)

# What each ingest outcome is called on this surface. The ingest vocabulary is
# written for a caller holding a journal row; this one is written for a person
# holding a document, which is why ``no_consent`` becomes the thing they can
# actually do about it.
_INGEST_STATUS: Final[Mapping[IngestOutcome, CorpusImportStatus]] = MappingProxyType(
    {
        IngestOutcome.STORED: CorpusImportStatus.STORED,
        IngestOutcome.NO_CONSENT: CorpusImportStatus.CONSENT_REQUIRED,
        IngestOutcome.TIER_REFUSED: CorpusImportStatus.TIER_REFUSED,
        IngestOutcome.UNCLASSIFIED: CorpusImportStatus.UNCLASSIFIED,
    }
)


@dataclass(frozen=True)
class VaultImportResult:
    """One document's fate at the vault destination, in the vault's own words.

    :class:`~domain.creek_vault.VaultUploadStatus` unwrapped and unrenamed: this
    is the shipped upload path's answer, and a caller reading it is reading what
    ``POST /journal/upload`` would have told them about the same document.
    """

    status: VaultUploadStatus
    vault_ref: str | None
    tags: tuple[str, ...]

    @property
    def stored(self) -> bool:
        """Whether the vault durably kept the document."""
        return self.status is VaultUploadStatus.ACCEPTED


@dataclass(frozen=True)
class CorpusImportResult:
    """One document's fate at the local-corpus destination.

    ``fragment_id`` is populated only when something was stored, so a caller
    reads the status and never infers an outcome from a field's presence.
    """

    status: CorpusImportStatus
    fragment_id: int | None = None

    @property
    def stored(self) -> bool:
        """Whether the corpus kept the document as a fragment."""
        return self.status is CorpusImportStatus.STORED


#: What an import answers with. A union rather than one record carrying both
#: vocabularies with one of them null: the two destinations cannot both apply,
#: and a type that can only hold one of them is what makes the surface unable
#: to report a vault status for a document that never went near a vault.
DocumentImportResult = VaultImportResult | CorpusImportResult


def reaches_a_vault(client: CreekVaultClient) -> bool:
    """Whether this request's resolved client stands in front of an actual vault.

    A type test rather than a database read. The resolver has already answered
    this question -- an account's own connection first, the deployment binding
    second, the local fallback otherwise -- and its answer is *which class it
    returned*. Asking the object is therefore reading the decision; asking the
    database again would be making a second one.
    """
    return not isinstance(client, LocalFallbackCreekVaultClient)


async def _to_vault(client: CreekVaultClient, document: UploadedDocument) -> VaultImportResult:
    """Hand the document to the vault, unchanged, at every tier.

    The whole branch is a call and a projection. The tier decision, the
    handshake, the degrade vocabulary and the withholding of a tier Creek's
    wire cannot express all stay where they already are.
    """
    outcome = await store_upload(client, document)
    return VaultImportResult(status=outcome.status, vault_ref=outcome.vault_ref, tags=outcome.tags)


async def _to_corpus(
    session: AsyncSession, document: UploadedDocument, raw: bytes
) -> CorpusImportResult:
    """Read the document and offer its writing to the account's own corpus.

    Reading comes first, and it is free: a format adepthood cannot open, bytes
    that are not text, an empty file and a file too long for one fragment are
    all decided without contacting anybody, so none of them costs a provider
    call or reaches the consent gate with nothing to gate.
    """
    text = read_document(document.filename, raw)
    if isinstance(text, DocumentReadFailure):
        return CorpusImportResult(_READ_FAILURE_STATUS[text])
    result = await ingest_content(
        session,
        user_id=document.owner_user_id,
        request=IngestRequest(
            content=text,
            tier=JournalClassification(document.classification),
            source=IMPORT_SOURCE,
        ),
    )
    fragment = result.fragment
    return CorpusImportResult(
        _INGEST_STATUS[result.outcome], None if fragment is None else fragment.id
    )


async def import_document(
    session: AsyncSession,
    client: CreekVaultClient,
    document: UploadedDocument,
    raw: bytes,
) -> DocumentImportResult:
    """Route one document to the destination this account actually has.

    One document reaches one destination. It is never attempted at both and
    never falls from one to the other: an account with a vault has chosen where
    their writing lives, and a document that also landed in an operator-readable
    store would undo that choice silently.

    ``raw`` is the already-decoded document, so the payload is decoded once per
    request even though only one of the two branches reads it -- see
    :func:`dependencies.document_payload.guard_document_payload`.

    Nothing is committed; the caller owns the transaction, as it does for every
    other corpus write.
    """
    if reaches_a_vault(client):
        return await _to_vault(client, document)
    return await _to_corpus(session, document, raw)
