"""Concrete Creek Vault client adapters and their factory.

This is the service-layer counterpart to the pure :mod:`domain.creek_vault`
seam, following the same domain-protocol -> service-adapter pattern as
:mod:`services.marginalia` and the env-var config / error-normalization pattern
as :mod:`services.botmason`.

Three implementations of :class:`~domain.creek_vault.CreekVaultClient` live here:

* :class:`McpCreekVaultClient` -- talks to a real vault over an injected
  :class:`VaultTransport`. It is written to **degrade, never crash**:
  :meth:`~McpCreekVaultClient.handshake` swallows every transport, parsing, and
  version-mismatch failure into :meth:`HandshakeResult.unavailable`, and every
  per-capability call normalizes any transport exception to
  :class:`CreekVaultUnavailableError` with a **static, capability-named message**
  that never echoes the entry body or the API key.
* :class:`HttpCreekVaultClient` -- talks to a real vault over plain HTTP/JSON,
  handshaking with a single ``GET /v1/capabilities``. It degrades the same way,
  and additionally records *which* failure mode degraded it
  (:class:`HandshakeDegradeReason`) so contract-version skew stays countable
  apart from a vault that is merely unreachable. Journal ingest is the one
  capability whose ``/v1`` shape Creek has ratified, so it is wired up as a
  ``PUT`` of the entry's own URL; classify, reflect, and wheel still refuse,
  because guessing an unratified wire format is worse than staying local. A
  failed ingest is *dropped*, not queued -- there is no retry and no backlog
  today, and the local Postgres row stays the system of record either way.
* :class:`LocalFallbackCreekVaultClient` -- the no-vault path. Handshake reports
  unavailable, nothing is supported, ingest is a silent no-op (operator Postgres
  stays the system of record), and the read/compute capabilities raise
  :class:`CreekCapabilityUnsupportedError`.

:func:`build_creek_vault_client` chooses between them from ``CREEK_VAULT_URL``
(unset means the local fallback, so an unconfigured deployment transparently
degrades) and ``CREEK_VAULT_PROTOCOL`` (which transport a configured vault is
reached over, defaulting to MCP so an existing deployment keeps its behavior
until it opts in).

Transport security: both configured transports refuse a plaintext ``http://``
URL to any non-loopback host, because every request carries the
``CREEK_VAULT_API_KEY`` bearer credential (and, over MCP, each call's tier
metadata) that must never cross a network in cleartext -- TLS misconfiguration
fails closed at construction, before the key is bound to anything. Both also
refuse a URL carrying userinfo, a query, or a fragment: userinfo is itself a
credential that httpx would log unmasked and turn into a Basic-auth downgrade
of our bearer, and a query or fragment would silently redirect the credential
away from the endpoint the operator configured.
:class:`_McpStreamableHttpTransport` speaks MCP streamable-HTTP framing
(initialize, then ``tools/call``); :class:`HttpCreekVaultClient` speaks
request/response JSON over a shared, credential-free pooled connection
(:class:`_VaultHttpPool`), building its authorization header per call so the
pooled connection never holds the key. This seam does not itself encrypt the entry
*body*: the end-to-end, ciphertext-only intimate-transit rule of Decision 6
in ``docs/adr/0004-creek-vault-http-application-boundary.md`` (a user-held
key the operator cannot decrypt) is enforced where the body is assembled, in
the write path built on this seam -- out of scope here, not forgotten.

Cross-references ``docs/creek-vault-mcp-contract.md`` for the shipped
per-capability fallback rules; Creek's published contract owns the wire shapes.
"""

from __future__ import annotations

import asyncio
import enum
import json
import os
from collections.abc import AsyncIterator, Callable, Iterable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from http import HTTPStatus
from typing import NoReturn, Protocol
from urllib.parse import SplitResult, quote, urlsplit

import httpx
import httpx2
from mcp import Client, MCPError
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult

from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CONSUMER_ID,
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultClient,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultErrorCode,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultTierCeiling,
    VaultWheelAspect,
    VaultWheelBalance,
)
from domain.resonance import ANCHOR_TEXT_MAX, NOTE_MAX

# Timeout (seconds) for a single HTTP call to the vault. Bounds how long a slow
# or hung vault can block a request before adepthood degrades to local.
_VAULT_TIMEOUT_SECONDS = 10.0

# The same budget applied to each phase of an HTTP call separately -- connect,
# read, write, and pool acquisition -- rather than as httpx's bare scalar. Naming
# every phase means none can silently inherit an unbounded default: a vault that
# accepts the connection and then goes quiet is bounded by the read phase, and a
# starved connection pool is bounded by the pool phase. These are per-phase
# budgets, *not* a request deadline -- httpx restarts the read budget on every
# socket read, so a vault that trickles stays inside all four indefinitely.
# Bounding the call as a whole is :data:`_VAULT_TOTAL_DEADLINE_SECONDS`'s job.
_VAULT_HTTP_TIMEOUT = httpx.Timeout(
    connect=_VAULT_TIMEOUT_SECONDS,
    read=_VAULT_TIMEOUT_SECONDS,
    write=_VAULT_TIMEOUT_SECONDS,
    pool=_VAULT_TIMEOUT_SECONDS,
)

# How many per-phase budgets one whole capability fetch may span. Three is the
# count of phases a single GET actually traverses -- pool acquisition, connect,
# read -- so a request that is legitimately slow at every one of them still
# finishes inside the deadline, while a vault that never finishes does not.
_VAULT_DEADLINE_PHASE_BUDGETS = 3

# Wall-clock ceiling (seconds) on one whole capability fetch. Necessary because
# httpx's phase budgets are not a request deadline: the ``read`` timeout is
# restarted by every socket read, so a vault trickling one byte just inside it
# stays within all four budgets forever while holding a pooled connection and a
# worker -- and the journal write path handshakes on every write.
_VAULT_TOTAL_DEADLINE_SECONDS = _VAULT_TIMEOUT_SECONDS * _VAULT_DEADLINE_PHASE_BUDGETS

# Read budget (seconds) for the MCP session's long-lived server-sent-event
# stream, which is held open for the life of the session and so cannot share the
# ten-second budget the request phases use -- a short read timeout would tear the
# session down while it is merely idle. Mirrors the MCP SDK's own default for
# that stream, restated here as a named constant because this module builds the
# transport's HTTP client itself.
_MCP_SSE_READ_TIMEOUT_SECONDS = 300.0

# The per-phase budget the MCP transport's HTTP client runs under: the same
# ten-second bound as every other vault call for connect, write, and pool
# acquisition, and the SSE budget for reads.
_MCP_HTTP_TIMEOUT = httpx2.Timeout(_VAULT_TIMEOUT_SECONDS, read=_MCP_SSE_READ_TIMEOUT_SECONDS)

# How a "MAJOR.MINOR.PATCH" version string decomposes, and how many of its
# leading components must match for two contract versions to interoperate. ADR
# 0004 Decision 4: while the contract is pre-1.0 a minor bump *is* the breaking
# change, so client and server must match on exact major.minor; from 1.0 onward
# minors are forward-compatible and only the major must match.
_VERSION_MAJOR_INDEX = 0
_PRE_1_0_MAJOR = "0"
_PRE_1_0_MATCHED_COMPONENTS = 2
_POST_1_0_MATCHED_COMPONENTS = 1

# Every way an httpx call can fail to land, whether it left this process or
# not. ``OSError`` covers connection and timeout errors (the whole-request
# deadline raises ``TimeoutError``, an ``OSError`` subclass), and
# ``httpx.HTTPError`` covers every transport and status failure.
# ``httpx.InvalidURL`` has to be named separately because it is *not* an
# ``HTTPError`` -- httpx raises it, from outside its own hierarchy, while
# building the request, so an unparseable vault URL would otherwise escape every
# degrade set and turn an optional replication into an exception on the caller's
# request path. A URL httpx cannot build a request for is unreachable in exactly
# the sense a refused connection is (the construction-time validator already
# refused the *unsafe* URLs, which is a different question), so it degrades the
# same way rather than raising.
_HTTP_CALL_FAILED_ERRORS: tuple[type[Exception], ...] = (
    OSError,
    httpx.HTTPError,
    httpx.InvalidURL,
)

# Every way the MCP session's own HTTP layer can fail to land. A separate set
# from :data:`_HTTP_CALL_FAILED_ERRORS` because the MCP SDK speaks ``httpx2``
# while :class:`HttpCreekVaultClient` speaks ``httpx``, and the two libraries'
# exception hierarchies are unrelated -- an ``httpx2.ConnectError`` is not an
# ``httpx.HTTPError`` and is not an ``OSError``, so without naming it here a
# vault that is merely unreachable over MCP would raise on the caller's request
# path instead of degrading. ``InvalidURL`` is named separately for the same
# reason it is on the httpx side: it sits outside that library's ``HTTPError``
# hierarchy.
_MCP_CALL_FAILED_ERRORS: tuple[type[Exception], ...] = (
    httpx2.HTTPError,
    httpx2.InvalidURL,
)

# Transport-layer failures we normalize to a degraded state.
# :data:`_HTTP_CALL_FAILED_ERRORS` and :data:`_MCP_CALL_FAILED_ERRORS` cover the
# httpx layer underneath each transport, ``MCPError`` covers an MCP protocol
# failure or a tool call that returned ``is_error`` (raised by
# :func:`_extract_tool_payload` with a static, content-free message),
# ``ExceptionGroup`` covers a streamable-HTTP connection failure (anyio task
# groups wrap the underlying connect error in a builtins ``ExceptionGroup``;
# catching the ``Exception``-only group -- never ``BaseExceptionGroup`` -- stays
# safe under cancellation), and ``json.JSONDecodeError`` covers a content-text
# block whose body is not JSON. All of these normalize the per-capability path
# to unavailable exactly as the handshake path already does, keeping one
# coherent degrade-set (``json.JSONDecodeError`` is a ``ValueError`` subclass,
# so it is already covered by the handshake's parse-error set).
_TRANSPORT_ERROR_TYPES: tuple[type[Exception], ...] = (
    *_HTTP_CALL_FAILED_ERRORS,
    *_MCP_CALL_FAILED_ERRORS,
    MCPError,
    ExceptionGroup,
    json.JSONDecodeError,
)

# JSON-RPC application-defined server-error code (the -32000..-32099 range) used
# when a vault tool call reports ``is_error``; the paired message is static so it
# can never echo the entry body or the API key.
_MCP_TOOL_ERROR_CODE = -32000

# The status value a ``creek.journal`` response reports on a durable write. Any
# other status -- or a missing one -- parses conservatively to "not stored".
_JOURNAL_OK_STATUS = "ok"

# Longest vault-issued fragment id adepthood will keep as an entry's durable
# reference. Opaque handles are short by nature -- a UUID is 36 characters -- so
# this is generous by nearly an order of magnitude, and it is a *bound*, not a
# format: the vault owns the shape of its own ids. It exists because that string
# is persisted verbatim into a journal entry's unbounded ``vault_ref`` text
# column on every save, which without a ceiling lets a compromised vault grow
# the operator's database by as much as it cares to answer with.
_MAX_FRAGMENT_ID_LENGTH = 256

# The status a ``creek.reflect`` response reports when it actually produced
# notes. Deliberately its own constant rather than a reuse of
# :data:`_JOURNAL_OK_STATUS`: the two capabilities merely happen to spell their
# success the same way today, and coupling them would let either one's future
# rename silently change how the other is parsed.
_REFLECT_OK_STATUS = "ok"

# How many notes of a reflect response adepthood will even look at. Double
# Creek's own shipped cap of six, so a vault that modestly raises its cap still
# lands whole, while a buggy or hostile one is bounded to roughly twelve times
# (:data:`~domain.resonance.ANCHOR_TEXT_MAX` + :data:`~domain.resonance.NOTE_MAX`)
# plus JSON overhead -- about 12 KB serialized -- instead of however much it
# cares to answer with. This is a bound on *untrusted vault output before
# serialization*, independent of the separate anchoring cap
# :mod:`domain.resonance` applies to how many of these notes survive onto the
# entry; neither one substitutes for the other.
_MAX_REFLECT_NOTES = 12

# How Creek's seven published note kinds render in adepthood's marginalia
# vocabulary. ``pattern`` is the one that speaks across entries -- Creek grounds
# its notes in the surrounding corpus, so a recurrence note is exactly what
# adepthood calls a ``connection`` -- while the other six each observe something
# about this one entry and so render as a ``theme``. Adepthood's third kind,
# ``symbol``, is deliberately unused: nothing in Creek's vocabulary denotes an
# image standing for something else, and forcing a non-symbol onto it would
# render the note as something it is not. A kind absent from this table is
# dropped, never coerced onto a nearest neighbor.
_MARGINALIA_KIND_BY_CREEK_KIND: Mapping[str, str] = {
    "pattern": "connection",
    "reframe": "theme",
    "fear": "theme",
    "longing": "theme",
    "value": "theme",
    "tension": "theme",
    "gift": "theme",
}

# The privacy ceiling adepthood presents when it asks for a wheel. Only
# aggregate per-Frequency counts and shares cross this seam -- never fragment
# content -- so the ceiling governs what the vault *counts*, not what it hands
# back. ``personal`` is the honest maximum: intimate content never reaches the
# vault from adepthood at all, and creek independently caps a network consumer
# below intimate. ``open`` would be worse than useless rather than safer,
# because creek ranks unclassified content with personal: an open ceiling
# silently excludes every not-yet-classified fragment, so a young corpus reads
# back as an all-zero wheel.
_WHEEL_TIER_CEILING = VaultTierCeiling.PERSONAL

# The status a ``creek.wheel`` response reports when it actually computed a
# wheel. Its own constant rather than a reuse of :data:`_JOURNAL_OK_STATUS` or
# :data:`_REFLECT_OK_STATUS`, for the reason those two are already kept apart:
# the capabilities merely happen to spell their success the same way today, and
# coupling them would let one capability's future rename silently change how
# another is parsed.
_WHEEL_OK_STATUS = "ok"

# The Frequency keys adepthood will read out of the vault's wheel map, in
# canonical order -- one per curriculum stage, so ``F1`` is stage 1. A whitelist
# rather than an iteration of whatever the vault sent, so a code creek adds
# later is ignored exactly as an unknown capability string already is.
_WHEEL_FREQUENCY_CODES: tuple[str, ...] = tuple(f"F{n}" for n in range(1, TOTAL_STAGES + 1))

# Longest Frequency name adepthood will accept from a wheel entry. A *bound*,
# not a format -- the vault owns what it calls its own Frequencies -- and a
# generous one, since the longest name either side actually ships is under
# thirty characters. It exists because that string is carried into a domain
# value and can reach a log, and without a ceiling a compromised vault could
# answer with a string of any size at all.
_MAX_WHEEL_ASPECT_NAME_LENGTH = 128

# Payload-parsing failures. A malformed or wrong-typed handshake response should
# degrade to unavailable exactly like a transport error, never propagate.
_PARSE_ERROR_TYPES: tuple[type[Exception], ...] = (KeyError, TypeError, AttributeError, ValueError)


class _IncompatibleContractVersionError(Exception):
    """A vault advertised a contract version this client will not interoperate with.

    Module-private and control-flow only: it exists so a version mismatch stays
    *distinguishable* from an unreachable or malformed vault while still
    degrading to the same caller-visible unavailable result (ADR 0004
    Decision 4). It carries no payload, so it can never echo a vault response.
    Deliberately not a :class:`~domain.creek_vault.CreekVaultError`: it never
    escapes this module.
    """


# Everything a handshake probe swallows into an "unavailable" result: transport
# failures (the vault is unreachable), parsing failures (its payload is
# malformed), and contract-version skew. Combining them keeps the MCP
# degradation path a single ``except``; the HTTP client splits them back out to
# record which one it hit, without changing what any caller sees.
_HANDSHAKE_DEGRADE_ERRORS: tuple[type[Exception], ...] = (
    *_TRANSPORT_ERROR_TYPES,
    *_PARSE_ERROR_TYPES,
    _IncompatibleContractVersionError,
)

# Hosts for which a plaintext ``http://`` vault URL is tolerated: a developer
# running the vault on the same machine. Every other host must use TLS so the
# bearer credential and tier metadata never cross a network in cleartext.
_LOOPBACK_HOSTS: frozenset[str] = frozenset({"localhost", "127.0.0.1", "::1"})

# Which transport a *configured* vault is reached over. MCP stays the default so
# an existing deployment keeps its current behavior until it opts into HTTP; an
# unrecognized value is a configuration error, never a silent fallback.
_PROTOCOL_ENV_VAR = "CREEK_VAULT_PROTOCOL"
_PROTOCOL_MCP = "mcp"
_PROTOCOL_HTTP = "http"


# URL components a configured vault URL must not carry, in the order their
# names are reported. ``userinfo`` (the ``user:pass@`` prefix) is itself a
# credential: httpx renders it *unmasked* in ``str(url)`` -- which is what its
# own INFO request log formats -- and, absent an explicit ``auth=``, derives
# ``BasicAuth`` from it whose auth flow *assigns* ``Authorization``, silently
# replacing our bearer with a weaker scheme. ``query`` and ``fragment`` break
# the capability URL instead: it is built by appending a path to the configured
# string, so either one swallows that path and aims the credential at an
# endpoint the operator never configured.
_FORBIDDEN_URL_PARTS = ("userinfo", "query", "fragment")


def _forbidden_url_parts(parsed: SplitResult) -> tuple[str, ...]:
    """Return the names of the disallowed components ``parsed`` carries.

    Userinfo counts as present whenever either half is set, so a degenerate
    ``https://user@host`` (empty password) is caught alongside the full form.
    """
    carried = (
        parsed.username is not None or parsed.password is not None,
        bool(parsed.query),
        bool(parsed.fragment),
    )
    return tuple(name for name, found in zip(_FORBIDDEN_URL_PARTS, carried, strict=True) if found)


def _require_bare_vault_url(parsed: SplitResult) -> None:
    """Reject a vault URL carrying userinfo, a query, or a fragment.

    The message names only the offending *component names*: it reaches logs,
    and one of the components it can name -- userinfo -- is a credential, so
    echoing any value here would be the very leak this check exists to prevent.
    """
    parts = _forbidden_url_parts(parsed)
    if parts:
        raise ValueError(f"CREEK_VAULT_URL must not carry these URL components: {', '.join(parts)}")


def _require_secure_vault_url(url: str) -> None:
    """Reject a vault URL that is unsafe to bind a credential to, failing closed.

    Guards both configured transports -- :class:`_McpStreamableHttpTransport`
    and :class:`HttpCreekVaultClient` -- each of which sends the
    ``CREEK_VAULT_API_KEY`` bearer credential (and, over MCP, each call's tier
    metadata) over the wire, so any future transport must keep calling it too.
    Two rules: the URL must carry no userinfo, query, or fragment
    (:func:`_require_bare_vault_url`, applied to every scheme), and a plaintext
    ``http://`` URL is allowed only to a loopback host, since cleartext to a
    remote host would expose the credential on the network. A misconfiguration
    raises here rather than silently leaking, before the key is bound to
    anything. The message names only component names, the scheme, and the host
    -- never the API key.
    """
    parsed = urlsplit(url)
    _require_bare_vault_url(parsed)
    if parsed.scheme == "https":
        return
    if parsed.scheme == "http" and parsed.hostname in _LOOPBACK_HOSTS:
        return
    raise ValueError(
        f"CREEK_VAULT_URL must use https for a non-loopback host "
        f"(scheme {parsed.scheme!r}, host {parsed.hostname!r})"
    )


class VaultTransport(Protocol):
    """The minimal request/response seam a vault client calls over.

    One async method: send an MCP ``method`` with ``params`` and return the
    decoded response mapping. Keeping the client's transport behind this
    protocol lets tests inject scripted fakes and lets the concrete HTTP
    transport be swapped without touching client logic. Parameters are
    positional-only so implementations may name them freely.
    """

    async def call(self, method: str, params: Mapping[str, object], /) -> Mapping[str, object]:
        """Send ``method`` with ``params`` and return the decoded response."""


def _handshake_params() -> Mapping[str, object]:
    """Build the privacy-floor params adepthood presents at handshake.

    The handshake carries only the privacy tier ceiling this deployment is
    willing to expose -- never a consumer identity or contract version, which
    the vault learns from the MCP session itself.
    """
    return {"privacy_tier_ceiling": VaultTierCeiling.OPEN.value}


def _require_str(payload: Mapping[str, object], key: str) -> str:
    """Return ``payload[key]`` as a ``str`` or raise so parsing fails closed.

    Raises ``KeyError`` when absent and ``TypeError`` when present but not a
    string; both are caught upstream and degrade the handshake to unavailable.
    """
    value = payload[key]
    if not isinstance(value, str):
        raise TypeError(f"handshake field {key!r} must be a string")
    return value


def _coerce_capability(item: object) -> CreekCapability | None:
    """Map one advertised wire string to a capability, or ``None`` if unknown.

    Unknown/forward-compatible capability strings are dropped rather than
    erroring, so a vault can advertise new capabilities without breaking an
    older client.
    """
    if not isinstance(item, str):
        return None
    try:
        return CreekCapability(item)
    except ValueError:
        return None


def _parse_capabilities(raw: object) -> frozenset[CreekCapability]:
    """Narrow an advertised capability list to the known-capability set.

    Raises ``TypeError`` when ``raw`` is not a list (a malformed payload), which
    upstream degrades to unavailable. Unknown member strings are ignored.
    """
    if not isinstance(raw, list):
        raise TypeError("handshake capabilities must be a list")
    return frozenset(
        capability for item in raw if (capability := _coerce_capability(item)) is not None
    )


def _parse_attestation(raw: object) -> Mapping[str, object] | None:
    """Return the attestation mapping unchanged, or ``None`` when absent.

    Raises ``TypeError`` for a present-but-wrong-typed value so a malformed
    payload degrades to unavailable.
    """
    if raw is None:
        return None
    if isinstance(raw, Mapping):
        return raw
    raise TypeError("handshake attestation must be a mapping or null")


def _contract_version_compatible(advertised: str, pinned: str = CONTRACT_VERSION) -> bool:
    """Return whether a vault's ``advertised`` contract version is safe to call.

    Implements ADR 0004 Decision 4. While ``pinned`` is pre-1.0 the comparison is
    on exact ``major.minor``: with the major stuck at ``0`` a major-only check is
    a no-op, and a pre-1.0 minor bump is precisely the breaking change worth
    catching (``0.3.0`` against a ``0.2.x`` pin is rejected; ``0.2.7`` against
    ``0.2.1`` is accepted -- patch is free to vary). From 1.0 onward the rule
    relaxes to a major match, since minors are then forward-compatible.

    ``pinned`` is a parameter rather than a closed-over constant so the post-1.0
    branch is exercisable while the shipped pin is still pre-1.0.
    """
    pinned_components = pinned.split(".")
    matched = (
        _PRE_1_0_MATCHED_COMPONENTS
        if pinned_components[_VERSION_MAJOR_INDEX] == _PRE_1_0_MAJOR
        else _POST_1_0_MATCHED_COMPONENTS
    )
    return advertised.split(".")[:matched] == pinned_components[:matched]


def _parse_handshake(payload: Mapping[str, object]) -> HandshakeResult:
    """Parse a well-formed handshake payload into a populated result.

    Reads and version-checks the contract before anything else: an incompatible
    version raises :class:`_IncompatibleContractVersionError` (we will not call a
    surface we do not understand), which every caller degrades to unavailable.
    Then honors the vault's own ``available`` field, fail-closed: a
    reachable server is not necessarily an available vault, so anything other
    than a literal ``True`` (including a missing field) degrades to
    unavailable. Any missing key or wrong-typed field raises out of the helpers
    and is caught by :meth:`McpCreekVaultClient.handshake`.
    """
    contract_version = _require_str(payload, "contract_version")
    if not _contract_version_compatible(contract_version):
        raise _IncompatibleContractVersionError
    if payload.get("available") is not True:
        return HandshakeResult.unavailable()
    return HandshakeResult(
        available=True,
        contract_version=contract_version,
        ontology_version=_require_str(payload, "ontology_version"),
        capabilities=_parse_capabilities(payload["capabilities"]),
        attestation=_parse_attestation(payload.get("attestation")),
    )


def _is_storable_ref(fragment_id: str) -> bool:
    """Return whether a vault-issued id is safe to persist as an entry's ``vault_ref``.

    Three conditions, and the last two are why this exists. Non-empty, because a
    blank id is no reference at all. Within :data:`_MAX_FRAGMENT_ID_LENGTH`, so a
    compromised vault cannot answer every journal save with an arbitrarily large
    string that lands in an unbounded text column. And printable, because this
    is the one vault-chosen string adepthood *stores* rather than drops:
    ``str.isprintable`` rejects NUL (which a Postgres text column refuses
    outright, turning a hostile response into a failed write of an
    already-saved entry), CR/LF (log injection, should the ref ever be
    rendered), and the zero-width and bidi-override codepoints the journal's own
    write boundary already sanitizes out of user text.
    """
    return (
        bool(fragment_id)
        and len(fragment_id) <= _MAX_FRAGMENT_ID_LENGTH
        and fragment_id.isprintable()
    )


def _usable_fragment_id(payload: Mapping[str, object]) -> str | None:
    """Return the vault's fragment id when it is storable, else ``None``.

    A missing, blank, non-string, oversized, or unprintable id is unusable as a
    durable reference (see :func:`_is_storable_ref`), and coercing one
    (``str(7)``) would fabricate a ref the vault never issued. Shared by both
    transports: an MCP vault gets no wider a channel into the ``vault_ref``
    column than an HTTP one.
    """
    fragment_id = payload.get("fragment_id")
    if isinstance(fragment_id, str) and _is_storable_ref(fragment_id):
        return fragment_id
    return None


def _parse_ingest_result(payload: Mapping[str, object]) -> VaultIngestResult:
    """Parse a ``creek.journal`` response, defaulting missing/odd fields conservatively.

    Only an ``"ok"`` status paired with a storable ``fragment_id`` counts as
    durably stored; a missing, empty, wrong-typed, oversized, or unprintable
    field parses to a not-stored result rather than fabricating a vault ref.
    """
    fragment_id = _usable_fragment_id(payload)
    if payload.get("status") == _JOURNAL_OK_STATUS and fragment_id is not None:
        return VaultIngestResult(stored=True, vault_ref=fragment_id)
    return VaultIngestResult(stored=False, vault_ref=None)


def _parse_classification(payload: Mapping[str, object]) -> VaultClassification:
    """Parse a classify response into a tuple of string tags (dropping non-strings)."""
    raw = payload.get("tags")
    if not isinstance(raw, list):
        return VaultClassification(tags=())
    return VaultClassification(tags=tuple(item for item in raw if isinstance(item, str)))


def _bounded_text(raw: object, limit: int) -> str | None:
    """Return a vault-supplied string when it is usable text within ``limit``, else ``None``.

    Three conditions, each of which a note cannot do without: it is a string at
    all (a number or a nested object is not text), it carries something other
    than whitespace (a blank quote anchors to nothing and a blank note says
    nothing), and it fits the marginalia field it is bound for, so no vault can
    answer with an unbounded string. The value is returned **verbatim** rather
    than stripped, because adepthood anchors a quote by matching it
    character-for-character against the entry body -- trimming here would
    silently break the very anchor this check exists to protect.
    """
    if not isinstance(raw, str) or not raw.strip() or len(raw) > limit:
        return None
    return raw


def _marginalia_kind(raw: object) -> str | None:
    """Map one Creek note kind onto adepthood's, or ``None`` when we do not know it.

    Mirrors :func:`_coerce_capability` and :func:`_coerce_ingest_action`: an
    unknown or wrong-typed kind is dropped rather than raising or being coerced
    onto a neighbor, so a vault that invents a kind loses that one note instead
    of having it rendered as something the user never wrote.
    """
    if not isinstance(raw, str):
        return None
    return _MARGINALIA_KIND_BY_CREEK_KIND.get(raw)


def _reflection_note(item: object) -> dict[str, str] | None:
    """Project one Creek note onto the marginalia contract, or drop it whole.

    This is the boundary where an untrusted vault's output becomes something
    adepthood renders back to the user, so every field has to survive on its own
    terms: a mappable kind, a quote within
    :data:`~domain.resonance.ANCHOR_TEXT_MAX`, a note within
    :data:`~domain.resonance.NOTE_MAX`. A partial note is dropped rather than
    completed with a default, which would put words in the user's Higher Self
    that neither they nor the vault ever wrote.
    """
    if not isinstance(item, Mapping):
        return None
    kind = _marginalia_kind(item.get("kind"))
    quote = _bounded_text(item.get("quote"), ANCHOR_TEXT_MAX)
    note = _bounded_text(item.get("note"), NOTE_MAX)
    if kind is None or quote is None or note is None:
        return None
    return {"kind": kind, "quote": quote, "note": note}


def _reflection_notes(raw: object) -> list[dict[str, str]]:
    """Narrow a vault's note list to the ones adepthood can actually render.

    Answers with an empty list -- never raises -- for anything that is not a
    list, since a malformed reflection must defer to the cloud rather than break
    the resonance pass. Only the leading :data:`_MAX_REFLECT_NOTES` items are
    considered, order preserved, so an over-eager or hostile vault cannot grow
    this work (or the JSON it feeds) without bound; inside that prefix each item
    stands or falls alone, so one malformed note never costs its siblings.
    """
    if not isinstance(raw, list):
        return []
    return [
        note for item in raw[:_MAX_REFLECT_NOTES] if (note := _reflection_note(item)) is not None
    ]


def _parse_reflection(payload: Mapping[str, object]) -> str:
    """Render a ``creek.reflect`` response as the strict marginalia JSON contract.

    Answers with the empty string -- which the caller reads as "no vault
    reflection", deferring to the cloud -- in every case but one: a literal
    ``ok`` status carrying at least one renderable note. The strict equality is
    what makes ``empty``, ``escalate`` (Creek's care handoff), ``refused``, and
    any status a future Creek adds all defer rather than be mined for notes.
    Zero surviving notes defers too, deliberately: rendering ``{"notes": []}``
    would suppress the fallback and leave the user with a Higher Self that said
    nothing at all, which is worse than a cloud answer.
    """
    if payload.get("status") != _REFLECT_OK_STATUS:
        return ""
    notes = _reflection_notes(payload.get("notes"))
    if not notes:
        return ""
    return json.dumps({"notes": notes})


def _reflect_params(body: str, tier_ceiling: VaultTierCeiling) -> Mapping[str, object]:
    """Map a reflection request onto the ``creek.reflect`` wire fields.

    Exactly two: the body to reflect on, and the privacy ceiling the vault's
    router enforces. No ``consumer`` key -- the vault learns the caller from the
    MCP session itself, as it already does for ingest -- and no ``entry_ref``,
    since adepthood reflects on an ad-hoc body rather than on a fragment the
    vault has already stored.
    """
    return {"content": body, "privacy_tier_ceiling": tier_ceiling.value}


def _wheel_params() -> Mapping[str, object]:
    """Map a wheel request onto the ``creek.wheel`` wire fields.

    Exactly one: the privacy ceiling the vault's router enforces while it counts.
    There is no ``consumer`` key -- the vault learns the caller from the MCP
    session itself, exactly as it already does for ingest and reflect -- and no
    other caller-supplied parameter exists on this tool.
    """
    return {"privacy_tier_ceiling": _WHEEL_TIER_CEILING.value}


def _wheel_fullness(raw: object) -> float | None:
    """Return a Frequency's share as a float, or ``None`` when it is not a number.

    Booleans are rejected *before* the numeric test, because ``isinstance(True,
    int)`` is ``True`` and a bare numeric check would silently read ``True`` as a
    completely full Frequency. The ``0.0..1.0`` bound is deliberately not checked
    here: the read path's own aspect check owns it, and its chained comparison
    already rejects ``NaN`` and the infinities. That is a division of labor
    between the two halves of the seam, not a gap in either.

    The conversion itself is guarded because JSON has no integer ceiling: a
    literal past the float range decodes to an arbitrary-precision ``int``, and
    ``float()`` then raises ``OverflowError`` -- an ``ArithmeticError`` that is in
    neither this client's transport degrade set nor the read path's
    ``CreekVaultError`` catch, so it would escape the seam as a crash on the
    caller's request path. A share no float can hold is simply unreadable, which
    is what ``None`` already means here.
    """
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        return None
    try:
        return float(raw)
    except OverflowError:
        return None


def _wheel_aspect(entry: object, stage_number: int) -> VaultWheelAspect | None:
    """Project one Frequency entry onto a domain aspect, or drop it whole.

    Both halves have to survive on their own terms: a numeric ``share`` and a
    non-blank, printable ``name`` within :data:`_MAX_WHEEL_ASPECT_NAME_LENGTH`. A
    partial entry is dropped rather than completed with a default, which would
    show the user a Frequency reading neither they nor the vault ever produced.

    Printability is required for the same reason :func:`_is_storable_ref` requires
    it of a fragment id: a Frequency name is short label text, so a control
    character in one is never legitimate, and a name carrying CR/LF, an ANSI
    escape, or a bidirectional override is exactly the payload that forges a log
    line or misrenders a label. The name is relabelled away before this wheel is
    rendered, but this helper is the boundary, and a value that is inert wherever
    it lands does not depend on that.
    """
    if not isinstance(entry, Mapping):
        return None
    fullness = _wheel_fullness(entry.get("share"))
    name = _bounded_text(entry.get("name"), _MAX_WHEEL_ASPECT_NAME_LENGTH)
    if fullness is None or name is None or not name.isprintable():
        return None
    return VaultWheelAspect(stage_number=stage_number, aspect=name, fullness=fullness)


def _wheel_aspects(wheel: Mapping[str, object]) -> tuple[VaultWheelAspect, ...]:
    """Project the whitelisted Frequency codes onto aspects, dropping the unusable ones.

    Walks :data:`_WHEEL_FREQUENCY_CODES` rather than the mapping's own keys, so
    the stage number comes from adepthood's canonical order and any code outside
    the whitelist is ignored. The caller decides what a short result means.
    """
    return tuple(
        aspect
        for stage_number, code in enumerate(_WHEEL_FREQUENCY_CODES, start=1)
        if (aspect := _wheel_aspect(wheel.get(code), stage_number)) is not None
    )


def _parse_wheel(payload: Mapping[str, object]) -> VaultWheelBalance | None:
    """Project a ``creek.wheel`` response onto a domain balance, or ``None`` if unusable.

    Answers ``None`` -- never raises -- so the caller owns the degrade. Three
    conditions: a literal :data:`_WHEEL_OK_STATUS`, which is the strict equality
    that makes ``refused``, ``empty``, and any status a future creek adds all
    degrade rather than be mined for numbers; a ``wheel`` that is a mapping; and
    a usable entry for *every* Frequency code. That last one is all-or-nothing on
    purpose: one bad Frequency rejects the whole read rather than yielding a ring
    with a hole in it.
    """
    if payload.get("status") != _WHEEL_OK_STATUS:
        return None
    wheel = payload.get("wheel")
    if not isinstance(wheel, Mapping):
        return None
    aspects = _wheel_aspects(wheel)
    if len(aspects) != len(_WHEEL_FREQUENCY_CODES):
        return None
    return VaultWheelBalance(aspects=aspects)


def _content_params(body: str, tier_ceiling: VaultTierCeiling) -> Mapping[str, object]:
    """Build the params for a ``creek.classify`` call, whose wire shape is unverified."""
    return {"consumer": CONSUMER_ID, "body": body, "tier_ceiling": tier_ceiling.value}


def _ingest_params(request: VaultIngestRequest) -> Mapping[str, object]:
    """Map an ingest request onto the ``creek.journal`` wire fields.

    ``external_id`` carries the entry's stable id so a re-send is idempotent
    (Creek edits the stored fragment in place); ``tier`` is the entry's own
    privacy tier and ``privacy_tier_ceiling`` the write ceiling the vault's
    router enforces. No ``consumer`` key: the vault learns the caller from the
    MCP session itself.
    """
    return {
        "content": request.body,
        "external_id": str(request.entry_id),
        "timestamp": request.created_at.isoformat(),
        "tier": request.tier.value,
        "privacy_tier_ceiling": request.tier_ceiling.value,
    }


def _unsupported_message(capability: CreekCapability) -> str:
    """Build the body/key-free message for an unsupported-capability error.

    Kept here so both the reachable-but-unadvertised path in
    :meth:`McpCreekVaultClient._invoke` and the no-vault-configured path in
    :class:`LocalFallbackCreekVaultClient` derive the wire name from
    :class:`~domain.creek_vault.CreekCapability` rather than duplicating it as a
    literal that could silently drift from the enum.
    """
    return f"creek vault capability unsupported: {capability.value}"


class McpCreekVaultClient:
    """A :class:`CreekVaultClient` backed by an injected MCP transport.

    Caches the last handshake so :meth:`is_available` and :meth:`supports` are
    cheap, synchronous reads. Re-handshaking re-probes the vault and refreshes
    that cache, so a vault that gains (or loses) a capability is picked up on the
    next handshake with no other client-side change.
    """

    def __init__(self, transport: VaultTransport) -> None:
        """Store the transport and seed the cache with an unavailable handshake.

        Before any handshake runs the client reports unavailable and supports
        nothing, so callers that skip the handshake still fail safe.
        """
        self._transport = transport
        self._last_handshake = HandshakeResult.unavailable()

    async def handshake(self) -> HandshakeResult:
        """Probe the vault, cache the result, and return it -- never raising.

        Every failure mode -- a raising transport, a malformed or wrong-typed
        payload, or a contract major-version mismatch -- collapses to
        :meth:`HandshakeResult.unavailable`. This is the crux of graceful
        degradation: callers get one branchable result and never a surprise
        exception from probing an optional dependency.
        """
        self._last_handshake = await self._probe()
        return self._last_handshake

    async def _probe(self) -> HandshakeResult:
        """Perform the handshake call and parse it, degrading on any failure."""
        try:
            payload = await self._transport.call(
                CreekCapability.HANDSHAKE.value, _handshake_params()
            )
            result = _parse_handshake(payload)
        except _HANDSHAKE_DEGRADE_ERRORS:
            return HandshakeResult.unavailable()
        return result

    def is_available(self) -> bool:
        """Return whether the cached handshake found a usable vault."""
        return self._last_handshake.available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether the cached handshake advertised ``capability``."""
        return capability in self._last_handshake.capabilities

    async def _invoke(
        self, capability: CreekCapability, params: Mapping[str, object]
    ) -> Mapping[str, object]:
        """Call a capability, gating on support and normalizing failures.

        Raises :class:`CreekCapabilityUnsupportedError` when the capability was
        not advertised. On any transport failure it raises
        :class:`CreekVaultUnavailableError` with a *static, capability-named*
        message and ``from None`` -- the original exception (whose text may
        contain the entry body or the API key) is deliberately not chained, so
        neither the message nor the traceback context can leak it. Transport
        failure here includes a non-JSON body (:class:`json.JSONDecodeError`,
        raised inside the transport's ``response.json()``), so a proxy error
        page or empty 200 degrades rather than crashing. A response that decodes
        but is not a mapping (a malformed or hostile payload) is normalized to
        the same error, so a per-capability call degrades rather than crashing
        on garbage -- the same fail-safe the handshake path already applies.
        """
        if not self.supports(capability):
            raise CreekCapabilityUnsupportedError(_unsupported_message(capability))
        try:
            payload = await self._transport.call(capability.value, params)
        except _TRANSPORT_ERROR_TYPES:
            raise CreekVaultUnavailableError(
                f"creek vault call failed: {capability.value}"
            ) from None
        if not isinstance(payload, Mapping):
            raise CreekVaultUnavailableError(
                f"creek vault returned a malformed response: {capability.value}"
            )
        return payload

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Store ``request`` in the vault, requiring the JOURNAL capability."""
        payload = await self._invoke(CreekCapability.JOURNAL, _ingest_params(request))
        return _parse_ingest_result(payload)

    async def classify(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Request Frequency/Wavelength tags for ``body``, requiring CLASSIFY."""
        payload = await self._invoke(CreekCapability.CLASSIFY, _content_params(body, tier_ceiling))
        return _parse_classification(payload)

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> str:
        """Produce a Higher Self reflection over the corpus, requiring REFLECT.

        Returns the vault's own notes translated into the marginalia JSON
        contract the resonance pass anchors against (:func:`_parse_reflection`),
        or the empty string when the vault declined, escalated, or answered with
        nothing renderable -- which the caller reads as "defer to the cloud".
        """
        payload = await self._invoke(CreekCapability.REFLECT, _reflect_params(body, tier_ceiling))
        return _parse_reflection(payload)

    async def wheel(self) -> VaultWheelBalance:
        """Return a vault-computed Wheel-of-Wholeness read, requiring WHEEL.

        Creek answers with a per-Frequency map keyed ``F1``..``F10``, which
        :func:`_parse_wheel` projects onto the pure-domain
        :class:`VaultWheelBalance` the seam contract returns -- so the domain
        module carries no wire dependency.

        A malformed or refused wheel degrades exactly like every other
        capability, to :class:`CreekVaultUnavailableError` carrying the same
        static, capability-named message, so no payload content can reach a log
        or a traceback. The wheel is an optional read, never a write, and a
        caller that cannot obtain it falls back to computing the balance locally.
        """
        payload = await self._invoke(CreekCapability.WHEEL, _wheel_params())
        balance = _parse_wheel(payload)
        if balance is None:
            raise CreekVaultUnavailableError(
                f"creek vault returned a malformed response: {CreekCapability.WHEEL.value}"
            )
        return balance


class HandshakeDegradeReason(enum.StrEnum):
    """Why a handshake degraded to :meth:`HandshakeResult.unavailable`.

    Callers still see exactly one degraded state -- that is the whole point of
    the unavailable result -- but operators need these apart: a contract-version
    skew is a coordination problem with a specific remedy (align the two pins),
    while an unreachable vault is an infrastructure problem, and a malformed
    payload is a vault bug. Values are the wire strings telemetry counts by, so
    they are part of this module's contract and must not be reworded casually.

    ``UNREACHABLE`` is the widest of the four and its name slightly overstates
    it: every non-2xx status lands there too, so it also absorbs a 401 (a bad
    credential -- a configuration problem) and a 500 (a vault-side fault).
    Telemetry should read it as "the call did not complete", not strictly as
    "the network is down".
    """

    UNREACHABLE = "unreachable"
    MALFORMED_PAYLOAD = "malformed_payload"
    INCOMPATIBLE_VERSION = "incompatible_version"
    VAULT_REPORTED_UNAVAILABLE = "vault_reported_unavailable"


# The vault's capability document, relative to the configured base URL.
_CAPABILITIES_PATH = "/v1/capabilities"

# The collection a journal entry is upserted into, relative to the configured
# base URL. One entry is one resource: the write is a ``PUT`` of the entry's own
# id, which is what makes a re-send idempotent (the vault edits the fragment it
# already keyed off that id instead of appending a second one). This and the
# capability document are the only ``/v1`` shapes Creek has ratified.
_JOURNAL_ENTRIES_PATH = "/v1/journal-entries/"

# The percent-encoded form of ``.``, used to neutralize a dot segment in an
# entry id (see :func:`_entry_path_segment`). Uppercase because RFC 3986 names
# uppercase hex the normal form for percent-encoding.
_ENCODED_DOT = "%2E"

# Statuses that mean "your credential was refused" rather than "the vault is
# missing". Checked before any body parsing, since a gateway rejecting the
# bearer will not answer in the vault's error vocabulary at all.
_CREDENTIAL_REJECTED_STATUSES: frozenset[int] = frozenset(
    {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}
)

# The two 4xx statuses that are *not* a statement about the request we sent.
# The rest of the 4xx range faults our payload, but 408 says the vault's own
# clock ran out waiting and 429 says it is shedding load: both are "come back
# later" -- an availability story identical to a 5xx, and both are cured by
# waiting rather than by changing anything in adepthood. Classifying them as
# contract defects would send an operator hunting a bug that is not there.
_RETRYABLE_CLIENT_STATUSES: frozenset[int] = frozenset(
    {HTTPStatus.REQUEST_TIMEOUT, HTTPStatus.TOO_MANY_REQUESTS}
)

# Vault error codes that mean adepthood got the call wrong -- a bad payload, a
# capability we should not have claimed, or a version we should not have pinned.
# Every one of them is fixed by changing adepthood, so they map to a contract
# error. ``TEMPORARILY_UNAVAILABLE`` is deliberately absent: it is the vault
# reporting on itself, which is an availability fault.
_CONTRACT_ERROR_CODES: frozenset[VaultErrorCode] = frozenset(
    {
        VaultErrorCode.INVALID_REQUEST,
        VaultErrorCode.UNSUPPORTED_CAPABILITY,
        VaultErrorCode.INCOMPATIBLE_VERSION,
    }
)

# The three static, capability-named messages the ingest path may raise with.
# Built from the capability enum rather than written as literals so they cannot
# drift from the wire name, and content-free by construction: no branch may
# interpolate the entry body, the API key, or a vault-supplied string into an
# exception that will reach a log or a traceback.
_INGEST_FAILED_MESSAGE = f"creek vault call failed: {CreekCapability.JOURNAL.value}"
_INGEST_REJECTED_MESSAGE = f"creek vault rejected the request: {CreekCapability.JOURNAL.value}"
_CREDENTIAL_REJECTED_MESSAGE = (
    f"creek vault rejected the credential: {CreekCapability.JOURNAL.value}"
)

# The one not-stored result every unreadable 2xx collapses to. Interned because
# it is value-identical on each of those paths, and named so no branch is
# tempted to invent a ``vault_ref`` the vault never issued.
_NOT_STORED_RESULT = VaultIngestResult(stored=False, vault_ref=None, action=None)


def _build_pooled_vault_client() -> httpx.AsyncClient:
    """Build the process-wide vault HTTP client: bare, credential-free, budget-bound.

    Deliberately carries no ``base_url`` and no authorization header. The pooled
    connection is shared by every :class:`HttpCreekVaultClient` in the process,
    so binding a URL or a credential to it would both leak the key into a
    long-lived object and invalidate the pool whenever the vault is
    reconfigured. Each adapter supplies its own absolute URL and builds its own
    header per request; the pool contributes only the reused connection and the
    timeout budget.
    """
    # ``follow_redirects`` is pinned rather than inherited from httpx's default:
    # not following redirects is a security property here, not a preference.
    # httpx preserves an *explicitly set* ``Authorization`` header across a
    # same-scheme cross-host redirect, so a hijacked or compromised vault could
    # 302 our bearer straight to an attacker's host. Refusing to follow turns
    # that into a non-2xx status, which degrades the handshake to unreachable.
    return httpx.AsyncClient(timeout=_VAULT_HTTP_TIMEOUT, follow_redirects=False)


class _VaultHttpPool:
    """Lazily built, closable holder for the shared vault HTTP client.

    An object rather than a module-level mutable, so building and closing the
    connection pool needs no ``global`` rebinding and so a test can substitute a
    pool with a scripted factory. Building is deferred until the first request:
    constructing a vault adapter must not open a connection pool, since an
    adapter is built per call site while a deployment with no reachable vault
    should never allocate one at all.
    """

    def __init__(self, build: Callable[[], httpx.AsyncClient] | None = None) -> None:
        """Store the client factory (defaulting to the production one) unbuilt."""
        self._build = build if build is not None else _build_pooled_vault_client
        self._client: httpx.AsyncClient | None = None

    def get(self) -> httpx.AsyncClient:
        """Return the pooled client, building it on first use and reusing it after."""
        if self._client is None:
            self._client = self._build()
        return self._client

    async def aclose(self) -> None:
        """Close the pooled client if one was built; idempotent by design.

        Clears the slot before awaiting the close so a repeat call (shutdown can
        be reached by more than one path) is a silent no-op, and so a later
        :meth:`get` builds a fresh client rather than handing back a closed one.
        """
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()


# The process-wide pool every HTTP vault adapter borrows its connection from.
_VAULT_HTTP_POOL = _VaultHttpPool()


async def close_creek_vault_http_pool() -> None:
    """Release the shared vault HTTP connection pool (call at app shutdown)."""
    await _VAULT_HTTP_POOL.aclose()


def _refuse_unratified(capability: CreekCapability) -> NoReturn:
    """Refuse a capability whose request/response shape adepthood cannot know yet.

    Raised with ``from None`` so no upstream exception rides along as a cause or
    context -- the same privacy discipline the transport-error paths follow.
    """
    raise CreekCapabilityUnsupportedError(_unsupported_message(capability)) from None


def _entry_path_segment(entry_id: int) -> str:
    """Encode an entry id into exactly one path segment that cannot climb out of it.

    ``quote(..., safe="")`` blocks the obvious escape by encoding ``/``, but it
    leaves a dot alone even with nothing marked safe -- so a segment of ``..``
    survives encoding intact and every URL parser (httpx included) then
    normalizes it away, aiming the ``PUT`` one level above the journal
    collection. Encoding the dot with :data:`_ENCODED_DOT` is what makes the
    segment inert; a percent-encoded dot is not a dot segment, so nothing
    normalizes it. An id is an integer today, so this changes no URL adepthood
    actually builds -- it is here because the entry *body* is what rides on this
    request, and a future identifier type must not be able to redirect it by its
    shape alone.
    """
    return quote(str(entry_id), safe="").replace(".", _ENCODED_DOT)


def _journal_entry_body(request: VaultIngestRequest) -> Mapping[str, object]:
    """Map an ingest request onto the ratified ``/v1`` journal-entry fields.

    Exactly three fields, and no more: the entry id travels in the URL (it is
    the resource), and the tier ceiling the MCP shape carries as a separate
    ``privacy_tier_ceiling`` is redundant here, since a journal write always
    stores at the writer's own tier. Sending a field the ratified shape does not
    name would be guessing.
    """
    return {
        "content": request.body,
        "timestamp": request.created_at.isoformat(),
        "tier": request.tier.value,
    }


def _coerce_ingest_action(raw: object) -> VaultIngestAction | None:
    """Map the vault's reported action onto our enum, or ``None`` if we do not know it.

    Mirrors :func:`_coerce_capability`: an unknown or wrong-typed value is
    dropped rather than raising, so the string a vault chose can never reach a
    message or a log. An unknown action is not a durable write, though -- the
    caller treats ``None`` as "we could not read this response".
    """
    if not isinstance(raw, str):
        return None
    try:
        return VaultIngestAction(raw)
    except ValueError:
        return None


def _parse_http_ingest_result(payload: object) -> VaultIngestResult:
    """Project a 2xx ingest body onto a result, conservatively.

    A durable write needs both halves: an action we recognize *and* a storable
    fragment id. Anything less -- a body that is not a JSON object, an unknown
    action, a blank or oversized or unprintable id -- parses to not-stored,
    which the write path records as a degraded write. That is the safe
    direction: reporting a write we cannot verify would let the entry look
    replicated when it is not.
    """
    if isinstance(payload, Mapping):
        action = _coerce_ingest_action(payload.get("action"))
        fragment_id = _usable_fragment_id(payload)
        if action is not None and fragment_id is not None:
            return VaultIngestResult(stored=True, vault_ref=fragment_id, action=action)
    return _NOT_STORED_RESULT


def _vault_error_code(response: httpx.Response) -> VaultErrorCode | None:
    """Read the vault's own error code from an error body, parsing only what we know.

    Four narrowing steps, each of which fails to ``None`` rather than raising: a
    body that is not JSON, JSON that is not an object, a ``code`` that is not a
    string, and a string that is not one of :class:`VaultErrorCode`'s members.
    The last step is the security-relevant one -- an unrecognized code is
    *dropped*, never stored or echoed, so a compromised vault cannot inject text
    (control characters and all) into an exception message or a log record.
    """
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, Mapping):
        return None
    return _coerce_error_code(payload.get("code"))


def _coerce_error_code(raw: object) -> VaultErrorCode | None:
    """Map a wire ``code`` string onto our enum, dropping anything unrecognized."""
    if not isinstance(raw, str):
        return None
    try:
        return VaultErrorCode(raw)
    except ValueError:
        return None


def _faults_our_request(response: httpx.Response) -> bool:
    """Return whether an uncoded status blames the request adepthood sent.

    True for the 4xx range, minus :data:`_RETRYABLE_CLIENT_STATUSES` -- a
    throttled or timed-out call says nothing about the payload, so treating it
    as a contract defect would be a false accusation an operator then has to
    disprove.
    """
    return response.is_client_error and response.status_code not in _RETRYABLE_CLIENT_STATUSES


def _ingest_failure(response: httpx.Response) -> CreekVaultError:
    """Classify a non-2xx ingest response into the failure it actually is.

    The order encodes what each answer tells an operator to do:

    1. A refused credential is a configuration fault with its own remedy, and it
       is decided on the status alone -- a gateway that rejects our bearer never
       reaches the vault's error vocabulary.
    2. A code we recognize is authoritative over the status class; the vault
       naming itself temporarily unavailable is the one such code that is *not*
       our defect.
    3. With no readable code, the status class decides: a 4xx means the vault
       faulted the request we sent (ours to fix), and everything else -- 5xx, a
       redirect we refuse to follow -- means the call did not land (not ours).
       :data:`_RETRYABLE_CLIENT_STATUSES` is the documented exception to that
       rule: two 4xx statuses describe the vault's own state rather than our
       request, so they answer to the availability story instead.
    """
    if response.status_code in _CREDENTIAL_REJECTED_STATUSES:
        return CreekVaultAuthError(_CREDENTIAL_REJECTED_MESSAGE)
    code = _vault_error_code(response)
    if code in _CONTRACT_ERROR_CODES:
        return CreekVaultContractError(_INGEST_REJECTED_MESSAGE, code=code)
    if code is None and _faults_our_request(response):
        return CreekVaultContractError(_INGEST_REJECTED_MESSAGE)
    return CreekVaultUnavailableError(_INGEST_FAILED_MESSAGE)


class HttpCreekVaultClient:
    """A :class:`CreekVaultClient` that speaks plain HTTP/JSON to a configured vault.

    Handshakes with a single ``GET /v1/capabilities`` carrying a bearer
    ``Authorization`` header, caches the result so :meth:`is_available` and
    :meth:`supports` stay cheap synchronous reads, and records
    :attr:`last_degrade_reason` when the probe fails. Like the MCP client it
    **degrades, never crashes**: :meth:`handshake` collapses every transport,
    parsing, and version failure into :meth:`HandshakeResult.unavailable`.

    Journal ingest is the one capability whose ``/v1`` request/response shape
    Creek has ratified, so :meth:`ingest` is wired up: it gates on the
    handshake exactly as the MCP client does, sends a ``PUT`` to the entry's own
    URL, and splits the answer into a durable write, a not-stored write, or one of
    three failure types (contract, auth, unavailable) an operator can act on
    differently. A failed ingest is **dropped, not queued** -- there is no retry
    and no backlog today, and it does not need one, because the local Postgres
    row is the system of record and the user's save already succeeded.

    :meth:`classify`, :meth:`reflect`, and :meth:`wheel` still refuse with
    :class:`CreekCapabilityUnsupportedError`, *including* when the vault
    advertises them. Their shapes have not shipped upstream, and this adapter
    will not guess a wire format: a refusal degrades the caller onto its local
    pipeline, whereas a wrong guess would send real journal content into a
    surface nobody has agreed on. Wiring them up is follow-on work, gated on
    that document.

    A plain class on purpose -- no dataclass, no custom ``__repr__`` -- so the
    default object repr can never render the bearer credential this instance
    holds.
    """

    def __init__(
        self, url: str, api_key: str, *, http_client: httpx.AsyncClient | None = None
    ) -> None:
        """Validate the URL, then bind the credential, the client, and a safe cache.

        :func:`_require_secure_vault_url` runs first, before the key is stored
        anywhere, so a plaintext remote URL fails closed with the credential
        still only a parameter. ``http_client`` is an injection seam for tests;
        production leaves it ``None`` and borrows the shared pool per call. The
        handshake cache is seeded unavailable so a client that never handshook
        supports nothing.
        """
        _require_secure_vault_url(url)
        self._api_key = api_key
        # Trailing slashes are stripped so a configured URL with or without one
        # yields the same capability URL rather than a double-slashed path.
        self._url = url.rstrip("/")
        self._http_client = http_client
        self._last_handshake = HandshakeResult.unavailable()
        self._degrade_reason: HandshakeDegradeReason | None = None

    def _active_client(self) -> httpx.AsyncClient:
        """Return the injected client, or borrow the shared pool's (built on demand).

        Resolved per call rather than in ``__init__`` so merely constructing an
        adapter never forces the pool into existence, and so a pool closed and
        later reopened is picked up without rebuilding the adapter.

        One narrow window remains, by choice: a request that has already taken
        the pooled client when :func:`close_creek_vault_http_pool` runs at
        shutdown will see httpx's ``RuntimeError("Cannot send a request, as the
        client has been closed.")``. That is deliberately *not* in any degrade
        set -- catching bare ``RuntimeError`` would mask genuine bugs, and this
        one can only surface as a process is already stopping. The pool
        self-heals for every later call, because :meth:`_VaultHttpPool.aclose`
        nulls the slot and the next :meth:`get` builds a fresh client.
        """
        if self._http_client is not None:
            return self._http_client
        return _VAULT_HTTP_POOL.get()

    async def _authorized_request(
        self, method: str, url: str, json_body: Mapping[str, object] | None = None
    ) -> httpx.Response:
        """Send one authorized vault request under the whole-request deadline.

        The single place any request leaves this adapter, so the two properties
        that must hold for *every* call hold once. The authorization header is
        built here, per call, so the credential lives only for the duration of
        the request and never on the shared pooled client.

        The deadline is necessary because httpx's ``read`` budget is per
        socket-read rather than a deadline: a trickling vault would otherwise
        hold this coroutine (and its pooled connection) open indefinitely.
        Expiry raises ``TimeoutError``, an ``OSError`` subclass, so it lands in
        each caller's existing transport branch. The module constant is read at
        call time rather than captured, so a redeployment (or a test) can move
        the ceiling without rebuilding the adapter.
        """
        async with asyncio.timeout(_VAULT_TOTAL_DEADLINE_SECONDS):
            return await self._active_client().request(
                method,
                url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json=json_body,
            )

    async def _fetch_capabilities(self) -> Mapping[str, object]:
        """Fetch and minimally narrow the vault's capability document.

        A non-2xx status raises ``httpx.HTTPStatusError`` and a non-JSON body
        raises ``json.JSONDecodeError``; both are degraded by the caller. A body
        that decodes to something other than a JSON object is a malformed
        payload, so it raises ``TypeError`` rather than being cast.
        """
        response = await self._authorized_request("GET", f"{self._url}{_CAPABILITIES_PATH}")
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, Mapping):
            raise TypeError("creek vault capability payload must be a JSON object")
        return payload

    async def _probe(self) -> tuple[HandshakeResult, HandshakeDegradeReason | None]:
        """Run one capability probe, mapping each failure mode to its own reason.

        The ``except`` clauses are split (where the MCP client uses one combined
        set) purely to attribute the degradation: every branch returns the same
        canonical unavailable result. :data:`_HTTP_CALL_FAILED_ERRORS` covers
        connection failures, timeouts, every non-2xx status raised by
        ``raise_for_status``, a socket-level failure escaping httpx's hierarchy,
        and a URL httpx will not build a request for. A payload that parsed but
        whose vault reported itself unavailable is not an error at all -- it is
        the vault answering honestly -- and is recorded as such.
        """
        try:
            result = _parse_handshake(await self._fetch_capabilities())
        except _IncompatibleContractVersionError:
            return HandshakeResult.unavailable(), HandshakeDegradeReason.INCOMPATIBLE_VERSION
        except _HTTP_CALL_FAILED_ERRORS:
            return HandshakeResult.unavailable(), HandshakeDegradeReason.UNREACHABLE
        except _PARSE_ERROR_TYPES:
            return HandshakeResult.unavailable(), HandshakeDegradeReason.MALFORMED_PAYLOAD
        if not result.available:
            return result, HandshakeDegradeReason.VAULT_REPORTED_UNAVAILABLE
        return result, None

    async def handshake(self) -> HandshakeResult:
        """Probe the vault, cache the result and its degrade reason, and return it."""
        self._last_handshake, self._degrade_reason = await self._probe()
        return self._last_handshake

    @property
    def last_degrade_reason(self) -> HandshakeDegradeReason | None:
        """Why the last handshake degraded, or ``None`` if it succeeded (or never ran)."""
        return self._degrade_reason

    def is_available(self) -> bool:
        """Return whether the cached handshake found a usable vault."""
        return self._last_handshake.available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether the cached handshake advertised ``capability``."""
        return capability in self._last_handshake.capabilities

    async def _put_journal_entry(self, request: VaultIngestRequest) -> httpx.Response:
        """Upsert one entry at its own URL, normalizing any transport failure.

        The entry id contributes exactly one inert path segment
        (:func:`_entry_path_segment`) -- an id is an integer today, but a URL
        assembled by concatenation is exactly where a future identifier type
        would otherwise smuggle in a path traversal, and the entry body is what
        rides on this request.

        Every transport failure (connection refused, a socket error, the
        whole-request deadline expiring, a URL httpx will not build a request
        for) becomes :class:`CreekVaultUnavailableError` with ``from None``: the
        original exception's text can carry the URL or the entry body, and
        neither its message nor its traceback context may ride along.
        """
        entry_url = f"{self._url}{_JOURNAL_ENTRIES_PATH}{_entry_path_segment(request.entry_id)}"
        try:
            return await self._authorized_request("PUT", entry_url, _journal_entry_body(request))
        except _HTTP_CALL_FAILED_ERRORS:
            raise CreekVaultUnavailableError(_INGEST_FAILED_MESSAGE) from None

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Upsert ``request`` into the vault, requiring the JOURNAL capability.

        Gated on the cached handshake first, exactly as
        :meth:`McpCreekVaultClient._invoke` gates: a vault that did not
        advertise JOURNAL is refused *locally*, so no entry body is ever put on
        the wire toward a surface that never claimed to accept it.

        The answer splits three ways. A 2xx is projected by
        :func:`_parse_http_ingest_result`, which reports not-stored rather than
        inventing a ref it could not read. A 2xx whose body will not decode at
        all is an unavailable vault, not a failed write -- we cannot tell what
        happened, and a proxy error page served as 200 is the usual cause. A
        non-2xx is classified by :func:`_ingest_failure` into the fault it
        represents. Every raise uses ``from None`` so no vault-supplied text
        reaches a traceback.
        """
        if not self.supports(CreekCapability.JOURNAL):
            raise CreekCapabilityUnsupportedError(_unsupported_message(CreekCapability.JOURNAL))
        response = await self._put_journal_entry(request)
        if not response.is_success:
            raise _ingest_failure(response) from None
        try:
            payload = response.json()
        except ValueError:
            raise CreekVaultUnavailableError(_INGEST_FAILED_MESSAGE) from None
        return _parse_http_ingest_result(payload)

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Refuse classification: its ``/v1`` request/response shape is unratified."""
        _refuse_unratified(CreekCapability.CLASSIFY)

    async def reflect(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> str:
        """Refuse reflection: its ``/v1`` request/response shape is unratified."""
        _refuse_unratified(CreekCapability.REFLECT)

    async def wheel(self) -> VaultWheelBalance:
        """Refuse a wheel read: its ``/v1`` request/response shape is unratified."""
        _refuse_unratified(CreekCapability.WHEEL)


class LocalFallbackCreekVaultClient:
    """The no-vault :class:`CreekVaultClient`: local pipeline stays authoritative.

    Used whenever no vault is configured. It reports unavailable and supports
    nothing, so callers uniformly fall back to local behavior. Ingest is a
    silent no-op (``stored=False``) because the operator's Postgres remains the
    sole system of record; the read/compute capabilities raise
    :class:`CreekCapabilityUnsupportedError` since there is nothing to serve
    them. Unused parameters are underscore-prefixed to match the protocol
    positionally without pretending to consume them.
    """

    async def handshake(self) -> HandshakeResult:
        """Report no usable vault."""
        return HandshakeResult.unavailable()

    def is_available(self) -> bool:
        """Report unavailable -- there is no vault behind this client."""
        return False

    def supports(self, _capability: CreekCapability, /) -> bool:
        """Report every capability as unsupported."""
        return False

    async def ingest(self, _request: VaultIngestRequest, /) -> VaultIngestResult:
        """No-op ingest: report not stored without raising (Postgres is authoritative)."""
        return VaultIngestResult(stored=False, vault_ref=None)

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Raise: classification has no local vault to serve it."""
        raise CreekCapabilityUnsupportedError(_unsupported_message(CreekCapability.CLASSIFY))

    async def reflect(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> str:
        """Raise: reflection has no local vault to serve it."""
        raise CreekCapabilityUnsupportedError(_unsupported_message(CreekCapability.REFLECT))

    async def wheel(self) -> VaultWheelBalance:
        """Raise: a vault wheel read has no local vault to serve it."""
        raise CreekCapabilityUnsupportedError(_unsupported_message(CreekCapability.WHEEL))


def _first_text_payload(content: Iterable[object]) -> Mapping[str, object]:
    """Decode the first text content block of a tool result into a mapping.

    Iterates rather than indexing so an empty content list falls through to the
    empty-mapping default instead of raising (``IndexError`` is not in the
    degrade set). A block whose text is not JSON raises
    ``json.JSONDecodeError``, which :data:`_TRANSPORT_ERROR_TYPES` degrades; a
    decoded value that is not a mapping yields the empty mapping.
    """
    for block in content:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            decoded = json.loads(text)
            return decoded if isinstance(decoded, Mapping) else {}
    return {}


def _build_mcp_http_client(api_key: str) -> httpx2.AsyncClient:
    """Build the HTTP client one MCP session runs over: credentialed, bounded, redirect-refusing.

    Built here rather than by the SDK's own ``create_mcp_http_client`` for one
    reason: that helper hard-codes ``follow_redirects=True`` and exposes no
    override, and not following a redirect is a security property of this seam
    rather than a preference -- the same property :func:`_build_pooled_vault_client`
    pins for the plain-HTTP transport. The journal entry body rides these
    requests, so a hijacked or compromised vault answering with a redirect could
    otherwise aim that body at a host the operator never configured. Refusing
    turns the redirect into a non-2xx, which degrades. Building the client
    ourselves costs nothing else: the SDK helper only ever set redirects, the
    timeout, and the headers this function sets explicitly.

    The bearer credential lives on this short-lived, per-call client and never on
    a shared pool, so it is released with the session that used it.
    """
    return httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=_MCP_HTTP_TIMEOUT,
        follow_redirects=False,
    )


def _extract_tool_payload(result: CallToolResult) -> Mapping[str, object]:
    """Extract the response mapping from an MCP tool-call result.

    A result flagged ``is_error`` raises :class:`MCPError` with a **static**
    message -- the error content is deliberately never read, because a vault's
    error text can echo the entry body. Otherwise structured content wins when
    present; a plain-dict tool result rides the content-text channel and is
    JSON-decoded via :func:`_first_text_payload`; anything else yields the
    empty mapping.
    """
    if result.is_error:
        raise MCPError(_MCP_TOOL_ERROR_CODE, "creek vault tool call returned an error")
    structured = result.structured_content
    if isinstance(structured, Mapping):
        return structured
    return _first_text_payload(result.content)


class _McpStreamableHttpTransport:
    """An MCP streamable-HTTP :class:`VaultTransport` for a configured vault.

    Each ``call`` opens an MCP session (streamable-HTTP framing with a bearer
    ``Authorization`` header sourced from ``CREEK_VAULT_API_KEY``), which
    handshakes on entry, invokes the method as an MCP tool, and extracts the
    response mapping via :func:`_extract_tool_payload`. The key is used only to
    build that header and is never logged or placed into any exception message
    (privacy invariant). Construction refuses a plaintext ``http://`` URL to a
    non-loopback host so the key is never bound to a transport that would send
    it in cleartext.

    Every failure branch lands in :data:`_TRANSPORT_ERROR_TYPES`: a connection
    failure surfaces either as an ``httpx2`` error or, when anyio wraps it, as
    an ``ExceptionGroup``; a protocol failure or ``is_error`` tool result as
    :class:`MCPError`; and a non-JSON content-text body as
    ``json.JSONDecodeError`` -- so the caller normalizes them to the degraded
    path rather than crashing. The injectable ``connect`` factory lets tests
    drive the full MCP lifecycle against an in-memory server with no network.
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        *,
        connect: Callable[[], AbstractAsyncContextManager[Client]] | None = None,
    ) -> None:
        """Store the vault URL, bearer key, and connect factory, refusing an insecure URL.

        Delegates to :func:`_require_secure_vault_url`, which raises for a
        plaintext ``http://`` URL to a non-loopback host before the key is
        bound. The optional ``connect`` factory defaults to the production
        streamable-HTTP connection and is supplied as an in-memory client
        factory under test.
        """
        _require_secure_vault_url(url)
        self._url = url
        self._api_key = api_key
        self._connect: Callable[[], AbstractAsyncContextManager[Client]] = (
            connect if connect is not None else self._connect_streamable_http
        )

    @asynccontextmanager
    async def _connect_streamable_http(self) -> AsyncIterator[Client]:
        """Open the production streamable-HTTP MCP session to the vault.

        The one untestable-without-a-network seam, kept as small as possible:
        build the HTTP client that carries the bearer header, this module's
        timeout budget, and its refusal to follow redirects
        (:func:`_build_mcp_http_client`); open the streamable-HTTP channel over
        it; and drive that channel with an MCP :class:`Client`. The HTTP client
        is entered here because the SDK only manages the lifecycle of a client it
        built itself, so an injected one would otherwise leak its connection
        pool.
        """
        async with (
            _build_mcp_http_client(self._api_key) as http_client,
            Client(streamable_http_client(self._url, http_client=http_client)) as client,
        ):
            yield client

    async def call(self, method: str, params: Mapping[str, object], /) -> Mapping[str, object]:
        """Run one MCP tool call over a fresh session, under the whole-call deadline.

        The deadline covers the session as a whole -- connect, MCP handshake, and
        ``tools/call`` -- for the same reason :meth:`HttpCreekVaultClient._authorized_request`
        carries one: the per-phase budgets are not a request deadline, since the
        read budget restarts on every socket read. Without it a vault that
        accepts the session and then trickles would hold this coroutine and its
        connection open indefinitely, and the journal write path handshakes on
        every write. Expiry raises ``TimeoutError``, an ``OSError`` subclass, so
        it lands in the caller's existing transport branch and degrades. The
        module constant is read at call time rather than captured, so a
        redeployment (or a test) can move the ceiling without rebuilding the
        transport.
        """
        async with asyncio.timeout(_VAULT_TOTAL_DEADLINE_SECONDS):
            async with self._connect() as client:
                result = await client.call_tool(method, dict(params))
            return _extract_tool_payload(result)


def build_creek_vault_client(transport: VaultTransport | None = None) -> CreekVaultClient:
    """Return the vault client appropriate for the current configuration.

    When ``CREEK_VAULT_URL`` is unset or empty, no vault is configured and a
    :class:`LocalFallbackCreekVaultClient` is returned so the app runs fully on
    its local pipeline -- checked first, so it holds whatever the protocol
    selector says. Otherwise :data:`_PROTOCOL_ENV_VAR` picks the transport: an
    :class:`HttpCreekVaultClient` for ``http``, or (by default) an
    :class:`McpCreekVaultClient` over the injected ``transport`` (tests supply a
    fake) or a freshly built :class:`_McpStreamableHttpTransport` bound to the
    configured URL and API key. An unrecognized selector raises rather than
    silently falling back, since guessing a transport would send vault traffic
    somewhere the operator did not choose.
    """
    # ``CREEK_VAULT_URL`` being unset or empty is the signal that no vault is
    # configured; the bearer credential is read only to build the transport's
    # auth header and is never logged or placed in any exception message.
    url = os.getenv("CREEK_VAULT_URL", "")
    if not url:
        return LocalFallbackCreekVaultClient()
    api_key = os.getenv("CREEK_VAULT_API_KEY", "")
    protocol = os.getenv(_PROTOCOL_ENV_VAR, _PROTOCOL_MCP).strip().lower()
    if protocol == _PROTOCOL_HTTP:
        return HttpCreekVaultClient(url, api_key)
    if protocol == _PROTOCOL_MCP:
        return McpCreekVaultClient(transport=transport or _McpStreamableHttpTransport(url, api_key))
    # Names only the offending value: the message reaches logs, and the URL and
    # the bearer credential must never travel with it.
    raise ValueError(f"unsupported {_PROTOCOL_ENV_VAR} value: {protocol!r}")
