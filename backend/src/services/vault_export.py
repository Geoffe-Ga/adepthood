"""Hand a writer back what their Creek Vault holds of theirs, a page at a time (#3579).

On a managed vault the vault holds the only copy of every document imported
through adepthood (#3016), and the writer cannot reach it except through
adepthood, which holds its credential (ADR 0009). So the take-your-data-with-you
promise of ``GET /users/me/export`` cannot be kept by adepthood's own tables
alone. This module keeps the rest of it: it reads Creek's owner export
(``GET /v1/export``, contract 0.27) through the caller's own resolved vault
client and streams it out as one JSON file, ``adepthood-vault-<date>.json``.

**Separate from the main archive, on purpose.** The vault may be asleep,
unreachable or on an older image; the main archive must still download when it
is. So this is its own route, and the main archive's ``not_included`` points
here rather than claiming a vault exports itself.

**Said, never silently omitted.** Before a byte is sent the first page is read,
so every way the export cannot start -- no vault, a vault that cannot be
reached, one that predates 0.27, one that refuses -- is a refusal the route
turns into a status with a code the app can explain (:class:`VaultExportRefusal`).
Once the file has started, the status is already sent, so a failure on a later
page cannot change it: the file instead ends with ``"complete": false`` and an
``incomplete_reason`` (:class:`IncompleteReason`), keeping everything read so
far. Every bound the export stops at is reported the same way. Nothing ever
ends a file with ``"complete": true`` that did not read every page and include
every item.

**Bounded.** One page is held at a time -- at most 200 items and 10 MiB of raw
content, Creek's own page budget -- and a whole export stops after
:data:`VAULT_EXPORT_MAX_PAGES` pages or :data:`VAULT_EXPORT_MAX_BYTES` received,
whichever comes first.

**It logs that an export happened and nothing about what it said**, exactly as
:mod:`services.data_export` does: one event with the account id and counts. No
content, no document name, no fragment id, no cursor. A vault failure is logged
through :func:`services.creek_vault_read.log_read_degraded`, whose fields are a
closed vocabulary.

**Every tier, Intimate included.** It is the owner's own writing returned to
the owner over their own authenticated channel -- the same reason the main
archive carries Intimate journal entries -- and Creek serves the read only to a
vault's sole configured consumer.
"""

from __future__ import annotations

import enum
import json
import logging
from collections.abc import AsyncIterator, Iterator
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final

from domain.creek_vault import (
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultUnavailableError,
    VaultErrorCode,
)
from services.creek_vault_read import log_read_degraded

if TYPE_CHECKING:
    from domain.creek_vault import CreekVaultExportClient
    from domain.vault_export import VaultExportPage

logger = logging.getLogger(__name__)

#: The single log line a vault export is allowed to emit. Counts only.
_AUDIT_EVENT: Final = "vault_data_exported"

#: The file's self-description, so a copy found on a disk years from now can
#: say what it is without the app that wrote it.
VAULT_EXPORT_FORMAT: Final = "adepthood-vault-export"
VAULT_EXPORT_FORMAT_VERSION: Final = 1

#: The most pages one export reads. At Creek's 200 items a page that is 200,000
#: items -- far past any managed vault this release provisions -- while still
#: bounding a vault that never stops answering ``next_cursor``. Read at call
#: time, so a test can lower it.
VAULT_EXPORT_MAX_PAGES = 1000

#: The most bytes of vault answers one export receives before it stops asking
#: for more. The page that crosses it is kept; no page is requested after it.
#: Read at call time, so a test can lower it.
VAULT_EXPORT_MAX_BYTES = 1024 * 1024 * 1024

#: What the file says about itself, in the reader's words.
_ABOUT: Final = (
    "Everything your Creek Vault held of yours when this file was made. Each "
    "document is its original bytes, base64-encoded, with its SHA-256; each "
    "fragment is the vault's file verbatim, with its privacy tier. Intimate "
    'fragments are included, because this copy is yours. If "complete" at the '
    "end of this file is not true, the copy is missing something, and "
    '"incomplete_reason" says what.'
)

_DOCUMENT_KIND: Final = "document"
_FRAGMENT_KIND: Final = "fragment"


class VaultExportRefusal(enum.StrEnum):
    """Why a vault export could not start, as the code the route answers with.

    Values are wire strings the app switches on to say what happened, so they
    are contract and must not be reworded casually.
    """

    NOT_CONNECTED = "vault_not_connected"
    UNAVAILABLE = "vault_unavailable"
    NEEDS_UPDATE = "vault_export_needs_update"
    FAILED = "vault_export_failed"


class IncompleteReason(enum.StrEnum):
    """Why a vault export that started did not finish whole.

    ``VAULT_UNAVAILABLE`` and ``VAULT_FAILED`` are a later page that could not
    be read; ``EXPORT_TOO_LARGE`` is a bound reached; ``CONTENT_NOT_INCLUDED``
    is every page read but some item's content missing from it -- withheld as
    larger than a page, or a file the vault could not read.
    """

    VAULT_UNAVAILABLE = "vault_unavailable"
    VAULT_FAILED = "vault_failed"
    EXPORT_TOO_LARGE = "export_too_large"
    CONTENT_NOT_INCLUDED = "content_not_included"


class VaultExportRefusedError(Exception):
    """A vault export that could not start, carrying the reason the route reports."""

    def __init__(self, refusal: VaultExportRefusal) -> None:
        """Keep the closed-vocabulary reason; nothing a vault sent rides along."""
        super().__init__(refusal.value)
        self.refusal = refusal


@dataclass(frozen=True)
class VaultExport:
    """An export whose first page has been read, ready to stream.

    ``client`` is the caller's own resolved vault client; ``user_id`` is the
    caller, for the audit line alone.
    """

    client: CreekVaultExportClient
    user_id: int
    first: VaultExportPage


@dataclass
class _Tally:
    """What an in-flight export has read, for its trailer and its audit line."""

    pages: int = 0
    received_bytes: int = 0
    documents: int = 0
    fragments: int = 0
    skipped: int = 0
    withheld: int = 0

    def add(self, page: VaultExportPage) -> None:
        """Count one page in."""
        self.pages += 1
        self.received_bytes += page.answer_bytes
        self.documents += len(page.documents)
        self.fragments += len(page.fragments)
        self.skipped += page.skipped
        flags = [document.content_included for document in page.documents]
        flags += [fragment.content_included for fragment in page.fragments]
        self.withheld += flags.count(False)

    def at_bound(self) -> bool:
        """Whether the export has read as much as it may."""
        return self.pages >= VAULT_EXPORT_MAX_PAGES or self.received_bytes >= VAULT_EXPORT_MAX_BYTES


def _refusal_for(error: CreekVaultError) -> VaultExportRefusal:
    """The reason a failed first page gives the caller.

    A vault that does not offer the read -- refused locally, or a ``409
    incompatible_version`` from one whose handshake overstated itself -- needs
    an update; one that could not answer is unavailable; anything else (a
    refusal, a rejected credential, an unreadable page) is a failed export.
    """
    if isinstance(error, CreekCapabilityUnsupportedError):
        return VaultExportRefusal.NEEDS_UPDATE
    if (
        isinstance(error, CreekVaultContractError)
        and error.code is VaultErrorCode.INCOMPATIBLE_VERSION
    ):
        return VaultExportRefusal.NEEDS_UPDATE
    if isinstance(error, CreekVaultUnavailableError):
        return VaultExportRefusal.UNAVAILABLE
    return VaultExportRefusal.FAILED


async def open_vault_export(
    client: CreekVaultExportClient, user_id: int, *, has_vault: bool
) -> VaultExport:
    """Check the caller's vault can export, and read its first page.

    ``has_vault`` is whether the account owns a vault connection at all, read
    locally by the caller, so "you have no vault" and "your vault is asleep" --
    which look alike on a client that degraded to the local fallback -- are told
    apart.

    Raises:
        VaultExportRefusedError: When the export cannot start, with the reason.
    """
    if not has_vault:
        raise VaultExportRefusedError(VaultExportRefusal.NOT_CONNECTED)
    handshake = await client.handshake()
    if not handshake.available:
        raise VaultExportRefusedError(VaultExportRefusal.UNAVAILABLE)
    try:
        first = await client.export_page(None)
    except CreekVaultError as error:
        log_read_degraded(CreekCapability.EXPORT, error)
        raise VaultExportRefusedError(_refusal_for(error)) from None
    return VaultExport(client=client, user_id=user_id, first=first)


def _encode(value: object) -> str:
    """One JSON fragment of the file."""
    return json.dumps(value)


def _items(page: VaultExportPage) -> Iterator[str]:
    """Each item on one page as a JSON object, documents first, tagged by kind."""
    for document in page.documents:
        yield _encode({"kind": _DOCUMENT_KIND, **asdict(document)})
    for fragment in page.fragments:
        yield _encode({"kind": _FRAGMENT_KIND, **asdict(fragment)})


async def _next_page(
    client: CreekVaultExportClient, page: VaultExportPage, tally: _Tally
) -> tuple[VaultExportPage | None, IncompleteReason | None]:
    """The page after ``page``, or ``None`` with the reason the export stops there.

    ``(None, None)`` is the last page read: the export finished. A bound comes
    before the request, so no page is asked for past it.
    """
    if page.next_cursor is None:
        return None, None
    if tally.at_bound():
        return None, IncompleteReason.EXPORT_TOO_LARGE
    try:
        return await client.export_page(page.next_cursor), None
    except CreekVaultError as error:
        log_read_degraded(CreekCapability.EXPORT, error)
        if isinstance(error, CreekVaultUnavailableError):
            return None, IncompleteReason.VAULT_UNAVAILABLE
        return None, IncompleteReason.VAULT_FAILED


def _preamble() -> str:
    """The file's self-description, written before any item."""
    header = {
        "format": VAULT_EXPORT_FORMAT,
        "format_version": VAULT_EXPORT_FORMAT_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "about": _ABOUT,
    }
    fields = ",".join(f"{_encode(key)}:{_encode(value)}" for key, value in header.items())
    return "{" + fields + ',"items":['


def _final_reason(tally: _Tally, stopped: IncompleteReason | None) -> IncompleteReason | None:
    """Why the file is incomplete, or ``None`` when every page and item is in it."""
    if stopped is not None:
        return stopped
    if tally.skipped or tally.withheld:
        return IncompleteReason.CONTENT_NOT_INCLUDED
    return None


def _epilogue(tally: _Tally, reason: IncompleteReason | None) -> str:
    """The closing trailer: what is missing, and whether the file is whole."""
    trailer = {
        "skipped": tally.skipped,
        "content_withheld": tally.withheld,
        "complete": reason is None,
        "incomplete_reason": None if reason is None else reason.value,
    }
    fields = ",".join(f"{_encode(key)}:{_encode(value)}" for key, value in trailer.items())
    return "]," + fields + "}"


def _record_audit(export: VaultExport, tally: _Tally, reason: IncompleteReason | None) -> None:
    """Note that a vault export ended. Counts only -- never a line of it."""
    logger.info(
        _AUDIT_EVENT,
        extra={
            "user_id": export.user_id,
            "documents_exported": tally.documents,
            "fragments_exported": tally.fragments,
            "pages_read": tally.pages,
            "complete": reason is None,
            "incomplete_reason": None if reason is None else reason.value,
        },
    )


async def stream_vault_export(export: VaultExport) -> AsyncIterator[str]:
    """Yield the vault export as one JSON document, a page at a time.

    Assembled as text rather than built and dumped, so memory holds one page
    rather than the vault.
    """
    tally = _Tally()
    yield _preamble()
    separator = ""
    page: VaultExportPage | None = export.first
    stopped: IncompleteReason | None = None
    while page is not None:
        tally.add(page)
        for item in _items(page):
            yield separator + item
            separator = ","
        page, stopped = await _next_page(export.client, page, tally)
    reason = _final_reason(tally, stopped)
    yield _epilogue(tally, reason)
    _record_audit(export, tally, reason)
