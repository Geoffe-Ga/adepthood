"""The one place a submitted document's size becomes an HTTP answer.

Two surfaces accept a document from a person: ``POST /journal/upload``, which
forwards it to their vault, and ``POST /corpus/import``, which routes it to
whichever destination they actually have. Both are bounded by the same ceiling,
and the ceiling is stated once -- in
:func:`schemas.journal_upload.decode_document`, beside the constants it
enforces. This module is the thin translation of that one decision into the two
status codes it earns.

The decoded bytes are *returned* rather than discarded, so the import path does
not decode the same payload a second time to read it. A ten-megabyte document
decoded twice is ten megabytes allocated twice, on a request that already holds
the encoded copy.
"""

from __future__ import annotations

from errors import payload_too_large, unprocessable
from schemas.journal_upload import DocumentEncodingError, DocumentTooLargeError, decode_document


def guard_document_payload(content_base64: str) -> bytes:
    """Decode one submitted document, or refuse the request with the right status.

    A document over the ceiling is a 413 and a document we could not decode is
    a 422, because they are different defects with different fixes: one is a
    file to split or shrink, the other is a client that built the payload
    wrong. Flattening them would leave a person unable to tell which of the two
    they have.
    """
    try:
        return decode_document(content_base64)
    except DocumentTooLargeError as exc:
        raise payload_too_large("document_too_large") from exc
    except DocumentEncodingError as exc:
        raise unprocessable("invalid_document_encoding") from exc
