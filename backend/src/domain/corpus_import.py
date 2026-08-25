"""The two vocabularies one document import is answered in.

A document a person hands over has two possible destinations and they are not
interchangeable, so the answer says which one it reached before it says what
happened there. :class:`ImportDestination` is that field.

The vault destination keeps its own vocabulary --
:class:`domain.creek_vault.VaultUploadStatus`, unchanged and unwrapped, because
the vault path is the shipped one and re-spelling its outcomes here would be a
second reading of the same four facts. :class:`CorpusImportStatus` exists only
because the local-corpus destination can end in ways a vault never does: it
gates on consent the account gave per source, and it calls a language model,
neither of which the vault path does.

That last difference is the whole asymmetry this surface exists to express. ADR
0004 Decision 6's 2026-08-08 amendment permits an intimate document to reach an
operator-held vault *because that path contacts no language model at any tier*.
The local corpus does contact one, to place the writing among the ten
frequencies, so the same reasoning does not carry across and the tier is
declined here instead. Both destinations end up refusing intimate material --
what differs is the reason, which is why they are different words.
"""

from __future__ import annotations

import enum


class ImportDestination(enum.StrEnum):
    """Where one imported document actually went.

    Resolved per account rather than per deployment: an account that has
    connected a vault of their own reaches it, and an account that has
    connected none reaches their local corpus. Neither is a fallback from the
    other -- they are two different places writing can live, and a person is
    entitled to be told which of them theirs is in.
    """

    VAULT = "vault"
    CORPUS = "corpus"


class CorpusImportStatus(enum.StrEnum):
    """What became of a document routed to the account's own ontologized corpus.

    Eight outcomes, one of which stores anything. They are enumerated rather
    than flattened into a boolean because each has a *different next step* for
    the person holding the document -- turn the setting on, choose another
    tier, export it as markdown, split it, or nothing at all -- and a surface
    that could not tell them apart would answer every one of them with "it
    didn't work".

    :attr:`FORMAT_UNREADABLE` and :attr:`NOT_TEXT` look alike and are not. The
    first is a format adepthood never claimed to open, and a connected vault
    would have opened it; the second is a file whose name says text and whose
    bytes are not.
    """

    STORED = "stored"
    CONSENT_REQUIRED = "consent_required"
    TIER_REFUSED = "tier_refused"
    FORMAT_UNREADABLE = "format_unreadable"
    NOT_TEXT = "not_text"
    EMPTY_DOCUMENT = "empty_document"
    DOCUMENT_TOO_LONG = "document_too_long"
    UNCLASSIFIED = "unclassified"
