"""What the import surface answers, and the sentence each answer carries.

The request is :class:`schemas.journal_upload.UploadDocumentRequest`, reused
rather than re-declared: the filename rules, the base64 transport and the tier
field are the same three facts about the same document, and a second copy of
them is a second place for them to drift. In particular the base64-in-JSON
transport is not a preference here either -- ``tests/test_transcription_privacy.py``
asserts by grep that no form-encoded file surface exists anywhere in the source
tree, so an import endpoint that reached for one would break a privacy
guarantee the repository enforces.

The response reports the destination first, because the two destinations answer
in two different vocabularies and a client that could not tell which applied
would have to guess. Exactly one of ``vault_status`` and ``corpus_status`` is
ever populated, and ``stored`` states in one boolean the fact every client
actually branches on.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType

from pydantic import BaseModel, Field

from domain.corpus_import import CorpusImportStatus, ImportDestination
from domain.creek_vault import VaultUploadStatus
from domain.document_text import MAX_DOCUMENT_CHARS, READABLE_SUFFIXES

# The formats named in the copy below, rendered from the set the reader
# actually enforces so the sentence a person is shown cannot come to list
# something the code declines.
_READABLE_LIST = ", ".join(sorted(READABLE_SUFFIXES))


# What each corpus outcome tells the person who sent the document. Every line
# names what happened and the one thing they can do next, in the same register
# as ``schemas.journal_upload.UPLOAD_MESSAGES`` -- none of them ends at
# "contact support", because every one of these has a self-serve remedy or is
# not a failure at all.
CORPUS_IMPORT_MESSAGES: Mapping[CorpusImportStatus, str] = MappingProxyType(
    {
        CorpusImportStatus.STORED: (
            "Your document is in your corpus. It will show up in reflections from here on."
        ),
        # The default is no, and it is no on purpose, so this is the ordinary
        # first answer rather than an error state. It names the setting rather
        # than the endpoint, because the person reading it is looking at a
        # screen and not at an API.
        CorpusImportStatus.CONSENT_REQUIRED: (
            "Nothing was imported. Adepthood only adds documents to your corpus once you "
            "turn that on, and you haven't yet — switch on uploads in your corpus "
            "settings and send it again."
        ),
        # The asymmetry, said plainly and without blaming the file. Placing a
        # document among the frequencies means showing it to a language model,
        # which is exactly what the intimate tier is for refusing.
        CorpusImportStatus.TIER_REFUSED: (
            "This document is marked Intimate, so it stayed on your device and nothing "
            "was stored. Adepthood reads a document with a language model to place it "
            "among the frequencies, and Intimate writing never goes to one. Choose a "
            "different tier if you want it in your corpus."
        ),
        CorpusImportStatus.FORMAT_UNREADABLE: (
            "Adepthood can't open this kind of file on its own, so nothing was stored. "
            f"It reads {_READABLE_LIST} files — most apps, including Claude and ChatGPT, "
            "can export as Markdown. Connect a Creek Vault if you want richer formats "
            "read for you."
        ),
        CorpusImportStatus.NOT_TEXT: (
            "This file is named as text but isn't readable as text, so nothing was "
            "stored. Re-export it as UTF-8 and send it again."
        ),
        CorpusImportStatus.EMPTY_DOCUMENT: (
            "There's no writing in this document, so there was nothing to store."
        ),
        CorpusImportStatus.DOCUMENT_TOO_LONG: (
            "This document is longer than one corpus entry can hold, so nothing was "
            f"stored. Split it into pieces of up to {MAX_DOCUMENT_CHARS:,} characters "
            "and send them separately."
        ),
        # Not a failure of the document and not phrased as one. A piece of
        # writing that sits at no position on the ontology could only ever be
        # retrieved by recency, which is the thing the corpus replaced.
        CorpusImportStatus.UNCLASSIFIED: (
            "Adepthood couldn't place this document among the frequencies, so it wasn't "
            "added — a corpus entry has to sit somewhere on the map to be found again. "
            "Nothing was changed, and you can try again."
        ),
    }
)


class DocumentImportResponse(BaseModel):
    """What became of one imported document, and where it went.

    ``destination`` is the discriminator: a ``vault`` answer carries
    ``vault_status`` and possibly a ``vault_ref`` and ``tags``, and a
    ``corpus`` answer carries ``corpus_status`` and possibly a ``fragment_id``.
    The other side is ``null`` in each case, which is a stronger statement than
    an absent field -- it says that vocabulary did not apply, rather than that
    nobody filled it in.
    """

    destination: ImportDestination = Field(description="Which corpus the document reached.")
    stored: bool = Field(description="Whether the document was durably kept anywhere.")
    vault_status: VaultUploadStatus | None = Field(
        default=None, description="What the vault did, for a vault destination."
    )
    vault_ref: str | None = Field(
        default=None, description="The vault's fragment handle, present only when accepted."
    )
    tags: list[str] = Field(
        default_factory=list, description="Tags the vault's ingest pipeline assigned."
    )
    corpus_status: CorpusImportStatus | None = Field(
        default=None, description="What the local corpus did, for a corpus destination."
    )
    fragment_id: int | None = Field(
        default=None, description="The stored corpus fragment's id, present only when stored."
    )
    message: str = Field(description="Self-serve explanation for the person who imported it.")
