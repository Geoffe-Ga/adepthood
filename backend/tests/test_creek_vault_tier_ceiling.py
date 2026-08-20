"""The tier ceiling adepthood declares on every ``/v1`` call that touches content.

Creek admits each request at a ceiling read from ``X-Creek-Tier-Ceiling`` and
**defaults an absent header to ``open``** -- the most restrictive value, chosen
so an omitted header can only fail closed
(``creek_mcp/httpapi/middleware/ceiling.py``). An ``open`` ceiling cannot admit
a ``personal``-tier write, and ``personal`` is adepthood's default journal
classification, so a client that never sends the header has every default entry
refused ``403 privacy_refused`` and reads a wheel computed over open-tier
material alone.

**Why this file exists at all.** The conformance suite drives an in-process
``httpx.MockTransport`` over Creek's vendored JSON, and that bundle publishes
schemas and examples -- it says nothing about request headers. A fixture that
answers whatever is asked cannot fail for a header nobody sent, which is exactly
how the omission shipped. So every assertion here runs against
:class:`_CeilingGatedVault`: a fake that transcribes Creek's own admission rule
and *refuses* a request whose declared ceiling is too narrow for what it carries.
Its refusing side is proved directly (:func:`test_the_gate_refuses_a_personal_
entry_when_no_ceiling_is_declared`) before any client assertion leans on it, so
"the call succeeded" is evidence rather than the fixture's good manners.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator, Callable, Mapping, Sequence
from datetime import UTC, datetime
from http import HTTPStatus
from typing import Final

import httpx
import pytest
import pytest_asyncio

from domain.creek_vault import (
    CONTRACT_VERSION,
    TIER_CEILING_BY_CLASSIFICATION,
    CreekCapability,
    CreekCeilingUnrepresentableError,
    CreekVaultContractError,
    VaultIngestRequest,
    VaultTierCeiling,
    WireTierCeiling,
    wire_ceiling_for,
)
from models.journal_entry import JournalClassification
from services.creek_vault_client import (
    _CEILING_HEADER,
    _WHEEL_TIER_CEILING,
    HttpCreekVaultClient,
)
from services.creek_vault_write import VaultWriteStatus, store_and_classify

# Creek's own name for the header, transcribed from ``creek_mcp/api/routes.py``
# rather than imported: the two repos are separate deployments, so the only
# thing that can hold them to one spelling is each side pinning the literal.
_CREEK_CEILING_HEADER: Final[str] = "X-Creek-Tier-Ceiling"

# The ceiling Creek admits a request at when the header is absent
# (``creek_mcp/httpapi/middleware/ceiling.py``). Named because the whole defect
# is what this default does to a personal-tier write.
_CREEK_ABSENT_HEADER_CEILING: Final[str] = "open"

# The two ceilings a remote caller may request; anything else is refused ``422``
# (``creek_mcp/policy.py::REMOTE_ADMITTED_CEILINGS``).
_REMOTE_ADMITTED: Final[frozenset[str]] = frozenset({"open", "personal"})

# How much material each ceiling admits, ascending. Creek ranks its own tiers
# the same way; this is the comparison that turns a declared ceiling into an
# admission decision.
_CEILING_RANK: Final[Mapping[str, int]] = {"open": 0, "personal": 1}

_VAULT_URL: Final[str] = "https://vault.example.test"
_API_KEY: Final[str] = "creek-vault-ceiling-test-key"  # pragma: allowlist secret
_CAPABILITIES_PATH: Final[str] = "/v1/capabilities"
_JOURNAL_PATH_PREFIX: Final[str] = "/v1/journal-entries/"
_REFLECTIONS_PATH: Final[str] = "/v1/reflections"
_WHEEL_PATH: Final[str] = "/v1/wheel"

_ENTRY_ID: Final[int] = 11
_ENTRY_BODY: Final[str] = "a default-classification journal entry"
_CREATED_AT: Final[datetime] = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)
_FRAGMENT_ID: Final[str] = "frag-11"
_ONTOLOGY_VERSION: Final[str] = "aptitude-wavelength/2026-05-23"

# The fake's whole corpus: one open-tier fragment and three personal-tier ones.
# A read admitted at ``open`` may count only the first, so the two ceilings
# answer with *different shares* -- which is what makes "the wheel silently
# counts open-tier material only" something a test can observe rather than
# something a fixture can hide.
_OPEN_FRAGMENT_COUNT: Final[int] = 1
_PERSONAL_FRAGMENT_COUNT: Final[int] = 3
_CORPUS_FRAGMENT_COUNT: Final[int] = _OPEN_FRAGMENT_COUNT + _PERSONAL_FRAGMENT_COUNT

# The Frequency codes Creek publishes a wheel over, and the names it gives them
# (``examples/wheel/success.json``). Every code must be present or adepthood
# rejects the read whole, so the fake answers the full ring.
_FREQUENCY_NAMES: Final[Mapping[str, str]] = {
    "F1": "Agency",
    "F2": "Receptivity",
    "F3": "Self-Love / Power",
    "F4": "Community Love / Conformity",
    "F5": "Achievism",
    "F6": "Pluralism",
    "F7": "Integration",
    "F8": "True Self / Transcendence",
    "F9": "Unity",
    "F10": "Emptiness",
}

# Creek's published name for each capability adepthood knows, as the handshake
# document spells it.
_PUBLISHED_CAPABILITY_NAMES: Final[Mapping[str, str]] = {
    CreekCapability.JOURNAL.value: "journal-upsert",
    CreekCapability.REFLECT.value: "reflections",
    CreekCapability.WHEEL.value: "wheel",
}

Handler = Callable[[httpx.Request], httpx.Response]
ClientFactory = Callable[[Handler], httpx.AsyncClient]


def _handshake_payload(capabilities: Sequence[str]) -> dict[str, object]:
    """Build the capability document Creek publishes, advertising ``capabilities``.

    Callers name capabilities in adepthood's own ``creek.*`` vocabulary because
    that is what the assertions read; this translates them to Creek's published
    wire names on the way out, so the handshake under test is the real document
    rather than one shaped to the client's reader.
    """
    minor = ".".join(CONTRACT_VERSION.split(".")[:2])
    return {
        "vault": {"available": True},
        "capabilities": [_PUBLISHED_CAPABILITY_NAMES[name] for name in capabilities],
        "contract_version": CONTRACT_VERSION,
        "contract_minor": minor,
        "supported_contract_minors": [minor],
        "ontology_version": _ONTOLOGY_VERSION,
        "attestation": None,
    }


def _error_body(code: str) -> dict[str, object]:
    """Build the published error envelope carrying ``code``."""
    return {"code": code, "detail": "the vault refused this request"}


def _counted_fragments(ceiling: str) -> int:
    """Return how many corpus fragments a read admitted at ``ceiling`` may count."""
    if _CEILING_RANK[ceiling] >= _CEILING_RANK[WireTierCeiling.PERSONAL.value]:
        return _CORPUS_FRAGMENT_COUNT
    return _OPEN_FRAGMENT_COUNT


def _counted_share(ceiling: str) -> float:
    """Return the share of the whole corpus a read at ``ceiling`` is allowed to see."""
    return _counted_fragments(ceiling) / _CORPUS_FRAGMENT_COUNT


class _CeilingGatedVault:
    """A fake ``/v1`` that admits every call at the ceiling the caller declared.

    Transcribes three rules from Creek, and nothing else:

    1. The admitted ceiling is ``X-Creek-Tier-Ceiling``, defaulting to ``open``
       when the header is absent (``httpapi/middleware/ceiling.py``).
    2. A ceiling outside the two a remote caller may request is refused ``422
       invalid_request`` (``policy.py``), so a client that sends ``intimate``
       fails loudly here rather than being quietly narrowed.
    3. A journal write whose entry tier outranks the admitted ceiling is refused
       ``403 privacy_refused`` (``httpapi/journal.py``), and a wheel read counts
       only fragments at or below it (``httpapi/wheel.py``).

    ``GET /v1/capabilities`` is served unconditionally: it carries no content, so
    no ceiling can be too narrow for it.
    """

    def __init__(self, capabilities: Sequence[str]) -> None:
        """Advertise ``capabilities`` and start an empty request log."""
        self._capabilities = list(capabilities)
        self.requests: list[httpx.Request] = []

    def requests_to(self, path_prefix: str) -> list[httpx.Request]:
        """Return every recorded request whose path starts with ``path_prefix``."""
        return [r for r in self.requests if r.url.path.startswith(path_prefix)]

    def declared_ceiling(self, path_prefix: str) -> str | None:
        """Return the ceiling declared on the one request to ``path_prefix``."""
        (request,) = self.requests_to(path_prefix)
        declared: str | None = request.headers.get(_CREEK_CEILING_HEADER)
        return declared

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then admit it at its declared ceiling or refuse it."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=_handshake_payload(self._capabilities))
        ceiling = request.headers.get(_CREEK_CEILING_HEADER, _CREEK_ABSENT_HEADER_CEILING)
        if ceiling not in _REMOTE_ADMITTED:
            return httpx.Response(
                HTTPStatus.UNPROCESSABLE_ENTITY, json=_error_body("invalid_request")
            )
        return self._route(request, ceiling)

    def _route(self, request: httpx.Request, ceiling: str) -> httpx.Response:
        """Dispatch an admitted request to the capability that serves it."""
        if request.url.path.startswith(_JOURNAL_PATH_PREFIX):
            return self._journal_upsert(request, ceiling)
        if request.url.path == _WHEEL_PATH:
            return self._wheel(ceiling)
        return self._reflection(ceiling)

    def _journal_upsert(self, request: httpx.Request, ceiling: str) -> httpx.Response:
        """Store the entry, or refuse it when its own tier outranks the ceiling."""
        tier = str(json.loads(request.content)["tier"])
        if _CEILING_RANK[tier] > _CEILING_RANK[ceiling]:
            return httpx.Response(HTTPStatus.FORBIDDEN, json=_error_body("privacy_refused"))
        return httpx.Response(
            HTTPStatus.OK,
            json={
                "status": "ok",
                "tier_ceiling": ceiling,
                "external_id": str(_ENTRY_ID),
                "fragment_id": _FRAGMENT_ID,
                "action": "created",
                "tier": tier,
            },
        )

    def _wheel(self, ceiling: str) -> httpx.Response:
        """Answer a wheel computed over exactly the fragments ``ceiling`` admits.

        Every Frequency reports the same count and share, so the only thing that
        moves between two reads is the ceiling that was declared -- which is the
        one variable under test.
        """
        counted = _counted_fragments(ceiling)
        share = _counted_share(ceiling)
        return httpx.Response(
            HTTPStatus.OK,
            json={
                "status": "ok",
                "tier_ceiling": ceiling,
                "total_classified": counted,
                "unclassified": 0,
                "wheel": {
                    code: {"count": counted, "name": name, "share": share}
                    for code, name in _FREQUENCY_NAMES.items()
                },
            },
        )

    def _reflection(self, ceiling: str) -> httpx.Response:
        """Answer a reflection echoing the ceiling it was admitted at."""
        return httpx.Response(
            HTTPStatus.OK,
            json={
                "status": "ok",
                "tier_ceiling": ceiling,
                "routed_tier": ceiling,
                "essay": None,
                "essay_grounded": False,
                "notes": [
                    {"kind": "pattern", "quote": _ENTRY_BODY, "note": "you have said this before"}
                ],
            },
        )


@pytest_asyncio.fixture
async def http_clients() -> AsyncGenerator[ClientFactory, None]:
    """Yield a factory for MockTransport-backed clients, closing each afterwards."""
    created: list[httpx.AsyncClient] = []

    def _build(handler: Handler) -> httpx.AsyncClient:
        """Build one in-memory client and register it for teardown."""
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        created.append(client)
        return client

    yield _build
    for client in created:
        await client.aclose()


async def _handshaken(
    handler: _CeilingGatedVault, http_clients: ClientFactory
) -> HttpCreekVaultClient:
    """Return a client that has completed its handshake against ``handler``."""
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    await client.handshake()
    return client


def _ingest_request(tier: VaultTierCeiling) -> VaultIngestRequest:
    """Build an ingest request whose entry tier and write ceiling are both ``tier``."""
    return VaultIngestRequest(
        entry_id=_ENTRY_ID,
        body=_ENTRY_BODY,
        tier=tier,
        tier_ceiling=tier,
        created_at=_CREATED_AT,
    )


def test_the_client_names_the_header_creek_reads() -> None:
    """Adepthood's header constant is the string Creek's middleware looks up."""
    assert _CEILING_HEADER == _CREEK_CEILING_HEADER


@pytest.mark.asyncio
async def test_the_gate_refuses_a_personal_entry_when_no_ceiling_is_declared(
    http_clients: ClientFactory,
) -> None:
    """The fake's refusing side, proved before any client assertion leans on it.

    Sent by hand with no ceiling header at all -- the request adepthood used to
    make -- so a later "the ingest succeeded" cannot be the fixture being
    agreeable.
    """
    handler = _CeilingGatedVault([CreekCapability.JOURNAL.value])
    response = await http_clients(handler).put(
        f"{_VAULT_URL}{_JOURNAL_PATH_PREFIX}{_ENTRY_ID}",
        json={"content": _ENTRY_BODY, "timestamp": _CREATED_AT.isoformat(), "tier": "personal"},
    )

    assert response.status_code == HTTPStatus.FORBIDDEN
    assert response.json()["code"] == "privacy_refused"


@pytest.mark.asyncio
async def test_the_gate_admits_a_personal_entry_under_a_personal_ceiling(
    http_clients: ClientFactory,
) -> None:
    """The fake's quiet side: the same write, declared honestly, is stored."""
    handler = _CeilingGatedVault([CreekCapability.JOURNAL.value])
    response = await http_clients(handler).put(
        f"{_VAULT_URL}{_JOURNAL_PATH_PREFIX}{_ENTRY_ID}",
        headers={_CREEK_CEILING_HEADER: "personal"},
        json={"content": _ENTRY_BODY, "timestamp": _CREATED_AT.isoformat(), "tier": "personal"},
    )

    assert response.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_a_personal_entry_replicates_and_declares_a_personal_ceiling(
    http_clients: ClientFactory,
) -> None:
    """The defect, stated as behaviour: the default journal entry must store."""
    handler = _CeilingGatedVault([CreekCapability.JOURNAL.value])
    client = await _handshaken(handler, http_clients)

    result = await client.ingest(_ingest_request(VaultTierCeiling.PERSONAL))

    assert result.stored is True
    assert result.vault_ref == _FRAGMENT_ID
    assert handler.declared_ceiling(_JOURNAL_PATH_PREFIX) == "personal"


@pytest.mark.asyncio
async def test_a_public_entry_declares_the_open_ceiling(
    http_clients: ClientFactory,
) -> None:
    """The ceiling is derived from the entry, not pinned to the widest value.

    The companion of the personal case: a constant ``personal`` would pass that
    test and this one is what refuses it.
    """
    handler = _CeilingGatedVault([CreekCapability.JOURNAL.value])
    client = await _handshaken(handler, http_clients)

    result = await client.ingest(_ingest_request(VaultTierCeiling.OPEN))

    assert result.stored is True
    assert handler.declared_ceiling(_JOURNAL_PATH_PREFIX) == "open"


@pytest.mark.asyncio
async def test_the_wheel_read_declares_a_ceiling_that_admits_personal_fragments(
    http_clients: ClientFactory,
) -> None:
    """A wheel read at ``open`` silently drops personal material; this asserts it does not."""
    handler = _CeilingGatedVault([CreekCapability.WHEEL.value])
    client = await _handshaken(handler, http_clients)

    balance = await client.wheel()

    assert handler.declared_ceiling(_WHEEL_PATH) == _WHEEL_TIER_CEILING.value
    seen = {aspect.fullness for aspect in balance.aspects}
    assert seen == {_counted_share(WireTierCeiling.PERSONAL.value)}
    assert seen != {_counted_share(_CREEK_ABSENT_HEADER_CEILING)}


@pytest.mark.asyncio
async def test_the_reflection_declares_the_entrys_own_ceiling(
    http_clients: ClientFactory,
) -> None:
    """A reflection is grounded in the corpus the writer's own tier authorizes."""
    handler = _CeilingGatedVault([CreekCapability.REFLECT.value])
    client = await _handshaken(handler, http_clients)

    reflection = await client.reflect(_ENTRY_BODY, VaultTierCeiling.PERSONAL)

    assert reflection.notes
    assert handler.declared_ceiling(_REFLECTIONS_PATH) == "personal"


@pytest.mark.asyncio
async def test_the_capability_handshake_declares_the_most_restrictive_ceiling(
    http_clients: ClientFactory,
) -> None:
    """The handshake reads no user material, so it declares the narrowest ceiling."""
    handler = _CeilingGatedVault([CreekCapability.JOURNAL.value])
    await _handshaken(handler, http_clients)

    assert handler.declared_ceiling(_CAPABILITIES_PATH) == _CREEK_ABSENT_HEADER_CEILING


def test_the_wire_vocabulary_cannot_express_intimate() -> None:
    """Creek's wire ceilings are the two a remote caller may request, and no more."""
    assert {ceiling.value for ceiling in WireTierCeiling} == _REMOTE_ADMITTED
    assert VaultTierCeiling.INTIMATE.value not in _REMOTE_ADMITTED


def test_wire_ceiling_for_maps_the_two_expressible_tiers() -> None:
    """The quiet side: both representable ceilings translate, and keep their value."""
    assert wire_ceiling_for(VaultTierCeiling.OPEN) is WireTierCeiling.OPEN
    assert wire_ceiling_for(VaultTierCeiling.PERSONAL) is WireTierCeiling.PERSONAL


def test_wire_ceiling_for_refuses_intimate() -> None:
    """The noisy side: an intimate ceiling has no wire spelling, so it raises."""
    with pytest.raises(CreekCeilingUnrepresentableError) as exc_info:
        wire_ceiling_for(VaultTierCeiling.INTIMATE)

    error = exc_info.value
    assert isinstance(error, CreekVaultContractError)
    assert VaultTierCeiling.INTIMATE.value not in str(error)


@pytest.mark.asyncio
async def test_an_intimate_ingest_never_reaches_the_wire(
    http_clients: ClientFactory,
) -> None:
    """Reaching the adapter with an intimate ceiling refuses before any request is sent."""
    handler = _CeilingGatedVault([CreekCapability.JOURNAL.value])
    client = await _handshaken(handler, http_clients)

    with pytest.raises(CreekCeilingUnrepresentableError):
        await client.ingest(_ingest_request(VaultTierCeiling.INTIMATE))

    assert handler.requests_to(_JOURNAL_PATH_PREFIX) == []
    assert _ENTRY_BODY not in "".join(r.read().decode() for r in handler.requests)


@pytest.mark.asyncio
async def test_the_write_path_withholds_an_intimate_classification(
    http_clients: ClientFactory,
) -> None:
    """The first guard: the classification adepthood spells ``intimate`` never calls out."""
    handler = _CeilingGatedVault([CreekCapability.JOURNAL.value])
    client = await _handshaken(handler, http_clients)
    handler.requests.clear()

    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_ENTRY_BODY,
        classification=JournalClassification.INTIMATE.value,
        created_at=_CREATED_AT,
    )

    assert outcome.status is VaultWriteStatus.SKIPPED_INTIMATE
    assert handler.requests == []


@pytest.mark.asyncio
async def test_the_write_path_withholds_any_classification_resolving_to_intimate(
    http_clients: ClientFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The second guard: withholding keys off the resolved tier, not one spelling.

    A classification added later that maps to ``intimate`` -- a second intimate
    spelling, a renamed one -- is caught by the tier it resolves to, not by the
    single string the first guard compares against. Without this guard that
    entry reaches the client and is refused only there.
    """
    added = "sealed"
    monkeypatch.setattr(
        "domain.creek_vault.TIER_CEILING_BY_CLASSIFICATION",
        {**TIER_CEILING_BY_CLASSIFICATION, added: VaultTierCeiling.INTIMATE},
    )
    handler = _CeilingGatedVault([CreekCapability.JOURNAL.value])
    client = await _handshaken(handler, http_clients)
    handler.requests.clear()

    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_ENTRY_BODY,
        classification=added,
        created_at=_CREATED_AT,
    )

    assert outcome.status is VaultWriteStatus.SKIPPED_INTIMATE
    assert handler.requests == []
