"""Concrete Creek Vault MCP client adapters and their factory.

This is the service-layer counterpart to the pure :mod:`domain.creek_vault`
seam, following the same domain-protocol -> service-adapter pattern as
:mod:`services.marginalia` and the env-var config / error-normalization pattern
as :mod:`services.botmason`.

Two implementations of :class:`~domain.creek_vault.CreekVaultClient` live here:

* :class:`McpCreekVaultClient` -- talks to a real vault over an injected
  :class:`VaultTransport`. It is written to **degrade, never crash**:
  :meth:`~McpCreekVaultClient.handshake` swallows every transport, parsing, and
  version-mismatch failure into :meth:`HandshakeResult.unavailable`, and every
  per-capability call normalizes any transport exception to
  :class:`CreekVaultUnavailableError` with a **static, capability-named message**
  that never echoes the entry body or the API key.
* :class:`LocalFallbackCreekVaultClient` -- the no-vault path. Handshake reports
  unavailable, nothing is supported, ingest is a silent no-op (operator Postgres
  stays the system of record), and the read/compute capabilities raise
  :class:`CreekCapabilityUnsupportedError`.

:func:`build_creek_vault_client` chooses between them from ``CREEK_VAULT_URL``,
so an unconfigured deployment transparently gets the local fallback.

Transport security: :class:`_HttpJsonTransport` refuses a plaintext ``http://``
URL to any non-loopback host, because every call carries the
``CREEK_VAULT_API_KEY`` bearer credential (and each call's tier metadata) that
must never cross a network in cleartext. This seam does not itself encrypt the
entry *body*: the contract's end-to-end, ciphertext-only intimate-transit rule
(a client-held key the operator cannot decrypt) is a property of the write path
built on this seam -- enforced where the body is assembled -- not of the seam's
construction, and so is deliberately out of scope here rather than forgotten.

Cross-references ``docs/creek-vault-mcp-contract.md`` for the wire surface and
the graceful-degradation guarantees.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Protocol
from urllib.parse import urlsplit

import httpx

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

# The major component of the contract version we will interoperate with. A vault
# advertising a different major is treated as incompatible and degrades to
# unavailable rather than risking a call under a surface we do not understand.
_CONTRACT_MAJOR = CONTRACT_VERSION.split(".")[0]

# Transport-layer failures we normalize to a degraded state. ``OSError`` covers
# connection/timeout errors, ``httpx.HTTPError`` covers every httpx transport and
# status failure, and ``json.JSONDecodeError`` covers a non-JSON body (a proxy
# error page, an empty 200, or any vault bug) that ``response.json()`` cannot
# decode -- the transport contract is to return a *decoded* mapping, so a decode
# failure is a transport failure. All three normalize the per-capability path to
# unavailable exactly as the handshake path already does, keeping one coherent
# degrade-set (``json.JSONDecodeError`` is a ``ValueError`` subclass, so it is
# already covered by the handshake's parse-error set).
_TRANSPORT_ERROR_TYPES: tuple[type[Exception], ...] = (
    OSError,
    httpx.HTTPError,
    json.JSONDecodeError,
)

# Payload-parsing failures. A malformed or wrong-typed handshake response should
# degrade to unavailable exactly like a transport error, never propagate.
_PARSE_ERROR_TYPES: tuple[type[Exception], ...] = (KeyError, TypeError, AttributeError, ValueError)

# Everything a handshake probe swallows into an "unavailable" result: transport
# failures (the vault is unreachable) and parsing failures (its payload is
# malformed). Combining them keeps the degradation path a single ``except``.
_HANDSHAKE_DEGRADE_ERRORS: tuple[type[Exception], ...] = (
    *_TRANSPORT_ERROR_TYPES,
    *_PARSE_ERROR_TYPES,
)

# Hosts for which a plaintext ``http://`` vault URL is tolerated: a developer
# running the vault on the same machine. Every other host must use TLS so the
# bearer credential and tier metadata never cross a network in cleartext.
_LOOPBACK_HOSTS: frozenset[str] = frozenset({"localhost", "127.0.0.1", "::1"})


def _require_secure_vault_url(url: str) -> None:
    """Reject a plaintext vault URL to a non-loopback host, failing closed.

    A configured vault is reached over :class:`_HttpJsonTransport`, which sends
    the ``CREEK_VAULT_API_KEY`` bearer credential (and each call's tier
    metadata) over the wire. Allowing a plaintext ``http://`` URL to a remote
    host would expose that credential in cleartext, so a misconfiguration raises
    here rather than silently leaking. Plaintext to a loopback host is permitted
    for local development. The message names only the scheme and host -- never
    the API key.
    """
    parsed = urlsplit(url)
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
    """Build the identity/version params adepthood presents at handshake."""
    return {"consumer": CONSUMER_ID, "contract_version": CONTRACT_VERSION}


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


def _parse_handshake(payload: Mapping[str, object]) -> HandshakeResult:
    """Parse a well-formed handshake payload into a populated result.

    Reads and version-checks the contract before anything else: a major-version
    mismatch returns unavailable directly (we will not call an incompatible
    surface). Any missing key or wrong-typed field raises out of the helpers and
    is caught by :meth:`McpCreekVaultClient.handshake`.
    """
    contract_version = _require_str(payload, "contract_version")
    if contract_version.split(".")[0] != _CONTRACT_MAJOR:
        return HandshakeResult.unavailable()
    return HandshakeResult(
        available=True,
        contract_version=contract_version,
        ontology_version=_require_str(payload, "ontology_version"),
        capabilities=_parse_capabilities(payload["capabilities"]),
        attestation=_parse_attestation(payload.get("attestation")),
    )


def _parse_ingest_result(payload: Mapping[str, object]) -> VaultIngestResult:
    """Parse an ingest response, defaulting missing/odd fields conservatively."""
    vault_ref = payload.get("vault_ref")
    return VaultIngestResult(
        stored=bool(payload.get("stored")),
        vault_ref=vault_ref if isinstance(vault_ref, str) else None,
    )


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
    """Map an ingest request onto wire params, applying its tier ceiling."""
    return {
        "consumer": CONSUMER_ID,
        "body": request.body,
        "tier_ceiling": request.tier_ceiling.value,
        "created_at": request.created_at.isoformat(),
        "aspect_tags": list(request.aspect_tags),
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
        """Store ``request`` in the vault, requiring the INGEST capability."""
        payload = await self._invoke(CreekCapability.INGEST, _ingest_params(request))
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


class _HttpJsonTransport:
    """A thin JSON-over-HTTP :class:`VaultTransport` for a configured vault.

    POSTs each MCP call as JSON with a bearer ``Authorization`` header sourced
    from ``CREEK_VAULT_API_KEY``. The key is used only to build that header and
    is never logged or placed into any exception message (privacy invariant).
    Construction refuses a plaintext ``http://`` URL to a non-loopback host so
    the key is never bound to a transport that would send it in cleartext.

    ``call`` has two failure branches the rest of the client depends on:
    ``response.raise_for_status()`` (a non-2xx status) raises an
    ``httpx.HTTPError`` and ``response.json()`` (a non-JSON body) raises a
    ``json.JSONDecodeError``. Both are in :data:`_TRANSPORT_ERROR_TYPES`, so the
    caller normalizes them to the degraded path rather than crashing. An
    injectable ``transport`` lets tests exercise those branches with an
    ``httpx.MockTransport`` instead of a live network.
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """Store the vault base URL and bearer key, refusing an insecure URL.

        Delegates to :func:`_require_secure_vault_url`, which raises for a
        plaintext ``http://`` URL to a non-loopback host before the key is bound.
        The optional ``transport`` is passed to :class:`httpx.AsyncClient`; it
        defaults to ``None`` (httpx's own network transport) in production and is
        supplied as an :class:`httpx.MockTransport` under test.
        """
        _require_secure_vault_url(url)
        self._url = url
        self._api_key = api_key
        self._transport = transport

    async def call(self, method: str, params: Mapping[str, object], /) -> Mapping[str, object]:
        """POST one MCP call and return the decoded JSON response mapping."""
        headers = {"Authorization": f"Bearer {self._api_key}"}
        async with httpx.AsyncClient(
            timeout=_VAULT_TIMEOUT_SECONDS, transport=self._transport
        ) as client:
            response = await client.post(
                self._url, json={"method": method, "params": dict(params)}, headers=headers
            )
            response.raise_for_status()
            decoded: Mapping[str, object] = response.json()
            return decoded


def build_creek_vault_client(transport: VaultTransport | None = None) -> CreekVaultClient:
    """Return the vault client appropriate for the current configuration.

    When ``CREEK_VAULT_URL`` is unset or empty, no vault is configured and a
    :class:`LocalFallbackCreekVaultClient` is returned so the app runs fully on
    its local pipeline. Otherwise an :class:`McpCreekVaultClient` is returned
    over the injected ``transport`` (tests supply a fake) or a freshly built
    :class:`_HttpJsonTransport` bound to the configured URL and API key.
    """
    # ``CREEK_VAULT_URL`` being unset or empty is the signal that no vault is
    # configured; the bearer credential is read only to build the transport's
    # auth header and is never logged or placed in any exception message.
    url = os.getenv("CREEK_VAULT_URL", "")
    if not url:
        return LocalFallbackCreekVaultClient()
    api_key = os.getenv("CREEK_VAULT_API_KEY", "")
    return McpCreekVaultClient(transport=transport or _HttpJsonTransport(url, api_key))
