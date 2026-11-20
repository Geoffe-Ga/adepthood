"""Keeping a receipt for each document an account sends to its vault (#3775).

``POST /corpus/import`` calls :func:`record_upload_receipt` with the answer it
is about to render, inside the transaction it already commits, so a receipt
exists exactly when the import's own answer does. The receipt is the answer
persisted -- filename, the digest id the upload was addressed by, the vault's
ref and status -- and never a byte of the document.

**The folder's name is not kept.** A folder import's namespace and paths are
the writer's own words about how they file their life, which is why the import
path never logs them (``tests/test_folder_upload_identity.py``); persisting the
namespace would put it in every statement log a database driver writes. A
receipt carries :func:`batch_digest` instead: the same opaque value for every
document of one import, which is all grouping needs.

Two imports earn no receipt. An account with no vault was answered
``vault_required`` and nothing was sent anywhere. An Intimate document is
withheld from the vault by construction, and its name is the writer's own words
about something they chose to keep closest; keeping it here as a "receipt" for
a send that never happened would store the one thing the tier exists to keep
put.
"""

from __future__ import annotations

import hashlib
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from domain.corpus_import import ImportDestination
from domain.upload_source import normalize_source_text
from models.journal_entry import JournalClassification
from models.upload_receipt import UploadReceipt
from services.corpus_import import DocumentImportResult, VaultImportResult
from services.creek_vault_upload import FolderSource, UploadedDocument, upload_external_id

#: How many hex characters of the batch digest a receipt keeps: enough that two
#: of one account's imports do not collide, short enough to name nothing.
BATCH_DIGEST_CHARS: Final = 16

#: Separates the account from the namespace in the digest's pre-image, so no
#: pair of (account, namespace) can be spelled two ways.
_BATCH_DOMAIN: Final = b"adepthood-upload-batch\x00"
_BATCH_SEPARATOR: Final = b"\x1f"


def batch_digest(owner_user_id: int, source: FolderSource | None) -> str | None:
    """An opaque value shared by every document of one folder import, or ``None``.

    Keyed on the account as well as the normalized namespace, so two accounts'
    identically named imports do not share a value. ``None`` for a single file.
    """
    if source is None:
        return None
    pre_image = b"".join(
        (
            _BATCH_DOMAIN,
            str(owner_user_id).encode(),
            _BATCH_SEPARATOR,
            normalize_source_text(source.namespace).encode(),
        )
    )
    return hashlib.sha256(pre_image).hexdigest()[:BATCH_DIGEST_CHARS]


def record_upload_receipt(
    session: AsyncSession, document: UploadedDocument, result: DocumentImportResult
) -> UploadReceipt | None:
    """Stage a receipt for one settled vault import, or nothing when none is owed.

    Adds the row to ``session`` without committing: the caller owns the
    transaction, and commits it with the rest of the import. Only the
    document's names are read; its content is never touched.
    """
    if not isinstance(result, VaultImportResult):
        return None
    if document.classification == JournalClassification.INTIMATE:
        return None
    receipt = UploadReceipt(
        user_id=document.owner_user_id,
        filename=document.filename,
        batch=batch_digest(document.owner_user_id, document.source),
        external_id=upload_external_id(document.owner_user_id, document.filename, document.source),
        vault_ref=result.vault_ref,
        destination=ImportDestination.VAULT.value,
        vault_status=result.status.value,
    )
    session.add(receipt)
    return receipt
