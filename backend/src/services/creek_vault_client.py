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
  apart from a vault that is merely unreachable. Its per-capability calls all
  refuse for now: Creek's ratified ``/v1`` request/response shapes have not
  shipped, and guessing a wire format is worse than staying local.
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
from typing import NoReturn, Protocol
from urllib.parse import SplitResult, urlsplit

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.shared.exceptions import McpError
from mcp.types import CallToolResult, ErrorData

from domain.creek_vault import (
    CONSUMER_ID,
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultClient,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultIngestRequest,
    VaultIngestResult,
    VaultTierCeiling,
    VaultWheelAspect,
    VaultWheelBalance,
)
from schemas.wheel import WheelBalanceResponse

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

# How a "MAJOR.MINOR.PATCH" version string decomposes, and how many of its
# leading components must match for two contract versions to interoperate. ADR
# 0004 Decision 4: while the contract is pre-1.0 a minor bump *is* the breaking
# change, so client and server must match on exact major.minor; from 1.0 onward
# minors are forward-compatible and only the major must match.
_VERSION_MAJOR_INDEX = 0
_PRE_1_0_MAJOR = "0"
_PRE_1_0_MATCHED_COMPONENTS = 2
_POST_1_0_MATCHED_COMPONENTS = 1

# Transport-layer failures we normalize to a degraded state. ``OSError`` covers
# connection/timeout errors, ``httpx.HTTPError`` covers every httpx transport
# and status failure underneath the MCP session, ``McpError`` covers an MCP
# protocol failure or a tool call that returned ``isError`` (raised by
# :func:`_extract_tool_payload` with a static, content-free message),
# ``ExceptionGroup`` covers a streamable-HTTP connection failure (anyio task
# groups wrap the underlying ``httpx.ConnectError`` in a builtins
# ``ExceptionGroup``; catching the ``Exception``-only group -- never
# ``BaseExceptionGroup`` -- stays safe under cancellation), and
# ``json.JSONDecodeError`` covers a content-text block whose body is not JSON.
# All of these normalize the per-capability path to unavailable exactly as the
# handshake path already does, keeping one coherent degrade-set
# (``json.JSONDecodeError`` is a ``ValueError`` subclass, so it is already
# covered by the handshake's parse-error set).
_TRANSPORT_ERROR_TYPES: tuple[type[Exception], ...] = (
    OSError,
    httpx.HTTPError,
    McpError,
    ExceptionGroup,
    json.JSONDecodeError,
)

# JSON-RPC application-defined server-error code (the -32000..-32099 range) used
# when a vault tool call reports ``isError``; the paired message is static so it
# can never echo the entry body or the API key.
_MCP_TOOL_ERROR_CODE = -32000

# The status value a ``creek.journal`` response reports on a durable write. Any
# other status -- or a missing one -- parses conservatively to "not stored".
_JOURNAL_OK_STATUS = "ok"

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


def _parse_ingest_result(payload: Mapping[str, object]) -> VaultIngestResult:
    """Parse a ``creek.journal`` response, defaulting missing/odd fields conservatively.

    Only an ``"ok"`` status paired with a non-empty string ``fragment_id``
    counts as durably stored; a missing, empty, or wrong-typed field parses to
    a not-stored result rather than fabricating a vault ref.
    """
    fragment_id = payload.get("fragment_id")
    status_ok = payload.get("status") == _JOURNAL_OK_STATUS
    if status_ok and isinstance(fragment_id, str) and fragment_id:
        return VaultIngestResult(stored=True, vault_ref=fragment_id)
    return VaultIngestResult(stored=False, vault_ref=None)


def _parse_classification(payload: Mapping[str, object]) -> VaultClassification:
    """Parse a classify response into a tuple of string tags (dropping non-strings)."""
    raw = payload.get("tags")
    if not isinstance(raw, list):
        return VaultClassification(tags=())
    return VaultClassification(tags=tuple(item for item in raw if isinstance(item, str)))


def _content_params(body: str, tier_ceiling: VaultTierCeiling) -> Mapping[str, object]:
    """Build the shared params for a content-bearing call (classify/reflect)."""
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
        """Produce a Higher Self reflection over the corpus, requiring REFLECT."""
        payload = await self._invoke(CreekCapability.REFLECT, _content_params(body, tier_ceiling))
        reflection = payload.get("reflection")
        return reflection if isinstance(reflection, str) else ""

    async def wheel(self) -> VaultWheelBalance:
        """Return a vault-computed Wheel-of-Wholeness read, requiring WHEEL.

        The wire payload is validated against :class:`WheelBalanceResponse` (the
        schema import is legitimate in this adapter layer) and then projected onto
        the pure-domain :class:`VaultWheelBalance` the seam contract returns, so
        the domain module carries no schema dependency.

        A well-formed mapping whose *fields* do not match the schema still raises
        ``pydantic.ValidationError`` here rather than degrading to
        :class:`CreekVaultUnavailableError`. That is the one un-normalized error
        path in this client and is deliberate: field-level wheel validation and a
        response-size ceiling belong with the read/compute path that consumes the
        wheel. It does not weaken the floor guarantee -- the wheel is an optional
        read, never a write, and a caller that cannot obtain it falls back to
        computing the balance locally.
        """
        payload = await self._invoke(CreekCapability.WHEEL, {"consumer": CONSUMER_ID})
        validated = WheelBalanceResponse.model_validate(payload)
        return VaultWheelBalance(
            aspects=tuple(
                VaultWheelAspect(
                    stage_number=aspect.stage_number,
                    aspect=aspect.aspect,
                    fullness=aspect.fullness,
                )
                for aspect in validated.aspects
            ),
        )


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


# The vault's capability document, relative to the configured base URL. The one
# endpoint adepthood can call today: Creek's ratified ``/v1`` request/response
# shapes for the other capabilities have not shipped.
_CAPABILITIES_PATH = "/v1/capabilities"


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


class HttpCreekVaultClient:
    """A :class:`CreekVaultClient` that speaks plain HTTP/JSON to a configured vault.

    Handshakes with a single ``GET /v1/capabilities`` carrying a bearer
    ``Authorization`` header, caches the result so :meth:`is_available` and
    :meth:`supports` stay cheap synchronous reads, and records
    :attr:`last_degrade_reason` when the probe fails. Like the MCP client it
    **degrades, never crashes**: :meth:`handshake` collapses every transport,
    parsing, and version failure into :meth:`HandshakeResult.unavailable`.

    The capability calls all refuse with
    :class:`CreekCapabilityUnsupportedError`, *including* ones the vault
    advertises. Creek's ratified ``/v1`` request/response shapes for them have
    not shipped upstream, and this adapter will not guess a wire format: a
    refusal degrades the caller onto its local pipeline, whereas a wrong guess
    would send real journal content into a surface nobody has agreed on. Wiring
    them up is follow-on work, gated on that document.

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

    async def _fetch_capabilities(self) -> Mapping[str, object]:
        """Fetch and minimally narrow the vault's capability document.

        The authorization header is built here, per call, so the credential
        lives only for the duration of the request and never on the shared
        pooled client. A non-2xx status raises ``httpx.HTTPStatusError`` and a
        non-JSON body raises ``json.JSONDecodeError``; both are degraded by the
        caller. A body that decodes to something other than a JSON object is a
        malformed payload, so it raises ``TypeError`` rather than being cast.

        The request runs under a whole-call deadline because httpx's ``read``
        budget is per socket-read rather than a deadline, so a trickling vault
        would otherwise hold this coroutine (and its pooled connection) open
        indefinitely. Expiry raises ``TimeoutError``, an ``OSError`` subclass,
        so it lands in the caller's existing transport branch and degrades to
        unreachable -- the degrade set is unchanged.
        """
        async with asyncio.timeout(_VAULT_TOTAL_DEADLINE_SECONDS):
            response = await self._active_client().get(
                f"{self._url}{_CAPABILITIES_PATH}",
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, Mapping):
            raise TypeError("creek vault capability payload must be a JSON object")
        return payload

    async def _probe(self) -> tuple[HandshakeResult, HandshakeDegradeReason | None]:
        """Run one capability probe, mapping each failure mode to its own reason.

        The ``except`` clauses are split (where the MCP client uses one combined
        set) purely to attribute the degradation: every branch returns the same
        canonical unavailable result. ``httpx.HTTPError`` covers connection
        failures, timeouts, and every non-2xx status raised by
        ``raise_for_status``; ``OSError`` covers a socket-level failure that
        escapes httpx's own hierarchy. A payload that parsed but whose vault
        reported itself unavailable is not an error at all -- it is the vault
        answering honestly -- and is recorded as such.
        """
        try:
            result = _parse_handshake(await self._fetch_capabilities())
        except _IncompatibleContractVersionError:
            return HandshakeResult.unavailable(), HandshakeDegradeReason.INCOMPATIBLE_VERSION
        except (httpx.HTTPError, OSError):
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

    async def ingest(self, _request: VaultIngestRequest, /) -> VaultIngestResult:
        """Refuse ingest: the ``/v1`` write shape is unratified (Postgres stays authoritative)."""
        _refuse_unratified(CreekCapability.JOURNAL)

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


def _extract_tool_payload(result: CallToolResult) -> Mapping[str, object]:
    """Extract the response mapping from an MCP tool-call result.

    A result flagged ``isError`` raises :class:`McpError` with a **static**
    message -- the error content is deliberately never read, because a vault's
    error text can echo the entry body. Otherwise structured content wins when
    present; a plain-dict tool result rides the content-text channel and is
    JSON-decoded via :func:`_first_text_payload`; anything else yields the
    empty mapping.
    """
    if result.isError:
        error_data = ErrorData(
            code=_MCP_TOOL_ERROR_CODE, message="creek vault tool call returned an error"
        )
        raise McpError(error_data)
    structured = result.structuredContent
    if isinstance(structured, Mapping):
        return structured
    return _first_text_payload(result.content)


class _McpStreamableHttpTransport:
    """An MCP streamable-HTTP :class:`VaultTransport` for a configured vault.

    Each ``call`` opens an MCP session (streamable-HTTP framing with a bearer
    ``Authorization`` header sourced from ``CREEK_VAULT_API_KEY``), initializes
    it, invokes the method as an MCP tool, and extracts the response mapping
    via :func:`_extract_tool_payload`. The key is used only to build that
    header and is never logged or placed into any exception message (privacy
    invariant). Construction refuses a plaintext ``http://`` URL to a
    non-loopback host so the key is never bound to a transport that would send
    it in cleartext.

    Every failure branch lands in :data:`_TRANSPORT_ERROR_TYPES`: a connection
    failure surfaces as an ``ExceptionGroup`` (anyio-wrapped
    ``httpx.ConnectError``), a protocol failure or ``isError`` tool result as
    :class:`McpError`, and a non-JSON content-text body as
    ``json.JSONDecodeError`` -- so the caller normalizes them to the degraded
    path rather than crashing. The injectable ``connect`` factory lets tests
    drive the full MCP lifecycle against an in-memory server with no network.
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        *,
        connect: Callable[[], AbstractAsyncContextManager[ClientSession]] | None = None,
    ) -> None:
        """Store the vault URL, bearer key, and connect factory, refusing an insecure URL.

        Delegates to :func:`_require_secure_vault_url`, which raises for a
        plaintext ``http://`` URL to a non-loopback host before the key is
        bound. The optional ``connect`` factory defaults to the production
        streamable-HTTP connection and is supplied as an in-memory session
        factory under test.
        """
        _require_secure_vault_url(url)
        self._url = url
        self._api_key = api_key
        self._connect: Callable[[], AbstractAsyncContextManager[ClientSession]] = (
            connect if connect is not None else self._connect_streamable_http
        )

    @asynccontextmanager
    async def _connect_streamable_http(self) -> AsyncIterator[ClientSession]:
        """Open the production streamable-HTTP MCP session to the vault.

        The one untestable-without-a-network seam, kept as small as possible:
        authenticate with the bearer header, open the streamable-HTTP channel
        (which yields a read stream, a write stream, and a session-id getter),
        and wrap the streams in a :class:`ClientSession`.
        """
        headers = {"Authorization": f"Bearer {self._api_key}"}
        async with (
            streamablehttp_client(self._url, headers=headers, timeout=_VAULT_TIMEOUT_SECONDS) as (
                read,
                write,
                _get_session_id,
            ),
            ClientSession(read, write) as session,
        ):
            yield session

    async def call(self, method: str, params: Mapping[str, object], /) -> Mapping[str, object]:
        """Run one MCP tool call over a fresh session and return its payload mapping."""
        async with self._connect() as session:
            await session.initialize()
            result = await session.call_tool(method, dict(params))
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
