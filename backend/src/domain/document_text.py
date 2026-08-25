"""Read one user-supplied document into the writing it contains, or say why not.

Pure, and deliberately small. This is the only thing standing between a
document a person handed over and :mod:`services.corpus_ingest`, and its whole
job is to answer one question honestly: *is this writing adepthood can read by
itself?*

**Adepthood parses no documents, and this is not a parser.** The vault path is
explicit that format sniffing and ingestor selection belong to the vault --
:mod:`services.creek_vault_upload` forwards bytes and a filename and nothing
else. Nothing here changes that. What this module does is narrower: it reads
the formats that are *already text*, and declines the rest by name rather than
by silence. A PDF, a spreadsheet, a word-processor file and an exported
conversation are all things a vault's ingestors open; with no vault connected
there is no ingestor, and saying so is the honest answer.

**Why an AI conversation is not listed and is not missing.** Both Claude and
ChatGPT let a person export a single conversation as markdown by hand, which is
exactly the path this module already reads. The other shape -- the whole-account
JSON archive -- is not one document: it is hundreds of conversations, which
would be hundreds of fragments and hundreds of classification calls in one
request. That is a background job with observable progress, not a synchronous
import, and shipping a parser whose every output exceeded the per-fragment
ceiling would be shipping a path nobody could use.

**One document is one fragment.** :data:`MAX_DOCUMENT_CHARS` is the same ceiling
a journal entry lives under, reused rather than invented: a fragment is quoted
*verbatim* into a grounding prompt, and the journal path is only safe from an
unbounded prompt because ``schemas.journal.JOURNAL_MESSAGE_MAX_LENGTH`` caps an
entry before it is ever a row. A document carries no such cap of its own, so
the ceiling has to be applied here. It refuses rather than truncating, because
a fragment holding the first two thirds of somebody's essay would quote them
back a sentence they did not finish and present it as what they wrote.

Splitting a longer document into several fragments is the obvious next step and
is deliberately not taken here: it is one classification call per piece, which
is a different cost story and a different request shape.
"""

from __future__ import annotations

import enum
from pathlib import PurePosixPath
from typing import Final

from schemas.journal import JOURNAL_MESSAGE_MAX_LENGTH

#: The most writing one imported document may become. The same bound one journal
#: entry lives under, for the reason the module docstring gives: what is stored
#: is quoted verbatim into a grounding prompt.
MAX_DOCUMENT_CHARS: Final[int] = JOURNAL_MESSAGE_MAX_LENGTH

#: The filename extensions that are text somebody wrote, with no parser between
#: the bytes and the words. Matched lowercased, because an extension names a
#: format rather than guarding a door.
#:
#: Markdown carries the weight here: it is what both major AI assistants export
#: a single conversation as, what a static-site blog is written in, and what
#: most note-taking apps export. Plain text is its floor.
READABLE_SUFFIXES: Final[frozenset[str]] = frozenset({".md", ".markdown", ".txt", ".text"})

#: The encoding a text document is read as. UTF-8 and nothing else: a document
#: that is not UTF-8 is refused rather than guessed at, because a wrong guess
#: does not fail -- it succeeds, and stores mojibake as somebody's writing.
_TEXT_ENCODING: Final[str] = "utf-8"


class DocumentReadFailure(enum.Enum):
    """Why one document did not yield writing, in terms a person can act on.

    A plain :class:`enum.Enum` rather than a ``StrEnum`` on purpose. This type
    shares a return annotation with :class:`str`, and a string enum would make
    ``isinstance(result, str)`` true for a *failure* -- the one narrowing every
    caller performs, silently inverted.

    Each member has a different remedy, which is why they are counted apart:
    :attr:`FORMAT_UNREADABLE` is a file that needs a vault, :attr:`NOT_TEXT` is
    a file that is not what its name says, :attr:`EMPTY` is a file with nothing
    in it, and :attr:`TOO_LONG` is a file to split.
    """

    FORMAT_UNREADABLE = enum.auto()
    NOT_TEXT = enum.auto()
    EMPTY = enum.auto()
    TOO_LONG = enum.auto()


def is_readable_format(filename: str) -> bool:
    """Whether ``filename`` names a format adepthood can read without a parser.

    The suffix is taken from the name the uploader supplied, which
    ``schemas.journal_upload.UploadDocumentRequest`` has already refused to
    accept as anything but one plain, inert name -- no separators, no dot runs,
    no leading dot. So the parse here is a suffix read rather than a path
    operation, and there is no traversal shape left for it to resolve.
    """
    return PurePosixPath(filename).suffix.lower() in READABLE_SUFFIXES


def _decode(raw: bytes) -> str | DocumentReadFailure:
    """Decode ``raw`` as UTF-8 text, or report that it is not text."""
    try:
        return raw.decode(_TEXT_ENCODING)
    except UnicodeDecodeError:
        return DocumentReadFailure.NOT_TEXT


def read_document(filename: str, raw: bytes) -> str | DocumentReadFailure:
    """Return the writing in one document, or the reason there is none to return.

    The order of the four refusals is the order in which each becomes knowable,
    and each stops before the next is attempted: an unreadable *format* is
    decided from the name alone, so a ten-megabyte PDF is refused without being
    decoded; bytes that are not text are refused before they are measured; and
    a document is measured after its surrounding whitespace is dropped, so a
    file padded with blank lines is judged on its writing.

    The returned text is stripped at both ends. What is stored is what a
    grounding prompt will quote, and leading blank lines are not something
    anybody wrote.
    """
    if not is_readable_format(filename):
        return DocumentReadFailure.FORMAT_UNREADABLE
    decoded = _decode(raw)
    if isinstance(decoded, DocumentReadFailure):
        return decoded
    text = decoded.strip()
    if not text:
        return DocumentReadFailure.EMPTY
    if len(text) > MAX_DOCUMENT_CHARS:
        return DocumentReadFailure.TOO_LONG
    return text
