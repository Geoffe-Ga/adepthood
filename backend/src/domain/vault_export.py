"""What a Creek Vault hands its owner back: the values of the 0.27 export read (#3579).

On a managed vault the vault holds the only copy of every document imported
through adepthood (#3016), and the writer cannot reach that vault except through
adepthood, which holds its credential (ADR 0009). So "Export my data" can only
keep its promise if adepthood asks the vault for the writer's content and hands
it over. Creek publishes that read as ``GET /v1/export`` at contract 0.27
(Creek-Vault#2033); this module holds the values one page of it becomes once
:mod:`services.creek_vault_export_wire` has parsed and checked it.

**Every tier, intimate included.** This is the one place adepthood names
``intimate`` as a value a vault may send. It is the owner's own writing,
returned to the owner over their own authenticated channel -- the same reason
adepthood's own journal export carries Intimate entries -- and Creek serves the
read only to a vault's sole configured consumer. :class:`VaultExportTier` is a
separate enum from :class:`~domain.creek_vault.WireTierCeiling` on purpose, so
no ceiling anywhere grows a member it must never carry.

A leaf: it imports nothing from the rest of the application, so both the
client protocol in :mod:`domain.creek_vault` and the wire parser can depend on
it without a cycle.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Final

#: The contract minor that publishes the export read. Declared on that one call
#: only, and only to a vault whose handshake lists it; the base pin stays put.
VAULT_EXPORT_SINCE_MINOR: Final = "0.27"

#: The most items Creek returns on one page, and so the page size adepthood asks
#: for: the published clamp, so a whole export takes as few round trips as the
#: contract allows.
VAULT_EXPORT_MAX_LIMIT: Final = 200


class VaultExportTier(enum.StrEnum):
    """The privacy tier an exported fragment carries -- every tier there is.

    Mirrors Creek's closed ``ExportTier``. ``UNCLASSIFIED`` is a fragment the
    vault has not sorted yet; it is exported like any other.
    """

    OPEN = "open"
    PERSONAL = "personal"
    INTIMATE = "intimate"
    UNCLASSIFIED = "unclassified"


@dataclass(frozen=True)
class VaultExportDocument:
    """One staged upload or attachment, as the vault holds it.

    ``document_id`` is Creek's staged name -- ``safe_stem(external_id)`` plus a
    sanitised suffix -- and for a document adepthood uploaded the external id is
    a digest of the upload's identity, so the name carries the file type but
    never the filename the writer chose. ``content_base64`` and ``sha256`` are
    ``None`` exactly when ``content_included`` is false: the document was larger
    than one page may carry. When they are present the digest and the size have
    already been checked against the bytes.
    """

    document_id: str
    size_bytes: int
    sha256: str | None
    content_base64: str | None
    content_included: bool


@dataclass(frozen=True)
class VaultExportFragment:
    """One classified fragment: its labels, and its file verbatim.

    ``markdown`` is the whole fragment file, frontmatter and body, or ``None``
    exactly when ``content_included`` is false. ``document_id`` names the staged
    document the fragment was ingested from, when it came from one.
    """

    fragment_id: str
    tier: VaultExportTier
    frequency: str
    phase: str
    source_platform: str
    document_id: str | None
    markdown: str | None
    content_included: bool


@dataclass(frozen=True)
class VaultExportPage:
    """One page of the owner's vault-held content, checked and ready to hand over.

    ``skipped`` is Creek's count of files on this page that claimed to be
    fragments but could not be read: counted rather than dropped, so an export
    can say it is missing something. ``next_cursor`` is where the next page
    starts, or ``None`` on the last page. ``answer_bytes`` is the size of the
    vault's answer on the wire, so a caller can bound a whole export by what it
    actually received rather than by item counts alone.
    """

    documents: tuple[VaultExportDocument, ...]
    fragments: tuple[VaultExportFragment, ...]
    skipped: int
    next_cursor: str | None
    answer_bytes: int
