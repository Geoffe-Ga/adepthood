"""Tests for the HTTP/JSON Creek Vault adapter in services.creek_vault_client.

Every case drives the adapter through an ``httpx.MockTransport`` handler, so no
test touches a network or waits on real time. Four response shapes are asserted
here: the capability document the handshake already parses, the journal ingest
exchange, the wheel read, and the reflection exchange -- the capabilities whose
``/v1`` shapes Creek has ratified. Nothing beyond those is invented, and every
wheel and reflection body is read from the vendored contract bundle rather than
written out here.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator, Callable, Coroutine, Iterator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from http import HTTPStatus
from typing import cast
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from conftest import test_engine
from dependencies import creek_vault as vault_dependency
from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultCareEscalationError,
    CreekVaultClient,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultErrorCode,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultWheelAspect,
    VaultWheelBalance,
)
from domain.resonance import ANCHOR_TEXT_MAX, NOTE_MAX, VALID_KINDS
from main import app, lifespan
from scripts.creek_contract_drift import BUNDLE_ROOT
from services.creek_vault_client import (
    _CONTRACT_MINOR_COMPONENTS,
    _CONTRACT_VERSION_HEADER,
    _MAX_FRAGMENT_ID_LENGTH,
    _MAX_WHEEL_ASPECT_NAME_LENGTH,
    _VAULT_HTTP_TIMEOUT,
    _VAULT_TIMEOUT_SECONDS,
    _VAULT_TOTAL_DEADLINE_SECONDS,
    _WHEEL_FREQUENCY_CODES,
    _WHEEL_OK_STATUS,
    CONTRACT_MINOR,
    HandshakeDegradeReason,
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
    _build_pooled_vault_client,
    _contract_version_compatible,
    _entry_path_segment,
    _parse_wheel,
    _VaultHttpPool,
    build_creek_vault_client,
    close_creek_vault_http_pool,
)
from services.creek_vault_payload import (
    _MARGINALIA_KIND_BY_CREEK_KIND,
    _MAX_REFLECT_NOTES,
    _bounded_text,
)
from services.creek_vault_telemetry import (
    VaultCallTimedOutError,
    VaultTelemetryOutcome,
    outcome_for_error,
    reset_vault_telemetry_for_tests,
    vault_outcome_counts,
)
from services.creek_vault_write import VaultWriteStatus, store_and_classify

_VAULT_URL = "https://vault.example.test"

_CAPABILITIES_PATH = "/v1/capabilities"

_CAPABILITIES_URL = f"{_VAULT_URL}{_CAPABILITIES_PATH}"

# The wheel is a whole-corpus aggregate rather than a resource, so it is read
# from one collection-level URL carrying no parameters at all.
_WHEEL_PATH = "/v1/wheel"

_WHEEL_URL = f"{_VAULT_URL}{_WHEEL_PATH}"

# A reflection is asked for, not addressed: adepthood posts an ad-hoc body to the
# collection rather than naming a fragment the vault already stores.
_REFLECTIONS_PATH = "/v1/reflections"

_REFLECTIONS_URL = f"{_VAULT_URL}{_REFLECTIONS_PATH}"

_API_KEY = "creek-vault-test-key"  # pragma: allowlist secret

# A configured vault's single bound owner, and somebody who is not them. Two ids
# that are never equal, so "owner" and "everyone else" cannot be satisfied by the
# same comparison.
_VAULT_OWNER_ID = 11
_NON_OWNER_ID = 12

_SENTINEL_KEY = "SENTINEL_VAULT_KEY_DO_NOT_LEAK"

# A password smuggled into the URL's userinfo component. httpx renders userinfo
# unmasked in ``str(url)`` and in its own INFO request log, and derives Basic
# auth from it that silently replaces our bearer -- so the adapter must refuse
# such a URL, and its refusal message must not repeat this value.
_URL_PASSWORD = "URLPASSWORD_DO_NOT_LEAK"  # pragma: allowlist secret

_USERINFO_VAULT_URL = f"https://opuser:{_URL_PASSWORD}@vault.example.test"

# A configured URL carrying a path prefix: still legal, and the capability path
# must be appended to it rather than replacing it.
_PATH_VAULT_URL = f"{_VAULT_URL}/vault/"

_ENTRY_BODY = "a floor-level journal entry"

# A body distinct enough to spot anywhere it must never appear: an exception
# message, a repr, or a log record.
_SENTINEL_BODY = "SENTINEL_ENTRY_BODY_DO_NOT_LEAK"

_CREATED_AT = datetime(2026, 7, 31, 12, 0, tzinfo=UTC)

# The stable external id the vault keys the stored fragment off, and the URL a
# PUT for it must land on.
_ENTRY_ID = 7

_JOURNAL_ENTRY_URL = f"{_VAULT_URL}/v1/journal-entries/{_ENTRY_ID}"

_FRAGMENT_ID = "frag-7"

# A hostile ``code`` a compromised or buggy vault could answer with: an
# unrecognized value carrying CRLF (log-injection) plus a token that must never
# be echoed. The adapter may parse only its own enum values, so this whole
# string has to be dropped rather than stored, formatted, or logged.
_HOSTILE_CODE_SENTINEL = "HOSTILE_VAULT_CODE_SENTINEL"
_HOSTILE_VAULT_CODE = f"not_a_real_code\r\n{_HOSTILE_CODE_SENTINEL}"

# Two fragment ids a compromised vault could answer a healthy 2xx with. The
# oversized one is storage amplification -- ``vault_ref`` is an unbounded text
# column written on every journal save -- and the hostile one carries the bytes
# (NUL, CRLF) that a text column rejects outright and a log line must never
# receive. Neither may become an entry's durable vault reference.
_OVERSIZED_FRAGMENT_ID = "f" * (_MAX_FRAGMENT_ID_LENGTH + 1)
_HOSTILE_FRAGMENT_ID = "frag\r\n\x00-7"

# The longest fragment id that is still storable, so the bound is asserted at
# its edge rather than merely somewhere beyond it.
_LONGEST_USABLE_FRAGMENT_ID = "f" * _MAX_FRAGMENT_ID_LENGTH

# A vault URL whose port is not a number. ``urlsplit`` accepts it -- so the
# construction-time security validator does too, since it never reads the port
# -- while httpx refuses to build a request for it, raising ``InvalidURL`` from
# outside its own ``HTTPError`` hierarchy. It stands in for an operator typo (a
# shell-interpolated port that came out non-numeric), which must degrade like
# any other unreachable vault rather than raise into the caller's request path.
_UNPARSEABLE_VAULT_URL = "https://vault.example.test:not-a-port"

_POOL_ATTR = "services.creek_vault_client._VAULT_HTTP_POOL"

_DEADLINE_ATTR = "services.creek_vault_client._VAULT_TOTAL_DEADLINE_SECONDS"

# A whole-request deadline short enough to expire during a test, paired with a
# handler sleep two orders of magnitude longer so the deadline -- never the
# sleep -- is what ends the call. The sleep is cancelled the moment the deadline
# fires, so the test costs milliseconds, not seconds.
_TINY_DEADLINE_SECONDS = 0.02
_SLOW_HANDLER_SLEEP_SECONDS = 5.0

# The redirect status a hijacked or misconfigured vault would answer with; it
# must degrade rather than forward the bearer to the Location host.
_REDIRECT_STATUS_FOUND = 302

# The marginalia kind Creek's ``pattern`` renders as. Written out rather than
# read back through the mapping under test: a projection asserted against itself
# would accept whatever the table happened to say.
_PATTERN_MARGINALIA_KIND = "connection"

# An essay a compromised or over-eager vault could attach to an otherwise
# well-formed answer. It is free model prose rather than the user's own words, so
# it may reach no note, no message, and no log.
_SENTINEL_ESSAY = "SENTINEL_VAULT_ESSAY_DO_NOT_RENDER"

# A synthetic correlation id for the two published error codes the bundle has no
# example cell for. Opaque and caller-independent, exactly as the envelope's own
# field description requires.
_SYNTHETIC_REQUEST_ID = "req-synthetic-not-published"

# Every spelling a declared tier ceiling could plausibly travel under. The
# ratified reflection request publishes none of them, so a request carrying any
# one would be an undocumented parameter this client invented.
_TIER_FIELD_NAMES = ("tier", "tier_ceiling", "privacy_tier_ceiling", "routed_tier")

# A contract version one pre-1.0 minor bump away from the pin, which is exactly
# the breaking change the compatibility rule refuses to interoperate across.
_SKEWED_CONTRACT_VERSION = "0.3.0"

_PROTOCOL_MEMBERS = (
    "handshake",
    "is_available",
    "supports",
    "ingest",
    "classify",
    "reflect",
    "wheel",
)

Handler = Callable[[httpx.Request], httpx.Response]
# Narrower than ``Awaitable`` on purpose: ``httpx.MockTransport`` accepts a
# coroutine function specifically, so a wider alias fails to type-check at the
# call site.
AsyncHandler = Callable[[httpx.Request], Coroutine[None, None, httpx.Response]]
ClientFactory = Callable[[Handler | AsyncHandler], httpx.AsyncClient]


def _minor_of(contract_version: str) -> str:
    """Return the ``major.minor`` of a full semantic contract version."""
    return ".".join(contract_version.split(".")[:_CONTRACT_MINOR_COMPONENTS])


# Inlined rather than a parameter: no test has ever overridden it, and carrying
# it as one pushed the builder past the argument ceiling once
# ``supported_contract_minors`` became a required field to vary.
_ONTOLOGY_VERSION = "aptitude-wavelength/2026-05-23"


def _handshake_payload(
    capabilities: Sequence[str],
    contract_version: str = CONTRACT_VERSION,
    attestation: Mapping[str, object] | None = None,
    *,
    available: bool = True,
    supported_contract_minors: Sequence[str] | None = None,
) -> dict[str, object]:
    """Build a handshake document in the shape Creek actually publishes.

    Callers pass adepthood-side capability values (``creek.*``) because that is
    the vocabulary the assertions are written in; this translates them to Creek's
    published wire names on the way out, so every test exercises the real
    document shape rather than one shaped to the client's former bugs.
    Availability is nested under ``vault``, where Creek puts it.

    A capability with no published name (UPLOAD, SAVE, CLASSIFY) is emitted
    unchanged so a test can still assert that an unrecognised advertisement is
    dropped rather than coerced.

    ``supported_contract_minors`` defaults to the single minor of
    ``contract_version``, which is the narrowest thing a server advertising that
    version can truthfully claim. That default is load-bearing for the existing
    skew cases: they pass ``"0.3.0"`` to mean "a server adepthood cannot talk
    to", and a default that quietly included adepthood's own pin would invert
    what every one of them asserts.
    """
    wire_name = {
        CreekCapability.HANDSHAKE.value: "capabilities",
        CreekCapability.JOURNAL.value: "journal-upsert",
        CreekCapability.REFLECT.value: "reflections",
        CreekCapability.WHEEL.value: "wheel",
    }
    minor = _minor_of(contract_version)
    return {
        "vault": {"available": available},
        "capabilities": [wire_name.get(c, c) for c in capabilities],
        "contract_version": contract_version,
        "contract_minor": minor,
        "supported_contract_minors": (
            [minor] if supported_contract_minors is None else list(supported_contract_minors)
        ),
        "ontology_version": _ONTOLOGY_VERSION,
        "attestation": attestation,
    }


def _json_handler(payload: object, status_code: int = 200) -> Handler:
    """Return a handler answering every request with ``payload`` as JSON."""

    def _handle(_request: httpx.Request) -> httpx.Response:
        """Answer with the fixed JSON payload and status."""
        return httpx.Response(status_code, json=payload)

    return _handle


def _text_handler(body: str, status_code: int = 200) -> Handler:
    """Return a handler answering with a non-JSON text body (a proxy error page)."""

    def _handle(_request: httpx.Request) -> httpx.Response:
        """Answer with the fixed text body and status."""
        return httpx.Response(status_code, text=body)

    return _handle


def _raising_handler(exc: Exception) -> Handler:
    """Return a handler that raises ``exc`` instead of answering."""

    def _handle(_request: httpx.Request) -> httpx.Response:
        """Raise the stored transport exception."""
        raise exc

    return _handle


def _redirect_handler(location: str) -> Handler:
    """Return a handler answering with a redirect to ``location`` and no body."""

    def _handle(_request: httpx.Request) -> httpx.Response:
        """Answer with the fixed redirect."""
        return httpx.Response(_REDIRECT_STATUS_FOUND, headers={"Location": location})

    return _handle


async def _slow_handler(_request: httpx.Request) -> httpx.Response:
    """Sleep far past any plausible deadline instead of answering.

    Stands in for a vault that accepts the connection and then trickles: every
    per-phase httpx budget stays unexhausted, so only a whole-request deadline
    can end the call.
    """
    await asyncio.sleep(_SLOW_HANDLER_SLEEP_SECONDS)
    return httpx.Response(200, json={})


def _healthy_handler(capabilities: Sequence[str]) -> Handler:
    """Return a handler answering with a healthy capability payload."""
    return _json_handler(_handshake_payload(capabilities))


def _payload_without_contract_version() -> dict[str, object]:
    """Build a capability payload whose contract_version key is absent."""
    payload = _handshake_payload([CreekCapability.JOURNAL.value])
    del payload["contract_version"]
    return payload


def _payload_without_supported_minors() -> dict[str, object]:
    """Build a capability payload whose supported_contract_minors key is absent."""
    payload = _handshake_payload([CreekCapability.JOURNAL.value])
    del payload["supported_contract_minors"]
    return payload


def _ingest_request(
    tier: VaultTierCeiling = VaultTierCeiling.OPEN, body: str = _ENTRY_BODY
) -> VaultIngestRequest:
    """Build an ingest request at ``tier`` carrying ``body``.

    An entry's own tier and its write ceiling are always the same value on the
    journal path, so one argument sets both.
    """
    return VaultIngestRequest(
        entry_id=_ENTRY_ID,
        body=body,
        tier=tier,
        tier_ceiling=tier,
        created_at=_CREATED_AT,
    )


def _ingest_payload(
    fragment_id: object = _FRAGMENT_ID,
    action: str = VaultIngestAction.CREATED.value,
) -> dict[str, object]:
    """Build a vault ingest response body carrying ``action`` and ``fragment_id``."""
    return {"action": action, "fragment_id": fragment_id}


def _error_payload(code: str) -> dict[str, object]:
    """Build a vault error body carrying a machine-readable ``code``."""
    return {"code": code, "detail": "the vault refused this request"}


class _RecordingHandler:
    """Handler that records every request it serves and answers with a fixed payload."""

    def __init__(self, payload: Mapping[str, object]) -> None:
        """Store the payload to answer with and start an empty request log."""
        self._payload = dict(payload)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request and answer 200 with the stored payload."""
        self.requests.append(request)
        return httpx.Response(200, json=self._payload)


@dataclass(frozen=True)
class _IngestReply:
    """One scripted answer to a journal-entry PUT: a status plus a JSON or text body."""

    status: int = HTTPStatus.OK
    payload: object = None
    text: str | None = None

    def to_response(self) -> httpx.Response:
        """Build the httpx response this reply describes."""
        if self.text is not None:
            return httpx.Response(self.status, text=self.text)
        return httpx.Response(self.status, json=self.payload)


_CREATED_REPLY = _IngestReply(payload=_ingest_payload())


class _VaultRouteHandler:
    """Route-aware handler: a healthy capability GET plus scripted journal PUTs.

    The handshake and the ingest have different shapes and different failure
    modes, so a test needs to script them independently while still seeing every
    request that crossed the transport. Replies are consumed in order and the
    last one repeats, so a two-call test scripts exactly two.
    """

    def __init__(
        self,
        replies: Sequence[_IngestReply] = (),
        *,
        capabilities: Sequence[str] = (CreekCapability.JOURNAL.value,),
        ingest_error: Exception | None = None,
    ) -> None:
        """Store the advertised capabilities, the PUT script, and any PUT failure."""
        self._capabilities = list(capabilities)
        self._replies = list(replies) or [_CREATED_REPLY]
        self._ingest_error = ingest_error
        self.requests: list[httpx.Request] = []

    @property
    def ingest_requests(self) -> list[httpx.Request]:
        """Return only the journal-entry PUTs this handler has served."""
        return [request for request in self.requests if request.method == "PUT"]

    def _next_reply(self) -> _IngestReply:
        """Return this PUT's scripted reply, repeating the last once the script runs out."""
        return self._replies[min(len(self.ingest_requests) - 1, len(self._replies) - 1)]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer the capability GET or the scripted PUT."""
        self.requests.append(request)
        if request.method == "GET":
            return httpx.Response(HTTPStatus.OK, json=_handshake_payload(self._capabilities))
        if self._ingest_error is not None:
            raise self._ingest_error
        return self._next_reply().to_response()


class _SlowIngestHandler:
    """Handler that handshakes healthily and then trickles forever on the journal PUT."""

    def __init__(self) -> None:
        """Start an empty request log."""
        self.requests: list[httpx.Request] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer the capability GET at once; never finish the PUT within any deadline."""
        self.requests.append(request)
        if request.method == "GET":
            return httpx.Response(
                HTTPStatus.OK, json=_handshake_payload([CreekCapability.JOURNAL.value])
            )
        await asyncio.sleep(_SLOW_HANDLER_SLEEP_SECONDS)
        return httpx.Response(HTTPStatus.OK, json=_ingest_payload())


def _wheel_example(state: str) -> dict[str, object]:
    """Return one vendored wheel example body, decoded fresh on every call.

    Fresh because the callers below build malformed variants by editing what
    they get back: the vendored file is read-only ground truth, and a shared
    decoded object would let one test's mutation reach another's.
    """
    decoded = json.loads((BUNDLE_ROOT / f"examples/wheel/{state}.json").read_bytes())
    assert isinstance(decoded, dict), state
    return decoded


def _wheel_frequencies(payload: Mapping[str, object]) -> dict[str, Mapping[str, object]]:
    """Return the ten published Frequency entries of a wheel body."""
    frequencies = payload["wheel"]
    assert isinstance(frequencies, dict)
    return {code: entry for code, entry in frequencies.items() if isinstance(entry, Mapping)}


def _wheel_required_keys() -> tuple[str, ...]:
    """Return the top-level fields Creek's wheel schema declares required."""
    schema = json.loads((BUNDLE_ROOT / "schemas/WheelResponse.schema.json").read_bytes())
    assert isinstance(schema, dict)
    required = schema["required"]
    assert isinstance(required, list)
    return tuple(str(key) for key in required)


def _wheel_with_ceiling(ceiling: object) -> dict[str, object]:
    """Return the success example with only its echoed tier ceiling replaced.

    ``ceiling`` is deliberately typed ``object``: a hostile vault can echo a
    number or a null where a tier string belongs, and an echo that is not even a
    string is as inadmissible as one that names a wider tier.
    """
    body = _wheel_example("success")
    body["tier_ceiling"] = ceiling
    return body


def _wheel_without_key(key: str) -> dict[str, object]:
    """Return the success example with one published required field removed."""
    body = _wheel_example("success")
    del body[key]
    return body


def _wheel_without_frequency(code: str) -> dict[str, object]:
    """Return the success example with one Frequency deleted from a copy of its wheel."""
    body = _wheel_example("success")
    frequencies = _wheel_frequencies(body)
    del frequencies[code]
    body["wheel"] = frequencies
    return body


def _wheel_with_share(code: str, share: object) -> dict[str, object]:
    """Return the success example with one Frequency's share replaced."""
    body = _wheel_example("success")
    frequencies = {name: dict(entry) for name, entry in _wheel_frequencies(body).items()}
    frequencies[code]["share"] = share
    body["wheel"] = frequencies
    return body


class _WheelRouteHandler:
    """Route-aware handler: a healthy capability GET plus one scripted wheel GET.

    Kept apart from :class:`_VaultRouteHandler` because the wheel is a different
    route with a different failure vocabulary; sharing one handler would have
    meant a method-and-path branch tree neither exchange needs.
    """

    def __init__(
        self,
        payload: object = None,
        status: int = HTTPStatus.OK,
        *,
        text: str | None = None,
        capabilities: Sequence[str] = (CreekCapability.WHEEL.value,),
        wheel_error: Exception | None = None,
    ) -> None:
        """Store the advertised capabilities and the one scripted wheel answer."""
        self._payload = payload
        self._status = status
        self._text = text
        self._capabilities = list(capabilities)
        self._wheel_error = wheel_error
        self.requests: list[httpx.Request] = []

    @property
    def wheel_requests(self) -> list[httpx.Request]:
        """Return only the wheel reads this handler has served."""
        return [request for request in self.requests if request.url.path == _WHEEL_PATH]

    def _wheel_response(self) -> httpx.Response:
        """Answer the scripted wheel body, raising the scripted transport failure instead."""
        if self._wheel_error is not None:
            raise self._wheel_error
        if self._text is not None:
            return httpx.Response(self._status, text=self._text)
        return httpx.Response(self._status, json=self._payload)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer the capability GET or the scripted wheel GET."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=_handshake_payload(self._capabilities))
        return self._wheel_response()


def _bundle_schema(name: str) -> dict[str, object]:
    """Return one vendored contract schema decoded as an object."""
    decoded = json.loads((BUNDLE_ROOT / f"schemas/{name}.schema.json").read_bytes())
    assert isinstance(decoded, dict), name
    return decoded


def _schema_properties(name: str) -> dict[str, object]:
    """Return the ``properties`` map one vendored schema publishes."""
    properties = _bundle_schema(name)["properties"]
    assert isinstance(properties, dict), name
    return properties


def _schema_required(name: str) -> tuple[str, ...]:
    """Return the top-level fields one vendored schema declares required."""
    required = _bundle_schema(name)["required"]
    assert isinstance(required, list), name
    return tuple(str(key) for key in required)


def _max_notes_bounds() -> tuple[int, int]:
    """Return the inclusive ``max_notes`` bounds Creek's request schema publishes."""
    field = _schema_properties("ReflectionRequest")["max_notes"]
    assert isinstance(field, dict)
    minimum = field["minimum"]
    maximum = field["maximum"]
    assert isinstance(minimum, int)
    assert isinstance(maximum, int)
    return minimum, maximum


def _reflection_example(state: str) -> dict[str, object]:
    """Return one vendored reflection example body, decoded fresh on every call.

    Fresh for the same reason the wheel examples are: the callers below build
    malformed variants by editing what they get back, and a shared decoded object
    would let one test's mutation reach another's.
    """
    decoded = json.loads((BUNDLE_ROOT / f"examples/reflections/{state}.json").read_bytes())
    assert isinstance(decoded, dict), state
    return decoded


def _published_note(state: str = "success") -> Mapping[str, object]:
    """Return the single margin note one vendored reflection example publishes."""
    notes = _reflection_example(state)["notes"]
    assert isinstance(notes, list)
    note = notes[0]
    assert isinstance(note, Mapping)
    return note


def _reflection_at_ceiling(ceiling: str) -> dict[str, object]:
    """Return the success example with both of its tier echoes set to ``ceiling``.

    Both, because the two are separate claims: ``tier_ceiling`` is what the vault
    says it was asked for and ``routed_tier`` is what it says it actually keyed
    the call with, and either exceeding what adepthood accepted means the answer
    was computed over material this app never authorized.
    """
    body = _reflection_example("success")
    body["tier_ceiling"] = ceiling
    body["routed_tier"] = ceiling
    return body


def _reflection_with(field: str, value: object) -> dict[str, object]:
    """Return the success example, pinned to open, with one field replaced."""
    body = _reflection_at_ceiling(VaultTierCeiling.OPEN.value)
    body[field] = value
    return body


def _reflection_without(field: str) -> dict[str, object]:
    """Return the success example with one published required field removed."""
    body = _reflection_example("success")
    del body[field]
    return body


def _error_envelope(code: str) -> dict[str, object]:
    """Build a synthetic error envelope for a published code with no example cell.

    Validated against the vendored envelope schema rather than merely shaped like
    it: the code must be a member of Creek's published enum, and the body must
    carry exactly the three fields the schema declares required -- the envelope is
    ``additionalProperties: false`` and echoes nothing, so a fourth field would be
    a document Creek does not publish.
    """
    defs = _bundle_schema("ErrorEnvelope")["$defs"]
    assert isinstance(defs, dict)
    error_code = defs["ErrorCode"]
    assert isinstance(error_code, dict)
    codes = error_code["enum"]
    assert isinstance(codes, list)
    assert code in codes, code
    envelope: dict[str, object] = {
        "code": code,
        "message": "a constant message from the published table",
        "request_id": _SYNTHETIC_REQUEST_ID,
    }
    assert set(envelope) == set(_schema_required("ErrorEnvelope"))
    return envelope


class _ReflectRouteHandler:
    """Route-aware handler: a healthy capability GET plus one scripted reflection POST.

    Its own handler rather than a branch added to the wheel's, for the reason the
    wheel got one: a reflection is a different route with a different request
    shape and a third failure vocabulary (an escalation is a 200), and folding
    three exchanges into one handler would mean a method-and-path branch tree none
    of them needs.
    """

    def __init__(
        self,
        payload: object = None,
        status: int = HTTPStatus.OK,
        *,
        text: str | None = None,
        capabilities: Sequence[str] = (CreekCapability.REFLECT.value,),
        reflect_error: Exception | None = None,
    ) -> None:
        """Store the advertised capabilities and the one scripted reflection answer."""
        self._payload = payload
        self._status = status
        self._text = text
        self._capabilities = list(capabilities)
        self._reflect_error = reflect_error
        self.requests: list[httpx.Request] = []

    @property
    def reflect_requests(self) -> list[httpx.Request]:
        """Return only the reflection posts this handler has served."""
        return [request for request in self.requests if request.url.path == _REFLECTIONS_PATH]

    def _reflect_response(self) -> httpx.Response:
        """Answer the scripted reflection body, raising the scripted failure instead."""
        if self._reflect_error is not None:
            raise self._reflect_error
        if self._text is not None:
            return httpx.Response(self._status, text=self._text)
        return httpx.Response(self._status, json=self._payload)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer the capability GET or the scripted POST."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=_handshake_payload(self._capabilities))
        return self._reflect_response()


def _sent_reflect_body(handler: _ReflectRouteHandler) -> dict[str, object]:
    """Return the decoded JSON body of the single reflection post the handler served."""
    assert len(handler.reflect_requests) == 1
    decoded = json.loads(handler.reflect_requests[0].content)
    assert isinstance(decoded, dict)
    return decoded


async def _handshaken_client(
    handler: Handler | AsyncHandler,
    http_clients: ClientFactory,
    api_key: str = _API_KEY,
) -> HttpCreekVaultClient:
    """Build a client over ``handler`` and complete its handshake before returning it."""
    client = HttpCreekVaultClient(_VAULT_URL, api_key, http_client=http_clients(handler))
    await client.handshake()
    return client


def _sent_ingest_body(handler: _VaultRouteHandler) -> dict[str, object]:
    """Return the decoded JSON body of the single journal PUT the handler served."""
    assert len(handler.ingest_requests) == 1
    decoded = json.loads(handler.ingest_requests[0].content)
    assert isinstance(decoded, dict)
    return decoded


class _CountingClientBuild:
    """Client factory that records every httpx client it builds."""

    def __init__(self, handler: Handler) -> None:
        """Store the handler each built client answers from."""
        self._handler = handler
        self.built: list[httpx.AsyncClient] = []

    def __call__(self) -> httpx.AsyncClient:
        """Build one MockTransport-backed client and record it."""
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(self._handler), timeout=_VAULT_HTTP_TIMEOUT
        )
        self.built.append(client)
        return client


@asynccontextmanager
async def _isolated_factory_patch() -> AsyncGenerator[None, None]:
    """Point main's session factory at the conftest SQLite engine for lifespan runs."""
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with patch("main.async_session_factory", new=factory):
        yield


@pytest_asyncio.fixture(autouse=True)
async def _closed_vault_pool() -> AsyncGenerator[None, None]:
    """Close the module-level vault HTTP pool after every test so none is GC'd open."""
    yield
    await close_creek_vault_http_pool()


@pytest.fixture(autouse=True)
def _reset_vault_telemetry() -> Iterator[None]:
    """Empty the process-wide outcome counters around every test in this module.

    The counters are process-wide by design, so without this a test that asserts
    a count would observe whatever its neighbours happened to record first.
    """
    reset_vault_telemetry_for_tests()
    yield
    reset_vault_telemetry_for_tests()


@pytest_asyncio.fixture
async def http_clients() -> AsyncGenerator[ClientFactory, None]:
    """Yield a factory for MockTransport-backed clients, closing each afterwards."""
    created: list[httpx.AsyncClient] = []

    def _build(handler: Handler | AsyncHandler) -> httpx.AsyncClient:
        """Build one in-memory client and register it for teardown."""
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), timeout=_VAULT_HTTP_TIMEOUT
        )
        created.append(client)
        return client

    yield _build
    for client in created:
        await client.aclose()


@pytest.mark.asyncio
async def test_http_client_satisfies_the_vault_client_protocol(
    http_clients: ClientFactory,
) -> None:
    """The HTTP adapter is assignable to the domain protocol and exposes every member."""
    client: CreekVaultClient = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=http_clients(_healthy_handler([CreekCapability.JOURNAL.value])),
    )
    for name in _PROTOCOL_MEMBERS:
        assert callable(getattr(client, name)), name


@pytest.mark.asyncio
async def test_fresh_http_client_reports_unavailable_before_any_handshake(
    http_clients: ClientFactory,
) -> None:
    """A client that has not handshaken yet fails safe: unavailable, nothing supported."""
    client = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=http_clients(_healthy_handler([CreekCapability.JOURNAL.value])),
    )
    assert client.is_available() is False
    assert client.supports(CreekCapability.JOURNAL) is False


@pytest.mark.asyncio
async def test_handshake_gets_v1_capabilities_with_bearer_auth(
    http_clients: ClientFactory,
) -> None:
    """The handshake is a single GET of /v1/capabilities carrying the bearer key."""
    handler = _RecordingHandler(_handshake_payload([CreekCapability.JOURNAL.value]))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    await client.handshake()
    assert len(handler.requests) == 1
    request = handler.requests[0]
    assert request.method == "GET"
    assert str(request.url) == _CAPABILITIES_URL
    assert request.headers["Authorization"] == f"Bearer {_API_KEY}"
    # The shared request helper passes ``json=None`` here so one code path can
    # serve both the GET and the journal PUT; httpx encodes that as no body at
    # all, and this pins it -- a GET carrying a body is ambiguous to every proxy
    # between here and the vault.
    assert request.content == b""
    assert "content-type" not in request.headers


@pytest.mark.asyncio
async def test_healthy_handshake_narrows_capabilities_and_drops_unknown_ones(
    http_clients: ClientFactory,
) -> None:
    """A healthy payload populates the result and silently drops unknown capability strings."""
    handler = _healthy_handler(
        [CreekCapability.JOURNAL.value, CreekCapability.REFLECT.value, "creek.telepathy"]
    )
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    result = await client.handshake()
    assert result.available is True
    assert result.capabilities == frozenset({CreekCapability.JOURNAL, CreekCapability.REFLECT})
    assert result.contract_version == CONTRACT_VERSION
    assert client.is_available() is True
    assert client.supports(CreekCapability.JOURNAL) is True
    assert client.supports(CreekCapability.REFLECT) is True
    assert client.supports(CreekCapability.CLASSIFY) is False
    assert client.last_degrade_reason is None


@pytest.mark.asyncio
async def test_factory_builds_one_http_client_for_every_vault_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two vault clients share one pooled httpx client across both of their handshakes."""
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "http")
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _API_KEY)
    handler = _RecordingHandler(_handshake_payload([CreekCapability.JOURNAL.value]))
    build = _CountingClientBuild(handler)
    pool = _VaultHttpPool(build=build)
    monkeypatch.setattr(_POOL_ATTR, pool)

    first = build_creek_vault_client()
    second = build_creek_vault_client()
    assert first is not second
    assert (await first.handshake()).available is True
    assert (await second.handshake()).available is True

    assert len(build.built) == 1
    assert pool.get() is build.built[0]
    assert len(handler.requests) == 2
    await pool.aclose()


@pytest.mark.asyncio
async def test_pool_builds_lazily_exactly_once() -> None:
    """The pool builds on first get and returns that same client on every later get."""
    build = _CountingClientBuild(_healthy_handler([CreekCapability.JOURNAL.value]))
    pool = _VaultHttpPool(build=build)
    assert len(build.built) == 0
    client = pool.get()
    assert pool.get() is client
    assert len(build.built) == 1
    await pool.aclose()


@pytest.mark.asyncio
async def test_close_pool_closes_the_client_and_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Shutdown closes the pooled client, and closing again is a silent no-op."""
    build = _CountingClientBuild(_healthy_handler([CreekCapability.JOURNAL.value]))
    pool = _VaultHttpPool(build=build)
    monkeypatch.setattr(_POOL_ATTR, pool)
    client = pool.get()

    await close_creek_vault_http_pool()
    assert client.is_closed is True

    await close_creek_vault_http_pool()
    assert len(build.built) == 1


@pytest.mark.asyncio
async def test_lifespan_closes_the_vault_http_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """App shutdown awaits the pool-close hook so no httpx client outlives the process."""
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    spy = AsyncMock()
    with patch("main.close_creek_vault_http_pool", new=spy):
        async with _isolated_factory_patch(), lifespan(app):
            pass
    spy.assert_awaited_once()


def test_vault_http_timeout_pins_every_phase_to_the_budget() -> None:
    """Connect, read, write, and pool timeouts are each set to the vault budget."""
    phases = (
        _VAULT_HTTP_TIMEOUT.connect,
        _VAULT_HTTP_TIMEOUT.read,
        _VAULT_HTTP_TIMEOUT.write,
        _VAULT_HTTP_TIMEOUT.pool,
    )
    for phase in phases:
        assert phase is not None
        assert phase == _VAULT_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_pooled_client_carries_the_explicit_timeout() -> None:
    """The pool's own client is built with the module's fully specified timeout."""
    pool = _VaultHttpPool()
    client = pool.get()
    assert client.timeout == _VAULT_HTTP_TIMEOUT
    await pool.aclose()


@pytest.mark.asyncio
async def test_pooled_client_refuses_to_follow_redirects() -> None:
    """The pooled client pins redirect-following off rather than inheriting the default."""
    client = _build_pooled_vault_client()
    try:
        assert client.follow_redirects is False
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_a_redirecting_vault_degrades_instead_of_forwarding_the_bearer(
    http_clients: ClientFactory,
) -> None:
    """A 302 degrades to unreachable: the bearer is never re-sent to the Location host."""
    handler = _redirect_handler("https://attacker.example.test/v1/capabilities")
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.UNREACHABLE


def test_the_total_deadline_exceeds_a_single_phase_budget() -> None:
    """The whole-request deadline leaves room for a slow connect *and* a slow read."""
    assert _VAULT_TOTAL_DEADLINE_SECONDS > _VAULT_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_a_trickling_vault_is_bounded_by_the_whole_request_deadline(
    monkeypatch: pytest.MonkeyPatch,
    http_clients: ClientFactory,
) -> None:
    """A call that outlives the deadline degrades as timed out rather than hanging.

    A deadline expiry is its own degrade reason: an operator reading
    ``unreachable`` goes looking for a network that is, in fact, up and merely
    slow, which is a different problem with a different remedy.
    """
    monkeypatch.setattr(_DEADLINE_ATTR, _TINY_DEADLINE_SECONDS)
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(_slow_handler))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.TIMED_OUT


@pytest.mark.asyncio
async def test_hung_vault_degrades_within_the_timeout_budget(
    http_clients: ClientFactory,
) -> None:
    """A read timeout degrades to unavailable and is reported as timed out, never raised."""
    handler = _raising_handler(httpx.ReadTimeout("vault never answered"))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.TIMED_OUT


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(_raising_handler(httpx.ConnectError("refused")), id="connection_refused"),
        pytest.param(_json_handler({"detail": "boom"}, 500), id="server_error"),
        pytest.param(_json_handler({"detail": "unauthorized"}, 401), id="unauthorized"),
        pytest.param(_text_handler("<html><body>Bad Gateway</body></html>"), id="non_json_body"),
        pytest.param(_json_handler([1, 2, 3]), id="json_is_not_an_object"),
        pytest.param(_json_handler(_payload_without_contract_version()), id="missing_version"),
        pytest.param(
            _json_handler(_handshake_payload([CreekCapability.JOURNAL.value], "0.3.0")),
            id="incompatible_version",
        ),
    ],
)
@pytest.mark.asyncio
async def test_handshake_degrades_to_unavailable_without_raising(
    handler: Handler,
    http_clients: ClientFactory,
) -> None:
    """Every unhealthy vault response collapses to the one canonical unavailable result."""
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()
    assert client.is_available() is False
    assert client.supports(CreekCapability.JOURNAL) is False


@pytest.mark.parametrize(
    ("handler", "expected"),
    [
        pytest.param(
            _json_handler(_handshake_payload([CreekCapability.JOURNAL.value], "0.3.0")),
            HandshakeDegradeReason.INCOMPATIBLE_VERSION,
            id="incompatible_version",
        ),
        pytest.param(
            _raising_handler(httpx.ConnectError("refused")),
            HandshakeDegradeReason.UNREACHABLE,
            id="unreachable",
        ),
        pytest.param(
            _text_handler("<html><body>Bad Gateway</body></html>"),
            HandshakeDegradeReason.MALFORMED_PAYLOAD,
            id="malformed_payload",
        ),
        pytest.param(
            _json_handler(_handshake_payload([CreekCapability.JOURNAL.value], available=False)),
            HandshakeDegradeReason.VAULT_REPORTED_UNAVAILABLE,
            id="vault_reported_unavailable",
        ),
    ],
)
@pytest.mark.asyncio
async def test_degrade_reason_distinguishes_the_failure_modes(
    handler: Handler,
    expected: HandshakeDegradeReason,
    http_clients: ClientFactory,
) -> None:
    """Each degrade path records its own reason so version skew is visible separately."""
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    await client.handshake()
    assert client.last_degrade_reason is expected


@pytest.mark.asyncio
async def test_incompatible_and_unreachable_return_the_same_degraded_result(
    http_clients: ClientFactory,
) -> None:
    """Callers see one degraded state; only the internal degrade reason differs."""
    skewed = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=http_clients(
            _json_handler(_handshake_payload([CreekCapability.JOURNAL.value], "0.3.0"))
        ),
    )
    offline = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=http_clients(_raising_handler(httpx.ConnectError("refused"))),
    )
    skewed_result = await skewed.handshake()
    offline_result = await offline.handshake()
    assert skewed_result == offline_result == HandshakeResult.unavailable()
    assert skewed.last_degrade_reason is HandshakeDegradeReason.INCOMPATIBLE_VERSION
    assert offline.last_degrade_reason is HandshakeDegradeReason.UNREACHABLE


def test_degrade_reason_wire_values_are_stable() -> None:
    """The degrade reasons carry the exact strings telemetry will count."""
    assert [reason.value for reason in HandshakeDegradeReason] == [
        "unreachable",
        "malformed_payload",
        "incompatible_version",
        "vault_reported_unavailable",
        "timed_out",
    ]


@pytest.mark.parametrize(
    ("advertised", "pinned", "compatible"),
    [
        pytest.param("0.3.0", "0.2.0", False, id="pre_1_0_minor_bump_rejected"),
        pytest.param("0.2.7", "0.2.1", True, id="pre_1_0_patch_bump_accepted"),
        pytest.param("1.5.0", "1.2.0", True, id="post_1_0_forward_minor_accepted"),
        pytest.param("2.0.0", "1.2.0", False, id="post_1_0_major_bump_rejected"),
    ],
)
def test_contract_version_compatibility_rule(
    advertised: str, pinned: str, compatible: bool
) -> None:
    """Pre-1.0 requires an exact major.minor match; 1.0 and later relaxes to major-match."""
    assert _contract_version_compatible(advertised, pinned) is compatible


def test_contract_version_compatible_defaults_to_the_pinned_constant() -> None:
    """The pinned contract version is, trivially, compatible with itself."""
    assert _contract_version_compatible(CONTRACT_VERSION) is True


@pytest.mark.parametrize("url", ["", None], ids=["empty", "unset"])
@pytest.mark.parametrize("protocol", [None, "mcp", "http"], ids=["unset", "mcp", "http"])
def test_factory_returns_local_fallback_when_no_url_under_every_protocol(
    url: str | None, protocol: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No configured vault URL means the local fallback, whatever the protocol says."""
    if url is None:
        monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    else:
        monkeypatch.setenv("CREEK_VAULT_URL", url)
    if protocol is None:
        monkeypatch.delenv("CREEK_VAULT_PROTOCOL", raising=False)
    else:
        monkeypatch.setenv("CREEK_VAULT_PROTOCOL", protocol)
    assert isinstance(build_creek_vault_client(), LocalFallbackCreekVaultClient)


@pytest.mark.parametrize("protocol", [None, "http", "HTTP "], ids=["unset", "http", "padded_upper"])
def test_factory_defaults_to_the_http_protocol(
    protocol: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unset, lowercase, or whitespace-padded http selector yields the HTTP adapter.

    The default is HTTP because HTTP is the only application transport adepthood
    still speaks: a deployment that names no protocol gets the one surface Creek
    has ratified rather than having to opt into it.
    """
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _API_KEY)
    if protocol is None:
        monkeypatch.delenv("CREEK_VAULT_PROTOCOL", raising=False)
    else:
        monkeypatch.setenv("CREEK_VAULT_PROTOCOL", protocol)
    assert isinstance(build_creek_vault_client(), HttpCreekVaultClient)


def test_factory_degrades_the_retired_mcp_protocol_to_the_local_fallback(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A stale ``mcp`` selector skips the optional replication instead of failing.

    ``mcp`` is the one value this repository's own env template prescribed until
    the transport was retired, so it is the one stale selector whose intent is
    known -- and the client is built on the request path, where raising would
    mean the journal handler never runs and the writer's entry is lost. Skipping
    the optional half is the honest answer; the WARNING is how the operator finds
    out, so it names the remedy and carries neither the URL nor the credential.
    """
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _SENTINEL_KEY)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "mcp")
    caplog.set_level(logging.WARNING)

    client = build_creek_vault_client()

    assert isinstance(client, LocalFallbackCreekVaultClient)
    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.levelno == logging.WARNING
    message = record.getMessage()
    assert "CREEK_VAULT_PROTOCOL" in message
    assert "http" in message
    assert record.__dict__["protocol"] == "mcp"
    assert record.__dict__["supported_protocol"] == "http"
    for rendered in [message, *[str(value) for value in record.__dict__.values()]]:
        assert _VAULT_URL not in rendered
        assert _SENTINEL_KEY not in rendered


@pytest.mark.parametrize("protocol", [None, "http", "mcp"], ids=["unset", "http", "retired_mcp"])
@pytest.mark.asyncio
async def test_local_fallback_still_serves_every_feature_without_a_url(
    protocol: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unconfigured deployment keeps working locally, whatever the protocol says.

    The URL check runs before the protocol is validated, so even a stale ``mcp``
    selector cannot turn a deployment that never had a vault into a startup
    failure -- and the client it gets back honours the whole seam contract:
    unavailable, supporting nothing, a silent not-stored ingest, and a refusal on
    every read.
    """
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _API_KEY)
    if protocol is None:
        monkeypatch.delenv("CREEK_VAULT_PROTOCOL", raising=False)
    else:
        monkeypatch.setenv("CREEK_VAULT_PROTOCOL", protocol)

    client = build_creek_vault_client()
    assert isinstance(client, LocalFallbackCreekVaultClient)
    assert await client.handshake() == HandshakeResult.unavailable()
    assert client.is_available() is False
    for capability in CreekCapability:
        assert client.supports(capability) is False
    assert await client.ingest(_ingest_request()) == VaultIngestResult(stored=False, vault_ref=None)
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.classify(_ENTRY_BODY, VaultTierCeiling.OPEN)
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.reflect(_ENTRY_BODY, VaultTierCeiling.OPEN)
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.wheel()


def test_factory_returns_http_client_when_protocol_is_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The http selector swaps in the HTTP/JSON adapter."""
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _API_KEY)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "http")
    assert isinstance(build_creek_vault_client(), HttpCreekVaultClient)


@pytest.mark.parametrize(
    ("protocol", "reported"),
    [
        pytest.param("grpc", "grpc", id="a_transport_nobody_implemented"),
        pytest.param("htp", "htp", id="a_typo_for_http"),
        pytest.param("HTTPS", "https", id="a_scheme_mistaken_for_a_selector"),
        pytest.param("  GrPc\t", "grpc", id="padded_and_mixed_case"),
    ],
)
def test_factory_degrades_an_unrecognized_protocol_to_the_local_fallback(
    protocol: str,
    reported: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unrecognized selector skips the optional replication rather than losing the entry.

    The factory runs inside a per-request dependency, so raising here means the
    journal handler's body never runs: a typo in one environment variable would
    turn every save into a 500 and the writer's entry would exist nowhere. The
    vault is optional and Postgres is the system of record, so the honest answer
    to a selector nobody can interpret is to skip the optional half and say so
    loudly. What it must never do is *guess* http -- that would send a
    deployment's vault traffic over a transport nobody chose.

    ``reported`` is spelled out per case rather than re-derived from ``protocol``
    with the same normalization the factory applies, so a bug in that
    normalization cannot satisfy both sides of the assertion at once.
    """
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _SENTINEL_KEY)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", protocol)
    caplog.set_level(logging.WARNING)

    client = build_creek_vault_client()

    assert isinstance(client, LocalFallbackCreekVaultClient)
    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.levelno == logging.WARNING
    message = record.getMessage()
    assert "CREEK_VAULT_PROTOCOL" in message
    assert "http" in message
    assert record.__dict__["protocol"] == reported
    assert record.__dict__["supported_protocol"] == "http"
    for rendered in [message, *[str(value) for value in record.__dict__.values()]]:
        assert _VAULT_URL not in rendered
        assert _SENTINEL_KEY not in rendered


def test_http_client_rejects_a_plaintext_remote_url() -> None:
    """Plaintext to a remote host fails closed at construction, before the key is bound.

    The refusal belongs to the constructor, which is where the credential would
    otherwise be bound to a URL nothing approved. Its *caller* is a different
    question: :func:`build_creek_vault_client` runs per request and degrades
    instead, since a raise there would cost the writer their entry -- the whole
    taxonomy of unusable URLs, and what each of them does to a journal save,
    lives in ``test_creek_vault_url_defects.py``.
    """
    with pytest.raises(ValueError, match="https") as exc_info:
        HttpCreekVaultClient("http://vault.example.test", _SENTINEL_KEY)
    message = str(exc_info.value)
    assert "http" in message
    assert "vault.example.test" in message
    assert _SENTINEL_KEY not in message


def test_http_factory_degrades_a_plaintext_remote_url_to_the_local_fallback(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The per-request factory skips the optional replication rather than losing the entry.

    Same reasoning as the retired and unrecognized protocol selectors above: this
    factory is reached from a dependency, so raising means the journal handler's
    body never runs. The credential still never reaches the suspect URL -- no
    HTTP adapter is built at all -- and the WARNING is how the operator finds
    out.
    """
    monkeypatch.setenv("CREEK_VAULT_URL", "http://vault.example.test")
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _SENTINEL_KEY)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "http")
    caplog.set_level(logging.WARNING)

    client = build_creek_vault_client()

    assert isinstance(client, LocalFallbackCreekVaultClient)
    assert len(caplog.records) == 1
    assert "CREEK_VAULT_URL" in caplog.records[0].getMessage()
    for rendered in [
        caplog.records[0].getMessage(),
        *[str(value) for value in caplog.records[0].__dict__.values()],
    ]:
        assert _SENTINEL_KEY not in rendered


def test_http_factory_accepts_a_plaintext_loopback_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """Plaintext to loopback stays allowed so a developer can run a vault locally."""
    monkeypatch.setenv("CREEK_VAULT_URL", "http://localhost:8000")
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _API_KEY)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "http")
    assert isinstance(build_creek_vault_client(), HttpCreekVaultClient)


@pytest.mark.parametrize(
    ("url", "part"),
    [
        pytest.param(_USERINFO_VAULT_URL, "userinfo", id="userinfo"),
        pytest.param("https://opuser@vault.example.test", "userinfo", id="userinfo_no_password"),
        pytest.param(f"{_VAULT_URL}/api?tenant=1", "query", id="query"),
        pytest.param(f"{_VAULT_URL}#frag", "fragment", id="fragment"),
        pytest.param(f"{_VAULT_URL}?", "query", id="empty_query"),
        pytest.param(f"{_VAULT_URL}/api?", "query", id="empty_query_after_path"),
        pytest.param(f"{_VAULT_URL}#", "fragment", id="empty_fragment"),
    ],
)
def test_http_client_rejects_a_url_carrying_userinfo_query_or_fragment(url: str, part: str) -> None:
    """Userinfo (a credential, and a silent Basic-auth downgrade), query, and fragment refuse.

    The empty-but-present cases are the ones a truthiness test misses: a URL
    ending in a bare ``?`` parses to an empty query string, which is falsy, yet
    the delimiter is still there in the string the capability path is appended
    to. Accepting it would build ``https://host?/v1/journal-entries/5`` and send
    every capability path as a query string against ``/`` -- aiming the bearer
    credential at an endpoint the operator never configured, which is precisely
    what this check exists to prevent.
    """
    with pytest.raises(ValueError, match=part) as exc_info:
        HttpCreekVaultClient(url, _SENTINEL_KEY)
    message = str(exc_info.value)
    assert _URL_PASSWORD not in message
    assert _SENTINEL_KEY not in message


def test_a_question_mark_inside_a_fragment_is_reported_as_the_fragment_alone() -> None:
    """One mistake is named once: a ``?`` after a ``#`` is fragment, not a second component.

    The refusal is never in doubt here -- either name rejects the URL. What is at
    stake is what the operator is told: reporting ``query`` as well would send
    them looking for a second problem they do not have, in a message that is
    deliberately the only thing they get (values never travel with it, since one
    of the components it can name is a credential).
    """
    with pytest.raises(ValueError, match="fragment") as exc_info:
        HttpCreekVaultClient(f"{_VAULT_URL}/api#anchor?tenant=1", _SENTINEL_KEY)
    assert "query" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_a_url_with_a_path_prefix_keeps_it_in_the_capability_url(
    http_clients: ClientFactory,
) -> None:
    """A path prefix stays legal and the capability path is appended to it."""
    handler = _RecordingHandler(_handshake_payload([CreekCapability.JOURNAL.value]))
    client = HttpCreekVaultClient(_PATH_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    assert (await client.handshake()).available is True
    assert str(handler.requests[0].url) == f"{_VAULT_URL}/vault/v1/capabilities"


@pytest.mark.asyncio
async def test_classify_is_still_refused_when_advertised(
    http_clients: ClientFactory,
) -> None:
    """Classify refuses, and at contract 0.2.0 it cannot even be advertised.

    Two guarantees, and the second is stronger than it used to be. Creek
    publishes no wire name for classify, so an advertisement of it is dropped at
    the parse boundary and :meth:`supports` is ``False`` -- there is no document
    a conformant vault can send that turns it on. And independently of that, the
    call refuses rather than guessing a payload shape that has never shipped, so
    the caller degrades onto its local pipeline either way.
    """
    advertised = [
        CreekCapability.JOURNAL.value,
        CreekCapability.CLASSIFY.value,
        CreekCapability.REFLECT.value,
        CreekCapability.WHEEL.value,
    ]
    client = HttpCreekVaultClient(
        _VAULT_URL, _API_KEY, http_client=http_clients(_healthy_handler(advertised))
    )
    await client.handshake()
    # Unadvertisable by construction: Creek has no published name for it.
    assert client.supports(CreekCapability.CLASSIFY) is False
    with pytest.raises(CreekCapabilityUnsupportedError) as exc_info:
        await client.classify(_ENTRY_BODY, VaultTierCeiling.OPEN)
    assert CreekCapability.CLASSIFY.value in str(exc_info.value)


@pytest.mark.asyncio
async def test_write_path_degrades_instead_of_losing_an_entry(
    http_clients: ClientFactory,
) -> None:
    """A vault that answers the PUT with a fault degrades the write instead of dropping it.

    The vault handshakes healthily and then rejects the ingest itself, so the
    degrade comes from a real failed write rather than from an unwired
    capability.
    """
    handler = _VaultRouteHandler(
        [_IngestReply(status=HTTPStatus.INTERNAL_SERVER_ERROR, payload={"detail": "boom"})]
    )
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_ENTRY_BODY,
        classification="public",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.DEGRADED
    assert outcome.vault_ref is None
    assert outcome.tags == ()
    assert len(handler.ingest_requests) == 1


@pytest.mark.asyncio
async def test_api_key_never_leaks_into_logs_repr_or_errors(
    caplog: pytest.LogCaptureFixture,
    http_clients: ClientFactory,
) -> None:
    """No log record, repr, or exception text ever carries the bearer credential."""
    caplog.set_level(logging.DEBUG)
    healthy = HttpCreekVaultClient(
        _VAULT_URL,
        _SENTINEL_KEY,
        http_client=http_clients(
            _VaultRouteHandler(
                [
                    _IngestReply(
                        status=HTTPStatus.BAD_REQUEST,
                        payload=_error_payload(VaultErrorCode.INVALID_REQUEST.value),
                    )
                ]
            )
        ),
    )
    hung = HttpCreekVaultClient(
        _VAULT_URL,
        _SENTINEL_KEY,
        http_client=http_clients(_raising_handler(httpx.ReadTimeout("vault never answered"))),
    )
    failing = HttpCreekVaultClient(
        _VAULT_URL,
        _SENTINEL_KEY,
        http_client=http_clients(_json_handler({"detail": "boom"}, 500)),
    )
    for client in (healthy, hung, failing):
        await client.handshake()
    with pytest.raises(CreekVaultContractError) as exc_info:
        await healthy.ingest(_ingest_request())

    assert _SENTINEL_KEY not in caplog.text
    for record in caplog.records:
        assert _SENTINEL_KEY not in record.getMessage()
    for client in (healthy, hung, failing):
        assert _SENTINEL_KEY not in repr(client)
        assert _SENTINEL_KEY not in str(client)
        assert repr(client) == object.__repr__(client)
    assert _SENTINEL_KEY not in str(exc_info.value)
    assert exc_info.value.__cause__ is None
    assert exc_info.value.__suppress_context__ is True


@pytest.mark.asyncio
async def test_ingest_puts_v1_journal_entries_with_bearer_and_exact_body(
    http_clients: ClientFactory,
) -> None:
    """One ingest is one PUT of the entry's own URL, carrying exactly three body fields."""
    handler = _VaultRouteHandler()
    client = await _handshaken_client(handler, http_clients)
    await client.ingest(_ingest_request())

    put = handler.ingest_requests[0]
    assert put.method == "PUT"
    assert str(put.url) == _JOURNAL_ENTRY_URL
    assert put.headers["Authorization"] == f"Bearer {_API_KEY}"
    body = _sent_ingest_body(handler)
    assert set(body) == {"content", "timestamp", "tier"}
    assert body["content"] == _ENTRY_BODY
    assert body["timestamp"] == _CREATED_AT.isoformat()
    assert body["tier"] == VaultTierCeiling.OPEN.value


@pytest.mark.parametrize(
    "entry_id",
    [
        pytest.param("..", id="parent_directory"),
        pytest.param("../../v1", id="two_levels_up"),
        pytest.param(".", id="current_directory"),
        pytest.param("7/../../admin", id="embedded_traversal"),
    ],
)
def test_entry_path_segment_cannot_climb_out_of_the_journal_collection(entry_id: str) -> None:
    """A dot-segment id stays inside the collection instead of redirecting the body.

    ``entry_id`` is typed ``int``, so this is a guard on the *shape* of the URL
    builder rather than a reachable input today -- but the entry body rides on
    this request, so the segment must be inert whatever the identifier type
    becomes. The cast is the point of the test: it is the future change,
    written down.
    """
    segment = _entry_path_segment(cast("int", entry_id))
    url = httpx.URL(f"{_VAULT_URL}/v1/journal-entries/{segment}")
    assert str(url).startswith(f"{_VAULT_URL}/v1/journal-entries/")


@pytest.mark.parametrize(
    "tier",
    [VaultTierCeiling.OPEN, VaultTierCeiling.PERSONAL],
    ids=["open", "personal"],
)
@pytest.mark.asyncio
async def test_ingest_sends_the_entrys_own_tier_never_a_lower_ceiling(
    tier: VaultTierCeiling,
    http_clients: ClientFactory,
) -> None:
    """The stored tier is the writer's own, so the vault never files an entry too widely."""
    handler = _VaultRouteHandler()
    client = await _handshaken_client(handler, http_clients)
    await client.ingest(_ingest_request(tier))
    assert _sent_ingest_body(handler)["tier"] == tier.value


@pytest.mark.parametrize(
    "action",
    list(VaultIngestAction),
    ids=[action.value for action in VaultIngestAction],
)
@pytest.mark.asyncio
async def test_ingest_success_projects_action_and_fragment_id(
    action: VaultIngestAction,
    http_clients: ClientFactory,
) -> None:
    """Every known action is a durable write whose ref is the vault's own fragment id."""
    handler = _VaultRouteHandler([_IngestReply(payload=_ingest_payload(action=action.value))])
    client = await _handshaken_client(handler, http_clients)
    result = await client.ingest(_ingest_request())
    assert result.stored is True
    assert result.vault_ref == _FRAGMENT_ID
    assert result.action is action


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param(_IngestReply(payload=_ingest_payload("")), id="blank_fragment_id"),
        pytest.param(
            _IngestReply(payload={"action": VaultIngestAction.CREATED.value}),
            id="missing_fragment_id",
        ),
        pytest.param(_IngestReply(payload=_ingest_payload(_ENTRY_ID)), id="non_string_fragment_id"),
        pytest.param(
            _IngestReply(payload=_ingest_payload(action="teleported")), id="unknown_action"
        ),
        pytest.param(_IngestReply(payload=[_FRAGMENT_ID]), id="json_is_not_an_object"),
        pytest.param(
            _IngestReply(payload=_ingest_payload(_OVERSIZED_FRAGMENT_ID)),
            id="oversized_fragment_id",
        ),
        pytest.param(
            _IngestReply(payload=_ingest_payload(_HOSTILE_FRAGMENT_ID)),
            id="unprintable_fragment_id",
        ),
    ],
)
@pytest.mark.asyncio
async def test_ingest_without_a_usable_fragment_id_parses_to_not_stored(
    reply: _IngestReply,
    http_clients: ClientFactory,
) -> None:
    """A 2xx adepthood cannot read is not-stored: a ref is never fabricated."""
    client = await _handshaken_client(_VaultRouteHandler([reply]), http_clients)
    result = await client.ingest(_ingest_request())
    assert result.stored is False
    assert result.vault_ref is None
    assert result.action is None


@pytest.mark.asyncio
async def test_ingest_accepts_a_fragment_id_at_the_length_bound(
    http_clients: ClientFactory,
) -> None:
    """The bound refuses only what exceeds it, so a legitimate long handle still stores."""
    handler = _VaultRouteHandler(
        [_IngestReply(payload=_ingest_payload(_LONGEST_USABLE_FRAGMENT_ID))]
    )
    client = await _handshaken_client(handler, http_clients)
    result = await client.ingest(_ingest_request())
    assert result.stored is True
    assert result.vault_ref == _LONGEST_USABLE_FRAGMENT_ID


@pytest.mark.asyncio
async def test_write_path_degrades_on_an_unstorable_fragment_id(
    http_clients: ClientFactory,
) -> None:
    """A hostile ref never becomes an entry's vault_ref -- the write degrades instead."""
    handler = _VaultRouteHandler([_IngestReply(payload=_ingest_payload(_HOSTILE_FRAGMENT_ID))])
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_ENTRY_BODY,
        classification="public",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.DEGRADED
    assert outcome.vault_ref is None


@pytest.mark.asyncio
async def test_resending_the_same_entry_id_reports_unchanged_with_the_same_fragment(
    http_clients: ClientFactory,
) -> None:
    """Re-sending an entry edits its one fragment in place rather than creating a second."""
    handler = _VaultRouteHandler(
        [
            _CREATED_REPLY,
            _IngestReply(payload=_ingest_payload(action=VaultIngestAction.UNCHANGED.value)),
        ]
    )
    client = await _handshaken_client(handler, http_clients)
    first = await client.ingest(_ingest_request())
    second = await client.ingest(_ingest_request())

    assert [str(request.url) for request in handler.ingest_requests] == [
        _JOURNAL_ENTRY_URL,
        _JOURNAL_ENTRY_URL,
    ]
    assert first.action is VaultIngestAction.CREATED
    assert second.action is VaultIngestAction.UNCHANGED
    assert second.vault_ref == first.vault_ref == _FRAGMENT_ID


@pytest.mark.asyncio
async def test_ingest_400_invalid_request_raises_a_contract_error(
    http_clients: ClientFactory,
) -> None:
    """A rejected payload is our bug, not the vault's absence, and carries its own code."""
    handler = _VaultRouteHandler(
        [
            _IngestReply(
                status=HTTPStatus.BAD_REQUEST,
                payload=_error_payload(VaultErrorCode.INVALID_REQUEST.value),
            )
        ]
    )
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultContractError) as exc_info:
        await client.ingest(_ingest_request())
    assert exc_info.value.code is VaultErrorCode.INVALID_REQUEST


@pytest.mark.asyncio
async def test_ingest_not_found_code_stays_a_contract_fault(
    http_clients: ClientFactory,
) -> None:
    """A routing code is adepthood's own bug, and learning to read it must not move it.

    Creek publishes ``not_found`` for a path this server does not serve, which is
    exactly the fault an uncoded 404 already reports. Teaching the error
    vocabulary that code must therefore leave the ingest answer where it was: a
    recognized code that fell into no contract set would silently reclassify a
    wrong URL as an absent vault.
    """
    handler = _VaultRouteHandler(
        [
            _IngestReply(
                status=HTTPStatus.NOT_FOUND,
                payload=_error_payload(VaultErrorCode.NOT_FOUND.value),
            )
        ]
    )
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultContractError) as exc_info:
        await client.ingest(_ingest_request())
    assert exc_info.value.code is VaultErrorCode.NOT_FOUND


@pytest.mark.parametrize(
    "status",
    [HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN],
    ids=["unauthorized", "forbidden"],
)
@pytest.mark.asyncio
async def test_ingest_401_raises_an_auth_error(
    status: HTTPStatus,
    http_clients: ClientFactory,
) -> None:
    """A rejected credential is a configuration fault, never reported as a missing vault."""
    handler = _VaultRouteHandler([_IngestReply(status=status, payload={"detail": "denied"})])
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultAuthError) as exc_info:
        await client.ingest(_ingest_request())
    assert not isinstance(exc_info.value, CreekVaultUnavailableError)
    assert isinstance(exc_info.value, CreekVaultError)


@pytest.mark.asyncio
async def test_ingest_temporarily_unavailable_code_raises_unavailable(
    http_clients: ClientFactory,
) -> None:
    """A vault naming itself temporarily unavailable is an availability fault, not a contract."""
    handler = _VaultRouteHandler(
        [
            _IngestReply(
                status=HTTPStatus.SERVICE_UNAVAILABLE,
                payload=_error_payload(VaultErrorCode.TEMPORARILY_UNAVAILABLE.value),
            )
        ]
    )
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultUnavailableError):
        await client.ingest(_ingest_request())


@pytest.mark.asyncio
async def test_ingest_connect_failure_raises_unavailable(
    http_clients: ClientFactory,
) -> None:
    """A vault that handshook and then went unreachable degrades rather than crashing."""
    handler = _VaultRouteHandler(ingest_error=httpx.ConnectError("refused"))
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultUnavailableError):
        await client.ingest(_ingest_request())


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        pytest.param(
            _IngestReply(status=HTTPStatus.BAD_REQUEST, payload={"detail": "nope"}),
            CreekVaultContractError,
            id="uncoded_400",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.NOT_FOUND, payload={"detail": "nope"}),
            CreekVaultContractError,
            id="uncoded_404",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.CONFLICT, payload={"detail": "nope"}),
            CreekVaultContractError,
            id="uncoded_409",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.BAD_REQUEST, text="<html>Bad Request</html>"),
            CreekVaultContractError,
            id="non_json_4xx",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.REQUEST_TIMEOUT, payload={"detail": "too slow"}),
            CreekVaultUnavailableError,
            id="uncoded_408_is_the_vaults_clock",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.TOO_MANY_REQUESTS, payload={"detail": "slow down"}),
            CreekVaultUnavailableError,
            id="uncoded_429_is_throttling",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.INTERNAL_SERVER_ERROR, payload={"detail": "boom"}),
            CreekVaultUnavailableError,
            id="uncoded_500",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.BAD_GATEWAY, payload={"detail": "boom"}),
            CreekVaultUnavailableError,
            id="uncoded_502",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.FOUND, payload={"detail": "elsewhere"}),
            CreekVaultUnavailableError,
            id="redirect_we_refuse_to_follow",
        ),
    ],
)
@pytest.mark.asyncio
async def test_ingest_classifies_an_uncoded_status_by_class(
    reply: _IngestReply,
    expected: type[CreekVaultError],
    http_clients: ClientFactory,
) -> None:
    """Uncoded, a 4xx is our contract fault -- except the two that describe the vault."""
    client = await _handshaken_client(_VaultRouteHandler([reply]), http_clients)
    with pytest.raises(expected) as exc_info:
        await client.ingest(_ingest_request())
    assert type(exc_info.value) is expected
    assert getattr(exc_info.value, "code", None) is None


@pytest.mark.asyncio
async def test_contract_and_unavailable_ingest_failures_are_distinguishable(
    http_clients: ClientFactory,
) -> None:
    """A bad payload and an unreachable vault raise two types, neither a subclass of the other."""
    contract_client = await _handshaken_client(
        _VaultRouteHandler(
            [
                _IngestReply(
                    status=HTTPStatus.BAD_REQUEST,
                    payload=_error_payload(VaultErrorCode.INVALID_REQUEST.value),
                )
            ]
        ),
        http_clients,
    )
    offline_client = await _handshaken_client(
        _VaultRouteHandler(ingest_error=httpx.ConnectError("refused")), http_clients
    )
    with pytest.raises(CreekVaultError) as contract_info:
        await contract_client.ingest(_ingest_request())
    with pytest.raises(CreekVaultError) as offline_info:
        await offline_client.ingest(_ingest_request())

    contract_error = contract_info.value
    offline_error = offline_info.value
    assert type(contract_error) is not type(offline_error)
    assert not isinstance(contract_error, type(offline_error))
    assert not isinstance(offline_error, type(contract_error))


@pytest.mark.asyncio
async def test_an_unrecognized_error_code_never_reaches_a_message_or_a_log(
    caplog: pytest.LogCaptureFixture,
    http_clients: ClientFactory,
) -> None:
    """A vault-supplied code is never parsed, stored, or echoed -- CRLF and all."""
    caplog.set_level(logging.DEBUG)
    handler = _VaultRouteHandler(
        [_IngestReply(status=HTTPStatus.BAD_REQUEST, payload=_error_payload(_HOSTILE_VAULT_CODE))]
    )
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultContractError) as exc_info:
        await client.ingest(_ingest_request())

    assert exc_info.value.code is None
    for rendered in (str(exc_info.value), repr(exc_info.value), caplog.text):
        assert _HOSTILE_CODE_SENTINEL not in rendered
        assert "\r\n" not in rendered


@pytest.mark.asyncio
async def test_ingest_is_bounded_by_the_whole_request_deadline(
    monkeypatch: pytest.MonkeyPatch,
    http_clients: ClientFactory,
) -> None:
    """An ingest that outlives the deadline degrades to unavailable rather than hanging."""
    monkeypatch.setattr(_DEADLINE_ATTR, _TINY_DEADLINE_SECONDS)
    client = await _handshaken_client(_SlowIngestHandler(), http_clients)
    with pytest.raises(CreekVaultUnavailableError):
        await client.ingest(_ingest_request())


@pytest.mark.asyncio
async def test_ingest_refuses_when_journal_was_not_advertised(
    http_clients: ClientFactory,
) -> None:
    """An unadvertised journal capability refuses locally: no entry body ever leaves."""
    handler = _VaultRouteHandler(capabilities=[CreekCapability.REFLECT.value])
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.ingest(_ingest_request())
    assert handler.ingest_requests == []


@pytest.mark.asyncio
async def test_entry_body_and_api_key_never_leak_from_any_ingest_failure(
    caplog: pytest.LogCaptureFixture,
    http_clients: ClientFactory,
) -> None:
    """No ingest path -- contract, auth, unavailable, or success -- echoes the body or the key."""
    caplog.set_level(logging.DEBUG)
    replies = {
        "contract": _IngestReply(
            status=HTTPStatus.BAD_REQUEST,
            payload=_error_payload(VaultErrorCode.INVALID_REQUEST.value),
        ),
        "auth": _IngestReply(status=HTTPStatus.UNAUTHORIZED, payload={"detail": "denied"}),
        "unavailable": _IngestReply(
            status=HTTPStatus.INTERNAL_SERVER_ERROR, payload={"detail": "boom"}
        ),
    }
    raised: list[CreekVaultError] = []
    for reply in replies.values():
        client = await _handshaken_client(_VaultRouteHandler([reply]), http_clients, _SENTINEL_KEY)
        with pytest.raises(CreekVaultError) as exc_info:
            await client.ingest(_ingest_request(body=_SENTINEL_BODY))
        raised.append(exc_info.value)
    stored = await _handshaken_client(_VaultRouteHandler(), http_clients, _SENTINEL_KEY)
    assert (await stored.ingest(_ingest_request(body=_SENTINEL_BODY))).stored is True

    assert len(raised) == len(replies)
    for error in raised:
        for rendered in (str(error), repr(error)):
            assert _SENTINEL_BODY not in rendered
            assert _SENTINEL_KEY not in rendered
        assert error.__cause__ is None
        assert error.__suppress_context__ is True
    assert _SENTINEL_BODY not in caplog.text
    assert _SENTINEL_KEY not in caplog.text


@pytest.mark.asyncio
async def test_intimate_entry_issues_zero_http_requests(
    http_clients: ClientFactory,
) -> None:
    """An intimate entry never reaches the wire -- the transport spy sees nothing at all."""
    handler = _VaultRouteHandler()
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_SENTINEL_BODY,
        classification="intimate",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.SKIPPED_INTIMATE
    assert handler.requests == []


@pytest.mark.asyncio
async def test_unknown_classification_sends_nothing_over_http(
    http_clients: ClientFactory,
) -> None:
    """An unrecognized classification fails closed before a single byte is sent."""
    handler = _VaultRouteHandler()
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    with pytest.raises(ValueError, match="bogus"):
        await store_and_classify(
            client,
            entry_id=_ENTRY_ID,
            body=_SENTINEL_BODY,
            classification="bogus",
            created_at=_CREATED_AT,
        )
    assert handler.requests == []


@pytest.mark.asyncio
async def test_handshake_degrades_when_httpx_cannot_parse_the_vault_url(
    http_clients: ClientFactory,
) -> None:
    """A vault URL httpx refuses to build a request for is unreachable, not a crash."""
    handler = _VaultRouteHandler()
    client = HttpCreekVaultClient(
        _UNPARSEABLE_VAULT_URL, _API_KEY, http_client=http_clients(handler)
    )
    result = await client.handshake()
    assert result.available is False
    assert client.last_degrade_reason is HandshakeDegradeReason.UNREACHABLE
    assert handler.requests == []


@pytest.mark.asyncio
async def test_write_path_degrades_when_httpx_cannot_parse_the_vault_url(
    http_clients: ClientFactory,
) -> None:
    """A misconfigured vault URL degrades the write instead of raising into the caller.

    ``httpx.InvalidURL`` sits outside the ``HTTPError`` hierarchy, so it is the
    one transport-layer failure that could escape the seam and turn a saved
    entry into a 500 for the user who saved it.
    """
    handler = _VaultRouteHandler()
    client = HttpCreekVaultClient(
        _UNPARSEABLE_VAULT_URL, _API_KEY, http_client=http_clients(handler)
    )
    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_SENTINEL_BODY,
        classification="public",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.UNAVAILABLE
    assert handler.requests == []


@pytest.mark.asyncio
async def test_write_path_ingests_over_http_end_to_end(
    http_clients: ClientFactory,
) -> None:
    """A healthy vault plus a successful PUT carries the write all the way to INGESTED."""
    handler = _VaultRouteHandler()
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_ENTRY_BODY,
        classification="public",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.INGESTED
    assert outcome.vault_ref == _FRAGMENT_ID
    assert _sent_ingest_body(handler)["tier"] == VaultTierCeiling.OPEN.value


@pytest.mark.asyncio
async def test_http_wheel_success_projects_the_ratified_frequencies(
    http_clients: ClientFactory,
) -> None:
    """Creek's published wheel body reads back as ten aspects carrying its own numbers.

    ``F{n}`` is adepthood's stage ``n`` and the share is the fullness verbatim:
    the adapter projects, it does not rescale, and a rounding step here would be
    invisible in every rendered wheel afterwards.
    """
    published = _wheel_example("success")
    frequencies = _wheel_frequencies(published)
    handler = _WheelRouteHandler(published)
    client = await _handshaken_client(handler, http_clients)

    balance = await client.wheel()

    assert [aspect.stage_number for aspect in balance.aspects] == list(range(1, TOTAL_STAGES + 1))
    for aspect in balance.aspects:
        entry = frequencies[f"F{aspect.stage_number}"]
        assert aspect.fullness == entry["share"]
        assert aspect.aspect == entry["name"]

    assert len(handler.wheel_requests) == 1
    read = handler.wheel_requests[0]
    assert read.method == "GET"
    assert str(read.url) == _WHEEL_URL
    assert read.url.query == b""
    assert read.content == b""
    assert read.headers["Authorization"] == f"Bearer {_API_KEY}"


@pytest.mark.asyncio
async def test_http_wheel_requires_the_advertised_capability_without_egress(
    http_clients: ClientFactory,
) -> None:
    """A vault that never advertised the wheel is refused locally, before any request."""
    handler = _WheelRouteHandler(_wheel_example("success"))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))

    with pytest.raises(CreekCapabilityUnsupportedError) as exc_info:
        await client.wheel()

    assert CreekCapability.WHEEL.value in str(exc_info.value)
    assert handler.requests == []


@pytest.mark.parametrize(
    "ceiling",
    [VaultTierCeiling.INTIMATE.value, "not-a-tier"],
    ids=["above_our_ceiling", "unrecognized_ceiling"],
)
@pytest.mark.asyncio
async def test_http_wheel_rejects_a_payload_whose_tier_echo_exceeds_our_ceiling(
    ceiling: str,
    http_clients: ClientFactory,
) -> None:
    """The echoed ceiling is verified, not trusted: a wider one discards the whole read.

    The ratified surface publishes no way to declare a ceiling, so the only
    control left is to check the one the vault says it applied. A tally counted
    above the tier adepthood may ever see is not a wheel this app can render.
    """
    handler = _WheelRouteHandler(_wheel_with_ceiling(ceiling))
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultPayloadError):
        await client.wheel()


@pytest.mark.parametrize(
    "ceiling",
    [VaultTierCeiling.OPEN.value, VaultTierCeiling.PERSONAL.value],
    ids=["open", "personal"],
)
@pytest.mark.asyncio
async def test_http_wheel_accepts_both_admissible_tier_echoes(
    ceiling: str,
    http_clients: ClientFactory,
) -> None:
    """Both ceilings a remote caller may reach are admissible echoes, not just the default."""
    assert _wheel_example("success")["tier_ceiling"] == VaultTierCeiling.OPEN.value
    handler = _WheelRouteHandler(_wheel_with_ceiling(ceiling))
    client = await _handshaken_client(handler, http_clients)

    balance = await client.wheel()

    assert len(balance.aspects) == TOTAL_STAGES


@pytest.mark.parametrize(
    ("state", "status", "expected", "code"),
    [
        pytest.param(
            "refusal",
            HTTPStatus.FORBIDDEN,
            CreekVaultContractError,
            VaultErrorCode.PRIVACY_REFUSED,
            id="refusal_403_is_a_privacy_refusal",
        ),
        pytest.param(
            "malformed-input",
            HTTPStatus.UNPROCESSABLE_ENTITY,
            CreekVaultContractError,
            VaultErrorCode.INVALID_REQUEST,
            id="malformed_input_422",
        ),
        pytest.param(
            "incompatible-version",
            HTTPStatus.CONFLICT,
            CreekVaultContractError,
            VaultErrorCode.INCOMPATIBLE_VERSION,
            id="incompatible_version_409",
        ),
        pytest.param(
            "unavailable-service",
            HTTPStatus.SERVICE_UNAVAILABLE,
            CreekVaultUnavailableError,
            VaultErrorCode.UNAVAILABLE,
            id="unavailable_service_503",
        ),
    ],
)
@pytest.mark.asyncio
async def test_http_wheel_error_states_are_classified_from_the_published_code(
    state: str,
    status: HTTPStatus,
    expected: type[CreekVaultError],
    code: VaultErrorCode,
    http_clients: ClientFactory,
) -> None:
    """Every published wheel error cell is classified from its code, never from its status.

    The 403 is the whole reason for that order. Creek publishes
    ``privacy_refused`` there, and deciding on the status alone would report a
    refusal as a rejected credential -- sending an operator to rotate a key that
    was never refused.
    """
    handler = _WheelRouteHandler(_wheel_example(state), status)
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(expected) as exc_info:
        await client.wheel()

    assert type(exc_info.value) is expected
    assert getattr(exc_info.value, "code", None) is code
    assert not isinstance(exc_info.value, CreekVaultAuthError)


@pytest.mark.asyncio
async def test_http_wheel_uncoded_credential_rejection_is_an_auth_error(
    http_clients: ClientFactory,
) -> None:
    """With no readable code, a refused credential is still a credential to rotate."""
    handler = _WheelRouteHandler({"detail": "denied"}, HTTPStatus.UNAUTHORIZED)
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultAuthError) as exc_info:
        await client.wheel()

    assert type(exc_info.value) is CreekVaultAuthError


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(
            _WheelRouteHandler(text="<html><body>Bad Gateway</body></html>"),
            id="body_is_not_json",
        ),
        pytest.param(_WheelRouteHandler([1, 2, 3]), id="json_is_not_an_object"),
        pytest.param(
            _WheelRouteHandler(_wheel_without_frequency("F7")),
            id="nine_frequencies_instead_of_ten",
        ),
        pytest.param(_WheelRouteHandler(_wheel_with_share("F3", "0.1")), id="share_is_a_string"),
        *[
            pytest.param(_WheelRouteHandler(_wheel_without_key(key)), id=f"missing_{key}")
            for key in _wheel_required_keys()
        ],
    ],
)
@pytest.mark.asyncio
async def test_http_wheel_malformed_success_bodies_are_payload_errors(
    handler: _WheelRouteHandler,
    http_clients: ClientFactory,
) -> None:
    """A 200 adepthood cannot read is a payload fault, all-or-nothing.

    One unusable Frequency rejects the whole read rather than yielding a ring
    with a hole in it, and a missing published field is not completed with a
    default the vault never sent.
    """
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultPayloadError):
        await client.wheel()


@pytest.mark.asyncio
async def test_http_wheel_transport_failure_is_unavailable_not_payload(
    http_clients: ClientFactory,
) -> None:
    """A vault that was not there is not a vault that answered badly.

    This is the pair that makes the new payload type worth having: schema failure
    and vault absence must stay separately countable, since one is a vault bug to
    report upstream and the other is infrastructure to restore.
    """
    handler = _WheelRouteHandler(wheel_error=httpx.ConnectError("refused"))
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultUnavailableError) as exc_info:
        await client.wheel()

    assert type(exc_info.value) is CreekVaultUnavailableError
    assert not isinstance(exc_info.value, CreekVaultPayloadError)


@pytest.mark.parametrize(
    ("handler", "expected"),
    [
        pytest.param(
            _WheelRouteHandler({"status": _HOSTILE_VAULT_CODE}),
            CreekVaultPayloadError,
            id="payload",
        ),
        pytest.param(
            _WheelRouteHandler(
                _error_payload(_HOSTILE_VAULT_CODE), HTTPStatus.UNPROCESSABLE_ENTITY
            ),
            CreekVaultContractError,
            id="contract",
        ),
        pytest.param(
            _WheelRouteHandler(_error_payload(_HOSTILE_VAULT_CODE), HTTPStatus.UNAUTHORIZED),
            CreekVaultAuthError,
            id="auth",
        ),
    ],
)
@pytest.mark.asyncio
async def test_http_wheel_failures_never_carry_vault_text_or_the_credential(
    handler: _WheelRouteHandler,
    expected: type[CreekVaultError],
    http_clients: ClientFactory,
) -> None:
    """No wheel failure echoes the credential or a string the vault chose.

    An unrecognized code is dropped rather than stored, and nothing rides along
    as a cause or a context: an exception raised inside a parse ``except`` would
    carry the vault's own decoder text into every traceback that renders it.
    """
    client = await _handshaken_client(handler, http_clients, _SENTINEL_KEY)

    with pytest.raises(expected) as exc_info:
        await client.wheel()

    error = exc_info.value
    for rendered in (str(error), repr(error)):
        assert _SENTINEL_KEY not in rendered
        assert _HOSTILE_CODE_SENTINEL not in rendered
        assert "\r\n" not in rendered
    assert error.__cause__ is None
    assert error.__context__ is None


@pytest.mark.asyncio
async def test_http_wheel_uncoded_non_client_status_is_unavailable(
    http_clients: ClientFactory,
) -> None:
    """A proxy error page at 502 is a call that did not land, not a request we got wrong.

    It carries no readable code and it is not a 4xx, so neither the code branch
    nor the request-fault branch decides it -- which is exactly the fall-through
    that says the vault was not reached.
    """
    handler = _WheelRouteHandler(
        text="<html><body>502 Bad Gateway</body></html>", status=HTTPStatus.BAD_GATEWAY
    )
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultUnavailableError) as exc_info:
        await client.wheel()

    assert type(exc_info.value) is CreekVaultUnavailableError
    assert exc_info.value.code is None


@pytest.mark.parametrize(
    "ceiling",
    [pytest.param(7, id="number"), pytest.param(None, id="null")],
)
@pytest.mark.asyncio
async def test_http_wheel_rejects_a_tier_echo_that_is_not_even_a_string(
    ceiling: object,
    http_clients: ClientFactory,
) -> None:
    """An echo that is not a string is not a claim, so it cannot satisfy the ceiling check.

    Narrowing the type before the lookup is what stops the check being passable
    by answering with something unreadable rather than with a tier.
    """
    handler = _WheelRouteHandler(_wheel_with_ceiling(ceiling))
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultPayloadError):
        await client.wheel()


@pytest.mark.asyncio
async def test_http_reflect_sends_exactly_the_ratified_request(
    http_clients: ClientFactory,
) -> None:
    """One reflection is one POST of the collection, carrying exactly two ratified fields.

    No ``entry_ref``, because adepthood reflects on an ad-hoc body rather than on
    a fragment the vault has already stored, and -- the property this test exists
    for -- no tier-ceiling field and no query string of any kind. The ratified
    request schema is ``additionalProperties: false`` and publishes no such field,
    so inventing one would be guessing at a contract rather than declaring
    anything.
    """
    handler = _ReflectRouteHandler(_reflection_example("success"))
    client = await _handshaken_client(handler, http_clients)

    await client.reflect(_ENTRY_BODY, VaultTierCeiling.PERSONAL)

    post = handler.reflect_requests[0]
    assert post.method == "POST"
    assert str(post.url) == _REFLECTIONS_URL
    assert post.url.query == b""
    assert post.headers["Authorization"] == f"Bearer {_API_KEY}"

    body = _sent_reflect_body(handler)
    published = _schema_properties("ReflectionRequest")
    minimum, maximum = _max_notes_bounds()
    assert set(body) == {"content", "max_notes"}
    assert set(body) <= set(published)
    assert body["content"] == _ENTRY_BODY
    assert body["max_notes"] == maximum
    assert minimum <= maximum
    assert "entry_ref" not in body
    for name in _TIER_FIELD_NAMES:
        assert name not in body


@pytest.mark.asyncio
async def test_http_reflect_ok_projects_the_ratified_notes(
    http_clients: ClientFactory,
) -> None:
    """Creek's published reflection reads back as a structured value carrying its own note.

    The quote and the note survive verbatim -- adepthood anchors a quote
    character-for-character against the entry body, so a trim here would silently
    break the anchor -- and the kind is projected onto adepthood's marginalia
    vocabulary rather than passed through in Creek's.
    """
    published = _published_note()
    assert published["kind"] == "pattern"
    handler = _ReflectRouteHandler(_reflection_example("success"))
    client = await _handshaken_client(handler, http_clients)

    reflection = await client.reflect(_ENTRY_BODY, VaultTierCeiling.PERSONAL)

    assert reflection.status is VaultReflectionStatus.OK
    assert reflection.notes == (
        VaultReflectionNote(
            kind=_PATTERN_MARGINALIA_KIND,
            quote=str(published["quote"]),
            note=str(published["note"]),
        ),
    )
    assert reflection.essay is None
    assert reflection.essay_grounded is False
    assert reflection.routed_tier is VaultTierCeiling.PERSONAL


@pytest.mark.asyncio
async def test_http_reflect_empty_is_a_status_not_a_failure(
    http_clients: ClientFactory,
) -> None:
    """Creek's empty state is a legitimate answer: a status the caller reads, not an error.

    A vault with nothing to say about this entry has said so successfully, which
    is a different fact from a vault that could not be reached -- and folding the
    two together is what made all six reflection outcomes one blank string.
    """
    published = _reflection_example("empty")
    assert published["notes"] == []
    handler = _ReflectRouteHandler(published)
    client = await _handshaken_client(handler, http_clients)

    reflection = await client.reflect(_ENTRY_BODY, VaultTierCeiling.PERSONAL)

    assert reflection.status is VaultReflectionStatus.EMPTY
    assert reflection.notes == ()
    assert reflection.essay is None


@pytest.mark.asyncio
async def test_http_reflect_escalation_raises_a_care_escalation(
    http_clients: ClientFactory,
) -> None:
    """A 200 escalation raises out of the seam, and none of Creek's copy rides with it.

    It must not be a ``CreekVaultError``, because the consumer catches that type
    and answers from the cloud -- which would override Creek's care guard with
    exactly the model prose it refused to produce. And it must carry nothing:
    Creek's reason, its message and its resource names are Creek's own copy, and
    adepthood renders only the care surface it reviewed itself.
    """
    published = _reflection_example("care-escalation")
    signal = published["care_signal"]
    assert isinstance(signal, dict)
    resources = signal["resources"]
    assert isinstance(resources, list)
    creek_copy = [str(signal["message"]), str(published["reason"]), str(signal["kind"])]
    creek_copy += [str(resource["name"]) for resource in resources if isinstance(resource, Mapping)]
    handler = _ReflectRouteHandler(published, HTTPStatus.OK)
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultCareEscalationError) as exc_info:
        await client.reflect(_ENTRY_BODY, VaultTierCeiling.PERSONAL)

    error = exc_info.value
    assert not isinstance(error, CreekVaultError)
    for rendered in (str(error), repr(error)):
        for text in creek_copy:
            assert text not in rendered


@pytest.mark.parametrize(
    ("payload", "status", "expected", "code"),
    [
        pytest.param(
            _reflection_example("refusal"),
            HTTPStatus.FORBIDDEN,
            CreekVaultContractError,
            VaultErrorCode.PRIVACY_REFUSED,
            id="refusal_403_is_a_privacy_refusal",
        ),
        pytest.param(
            _reflection_example("malformed-input"),
            HTTPStatus.UNPROCESSABLE_ENTITY,
            CreekVaultContractError,
            VaultErrorCode.INVALID_REQUEST,
            id="malformed_input_422",
        ),
        pytest.param(
            _reflection_example("incompatible-version"),
            HTTPStatus.CONFLICT,
            CreekVaultContractError,
            VaultErrorCode.INCOMPATIBLE_VERSION,
            id="incompatible_version_409",
        ),
        pytest.param(
            _reflection_example("unavailable-service"),
            HTTPStatus.SERVICE_UNAVAILABLE,
            CreekVaultUnavailableError,
            VaultErrorCode.UNAVAILABLE,
            id="unavailable_service_503",
        ),
        pytest.param(
            _error_envelope(VaultErrorCode.NOT_FOUND.value),
            HTTPStatus.NOT_FOUND,
            CreekVaultContractError,
            VaultErrorCode.NOT_FOUND,
            id="synthetic_not_found_404",
        ),
        pytest.param(
            _error_envelope(VaultErrorCode.TEMPORARILY_UNAVAILABLE.value),
            HTTPStatus.SERVICE_UNAVAILABLE,
            CreekVaultUnavailableError,
            VaultErrorCode.TEMPORARILY_UNAVAILABLE,
            id="synthetic_temporarily_unavailable_503",
        ),
    ],
)
@pytest.mark.asyncio
async def test_http_reflect_error_states_are_classified_from_the_published_code(
    payload: Mapping[str, object],
    status: HTTPStatus,
    expected: type[CreekVaultError],
    code: VaultErrorCode,
    http_clients: ClientFactory,
) -> None:
    """Every reflection error is classified from its code, never from its status class.

    The 403 is the whole reason for that order: Creek publishes
    ``privacy_refused`` there, and deciding on the status alone would report a
    refusal as a rejected credential, sending an operator to rotate a key that was
    never refused while the real remedy goes unmentioned. The two codes with no
    published example cell are constructed against the envelope schema instead, so
    the classifier is exercised over Creek's whole error vocabulary rather than
    only the part with fixtures.
    """
    handler = _ReflectRouteHandler(payload, status)
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(expected) as exc_info:
        await client.reflect(_ENTRY_BODY, VaultTierCeiling.PERSONAL)

    assert type(exc_info.value) is expected
    assert getattr(exc_info.value, "code", None) is code
    assert not isinstance(exc_info.value, CreekVaultAuthError)


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(
            {**_reflection_example("success"), "essay": _SENTINEL_ESSAY, "essay_grounded": True},
            id="claims_a_grounded_essay",
        ),
        pytest.param(_reflection_without("essay_grounded"), id="essay_grounded_absent"),
    ],
)
@pytest.mark.asyncio
async def test_http_reflect_rejects_a_grounded_essay_claim(
    payload: Mapping[str, object],
    http_clients: ClientFactory,
) -> None:
    """Only a literally false, literally present ``essay_grounded`` is admissible at 0.2.

    The field is a ``const false`` in the published schema, so a payload claiming
    a grounded essay describes a contract this client does not speak, and one
    omitting the claim makes no statement at all. Either way the answer is
    rejected whole rather than read past.
    """
    handler = _ReflectRouteHandler(payload)
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultPayloadError) as exc_info:
        await client.reflect(_ENTRY_BODY, VaultTierCeiling.PERSONAL)

    assert _SENTINEL_ESSAY not in str(exc_info.value)


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(
            _reflection_with("routed_tier", VaultTierCeiling.PERSONAL.value),
            id="routed_above_our_ceiling",
        ),
        pytest.param(
            _reflection_with("tier_ceiling", VaultTierCeiling.PERSONAL.value),
            id="ceiling_above_our_ceiling",
        ),
        pytest.param(_reflection_with("routed_tier", "not-a-tier"), id="unrecognized_ceiling"),
    ],
)
@pytest.mark.asyncio
async def test_http_reflect_rejects_a_tier_echo_above_the_declared_ceiling(
    payload: Mapping[str, object],
    http_clients: ClientFactory,
) -> None:
    """Both tier echoes are verified against what the caller accepted, not trusted.

    The ratified surface publishes no way to declare a ceiling, so the only
    control left is checking the one the vault says it applied. An answer routed
    above what adepthood was willing to accept was drawn from material this app
    never authorized, and an echo that will not parse as a tier is not a claim at
    all -- accepting one would make the check passable by answering with nonsense.
    """
    handler = _ReflectRouteHandler(payload)
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultPayloadError):
        await client.reflect(_ENTRY_BODY, VaultTierCeiling.OPEN)


@pytest.mark.asyncio
async def test_http_reflect_accepts_an_echo_at_the_ceiling_the_caller_allowed(
    http_clients: ClientFactory,
) -> None:
    """The ceiling check refuses only what exceeds it, so an equal echo still answers.

    Without this the rejection cases above would pass just as well against a
    client that refused every reflection, which is what the capability did
    before it was wired.
    """
    handler = _ReflectRouteHandler(_reflection_at_ceiling(VaultTierCeiling.OPEN.value))
    client = await _handshaken_client(handler, http_clients)

    reflection = await client.reflect(_ENTRY_BODY, VaultTierCeiling.OPEN)

    assert reflection.status is VaultReflectionStatus.OK
    assert reflection.routed_tier is VaultTierCeiling.OPEN


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(
            _ReflectRouteHandler(text="<html><body>Bad Gateway</body></html>"),
            id="body_is_not_json",
        ),
        pytest.param(_ReflectRouteHandler([1, 2, 3]), id="json_is_an_array"),
        pytest.param(
            _ReflectRouteHandler(_reflection_with("notes", {"kind": "pattern"})),
            id="notes_is_not_a_list",
        ),
        *[
            pytest.param(_ReflectRouteHandler(_reflection_without(key)), id=f"missing_{key}")
            for key in _schema_required("ReflectionResponse")
        ],
    ],
)
@pytest.mark.asyncio
async def test_http_reflect_malformed_bodies_are_payload_errors(
    handler: _ReflectRouteHandler,
    http_clients: ClientFactory,
) -> None:
    """A 200 adepthood cannot read as the published shape is a payload fault, not a fallback.

    A missing published field is not completed with a default the vault never
    sent, and the required-field cases are generated from the schema's own
    ``required`` list so a field Creek adds later is covered without this test
    being edited.
    """
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultPayloadError):
        await client.reflect(_ENTRY_BODY, VaultTierCeiling.PERSONAL)


@pytest.mark.asyncio
async def test_http_reflect_requires_the_advertised_capability_without_egress(
    http_clients: ClientFactory,
) -> None:
    """A vault that never advertised reflections is refused locally, before any request.

    The no-egress half is the load-bearing one: refusing after sending would have
    already put the entry body on a wire toward a capability nobody claimed to
    serve.
    """
    handler = _ReflectRouteHandler(_reflection_example("success"))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))

    with pytest.raises(CreekCapabilityUnsupportedError) as exc_info:
        await client.reflect(_SENTINEL_BODY, VaultTierCeiling.PERSONAL)

    assert CreekCapability.REFLECT.value in str(exc_info.value)
    assert handler.requests == []
    assert _SENTINEL_BODY not in str(exc_info.value)


@pytest.mark.parametrize(
    ("handler", "expected"),
    [
        pytest.param(
            _ReflectRouteHandler({"status": _HOSTILE_VAULT_CODE}),
            CreekVaultPayloadError,
            id="payload",
        ),
        pytest.param(
            _ReflectRouteHandler(
                _error_payload(_HOSTILE_VAULT_CODE), HTTPStatus.UNPROCESSABLE_ENTITY
            ),
            CreekVaultContractError,
            id="contract",
        ),
        pytest.param(
            _ReflectRouteHandler(_error_payload(_HOSTILE_VAULT_CODE), HTTPStatus.UNAUTHORIZED),
            CreekVaultAuthError,
            id="auth",
        ),
    ],
)
@pytest.mark.asyncio
async def test_http_reflect_failures_never_carry_vault_text_the_body_or_the_credential(
    handler: _ReflectRouteHandler,
    expected: type[CreekVaultError],
    http_clients: ClientFactory,
) -> None:
    """No reflection failure echoes the entry, the credential, or a string the vault chose.

    The reflection path is the one that carries a whole journal entry outward, so
    its failures are the ones an entry could ride back out on. An unrecognized
    code is dropped rather than stored, and nothing rides along as a cause or a
    context: an exception raised inside a parse ``except`` would carry the vault's
    own decoder text -- which quotes its bytes -- into every traceback.
    """
    client = await _handshaken_client(handler, http_clients, _SENTINEL_KEY)

    with pytest.raises(expected) as exc_info:
        await client.reflect(_SENTINEL_BODY, VaultTierCeiling.PERSONAL)

    error = exc_info.value
    for rendered in (str(error), repr(error)):
        assert _SENTINEL_KEY not in rendered
        assert _SENTINEL_BODY not in rendered
        assert _HOSTILE_CODE_SENTINEL not in rendered
        assert "\r\n" not in rendered
    assert error.__cause__ is None
    assert error.__context__ is None


OutcomeDriver = Callable[[ClientFactory, pytest.MonkeyPatch], Coroutine[None, None, None]]


async def _drive_ingest_success(
    http_clients: ClientFactory, _monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive one durable journal write over a real HTTP exchange."""
    client = await _handshaken_client(_VaultRouteHandler(), http_clients)
    assert (await client.ingest(_ingest_request())).stored is True


async def _drive_ingest_not_stored(
    http_clients: ClientFactory, _monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive a 2xx whose body does not mean what the published schema promises."""
    reply = _IngestReply(payload={"action": VaultIngestAction.CREATED.value})
    client = await _handshaken_client(_VaultRouteHandler([reply]), http_clients)
    assert (await client.ingest(_ingest_request())).stored is False


async def _drive_ingest_unavailable(
    http_clients: ClientFactory, _monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive a vault-side fault, which is a call that did not land."""
    reply = _IngestReply(status=HTTPStatus.INTERNAL_SERVER_ERROR, payload={"detail": "boom"})
    client = await _handshaken_client(_VaultRouteHandler([reply]), http_clients)
    with pytest.raises(CreekVaultUnavailableError):
        await client.ingest(_ingest_request())


async def _drive_ingest_auth_failed(
    http_clients: ClientFactory, _monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive a refused credential, which is a configuration fault of its own."""
    reply = _IngestReply(status=HTTPStatus.UNAUTHORIZED, payload={"detail": "denied"})
    client = await _handshaken_client(_VaultRouteHandler([reply]), http_clients)
    with pytest.raises(CreekVaultAuthError):
        await client.ingest(_ingest_request())


async def _drive_ingest_contract_failure(
    http_clients: ClientFactory, _monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive a payload the vault rejected, which is adepthood's own defect."""
    reply = _IngestReply(
        status=HTTPStatus.BAD_REQUEST,
        payload=_error_payload(VaultErrorCode.INVALID_REQUEST.value),
    )
    client = await _handshaken_client(_VaultRouteHandler([reply]), http_clients)
    with pytest.raises(CreekVaultContractError):
        await client.ingest(_ingest_request())


async def _drive_ingest_timeout(
    http_clients: ClientFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive a vault that accepted the write and then never finished it.

    The deadline is shortened only after the handshake, so the probe is not
    racing it and the one call under a tiny budget is the ingest.
    """
    client = await _handshaken_client(_SlowIngestHandler(), http_clients)
    monkeypatch.setattr(_DEADLINE_ATTR, _TINY_DEADLINE_SECONDS)
    with pytest.raises(CreekVaultUnavailableError):
        await client.ingest(_ingest_request())


async def _drive_reflect_refused(
    http_clients: ClientFactory, _monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive Creek's published privacy refusal, which is not a rejected credential."""
    handler = _ReflectRouteHandler(_reflection_example("refusal"), HTTPStatus.FORBIDDEN)
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultContractError):
        await client.reflect(_ENTRY_BODY, VaultTierCeiling.PERSONAL)


async def _drive_reflect_escalated(
    http_clients: ClientFactory, _monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive Creek's 200 care handoff, which is a routing decision rather than a failure."""
    handler = _ReflectRouteHandler(_reflection_example("care-escalation"))
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultCareEscalationError):
        await client.reflect(_ENTRY_BODY, VaultTierCeiling.PERSONAL)


async def _drive_classify_unsupported(
    http_clients: ClientFactory, _monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive the one capability this adapter still refuses to guess a wire format for."""
    client = await _handshaken_client(_VaultRouteHandler(), http_clients)
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.classify(_ENTRY_BODY, VaultTierCeiling.OPEN)


async def _drive_handshake_incompatible_version(
    http_clients: ClientFactory, _monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive a vault advertising a contract this client will not interoperate with."""
    handler = _json_handler(
        _handshake_payload([CreekCapability.JOURNAL.value], _SKEWED_CONTRACT_VERSION)
    )
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    assert (await client.handshake()).available is False


async def _drive_fallback_unconfigured(
    _http_clients: ClientFactory, _monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive the no-vault path, whose silent no-op is still an outcome worth counting."""
    assert (await LocalFallbackCreekVaultClient().ingest(_ingest_request())).stored is False


async def _drive_fallback_not_owner(
    _http_clients: ClientFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive a user who is not the bound owner of a configured vault.

    Through the real gate rather than by constructing the fallback with the
    outcome by hand: that gate is the only thing in adepthood that ever chooses
    this outcome, so driving anything else would count a path production does not
    have.
    """
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv(vault_dependency.OWNER_ENV_VAR, str(_VAULT_OWNER_ID))
    client = vault_dependency.get_creek_vault_client(_NON_OWNER_ID)
    assert (await client.ingest(_ingest_request())).stored is False


_OUTCOME_DRIVERS: tuple[tuple[VaultTelemetryOutcome, CreekCapability, OutcomeDriver], ...] = (
    (VaultTelemetryOutcome.SUCCESS, CreekCapability.JOURNAL, _drive_ingest_success),
    (VaultTelemetryOutcome.SCHEMA_FAILURE, CreekCapability.JOURNAL, _drive_ingest_not_stored),
    (VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.JOURNAL, _drive_ingest_unavailable),
    (VaultTelemetryOutcome.AUTH_FAILED, CreekCapability.JOURNAL, _drive_ingest_auth_failed),
    (
        VaultTelemetryOutcome.CONTRACT_FAILURE,
        CreekCapability.JOURNAL,
        _drive_ingest_contract_failure,
    ),
    (VaultTelemetryOutcome.TIMEOUT, CreekCapability.JOURNAL, _drive_ingest_timeout),
    (VaultTelemetryOutcome.REFUSED, CreekCapability.REFLECT, _drive_reflect_refused),
    (VaultTelemetryOutcome.ESCALATED, CreekCapability.REFLECT, _drive_reflect_escalated),
    (
        VaultTelemetryOutcome.CAPABILITY_UNSUPPORTED,
        CreekCapability.CLASSIFY,
        _drive_classify_unsupported,
    ),
    (
        VaultTelemetryOutcome.INCOMPATIBLE_VERSION,
        CreekCapability.HANDSHAKE,
        _drive_handshake_incompatible_version,
    ),
    (
        VaultTelemetryOutcome.FALLBACK_UNCONFIGURED,
        CreekCapability.JOURNAL,
        _drive_fallback_unconfigured,
    ),
    (
        VaultTelemetryOutcome.FALLBACK_NOT_OWNER,
        CreekCapability.JOURNAL,
        _drive_fallback_not_owner,
    ),
)


@pytest.mark.parametrize(
    ("outcome", "capability", "drive"),
    [
        pytest.param(outcome, capability, drive, id=outcome.value)
        for outcome, capability, drive in _OUTCOME_DRIVERS
    ],
)
@pytest.mark.asyncio
async def test_each_outcome_lands_on_its_own_counter_through_a_real_path(
    outcome: VaultTelemetryOutcome,
    capability: CreekCapability,
    drive: OutcomeDriver,
    http_clients: ClientFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every outcome is reached by driving a real exchange, and lands on one key of its own.

    The second assertion is the load-bearing one: nothing else was counted for
    that capability, so an implementation that recorded two outcomes for one
    attempt -- or the wrong one alongside the right one -- fails here.
    """
    await drive(http_clients, monkeypatch)

    counts = vault_outcome_counts()
    assert counts[(outcome, capability)] == 1
    assert {key for key in counts if key[1] is capability} == {(outcome, capability)}


def test_every_telemetry_outcome_has_a_real_driven_path() -> None:
    """The drivers above cover the whole outcome vocabulary, so none is countable only in theory."""
    assert {outcome for outcome, _capability, _drive in _OUTCOME_DRIVERS} == set(
        VaultTelemetryOutcome
    )
    assert len(_OUTCOME_DRIVERS) == len(VaultTelemetryOutcome)


@pytest.mark.asyncio
async def test_a_contract_failure_and_an_unreachable_vault_count_apart(
    http_clients: ClientFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rejected payload and a vault that did not answer land on two different keys.

    This is the pair the whole counter exists for: one is adepthood's bug to fix
    and the other is infrastructure to restore, and a single ``vault_failure``
    tally would have made an operator guess which.
    """
    await _drive_ingest_contract_failure(http_clients, monkeypatch)
    contract_counts = vault_outcome_counts()
    reset_vault_telemetry_for_tests()
    await _drive_ingest_unavailable(http_clients, monkeypatch)
    unavailable_counts = vault_outcome_counts()

    contract_key = (VaultTelemetryOutcome.CONTRACT_FAILURE, CreekCapability.JOURNAL)
    unavailable_key = (VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.JOURNAL)
    assert contract_key != unavailable_key
    assert contract_counts[contract_key] == 1
    assert unavailable_counts[unavailable_key] == 1
    assert unavailable_key not in contract_counts
    assert contract_key not in unavailable_counts


@pytest.mark.asyncio
async def test_incompatible_contract_version_counts_without_raising(
    http_clients: ClientFactory,
) -> None:
    """Contract skew is counted on its own key while the probe still degrades quietly.

    Skew has a specific remedy -- align the two pins -- which is invisible if it
    is tallied with every other reason a vault was not usable, and a handshake
    that raised would break the one caller-visible contract this seam has.
    """
    handler = _json_handler(
        _handshake_payload([CreekCapability.JOURNAL.value], _SKEWED_CONTRACT_VERSION)
    )
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))

    result = await client.handshake()

    assert result.available is False
    assert client.last_degrade_reason is HandshakeDegradeReason.INCOMPATIBLE_VERSION
    assert vault_outcome_counts() == {
        (VaultTelemetryOutcome.INCOMPATIBLE_VERSION, CreekCapability.HANDSHAKE): 1,
    }


@pytest.mark.asyncio
async def test_a_timed_out_call_counts_as_timeout_and_still_degrades_the_old_way(
    http_clients: ClientFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A timeout is counted apart from absence while staying an unavailability to callers.

    Both halves matter. A vault that is up but too slow is a capacity problem, so
    it must not be tallied as an absent one -- and the error it raises must stay a
    :class:`CreekVaultUnavailableError` so every caller written before this
    distinction existed degrades exactly as it always did.
    """
    client = await _handshaken_client(_SlowIngestHandler(), http_clients)
    monkeypatch.setattr(_DEADLINE_ATTR, _TINY_DEADLINE_SECONDS)

    with pytest.raises(CreekVaultUnavailableError) as exc_info:
        await client.ingest(_ingest_request())

    assert isinstance(exc_info.value, VaultCallTimedOutError)
    assert CreekCapability.JOURNAL.value in str(exc_info.value)
    counts = vault_outcome_counts()
    assert counts[(VaultTelemetryOutcome.TIMEOUT, CreekCapability.JOURNAL)] == 1
    assert (VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.JOURNAL) not in counts


async def _fallback_handshake(client: LocalFallbackCreekVaultClient) -> None:
    """Probe the local fallback, which reports no usable vault."""
    assert (await client.handshake()).available is False


async def _fallback_ingest(client: LocalFallbackCreekVaultClient) -> None:
    """Write to the local fallback, whose ingest is a silent no-op."""
    assert (await client.ingest(_ingest_request())).stored is False


async def _fallback_classify(client: LocalFallbackCreekVaultClient) -> None:
    """Ask the local fallback to classify, which it has nothing to serve."""
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.classify(_ENTRY_BODY, VaultTierCeiling.OPEN)


async def _fallback_reflect(client: LocalFallbackCreekVaultClient) -> None:
    """Ask the local fallback to reflect, which it has nothing to serve."""
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.reflect(_ENTRY_BODY, VaultTierCeiling.OPEN)


async def _fallback_wheel(client: LocalFallbackCreekVaultClient) -> None:
    """Ask the local fallback for a wheel, which it has nothing to serve."""
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.wheel()


FallbackCall = Callable[[LocalFallbackCreekVaultClient], Coroutine[None, None, None]]

_FALLBACK_CALLS: tuple[tuple[CreekCapability, FallbackCall], ...] = (
    (CreekCapability.HANDSHAKE, _fallback_handshake),
    (CreekCapability.JOURNAL, _fallback_ingest),
    (CreekCapability.CLASSIFY, _fallback_classify),
    (CreekCapability.REFLECT, _fallback_reflect),
    (CreekCapability.WHEEL, _fallback_wheel),
)


@pytest.mark.parametrize(
    ("capability", "call"),
    [pytest.param(capability, call, id=capability.value) for capability, call in _FALLBACK_CALLS],
)
@pytest.mark.asyncio
async def test_local_fallback_labels_each_capability_with_its_own_name(
    capability: CreekCapability, call: FallbackCall
) -> None:
    """The no-vault path counts per capability, so "never configured" stays legible.

    A single unlabelled tally would say a deployment has no vault without saying
    what it kept asking for, which is the whole reason the fallback is countable
    at all.
    """
    await call(LocalFallbackCreekVaultClient())

    assert vault_outcome_counts() == {
        (VaultTelemetryOutcome.FALLBACK_UNCONFIGURED, capability): 1,
    }


def test_local_fallback_synchronous_reads_record_nothing() -> None:
    """``supports`` and ``is_available`` are cache reads, not attempts, so they count nothing."""
    client = LocalFallbackCreekVaultClient()

    assert client.is_available() is False
    assert client.supports(CreekCapability.JOURNAL) is False

    assert vault_outcome_counts() == {}


# --- Capability-document narrowing, driven through the real handshake ---------
# Relocated from the retired MCP suite, which was the only place these branches
# were reached. The rules belong to the shared parser rather than to a transport,
# so they are driven here through the one adapter that still exists.

# Creek's seven published note kinds, restated here on purpose: this literal is
# the pin against the vocabulary drifting out from under the mapping table.
_CREEK_NOTE_KINDS = frozenset(
    {"reframe", "fear", "longing", "value", "pattern", "tension", "gift"},
)

# One well-formed margin note's quote and note text, reused so the hygiene matrix
# below can pair exactly one malformed item against a known-good sibling.
_MARGIN_QUOTE = "the river kept moving"
_MARGIN_NOTE = "You keep reaching for motion when you write about rest."

# A JSON integer whose magnitude no float can hold. Every integer literal is
# valid JSON and Python decodes one to an arbitrary-precision ``int``, so a
# hostile or buggy vault can put this in a ``share``; ``float()`` on it raises
# ``OverflowError``, an ``ArithmeticError`` that sits in neither the client's
# transport degrade set nor the read path's ``CreekVaultError`` catch. The
# exponent is a decade past the ~1.8e308 float ceiling and far inside CPython's
# 4300-digit integer-parsing limit, so it is a value that really does arrive.
_FLOAT_OVERFLOWING_SHARE = 10**400

# An attestation document a vault may carry on a healthy handshake. Its contents
# are the vault's own, so the parser must hand the mapping back untouched rather
# than narrow it to fields adepthood happens to know.
_ATTESTATION = {"quote": "sentinel-attestation"}


def _margin_note(kind: object, quote: object, note: object) -> dict[str, object]:
    """Build one published margin note, allowing deliberately malformed field types."""
    return {"kind": kind, "quote": quote, "note": note}


def _wheel_with(key: str, value: object) -> dict[str, object]:
    """Return the success wheel example with one top-level field replaced."""
    body = _wheel_example("success")
    body[key] = value
    return body


def _wheel_with_name(code: str, name: object) -> dict[str, object]:
    """Return the success example with one Frequency's name replaced."""
    body = _wheel_example("success")
    frequencies = {label: dict(entry) for label, entry in _wheel_frequencies(body).items()}
    frequencies[code]["name"] = name
    body["wheel"] = frequencies
    return body


def _published_balance() -> VaultWheelBalance:
    """Build the domain balance the vendored success wheel projects onto."""
    frequencies = _wheel_frequencies(_wheel_example("success"))
    return VaultWheelBalance(
        aspects=tuple(
            VaultWheelAspect(
                stage_number=stage,
                aspect=str(frequencies[f"F{stage}"]["name"]),
                fullness=float(cast("float", frequencies[f"F{stage}"]["share"])),
            )
            for stage in range(1, TOTAL_STAGES + 1)
        )
    )


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(
            {**_handshake_payload([CreekCapability.JOURNAL.value]), "contract_version": 123},
            id="contract_version_is_not_a_string",
        ),
        pytest.param(
            {**_handshake_payload([]), "capabilities": "not-a-list"},
            id="capabilities_is_not_a_list",
        ),
        pytest.param(
            {**_handshake_payload([CreekCapability.JOURNAL.value]), "attestation": "not-a-mapping"},
            id="attestation_is_neither_mapping_nor_null",
        ),
    ],
)
@pytest.mark.asyncio
async def test_handshake_degrades_on_a_wrong_typed_capability_document(
    payload: Mapping[str, object],
    http_clients: ClientFactory,
) -> None:
    """A field of the wrong type is a malformed document, not a field to coerce.

    Every one of these is a vault answering in a shape adepthood does not
    understand, and reading past it -- casting the version to text, treating a
    string as a one-element capability list -- would let a client negotiate
    against a contract nobody published.
    """
    client = HttpCreekVaultClient(
        _VAULT_URL, _API_KEY, http_client=http_clients(_json_handler(payload))
    )

    result = await client.handshake()

    assert result == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.MALFORMED_PAYLOAD


@pytest.mark.asyncio
async def test_handshake_drops_a_non_string_capability_beside_the_valid_ones(
    http_clients: ClientFactory,
) -> None:
    """A capability entry that is not even a string is dropped, never fatal.

    Forward compatibility runs item by item: a vault may advertise things this
    client has not heard of, so one unusable entry costs that entry and nothing
    else.
    """
    payload = {
        **_handshake_payload([]),
        # Creek's published wire names, since this bypasses the helper's translation.
        "capabilities": ["journal-upsert", 42, "wheel"],
    }
    client = HttpCreekVaultClient(
        _VAULT_URL, _API_KEY, http_client=http_clients(_json_handler(payload))
    )

    result = await client.handshake()

    assert result.available is True
    assert result.capabilities == frozenset({CreekCapability.JOURNAL, CreekCapability.WHEEL})


@pytest.mark.asyncio
async def test_handshake_carries_a_vaults_attestation_through_untouched(
    http_clients: ClientFactory,
) -> None:
    """An attestation mapping reaches the result verbatim, because its contents are the vault's.

    Adepthood does not interpret this document, so narrowing it to the fields
    this client happens to know would quietly discard the part a future check
    needs.
    """
    payload = _handshake_payload([CreekCapability.JOURNAL.value], attestation=_ATTESTATION)
    client = HttpCreekVaultClient(
        _VAULT_URL, _API_KEY, http_client=http_clients(_json_handler(payload))
    )

    result = await client.handshake()

    assert result.available is True
    assert result.attestation == _ATTESTATION


# --- The shared wheel projection, as a helper and through the adapter ---------


def test_wheel_frequency_codes_cover_every_stage_in_ascending_order() -> None:
    """The wheel's Frequency codes are F1..F10, one per curriculum stage, in order."""
    expected_codes = tuple(f"F{n}" for n in range(1, TOTAL_STAGES + 1))
    assert expected_codes == _WHEEL_FREQUENCY_CODES


def test_wheel_wire_constants_match_creeks_published_contract() -> None:
    """The wheel's success status and its aspect-name ceiling hold their pinned values."""
    assert _WHEEL_OK_STATUS == "ok"
    assert _MAX_WHEEL_ASPECT_NAME_LENGTH == 128


def test_parse_wheel_projects_a_published_payload_onto_the_domain_balance() -> None:
    """``_parse_wheel`` maps each F-code onto its stage number, its name, and its share.

    Asserted against the vendored example rather than a hand-written map, so the
    projection is checked against the wire shape Creek actually publishes.
    """
    assert _parse_wheel(_wheel_example("success")) == _published_balance()


def test_parse_wheel_returns_none_for_an_unusable_payload() -> None:
    """``_parse_wheel`` answers None rather than raising, leaving the degrade to its caller.

    That division of labour is the reason the helper is safe to share: a parser
    that raised would make every caller responsible for a degrade set it does not
    own.
    """
    assert _parse_wheel(_wheel_with("status", "refused")) is None


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(
            _WheelRouteHandler(_wheel_with_share("F2", _FLOAT_OVERFLOWING_SHARE)),
            id="share_no_float_can_hold",
        ),
        pytest.param(_WheelRouteHandler(_wheel_with_share("F2", True)), id="share_is_a_bool"),
        pytest.param(_WheelRouteHandler(_wheel_with("status", "refused")), id="status_is_refused"),
        pytest.param(
            _WheelRouteHandler(
                _wheel_with("wheel", [_wheel_frequencies(_wheel_example("success"))])
            ),
            id="wheel_is_not_a_mapping",
        ),
        pytest.param(
            _WheelRouteHandler(_wheel_with_name("F5", "x" * (_MAX_WHEEL_ASPECT_NAME_LENGTH + 1))),
            id="name_over_the_length_cap",
        ),
        pytest.param(
            _WheelRouteHandler(_wheel_with_name("F5", "Agency\nWARN root: pay up")),
            id="name_carrying_a_newline",
        ),
    ],
)
@pytest.mark.asyncio
async def test_http_wheel_refuses_an_unusable_frequency_or_envelope(
    handler: _WheelRouteHandler,
    http_clients: ClientFactory,
) -> None:
    """Each way one Frequency can be unusable rejects the whole read, never a partial ring.

    Three of these are why the checks are written the way they are. A boolean
    would read as a completely full Frequency under a bare numeric test, since
    ``isinstance(True, int)`` is true. An integer past the float range decodes to
    an arbitrary-precision ``int`` whose ``float()`` raises ``OverflowError`` --
    an ``ArithmeticError`` in nobody's degrade set -- so it would escape the seam
    as a crash rather than a fallback. And a name carrying a newline is the
    payload that forges a log line, which is why a Frequency name has to be
    printable and bounded even though it is relabelled away before rendering.
    """
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultPayloadError):
        await client.wheel()


@pytest.mark.asyncio
async def test_http_wheel_keeps_a_name_at_the_exact_length_boundary(
    http_clients: ClientFactory,
) -> None:
    """A name of exactly ``_MAX_WHEEL_ASPECT_NAME_LENGTH`` characters survives verbatim.

    The bound is asserted at its edge rather than merely somewhere beyond it, so
    an off-by-one that silently discarded the longest legitimate name would fail
    here rather than in a wheel that quietly stopped rendering.
    """
    name = "x" * _MAX_WHEEL_ASPECT_NAME_LENGTH
    handler = _WheelRouteHandler(_wheel_with_name("F5", name))
    client = await _handshaken_client(handler, http_clients)

    balance = await client.wheel()

    stage_five = next(aspect for aspect in balance.aspects if aspect.stage_number == 5)
    assert stage_five.aspect == name


@pytest.mark.asyncio
async def test_http_wheel_accepts_a_share_serialized_as_a_plain_integer(
    http_clients: ClientFactory,
) -> None:
    """A share of ``1`` is a whole Frequency, not an unreadable one.

    JSON has no float type distinct from its integer one, so a vault that
    computed a share of exactly one or exactly zero may serialize it as ``1``
    rather than ``1.0`` -- entirely legitimately. Every other share case here
    asserts a rejection, so without this one a numeric check narrowed to ``float``
    alone would pass the whole suite while blanking any wheel a vault happened to
    round off, collapsing the read to a payload fault.
    """
    handler = _WheelRouteHandler(_wheel_with_share("F2", 1))
    client = await _handshaken_client(handler, http_clients)

    balance = await client.wheel()

    stage_two = next(aspect for aspect in balance.aspects if aspect.stage_number == 2)
    assert stage_two.fullness == 1.0


# --- The shared marginalia projection, driven through the reflection exchange --


def test_marginalia_kind_map_targets_only_anchorable_kinds() -> None:
    """Every mapped kind is one ``domain.resonance`` will actually anchor."""
    assert set(_MARGINALIA_KIND_BY_CREEK_KIND.values()) <= VALID_KINDS


def test_marginalia_kind_map_covers_creeks_published_kinds() -> None:
    """The mapping's keys are exactly Creek's seven published note kinds."""
    assert set(_MARGINALIA_KIND_BY_CREEK_KIND) == _CREEK_NOTE_KINDS


def _strip_spy_text(value: str) -> tuple[str, list[str | None]]:
    """Build a string that logs every ``strip`` asked of it, and return both.

    ``_bounded_text`` admits a value on ``isinstance(raw, str)``, which a subclass
    satisfies, so this walks the helper down exactly the path a vault-supplied
    string walks while leaving a record of which guards were consulted along the
    way. The log lives in this closure rather than on the instance because a
    ``str`` subclass may only carry an empty ``__slots__``, and keeping it here
    rather than on the class also keeps one call's record out of the next one's.
    The override still delegates, so the value behaves as its own text to anything
    else that touches it.
    """
    strip_calls: list[str | None] = []

    class _StripSpyText(str):
        """A string that answers as itself while recording each ``strip``."""

        __slots__ = ()

        def strip(self, chars: str | None = None, /) -> str:
            """Record the consultation, then answer as the underlying string would."""
            strip_calls.append(chars)
            return super().strip(chars)

    return _StripSpyText(value), strip_calls


def test_bounded_text_rejects_an_over_limit_value_without_consulting_strip() -> None:
    """An over-limit value is refused on its length alone, before anything copies it.

    A vault answers with untrusted text, and the cheap check on that text is its
    length: an oversized value is going to be dropped whatever its contents, so
    asking it to ``strip`` first buys nothing and costs a transient copy of the
    whole oversized string. The copy is real only for whitespace-padded input --
    CPython hands back the receiver itself when an exact ``str`` has nothing to
    remove -- so the value here is padded and exactly one character over, the
    smallest shape in which the wasted work actually happens.

    Reordering side-effect-free guards behind ``or`` cannot change what the helper
    returns for any input, so no input/output assertion can pin it. Observing
    whether ``strip`` was consulted at all is the only way to hold the ordering in
    place against a later edit that quietly restores the expensive check to the
    front.
    """
    oversized, strip_calls = _strip_spy_text(" " + "x" * ANCHOR_TEXT_MAX)

    assert _bounded_text(oversized, ANCHOR_TEXT_MAX) is None
    assert strip_calls == []


@pytest.mark.parametrize(
    "accepted",
    [
        pytest.param("x" * ANCHOR_TEXT_MAX, id="exactly_at_the_limit"),
        pytest.param(f"  {_MARGIN_QUOTE}  ", id="whitespace_padded"),
    ],
)
def test_bounded_text_returns_usable_text_verbatim(accepted: str) -> None:
    """Usable text comes back as the very object that went in, untouched.

    The limit is a ceiling rather than a threshold, so a value of exactly
    ``ANCHOR_TEXT_MAX`` is still usable text. Identity rather than equality is the
    assertion that matters: adepthood anchors a quote by matching it
    character-for-character against the entry body, so a helper that trimmed the
    padding it checked for would break the anchor it exists to protect.
    """
    assert _bounded_text(accepted, ANCHOR_TEXT_MAX) is accepted


@pytest.mark.parametrize(
    "refused",
    [
        pytest.param("x" * (ANCHOR_TEXT_MAX + 1), id="one_over_the_limit"),
        pytest.param(" \n\t ", id="whitespace_only"),
        pytest.param(7, id="not_a_string"),
    ],
)
def test_bounded_text_refuses_what_cannot_anchor(refused: object) -> None:
    """Each of the three ways a value fails to be usable text drops it on its own.

    A number is not text, a blank quote anchors to nothing, and a value past the
    ceiling would let a vault answer with an unbounded string -- so all three are
    refused rather than repaired, and none of them may be salvaged by another.
    """
    assert _bounded_text(refused, ANCHOR_TEXT_MAX) is None


async def _reflected_notes(
    notes: object, http_clients: ClientFactory
) -> tuple[VaultReflectionNote, ...]:
    """Drive one published reflection carrying ``notes`` and return what survived projection."""
    handler = _ReflectRouteHandler(_reflection_with("notes", notes))
    client = await _handshaken_client(handler, http_clients)
    reflection = await client.reflect(_ENTRY_BODY, VaultTierCeiling.OPEN)
    return reflection.notes


@pytest.mark.parametrize(
    ("creek_kind", "marginalia_kind"),
    [
        pytest.param("pattern", "connection", id="pattern"),
        pytest.param("reframe", "theme", id="reframe"),
        pytest.param("fear", "theme", id="fear"),
        pytest.param("longing", "theme", id="longing"),
        pytest.param("value", "theme", id="value"),
        pytest.param("tension", "theme", id="tension"),
        pytest.param("gift", "theme", id="gift"),
    ],
)
@pytest.mark.asyncio
async def test_reflect_maps_each_published_note_kind(
    creek_kind: str,
    marginalia_kind: str,
    http_clients: ClientFactory,
) -> None:
    """Each of Creek's seven note kinds renders as its ratified marginalia kind."""
    notes = await _reflected_notes(
        [_margin_note(creek_kind, _MARGIN_QUOTE, _MARGIN_NOTE)], http_clients
    )
    assert notes == (
        VaultReflectionNote(kind=marginalia_kind, quote=_MARGIN_QUOTE, note=_MARGIN_NOTE),
    )


@pytest.mark.parametrize(
    "bad_note",
    [
        pytest.param("not-a-mapping", id="non_mapping_item"),
        pytest.param(_margin_note("prophecy", _MARGIN_QUOTE, _MARGIN_NOTE), id="unknown_kind"),
        pytest.param(_margin_note(7, _MARGIN_QUOTE, _MARGIN_NOTE), id="non_string_kind"),
        pytest.param({"kind": "gift", "note": _MARGIN_NOTE}, id="missing_quote"),
        pytest.param({"kind": "gift", "quote": _MARGIN_QUOTE}, id="missing_note"),
        pytest.param(_margin_note("gift", 7, _MARGIN_NOTE), id="non_string_quote"),
        pytest.param(_margin_note("gift", _MARGIN_QUOTE, 7), id="non_string_note"),
        pytest.param(_margin_note("gift", "", _MARGIN_NOTE), id="empty_quote"),
        pytest.param(_margin_note("gift", " \n\t ", _MARGIN_NOTE), id="whitespace_quote"),
        pytest.param(_margin_note("gift", _MARGIN_QUOTE, ""), id="empty_note"),
        pytest.param(_margin_note("gift", _MARGIN_QUOTE, " \n\t "), id="whitespace_note"),
        pytest.param(
            _margin_note("gift", "q" * (ANCHOR_TEXT_MAX + 1), _MARGIN_NOTE), id="oversized_quote"
        ),
        pytest.param(
            _margin_note("gift", _MARGIN_QUOTE, "n" * (NOTE_MAX + 1)), id="oversized_note"
        ),
    ],
)
@pytest.mark.asyncio
async def test_reflect_drops_a_malformed_note_keeping_its_sibling(
    bad_note: object,
    http_clients: ClientFactory,
) -> None:
    """A malformed note is dropped item by item, never taking its well-formed sibling with it.

    Every field has to survive on its own terms because this is the boundary
    where an untrusted vault's output becomes something adepthood renders back to
    the user: completing a partial note with a default would put words in the
    user's Higher Self that neither they nor the vault ever wrote.
    """
    notes = await _reflected_notes(
        [bad_note, _margin_note("gift", _MARGIN_QUOTE, _MARGIN_NOTE)], http_clients
    )
    assert notes == (VaultReflectionNote(kind="theme", quote=_MARGIN_QUOTE, note=_MARGIN_NOTE),)


@pytest.mark.asyncio
async def test_reflect_keeps_notes_at_the_exact_length_boundaries(
    http_clients: ClientFactory,
) -> None:
    """A quote of exactly ANCHOR_TEXT_MAX and a note of exactly NOTE_MAX both survive."""
    quote = "q" * ANCHOR_TEXT_MAX
    note = "n" * NOTE_MAX
    notes = await _reflected_notes([_margin_note("value", quote, note)], http_clients)
    assert notes == (VaultReflectionNote(kind="theme", quote=quote, note=note),)


@pytest.mark.asyncio
async def test_reflect_passes_the_quote_through_verbatim(http_clients: ClientFactory) -> None:
    """A quote keeps its exact surrounding whitespace, since adepthood anchors it verbatim.

    Trimming here would silently break the character-for-character match the
    anchor depends on, and the note would then never render at all.
    """
    quote = f"  {_MARGIN_QUOTE}  "
    notes = await _reflected_notes([_margin_note("pattern", quote, _MARGIN_NOTE)], http_clients)
    assert notes == (VaultReflectionNote(kind="connection", quote=quote, note=_MARGIN_NOTE),)


@pytest.mark.asyncio
async def test_reflect_caps_the_note_count_keeping_the_leading_prefix(
    http_clients: ClientFactory,
) -> None:
    """Only the first ``_MAX_REFLECT_NOTES`` notes are carried, in the order the vault sent them.

    The cap bounds untrusted vault output before adepthood does any work on it,
    so an over-eager or hostile vault cannot grow this pass without limit; taking
    the leading prefix rather than a sample keeps the vault's own ordering, which
    is the only ranking there is.
    """
    over_cap = [
        _margin_note("gift", _MARGIN_QUOTE, f"note number {index}")
        for index in range(_MAX_REFLECT_NOTES + 3)
    ]
    notes = await _reflected_notes(over_cap, http_clients)
    assert [note.note for note in notes] == [
        f"note number {index}" for index in range(_MAX_REFLECT_NOTES)
    ]


@pytest.mark.parametrize(
    "notes",
    [
        pytest.param([], id="empty_list"),
        pytest.param(
            ["not-a-mapping", _margin_note("prophecy", _MARGIN_QUOTE, _MARGIN_NOTE), 7],
            id="every_item_malformed",
        ),
    ],
)
@pytest.mark.asyncio
async def test_reflect_ok_without_usable_notes_is_still_a_well_formed_answer(
    notes: object,
    http_clients: ClientFactory,
) -> None:
    """A well-formed ok answer nothing survived is still a well-formed answer.

    The consumer, not the adapter, decides that zero renderable notes means
    deferring to the cloud -- the adapter's job is to report what the vault said.
    """
    assert await _reflected_notes(notes, http_clients) == ()


@pytest.mark.asyncio
async def test_reflect_carries_the_essay_without_letting_it_into_the_notes(
    http_clients: ClientFactory,
) -> None:
    """Free prose rides on the value where a caller can see it, and nowhere it could render.

    An essay is the model's own words rather than the user's, so it is carried so
    the seam can report what the vault answered and kept out of the notes, which
    are the only thing anchored back onto the entry.
    """
    handler = _ReflectRouteHandler(_reflection_with("essay", _SENTINEL_ESSAY))
    client = await _handshaken_client(handler, http_clients)

    reflection = await client.reflect(_ENTRY_BODY, VaultTierCeiling.OPEN)

    assert reflection.essay == _SENTINEL_ESSAY
    assert reflection.essay_grounded is False
    assert all(_SENTINEL_ESSAY not in note.note for note in reflection.notes)


# --- Transport failure on the two read exchanges ------------------------------


@pytest.mark.parametrize(
    ("failure", "expected_timeout"),
    [
        pytest.param(httpx.ConnectError("refused"), False, id="connection_refused"),
        pytest.param(httpx.ReadTimeout("vault never answered"), True, id="read_timeout"),
    ],
)
@pytest.mark.asyncio
async def test_http_reflect_transport_failure_degrades_without_carrying_the_entry(
    failure: Exception,
    expected_timeout: bool,
    http_clients: ClientFactory,
) -> None:
    """A reflection that never landed is an absent vault, and a slow one is countably distinct.

    The reflection request carries a whole journal entry, so its transport
    failures are the ones the entry could ride back out on: the message stays
    static and capability-named, and ``from None`` severs the chain so no
    traceback printer surfaces the httpx exception -- whose text can carry the
    URL -- as a cause or a context. A timeout raises the unavailable *subclass*,
    so every caller degrades exactly as before while the counters can still tell
    "not there" from "too slow".
    """
    handler = _ReflectRouteHandler(reflect_error=failure)
    client = await _handshaken_client(handler, http_clients, _SENTINEL_KEY)

    with pytest.raises(CreekVaultUnavailableError) as exc_info:
        await client.reflect(_SENTINEL_BODY, VaultTierCeiling.PERSONAL)

    error = exc_info.value
    assert isinstance(error, VaultCallTimedOutError) is expected_timeout
    assert CreekCapability.REFLECT.value in str(error)
    assert _SENTINEL_BODY not in str(error)
    assert _SENTINEL_KEY not in str(error)
    assert error.__cause__ is None
    assert error.__suppress_context__ is True


@pytest.mark.asyncio
async def test_http_wheel_read_timeout_is_a_timeout_not_a_bare_unavailability(
    http_clients: ClientFactory,
) -> None:
    """A wheel read that ran out of time counts as a timeout while degrading unchanged."""
    handler = _WheelRouteHandler(wheel_error=httpx.ReadTimeout("vault never answered"))
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(VaultCallTimedOutError) as exc_info:
        await client.wheel()

    assert CreekCapability.WHEEL.value in str(exc_info.value)
    assert vault_outcome_counts()[(VaultTelemetryOutcome.TIMEOUT, CreekCapability.WHEEL)] == 1


class _ContractVersionEnforcingHandler:
    """A fake ``/v1`` that refuses capability calls lacking the contract header.

    The whole point of this fixture: a fake that answers regardless of headers
    cannot prove the header is sent, and one that answered regardless is exactly
    what let the omission ship. ``GET /v1/capabilities`` is served without the
    header because the contract exempts it -- and it records what it saw, so a
    test can also assert adepthood does not send it there.
    """

    def __init__(self, capabilities: Sequence[str], reply: httpx.Response | None = None) -> None:
        """Store the advertised capabilities and the reply for a capability call."""
        self._capabilities = list(capabilities)
        self._reply = reply
        self.requests: list[httpx.Request] = []

    @property
    def capability_requests(self) -> list[httpx.Request]:
        """Return every request that was not the exempt capability-document GET."""
        return [r for r in self.requests if not r.url.path.endswith("/capabilities")]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Serve the handshake unconditionally; refuse an unversioned capability call."""
        self.requests.append(request)
        if request.url.path.endswith("/capabilities"):
            return httpx.Response(HTTPStatus.OK, json=_handshake_payload(self._capabilities))
        if request.headers.get(_CONTRACT_VERSION_HEADER) != CONTRACT_MINOR:
            return httpx.Response(
                HTTPStatus.CONFLICT,
                json=_error_payload(VaultErrorCode.INCOMPATIBLE_VERSION.value),
            )
        assert self._reply is not None
        return self._reply


@pytest.mark.asyncio
async def test_journal_ingest_carries_the_contract_version_header(
    http_clients: ClientFactory,
) -> None:
    """A vault that refuses unversioned capability calls still accepts adepthood's ingest."""
    handler = _ContractVersionEnforcingHandler(
        [CreekCapability.JOURNAL.value],
        httpx.Response(HTTPStatus.OK, json=_ingest_payload()),
    )
    client = await _handshaken_client(handler, http_clients)
    result = await client.ingest(_ingest_request())
    assert result.stored is True
    assert handler.capability_requests
    assert all(
        request.headers[_CONTRACT_VERSION_HEADER] == CONTRACT_MINOR
        for request in handler.capability_requests
    )


@pytest.mark.asyncio
async def test_the_capability_document_fetch_is_exempt_from_the_header(
    http_clients: ClientFactory,
) -> None:
    """The negotiation endpoint must never itself be able to fail to negotiate."""
    handler = _ContractVersionEnforcingHandler([CreekCapability.JOURNAL.value])
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    await client.handshake()
    handshake_requests = [r for r in handler.requests if r.url.path.endswith("/capabilities")]
    assert handshake_requests
    assert all(_CONTRACT_VERSION_HEADER not in r.headers for r in handshake_requests)


@pytest.mark.asyncio
async def test_a_server_serving_a_widened_window_is_still_compatible(
    http_clients: ClientFactory,
) -> None:
    """Upstream's 0.3.0 widening keeps serving 0.2, so adepthood must accept it.

    The exact case that made the old rule wrong: upstream moved to 0.3.0 and
    widened ``SUPPORTED_CONTRACT_MINORS`` to ``("0.3", "0.2")`` rather than
    shifting it, so a client still speaking 0.2 is served as before. Gating on
    the server's own ``contract_version`` refused that vault while it was
    advertising that it would answer.
    """
    handler = _json_handler(
        _handshake_payload(
            [CreekCapability.JOURNAL.value],
            "0.3.0",
            supported_contract_minors=["0.3", "0.2"],
        )
    )
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    result = await client.handshake()
    assert result.available is True
    assert client.last_degrade_reason is None
    assert client.supports(CreekCapability.JOURNAL) is True


@pytest.mark.asyncio
async def test_a_server_that_no_longer_serves_our_minor_is_incompatible(
    http_clients: ClientFactory,
) -> None:
    """A window that has moved past adepthood's pin is still version skew."""
    handler = _json_handler(
        _handshake_payload(
            [CreekCapability.JOURNAL.value],
            "0.4.0",
            supported_contract_minors=["0.4", "0.3"],
        )
    )
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    assert await client.handshake() == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.INCOMPATIBLE_VERSION


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(_payload_without_supported_minors(), id="absent"),
        pytest.param(
            _handshake_payload([CreekCapability.JOURNAL.value])
            | {"supported_contract_minors": "0.2"},
            id="bare_string",
        ),
        pytest.param(
            _handshake_payload([CreekCapability.JOURNAL.value])
            | {"supported_contract_minors": [2]},
            id="not_strings",
        ),
    ],
)
@pytest.mark.asyncio
async def test_an_unusable_supported_minors_field_is_a_malformed_payload(
    payload: Mapping[str, object],
    http_clients: ClientFactory,
) -> None:
    """It is a required property, so its absence or wrong type is a malformed document.

    Never silently trusted: a server that cannot say which minors it serves has
    not negotiated, and treating that as compatible would be the same
    assume-it-works mistake in the other direction.
    """
    client = HttpCreekVaultClient(
        _VAULT_URL, _API_KEY, http_client=http_clients(_json_handler(payload))
    )
    assert await client.handshake() == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.MALFORMED_PAYLOAD


@pytest.mark.asyncio
async def test_a_409_on_a_capability_call_counts_as_version_skew(
    http_clients: ClientFactory,
) -> None:
    """Version skew stays countable apart from a generic contract failure.

    ADR 0004 Decision 4 already requires that separation, and ``409
    incompatible_version`` is the response code that carries it on the capability
    path -- what a real Creek server answers when the header does not name a
    minor it serves. The handshake still succeeds here, which is the point: the
    refusal happens per capability call, not at negotiation.
    """

    def _handle(request: httpx.Request) -> httpx.Response:
        """Handshake healthily, then refuse the ingest with the published skew code."""
        if request.url.path.endswith("/capabilities"):
            return httpx.Response(
                HTTPStatus.OK, json=_handshake_payload([CreekCapability.JOURNAL.value])
            )
        return httpx.Response(
            HTTPStatus.CONFLICT,
            json=_error_payload(VaultErrorCode.INCOMPATIBLE_VERSION.value),
        )

    client = await _handshaken_client(_handle, http_clients)
    with pytest.raises(CreekVaultContractError) as caught:
        await client.ingest(_ingest_request())
    assert caught.value.code is VaultErrorCode.INCOMPATIBLE_VERSION
    assert outcome_for_error(caught.value) is VaultTelemetryOutcome.INCOMPATIBLE_VERSION


def test_the_contract_minor_is_the_first_two_components_of_the_pin() -> None:
    """The header value is derived from the pin, never written out twice."""
    assert ".".join(CONTRACT_VERSION.split(".")[:_CONTRACT_MINOR_COMPONENTS]) == CONTRACT_MINOR
    assert CONTRACT_VERSION.startswith(CONTRACT_MINOR)
