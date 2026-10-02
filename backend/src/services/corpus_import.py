"""Route one document a person chose to their vault, or tell them it needs one.

**A corpus lives in a vault (#3015).** The owner ruling on epic #3015 is that
you can only have a corpus if you have a vault to keep it in. So a document has
exactly one destination: the account's vault. An account the resolver finds no
vault for is answered :attr:`~domain.corpus_import.CorpusImportStatus.VAULT_REQUIRED`
and nothing else happens -- the document is not read, no consent is consulted,
no language model is contacted and nothing is stored. Until #3016 such an
account's document was read, classified and kept in a local corpus instead;
that second destination is retired, and journal writing is now the only thing
that reaches the local corpus (:mod:`services.corpus_ingest`).

**Nothing here is a second upload path.** The vault branch is
:func:`services.creek_vault_upload.store_upload`, called with an
:class:`~services.creek_vault_upload.UploadedDocument` and answered in the
:class:`~domain.creek_vault.VaultUploadStatus` vocabulary the vault write path
has always used. What this module adds is the routing rule and nothing else.

**The routing rule is about configuration, not weather.** The question is "does
this account reach a vault at all", and the answer is already computed once per
request by :func:`dependencies.creek_vault.get_creek_vault_client`, which
resolves the account's own connection first and the deployment binding second.
:class:`~services.creek_vault_client.LocalFallbackCreekVaultClient` is precisely
what that resolver hands back when the answer is no, so asking whether the
client *is* one is reading the resolver's own conclusion rather than
re-deriving it from a second lookup that could come to disagree.

"No" covers more than an account that never set a vault up. The resolver also
falls back for a managed vault that is still being prepared, for a stored host
it re-judged undialable, and for a deployment binding that belongs to somebody
else. That is why the answer's wording says the place a corpus lives is not
ready *for this account* rather than that the account has none.

It is deliberately not "did the vault answer". An account whose vault is
momentarily unreachable has a vault, and is told the vault did not answer, in
the vault's own vocabulary; their document goes nowhere either way.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from domain.corpus_import import CorpusImportStatus
from domain.creek_vault import CreekVaultClient, VaultUploadStatus
from models.corpus_fragment import CorpusSource
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_upload import UploadedDocument, store_upload

#: The consent source a brought-in document is offered under. ``UPLOAD`` rather
#: than ``IMPORT``: the enum reserves ``import`` for material pulled from a
#: service the account writes on elsewhere.
#:
#: Since #3016 nothing in this module writes a fragment under it, because a
#: document now goes to a vault or nowhere. It is kept, named, because epic
#: #3015 leaves the consent surface untouched: the switch for "documents you
#: bring in" stays offered, and the frontend's consent copy derives the
#: switches it offers from the sources the backend names. Whether that switch
#: should be retired is the epic owner's decision, not this module's.
IMPORT_SOURCE: Final[CorpusSource] = CorpusSource.UPLOAD


@dataclass(frozen=True)
class VaultImportResult:
    """One document's fate at the vault destination, in the vault's own words.

    :class:`~domain.creek_vault.VaultUploadStatus` unwrapped and unrenamed: the
    vault's own vocabulary reaches the caller as the vault said it, because a
    second set of words for one outcome is a second thing to keep true.
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
    """A document's fate when it reached no vault, in the corpus vocabulary.

    Since #3016 the import route produces exactly one of these,
    :data:`VAULT_REQUIRED_RESULT`, and it stores nothing. The shape keeps its
    ``fragment_id`` because the response it renders into is a published
    contract; a caller reads the status and never infers an outcome from a
    field's presence.
    """

    status: CorpusImportStatus
    fragment_id: int | None = None

    @property
    def stored(self) -> bool:
        """Whether the corpus kept the document as a fragment."""
        return self.status is CorpusImportStatus.STORED


#: What an import answers with. A union rather than one record carrying both
#: vocabularies with one of them null: the two answers cannot both apply, and a
#: type that can only hold one of them is what makes the surface unable to
#: report a vault status for a document that never went near a vault.
DocumentImportResult = VaultImportResult | CorpusImportResult

#: The whole answer for an account that reaches no vault. One shared, frozen
#: value: there is nothing about the document in it, because nothing about the
#: document was looked at.
VAULT_REQUIRED_RESULT: Final[CorpusImportResult] = CorpusImportResult(
    CorpusImportStatus.VAULT_REQUIRED
)


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


async def import_document(
    client: CreekVaultClient, document: UploadedDocument
) -> DocumentImportResult:
    """Take one document to this account's vault, or answer that it needs one.

    One document reaches one destination or none. An account with a vault has
    chosen where their writing lives; an account without one has, under #3015,
    nowhere a corpus can be kept, so it is told that and nothing is stored.

    No database session is taken, and that is the point: the no-vault answer is
    decided from the resolved client alone, so it cannot read consent, write a
    fragment, or reach a provider. The vault branch commits nothing either; the
    caller owns its transaction.
    """
    if not reaches_a_vault(client):
        return VAULT_REQUIRED_RESULT
    return await _to_vault(client, document)
