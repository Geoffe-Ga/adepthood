"""The one place a submitted document's size becomes an HTTP answer.

One surface accepts a document from a person -- ``POST /corpus/import``, which
takes it to their vault or answers that it needs one -- and this module stays
separate from it rather than folding back into the router, because the ceiling
belongs to the document rather than to the route that happens to carry it. It
is stated once, in :func:`schemas.journal_upload.decode_document`, beside the
constants it enforces; this is the thin translation of that one decision into
the two status codes it earns. ``POST /journal/upload`` was the second such
surface until it was retired, having no caller and no destination the import
route did not already reach.

The decoded bytes are discarded. Since #3016 nothing on the import route reads
a document's text -- the vault is handed the encoded copy and an account with no
vault is answered before anything is read -- so the decode exists only as the
check: the decoded-length ceiling and the encoding test are both answered by
attempting it. It still runs first, for every caller, so an oversized or broken
document is refused as such whether or not the account has a vault.
"""

from __future__ import annotations

from errors import payload_too_large, unprocessable
from schemas.journal_upload import DocumentEncodingError, DocumentTooLargeError, decode_document


def guard_document_payload(content_base64: str) -> None:
    """Check one submitted document decodes within bounds, or refuse the request.

    A document over the ceiling is a 413 and a document we could not decode is
    a 422, because they are different defects with different fixes: one is a
    file to split or shrink, the other is a client that built the payload
    wrong. Flattening them would leave a person unable to tell which of the two
    they have.
    """
    try:
        decode_document(content_base64)
    except DocumentTooLargeError as exc:
        raise payload_too_large("document_too_large") from exc
    except DocumentEncodingError as exc:
        raise unprocessable("invalid_document_encoding") from exc
