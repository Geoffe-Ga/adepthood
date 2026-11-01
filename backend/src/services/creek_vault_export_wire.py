"""The wire half of Creek's owner export (contract 0.27, Creek-Vault#2033, #3579).

``GET /v1/export?cursor=&limit=`` answers one bounded page of the vault's own
content: ``documents`` (each staged upload or attachment as base64 original
bytes with its SHA-256) and then ``fragments`` (each fragment file verbatim,
with tier, frequency, phase, source platform and originating document), plus
``skipped`` and ``next_cursor``. This module holds the request path, the static
messages the adapter raises with, and the one parser that turns an answer into
:class:`~domain.vault_export.VaultExportPage`.

**Strict, then checked.** The models below mirror the published
``ExportResponse`` schema field for field and forbid anything else, so a field
Creek never published, a tier outside the closed enum, an unsafe document name
or a malformed cursor refuses the *whole* page. Then every included document is
decoded and held to its own ``size_bytes`` and ``sha256``, and every item's
``content_included`` must agree with whether content is present. An answer that
fails any of this is a :class:`~domain.creek_vault.CreekVaultPayloadError`: an
export must never silently hand over something other than what the vault holds,
and a corrupted page reported as a good one would be exactly that.

**Bounded.** Creek caps a page at 200 items and 10 MiB of raw content; base64
and JSON escaping inflate that, so :data:`EXPORT_ANSWER_MAX_BYTES` is a ceiling
no conformant page reaches, and an answer past it is refused rather than parsed.

**Nothing here logs, and nothing a vault sent reaches an exception.** Messages
are static and capability-named; validation errors are swallowed before the
refusal is raised, so their quotes of the input never ride a traceback.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from collections.abc import Awaitable, Callable
from typing import Annotated, Final, Literal, Protocol
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from domain.creek_vault import (
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    HandshakeResult,
    WireTierCeiling,
)
from domain.vault_export import (
    VAULT_EXPORT_MAX_LIMIT,
    VAULT_EXPORT_SINCE_MINOR,
    VaultExportDocument,
    VaultExportFragment,
    VaultExportPage,
    VaultExportTier,
)
from services.creek_vault_call_errors import HTTP_CALL_FAILED_ERRORS, HTTP_CALL_TIMED_OUT_ERRORS
from services.creek_vault_telemetry import (
    VaultCallTimedOutError,
    VaultTelemetryOutcome,
    record_vault_outcome,
)

#: Where the read is asked for, relative to the configured base URL.
EXPORT_PATH: Final = "/v1/export"

#: Whole-request budget (seconds) for one export page. A page may carry up to
#: 10 MiB of raw content -- base64 on the wire -- so it cannot fit the standing
#: deadline a content-free read does; a minute still bounds a vault that trickles.
#: The adapter applies it as a ``_CallDepartures`` override, which moves both the
#: whole-request deadline and the per-phase read budget, so it is reachable.
EXPORT_DEADLINE_SECONDS: Final = 60.0

#: The published ``ExportQuery.cursor`` pattern: ``d-``/``f-`` plus a SHA-256
#: order key. Opaque, and it names no file, so it is safe in a request line.
EXPORT_CURSOR_PATTERN: Final = "^[df]-[0-9a-f]{64}$"

#: The published staged-document name pattern.
EXPORT_DOCUMENT_ID_PATTERN: Final = "^[A-Za-z0-9._-]{1,128}$"

#: The largest answer one page may be. Creek's page budget is 10 MiB of raw
#: content; base64 adds a third and JSON escaping of fragment text can add more,
#: so 32 MiB is a ceiling no conformant page reaches. Read at call time, so a
#: test can lower it.
EXPORT_ANSWER_MAX_BYTES = 32 * 1024 * 1024

# The published bounds on a fragment's fields (``ExportFragment.schema.json``).
_FRAGMENT_ID_MAX_LENGTH: Final = 512
_FREQUENCY_PATTERN: Final = "^(?:F(?:[1-9]|10)|unclassified)$"
_LABEL_PATTERN: Final = "^[a-z][a-z_]{0,31}$"
_SHA256_PATTERN: Final = "^[0-9a-f]{64}$"

_CURSOR_RE: Final = re.compile(EXPORT_CURSOR_PATTERN)

# The two query parameters the route publishes.
_CURSOR_PARAM: Final = "cursor"
_LIMIT_PARAM: Final = "limit"

# The static messages, built the way every other capability's are.
EXPORT_FAILED_MESSAGE: Final = f"creek vault call failed: {CreekCapability.EXPORT.value}"
EXPORT_UNSUPPORTED_MESSAGE: Final = (
    f"creek vault capability unsupported: {CreekCapability.EXPORT.value}"
)
EXPORT_UNREADABLE_MESSAGE: Final = (
    f"creek vault returned an unreadable response: {CreekCapability.EXPORT.value}"
)
_CURSOR_MESSAGE: Final = "export cursor is not one the vault minted"

_CLOSED: Final = ConfigDict(extra="forbid", strict=True, frozen=True)

_DocumentId = Annotated[str, Field(pattern=EXPORT_DOCUMENT_ID_PATTERN)]


class _WireDocument(BaseModel):
    """``ExportDocument``: five fields, and never a sixth."""

    model_config = _CLOSED

    document_id: _DocumentId
    size_bytes: Annotated[int, Field(ge=0)]
    sha256: Annotated[str, Field(pattern=_SHA256_PATTERN)] | None
    content_base64: str | None
    content_included: bool


class _WireFragment(BaseModel):
    """``ExportFragment``: eight fields, and never a ninth."""

    model_config = _CLOSED

    fragment_id: Annotated[str, Field(min_length=1, max_length=_FRAGMENT_ID_MAX_LENGTH)]
    tier: VaultExportTier
    frequency: Annotated[str, Field(pattern=_FREQUENCY_PATTERN)]
    phase: Annotated[str, Field(pattern=_LABEL_PATTERN)]
    source_platform: Annotated[str, Field(pattern=_LABEL_PATTERN)]
    document_id: _DocumentId | None
    markdown: str | None
    content_included: bool


class _WireResponse(BaseModel):
    """``ExportResponse``: the envelope, closed like every wire model."""

    model_config = _CLOSED

    status: Literal["ok"]
    documents: Annotated[list[_WireDocument], Field(max_length=VAULT_EXPORT_MAX_LIMIT)]
    fragments: Annotated[list[_WireFragment], Field(max_length=VAULT_EXPORT_MAX_LIMIT)]
    skipped: Annotated[int, Field(ge=0)]
    next_cursor: Annotated[str, Field(pattern=EXPORT_CURSOR_PATTERN)] | None


def _validated(body: bytes) -> _WireResponse | None:
    """Validate one answer's raw bytes, or ``None`` when they are not the published shape.

    ``None`` rather than a raise, so the caller's refusal is raised *outside*
    this ``except``: a :class:`~pydantic.ValidationError` quotes the input it
    refused -- here, the writer's own documents -- and an exception raised inside
    the handler would carry that quote as its ``__context__``.
    """
    try:
        return _WireResponse.model_validate_json(body)
    except ValidationError:
        return None


def _decoded(content_base64: str) -> bytes | None:
    """The bytes ``content_base64`` carries, or ``None`` when it is not strict base64."""
    try:
        return base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError):
        return None


def _included_bytes(document: _WireDocument) -> bytes | None:
    """The bytes an included document carries, or ``None`` when it carries none."""
    if document.content_base64 is None or document.sha256 is None:
        return None
    return _decoded(document.content_base64)


def _bytes_match(raw: bytes, document: _WireDocument) -> bool:
    """Whether ``raw`` is exactly the size and digest the document claims."""
    return len(raw) == document.size_bytes and hashlib.sha256(raw).hexdigest() == document.sha256


def _document_is_intact(document: _WireDocument) -> bool:
    """Whether a document's content flag, bytes, size and digest all agree.

    A withheld document carries neither content nor digest. An included one
    must decode, be exactly ``size_bytes`` long, and hash to ``sha256`` -- the
    check that makes the export a copy of what the vault holds rather than of
    whatever arrived.
    """
    if not document.content_included:
        return document.content_base64 is None and document.sha256 is None
    raw = _included_bytes(document)
    return raw is not None and _bytes_match(raw, document)


def _fragment_is_intact(fragment: _WireFragment) -> bool:
    """Whether a fragment's content flag agrees with whether its file is present."""
    return fragment.content_included == (fragment.markdown is not None)


def _document(document: _WireDocument) -> VaultExportDocument:
    """Project one checked wire document onto the domain value."""
    return VaultExportDocument(
        document_id=document.document_id,
        size_bytes=document.size_bytes,
        sha256=document.sha256,
        content_base64=document.content_base64,
        content_included=document.content_included,
    )


def _fragment(fragment: _WireFragment) -> VaultExportFragment:
    """Project one checked wire fragment onto the domain value."""
    return VaultExportFragment(
        fragment_id=fragment.fragment_id,
        tier=fragment.tier,
        frequency=fragment.frequency,
        phase=fragment.phase,
        source_platform=fragment.source_platform,
        document_id=fragment.document_id,
        markdown=fragment.markdown,
        content_included=fragment.content_included,
    )


def _page_is_intact(response: _WireResponse) -> bool:
    """Whether every item on a validated page passes its integrity check."""
    documents = all(map(_document_is_intact, response.documents))
    return documents and all(map(_fragment_is_intact, response.fragments))


def _checked(body: bytes) -> _WireResponse | None:
    """The validated, integrity-checked page in ``body``, or ``None``."""
    if len(body) > EXPORT_ANSWER_MAX_BYTES:
        return None
    response = _validated(body)
    if response is None or not _page_is_intact(response):
        return None
    return response


def export_page_from(body: bytes) -> VaultExportPage | None:
    """Parse and check one successful answer, or ``None`` if it is unreadable.

    Validated from the raw JSON bytes, as the activity read is, and refused
    whole: one corrupted item makes the page unreadable rather than a page
    with a hole in it nobody was told about. An answer past
    :data:`EXPORT_ANSWER_MAX_BYTES` is refused before it is parsed.
    """
    response = _checked(body)
    if response is None:
        return None
    return VaultExportPage(
        documents=tuple(map(_document, response.documents)),
        fragments=tuple(map(_fragment, response.fragments)),
        skipped=response.skipped,
        next_cursor=response.next_cursor,
        answer_bytes=len(body),
    )


def export_offered(handshake: HandshakeResult) -> bool:
    """Whether a vault's handshake offers the export at a minor it will answer.

    Both halves are needed. Creek refuses any minor its
    ``supported_contract_minors`` does not list, so a vault that advertised
    ``export`` without listing 0.27 would answer the read with a ``409``.
    """
    return CreekCapability.EXPORT in handshake.capabilities and handshake.serves_minor(
        VAULT_EXPORT_SINCE_MINOR
    )


def export_path(cursor: str | None) -> str:
    """The request path and query for the page starting at ``cursor``.

    Always asks for the published maximum, so a whole export takes as few
    round trips as the contract allows. A cursor is checked before anything
    else: it only ever comes from the vault's own previous page, so one that
    does not match is a caller's bug, refused here rather than sent.

    Raises:
        ValueError: When ``cursor`` is not one the vault could have minted.
    """
    params: dict[str, str | int] = {_LIMIT_PARAM: VAULT_EXPORT_MAX_LIMIT}
    if cursor is not None:
        if _CURSOR_RE.fullmatch(cursor) is None:
            raise ValueError(_CURSOR_MESSAGE)
        params[_CURSOR_PARAM] = cursor
    return f"{EXPORT_PATH}?{urlencode(params)}"


class ExportTransport(Protocol):
    """The adapter's one authorized, deadlined way onto the wire, bound to 0.27."""

    def __call__(
        self, method: str, url: str, /, *, ceiling: WireTierCeiling
    ) -> Awaitable[httpx.Response]:
        """Send one request at ``ceiling`` and return the vault's answer."""


#: The adapter's read classifier for a non-2xx answer.
ReadFailure = Callable[[CreekCapability, httpx.Response], CreekVaultError]


async def _get(send: ExportTransport, url: str) -> httpx.Response:
    """``GET`` ``url``, normalizing any transport failure.

    Declared at the content-free ``open`` ceiling: the request carries no
    content, and the export is the one ``/v1`` read Creek does not govern by
    ceiling -- who may call it is decided by the sole-consumer rule instead. A
    call that ran out of time is :class:`VaultCallTimedOutError`; any other that
    did not land is :class:`CreekVaultUnavailableError`. Both carry only the
    static message and are raised ``from None``.
    """
    try:
        return await send("GET", url, ceiling=WireTierCeiling.OPEN)
    except HTTP_CALL_TIMED_OUT_ERRORS:
        raise VaultCallTimedOutError(EXPORT_FAILED_MESSAGE) from None
    except HTTP_CALL_FAILED_ERRORS:
        raise CreekVaultUnavailableError(EXPORT_FAILED_MESSAGE) from None


async def read_export_page(
    send: ExportTransport,
    base_url: str,
    cursor: str | None,
    *,
    supported: bool,
    read_failure: ReadFailure,
) -> VaultExportPage:
    """Read one page of ``GET /v1/export`` and report how the exchange ended.

    The cursor is checked first, then the capability: a vault that did not
    advertise the read at a minor it serves gets no request at all. A success
    is counted here; every failure is raised, for the caller's counting wrapper.

    Raises:
        ValueError: When ``cursor`` is malformed.
        CreekCapabilityUnsupportedError: When the vault does not offer the read.
        CreekVaultPayloadError: When a 2xx answer is off-schema or corrupted.
        CreekVaultError: The classified failure of any non-2xx answer.
    """
    path = export_path(cursor)
    if not supported:
        raise CreekCapabilityUnsupportedError(EXPORT_UNSUPPORTED_MESSAGE)
    response = await _get(send, f"{base_url}{path}")
    if not response.is_success:
        raise read_failure(CreekCapability.EXPORT, response) from None
    page = export_page_from(response.content)
    if page is None:
        raise CreekVaultPayloadError(EXPORT_UNREADABLE_MESSAGE)
    record_vault_outcome(VaultTelemetryOutcome.SUCCESS, CreekCapability.EXPORT)
    return page
