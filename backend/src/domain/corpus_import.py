"""The two vocabularies one document import is answered in.

A document a person hands over is answered either by their vault or, when they
have none, by adepthood on the vault's behalf, and the two answers are in
different words, so the answer says which applied before it says what
happened. :class:`ImportDestination` is that field.

The vault destination keeps its own vocabulary --
:class:`domain.creek_vault.VaultUploadStatus`, unchanged and unwrapped, because
the vault path is the shipped one and re-spelling its outcomes here would be a
second reading of the same four facts.

**A corpus lives in a vault (#3015).** Since #3016 an account with no vault has
no second destination: its document is not read, classified or stored, and the
answer is :attr:`CorpusImportStatus.VAULT_REQUIRED`. The other eight members of
:class:`CorpusImportStatus` described a local corpus import that no longer
happens. They are kept on the wire deliberately: the enum is published in
``openapi.json`` and mirrored by every shipped client's validator, and
narrowing a published enum in the same change that stops producing its values
would turn an old client's harmless unused branch into a validation failure.
Pruning them is a follow-up for epic #3015, not a side effect of this one.
"""

from __future__ import annotations

import enum


class ImportDestination(enum.StrEnum):
    """Which vocabulary one import's answer is in.

    Resolved per account rather than per deployment. ``vault`` means the
    account reaches a vault and the vault answered. ``corpus`` means it reaches
    none: since #3016 that answer is always
    :attr:`CorpusImportStatus.VAULT_REQUIRED` and nothing was stored anywhere --
    the label is the one the wire has always carried for a vault-less account,
    not a claim that a local corpus took the document.
    """

    VAULT = "vault"
    CORPUS = "corpus"


class CorpusImportStatus(enum.StrEnum):
    """What became of a document that reached no vault.

    :attr:`VAULT_REQUIRED` is the only member the import route produces since
    #3016: the account has nowhere a corpus can be kept, and the next step is
    to set up, or check on, the place it lives -- *Where your corpus lives* in
    Settings. Nothing is stored.

    The other eight described the retired local-corpus import, one of which
    (:attr:`STORED`) stored anything. They are unreachable from
    ``POST /corpus/import`` and stay only for wire stability, as the module
    docstring explains.
    """

    STORED = "stored"
    CONSENT_REQUIRED = "consent_required"
    TIER_REFUSED = "tier_refused"
    FORMAT_UNREADABLE = "format_unreadable"
    NOT_TEXT = "not_text"
    EMPTY_DOCUMENT = "empty_document"
    DOCUMENT_TOO_LONG = "document_too_long"
    UNCLASSIFIED = "unclassified"
    VAULT_REQUIRED = "vault_required"
