"""The request DTO for one user document, and what each outcome tells them.

Named for the surface these shapes were written for, ``POST /journal/upload``,
which has since been retired: ``POST /corpus/import`` reuses the request
verbatim and routes it per account -- to the vault when the account has one, to
its own ontologized corpus when it has not -- so the vault-only route it grew
out of had nothing left that it alone could do. The vocabulary stayed because
it is the vault's, not the route's.

The transport is deliberately **base64-in-JSON**, exactly as the page-capture
flow moves image bytes, and deliberately *not* the form-encoded file transport
Starlette spools to disk. That is a standing constraint rather than a
preference: ``tests/test_transcription_privacy.py`` asserts the source tree
carries no such surface anywhere, so an endpoint that reached for one would
break a privacy guarantee the repository enforces by grep. Document bytes stay
in request-scoped memory and never touch disk.

Nothing on this DTO is persisted locally when the document goes to a vault.
It travels through adepthood and adepthood keeps no copy: there is no upload
table, no spool, and no row that outlives the request. What comes back is the
vault's own outcome, which is the only record either side keeps. An account
with no vault is the other half of that decision and is
:mod:`services.corpus_import`'s subject, not this module's.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
from types import MappingProxyType

from pydantic import BaseModel, Field, field_validator

from domain.creek_vault import VaultUploadStatus
from models.journal_entry import JournalClassification

# The decoded-bytes ceiling for one document. Ten megabytes comfortably admits a
# scanned PDF or a long export while bounding what a single request can make the
# process allocate. Exported (not underscore-private) because the frontend picker
# and the user-facing copy both need to name the same number.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

# Cheap oversize pre-guard on the *encoded* string, so a huge payload is rejected
# without ever allocating the decoded bytes. Base64 expands raw bytes by 4/3; the
# ``+ 4`` absorbs the padding block so a legitimately max-sized document is not
# rejected by rounding. The same shape ``routers/transcription.py`` uses.
MAX_UPLOAD_BASE64_CHARS = (MAX_UPLOAD_BYTES * 4) // 3 + 4


class DocumentTooLargeError(ValueError):
    """Raised when a submitted document exceeds :data:`MAX_UPLOAD_BYTES`."""


class DocumentEncodingError(ValueError):
    """Raised when a submitted document is not decodable base64."""


def decode_document(content_base64: str) -> bytes:
    """Decode one submitted document, refusing an oversized or unreadable one.

    Two gates, cheapest first, mirroring ``routers/transcription.py``: the
    *encoded* length is checked against :data:`MAX_UPLOAD_BASE64_CHARS` so a
    huge payload is rejected without allocating the decoded bytes at all, and
    the decoded length is then checked against the real ceiling so a payload
    that slipped past the first by rounding still cannot exceed it.

    Lives here, beside the ceiling it enforces, and raises plain exceptions
    rather than :class:`fastapi.HTTPException`, so the ceiling is stated once
    however many surfaces come to accept a document -- a ceiling enforced twice
    is a ceiling that can come to disagree with itself.
    :func:`dependencies.document_payload.guard_document_payload` is the single
    place these become HTTP answers.

    A malformed encoding is deliberately a different exception from an
    oversized one: they are different defects with different fixes, and bytes
    we could not decode must not travel anywhere as if they were a document.
    """
    if len(content_base64) > MAX_UPLOAD_BASE64_CHARS:
        raise DocumentTooLargeError
    try:
        raw = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise DocumentEncodingError from exc
    if len(raw) > MAX_UPLOAD_BYTES:
        raise DocumentTooLargeError
    return raw


# Longest filename accepted. Generous for real documents, and short enough that a
# name cannot itself become a payload.
MAX_FILENAME_LENGTH = 255

# The two characters that turn a name into a path. Rejected rather than escaped,
# because the name is what the vault reads an ingestor choice off -- a name whose
# meaning we cannot state is one we should not forward.
_PATH_SEPARATORS = frozenset({"/", "\\"})

# A run of dots is how a name climbs out of the collection it was meant to sit in.
_CONSECUTIVE_DOTS = ".."


def _is_safe_filename(value: str) -> bool:
    """Return whether ``value`` is one plain, inert filename.

    Deliberately a *denylist of dangerous shapes* rather than an
    allowlist of permitted characters. An ASCII allowlist is the obvious
    implementation and the wrong one: it would refuse ``résumé.pdf``, every CJK
    filename, and most of the world's documents, which is a far larger harm than
    the one it prevents. What actually has to be excluded is small and nameable.

    ``str.isprintable`` carries most of the weight, and carries it for the same
    reasons :func:`security.sanitize_user_text` scrubs journal text: it rejects
    NUL (which a path cannot carry anyway), CR/LF (log injection, should the name
    ever be rendered), every other control character, and the zero-width and
    bidi-override codepoints that make a name display as something other than
    what it is -- a ``.txt`` that reads as a ``.exe``. It also rejects the
    non-ASCII separators, since Unicode ``Zs`` is non-printable by this test while
    the plain ASCII space, which real filenames use constantly, is allowed.

    The rest is explicit: no path separator, no dot run, and no leading dot or
    surrounding whitespace -- a leading dot both hides the file and, for a name
    that is only dots, is the traversal shape itself.
    """
    if not value.isprintable():
        return False
    if _CONSECUTIVE_DOTS in value or value.startswith("."):
        return False
    if _PATH_SEPARATORS.intersection(value):
        return False
    return value == value.strip()


class UploadDocumentRequest(BaseModel):
    """One user-supplied document submitted for the vault to ingest.

    ``filename`` is what the vault reads an extension off to pick its ingestor,
    so it is validated here rather than passed through: adepthood does not parse
    the document, which makes the name the single field that steers what happens
    to it on the far side.

    ``classification`` is the privacy tier the uploader chose, and it is honored
    end to end: the document is stored at exactly that tier, never quietly
    downgraded so a call can succeed. An ``intimate`` document is therefore
    forwarded nowhere -- Creek's published upload request has no spelling for
    that tier, and narrowing it would file the document at a depth its owner did
    not choose. See :mod:`services.creek_vault_upload`. No tier on this path
    reaches a cloud LLM either way.
    """

    filename: str = Field(
        min_length=1,
        max_length=MAX_FILENAME_LENGTH,
        description="The document's own name; its extension selects the vault's ingestor.",
    )
    content_base64: str = Field(
        min_length=1,
        description="Base64-encoded document bytes.",
        # Kept out of ``repr()``/``str()`` so the document can never leak into a
        # log line or a traceback that stringifies the model.
        repr=False,
    )
    classification: JournalClassification = Field(
        description="The privacy tier the uploader chose for this document."
    )

    @field_validator("filename")
    @classmethod
    def _reject_unsafe_filename(cls, value: str) -> str:
        """Reject any name that is not one plain, inert filename.

        Fails closed on anything ambiguous. The name ends up in a request the
        vault routes on and, before that, in adepthood's own identity digest, so
        "reject what we cannot state the meaning of" is cheaper than reasoning
        about what a path separator or a control character would do to either.
        """
        if not _is_safe_filename(value):
            message = "filename must be a single plain name without path separators"
            raise ValueError(message)
        return value


# What each upload outcome tells the person who sent the document. Every line
# names what happened, why, and the one thing they can do next -- none of them
# ends at "contact support", because every one of these has a self-serve remedy.
UPLOAD_MESSAGES: Mapping[VaultUploadStatus, str] = MappingProxyType(
    {
        VaultUploadStatus.ACCEPTED: (
            "Your document is in your vault. It will show up in reflections from here on."
        ),
        VaultUploadStatus.VAULT_UNAVAILABLE: (
            "Your vault didn't answer, so the document wasn't sent. Check that your vault "
            "is running and reachable, then upload it again."
        ),
        # Reached three ways, and the message has to serve all three without
        # misdirecting any: the vault never offered uploads, it offers a route
        # this pair of versions cannot negotiate, or the document is marked
        # ``intimate`` and that tier has no spelling on the wire at all. Telling
        # someone to update software that is already current is an instruction
        # that cannot work, and so is telling the intimate case to update
        # anything -- so the tier is named first, because it is the only one of
        # the three with a remedy the person holding the document controls.
        # Nothing here promises a retry of the same request, because none of the
        # three is cleared by one.
        VaultUploadStatus.CAPABILITY_UNSUPPORTED: (
            "This document wasn't sent, and nothing in your vault changed — journal "
            "entries still save as usual. If you marked it Intimate, that tier stays on "
            "this device and never goes to a vault; choose a different tier if you want "
            "it there. Otherwise file uploads aren't working between Adepthood and your "
            "vault yet — update your vault if a newer version is out, and keep the file "
            "until one of you has caught up."
        ),
        VaultUploadStatus.DEGRADED: (
            "The upload didn't complete and the document wasn't stored. Nothing was "
            "changed in your vault — please try again."
        ),
    }
)


# Matched to ``transcription.TRANSCRIBE_RATE_LIMIT`` rather than to the stricter
# resonance limit, because this endpoint is the same *class* of thing: a base64
# payload a person submits deliberately, in bursts, with no LLM spend attached.
# Someone adding a folder of documents legitimately makes a dozen calls in a row,
# and one document per request is the shipped contract (batching is a follow-up),
# so a tighter cap would throttle ordinary use rather than abuse.
#
# It is bounded at all because an upload is heavier than an ordinary write: 10 MB
# per call, twice what transcription accepts, and every accepted call is forwarded
# to an external network dependency. A plain ``POST /journal/`` carries neither
# cost, which is why it is unrated and this is not.
UPLOAD_RATE_LIMIT = "20/minute"
