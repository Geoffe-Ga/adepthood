"""Two facts about documents that the import copy still states.

This module used to read a document into text for the local-corpus import. That
import is retired (#3015, #3016): an account with no vault is answered before
anything is read, and a vault reads documents itself, so adepthood parses and
reads no documents at all. The reader went with it.

What is left are the two facts the retained corpus copy in
:mod:`schemas.corpus_import` quotes -- the formats that are already text and
the one-fragment ceiling -- kept here, beside each other, for as long as the
statuses that quote them stay on the wire.
"""

from __future__ import annotations

from typing import Final

from schemas.journal import JOURNAL_MESSAGE_MAX_LENGTH

#: The most writing one imported document could become. The same bound one
#: journal entry lives under, because a stored fragment is quoted verbatim into a
#: grounding prompt.
MAX_DOCUMENT_CHARS: Final[int] = JOURNAL_MESSAGE_MAX_LENGTH

#: The filename extensions that are text somebody wrote, with no parser between
#: the bytes and the words.
#:
#: Markdown carries the weight here: it is what both major AI assistants export
#: a single conversation as, what a static-site blog is written in, and what
#: most note-taking apps export. Plain text is its floor.
READABLE_SUFFIXES: Final[frozenset[str]] = frozenset({".md", ".markdown", ".txt", ".text"})
