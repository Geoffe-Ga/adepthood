"""Request/response DTOs for handing one user document to the Creek Vault.

The transport is deliberately **base64-in-JSON**, exactly as the page-capture
flow moves image bytes, and deliberately *not* the form-encoded file transport
Starlette spools to disk. That is a standing constraint rather than a
preference: ``tests/test_transcription_privacy.py`` asserts the source tree
carries no such surface anywhere, so an endpoint that reached for one would
break a privacy guarantee the repository enforces by grep. Document bytes stay
in request-scoped memory and never touch disk.

Nothing on either DTO is persisted locally. The document travels through
adepthood to the vault and adepthood keeps no copy: there is no upload table, no
spool, and no row that outlives the request. What comes back is the vault's own
outcome, which is the only record either side keeps.
"""

from __future__ import annotations

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


class UploadDocumentResponse(BaseModel):
    """What became of one uploaded document, in the vault's own terms.

    ``status`` is the whole answer: a client renders from it and never has to
    infer an outcome from the presence or absence of another field.
    ``vault_ref`` is the vault's handle on the stored fragment, present only when
    the document was actually accepted. ``tags`` are the classification the
    vault's ingest pipeline assigned -- empty until the vault returns them, which
    is the expected answer today rather than a failure. ``message`` is the
    self-serve sentence shown to the person who uploaded it.
    """

    status: VaultUploadStatus = Field(description="What the vault did with the document.")
    vault_ref: str | None = Field(
        default=None, description="The vault's fragment handle, present only when accepted."
    )
    tags: list[str] = Field(
        default_factory=list, description="Tags the vault's ingest pipeline assigned."
    )
    message: str = Field(description="Self-serve explanation for the person who uploaded it.")
