"""Tests for the Creek Vault write path (services.creek_vault_write).

This is the TDD RED suite: services.creek_vault_write does not exist yet, so
every test here fails on import until the implementation specialist writes
the module against the signatures documented in the module docstring these
tests assume.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator, Callable, Iterator
from datetime import UTC, datetime
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultContractError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultErrorCode,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflection,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultWheelBalance,
)
from services.creek_vault_client import HttpCreekVaultClient, LocalFallbackCreekVaultClient
from services.creek_vault_telemetry import (
    reset_vault_telemetry_for_tests,
    vault_outcome_counts,
)
from services.creek_vault_write import (
    VaultDegradeReason,
    VaultWriteOutcome,
    VaultWriteStatus,
    store_and_classify,
)
from tests.test_creek_vault_http_client import Handler as _VaultHandler
from tests.test_creek_vault_http_client import _handshake_payload as _vault_capability_payload
from tests.test_creek_vault_http_client import _json_handler as _vault_json_handler
from tests.test_creek_vault_http_client import _raising_handler as _vault_raising_handler
from tests.test_creek_vault_http_client import _text_handler as _vault_text_handler

_CREATED_AT = datetime(2026, 7, 10, 12, 0, tzinfo=UTC)
_BODY = "A quiet entry about the week's practice."

_ENTRY_ID = 101

# Any authenticated caller: the paths exercised here have no vault to belong to
# anyone, so which user asks makes no difference to what they are handed.
_ANY_USER_ID = 1

# A body and an error text distinctive enough to spot in any log record. The
# degrade log must be a static message with content-free structured fields, so
# neither the writer's words nor a vault's own error prose may appear.
_SENTINEL_BODY = "SENTINEL_JOURNAL_BODY_DO_NOT_LOG"
_SENTINEL_ERROR_TEXT = "SENTINEL_VAULT_ERROR_TEXT_DO_NOT_LOG"

_DEGRADED_OUTCOME = VaultWriteOutcome(status=VaultWriteStatus.DEGRADED, vault_ref=None, tags=())


def _empty_reflection() -> VaultReflection:
    """Return the reflection an unexercised reflect path answers with.

    The vault said nothing, successfully -- which is a different fact from an
    unreachable one, and this path asserts neither.
    """
    return VaultReflection(
        status=VaultReflectionStatus.EMPTY,
        notes=(),
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.OPEN,
    )


class RecordingVaultClient:
    """Fake CreekVaultClient that records every call and returns scripted results."""

    def __init__(
        self,
        *,
        available: bool = True,
        capabilities: frozenset[CreekCapability] = frozenset({CreekCapability.JOURNAL}),
        ingest: VaultIngestResult | Exception | None = None,
        classify: VaultClassification | Exception | None = None,
    ) -> None:
        """Store the scripted handshake/ingest/classify behavior for this fake.

        ``ingest`` and ``classify`` each take either the scripted success result
        or an ``Exception`` to raise when that method is called.
        """
        self.calls: list[tuple[str, object]] = []
        self._available = available
        self._capabilities = capabilities
        self._ingest = ingest or VaultIngestResult(stored=True, vault_ref="ref-default")
        self._classify = classify or VaultClassification(tags=())

    async def handshake(self) -> HandshakeResult:
        """Record the call and return the scripted availability/capabilities."""
        self.calls.append(("handshake", None))
        return HandshakeResult(
            available=self._available,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Return the scripted availability without recording a call."""
        return self._available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether ``capability`` is in the scripted capability set."""
        return capability in self._capabilities

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Record the ingest request, then raise or return the scripted result."""
        self.calls.append(("ingest", request))
        if isinstance(self._ingest, Exception):
            raise self._ingest
        return self._ingest

    async def classify(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Record the classify call, then raise or return the scripted result."""
        self.calls.append(("classify", (body, tier_ceiling)))
        if isinstance(self._classify, Exception):
            raise self._classify
        return self._classify

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Record the reflect call and answer with an empty reflection (unused here)."""
        self.calls.append(("reflect", (body, tier_ceiling)))
        return _empty_reflection()

    async def wheel(self) -> VaultWheelBalance:
        """Record the wheel call and return an empty balance (unused here)."""
        self.calls.append(("wheel", None))
        return VaultWheelBalance(aspects=())


@pytest.fixture(autouse=True)
def _reset_vault_telemetry() -> Iterator[None]:
    """Empty the process-wide outcome counters around every test in this module.

    The counters are process-wide by design, so without this the pin below would
    observe whatever its neighbours happened to record first.
    """
    reset_vault_telemetry_for_tests()
    yield
    reset_vault_telemetry_for_tests()


def _call_names(client: RecordingVaultClient) -> list[str]:
    """Return the ordered list of method names the fake recorded."""
    return [name for name, _args in client.calls]


def _ingest_request(client: RecordingVaultClient) -> VaultIngestRequest:
    """Return the single VaultIngestRequest the fake recorded on ingest."""
    args = next(a for name, a in client.calls if name == "ingest")
    assert isinstance(args, VaultIngestRequest)
    return args


@pytest.mark.asyncio
async def test_intimate_entry_skips_and_never_touches_client() -> None:
    """An intimate entry never calls the vault -- not even handshake()."""
    client = RecordingVaultClient()
    outcome = await store_and_classify(
        client, body=_BODY, classification="intimate", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.SKIPPED_INTIMATE, vault_ref=None, tags=()
    )
    assert client.calls == []


@pytest.mark.asyncio
async def test_unavailable_vault_returns_unavailable_status() -> None:
    """A handshake reporting unavailable degrades to UNAVAILABLE, never calling ingest."""
    client = RecordingVaultClient(available=False, capabilities=frozenset())
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.UNAVAILABLE, vault_ref=None, tags=()
    )
    assert _call_names(client) == ["handshake"]


@pytest.mark.asyncio
async def test_available_but_ingest_unsupported_returns_unavailable_status() -> None:
    """An available vault that does not advertise JOURNAL also degrades to UNAVAILABLE."""
    client = RecordingVaultClient(available=True, capabilities=frozenset({CreekCapability.REFLECT}))
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome.status == VaultWriteStatus.UNAVAILABLE
    assert outcome.vault_ref is None
    assert outcome.tags == ()
    assert _call_names(client) == ["handshake"]


@pytest.mark.asyncio
async def test_public_classification_maps_to_open_tier_ceiling() -> None:
    """A public entry's ingest request carries the OPEN tier ceiling."""
    client = RecordingVaultClient(ingest=VaultIngestResult(stored=True, vault_ref="ref-open"))
    await store_and_classify(
        client, body=_BODY, classification="public", created_at=_CREATED_AT, entry_id=101
    )
    ingest_call = _ingest_request(client)
    assert ingest_call.tier_ceiling == VaultTierCeiling.OPEN


@pytest.mark.asyncio
async def test_personal_classification_maps_to_personal_tier_ceiling() -> None:
    """A personal entry's ingest request carries the PERSONAL tier ceiling."""
    client = RecordingVaultClient(ingest=VaultIngestResult(stored=True, vault_ref="ref-personal"))
    await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    ingest_call = _ingest_request(client)
    assert ingest_call.tier_ceiling == VaultTierCeiling.PERSONAL


@pytest.mark.asyncio
async def test_ingest_request_carries_body_created_at_and_entry_id() -> None:
    """The mapped VaultIngestRequest carries the caller's body, timestamp, id, and tier."""
    client = RecordingVaultClient()
    await store_and_classify(
        client,
        body=_BODY,
        classification="personal",
        created_at=_CREATED_AT,
        entry_id=101,
    )
    ingest_call = _ingest_request(client)
    assert ingest_call.body == _BODY
    assert ingest_call.created_at == _CREATED_AT
    assert ingest_call.entry_id == 101
    assert ingest_call.tier == VaultTierCeiling.PERSONAL


@pytest.mark.asyncio
async def test_ingest_success_without_classify_support_returns_ingested_empty_tags() -> None:
    """A vault supporting only INGEST returns INGESTED with the vault_ref and empty tags."""
    client = RecordingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL}),
        ingest=VaultIngestResult(stored=True, vault_ref="ref-x"),
    )
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.INGESTED, vault_ref="ref-x", tags=()
    )
    assert _call_names(client) == ["handshake", "ingest"]


@pytest.mark.asyncio
async def test_journal_write_never_classifies_even_with_classify_advertised() -> None:
    """The journal write path never calls classify, even when CLASSIFY is advertised."""
    client = RecordingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL, CreekCapability.CLASSIFY}),
        ingest=VaultIngestResult(stored=True, vault_ref="ref-y"),
        classify=VaultClassification(tags=("courage", "shadow")),
    )
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.INGESTED, vault_ref="ref-y", tags=()
    )
    assert _call_names(client) == ["handshake", "ingest"]


@pytest.mark.asyncio
async def test_ingest_raising_creek_vault_error_returns_degraded_without_raising() -> None:
    """A CreekVaultError from ingest() degrades to DEGRADED rather than propagating."""
    client = RecordingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL}),
        ingest=CreekVaultUnavailableError("creek vault call failed: creek.journal"),
    )
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(status=VaultWriteStatus.DEGRADED, vault_ref=None, tags=())


@pytest.mark.asyncio
async def test_ingest_reporting_not_stored_from_available_vault_returns_degraded() -> None:
    """stored=False from an available, supporting vault is a degraded write, not an ingest."""
    client = RecordingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL}),
        ingest=VaultIngestResult(stored=False, vault_ref=None),
    )
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(status=VaultWriteStatus.DEGRADED, vault_ref=None, tags=())


@pytest.mark.asyncio
async def test_classify_error_after_successful_ingest_still_returns_ingested() -> None:
    """A classify scripted to raise is never even called; the write stays INGESTED."""
    client = RecordingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL, CreekCapability.CLASSIFY}),
        ingest=VaultIngestResult(stored=True, vault_ref="ref-z"),
        classify=CreekVaultUnavailableError("creek vault call failed: creek.classify"),
    )
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.INGESTED, vault_ref="ref-z", tags=()
    )
    assert _call_names(client) == ["handshake", "ingest"]


@pytest.mark.asyncio
async def test_unknown_classification_raises_value_error_without_touching_client() -> None:
    """An unrecognized classification fails closed via tier_ceiling_for, before any vault call."""
    client = RecordingVaultClient()
    with pytest.raises(ValueError, match="bogus"):
        await store_and_classify(
            client, body=_BODY, classification="bogus", created_at=_CREATED_AT, entry_id=101
        )
    assert client.calls == []


@pytest.mark.asyncio
async def test_local_fallback_client_returns_unavailable_for_non_intimate_entry() -> None:
    """The real no-vault LocalFallbackCreekVaultClient degrades a non-intimate write."""
    client = LocalFallbackCreekVaultClient()
    outcome = await store_and_classify(
        client, body=_BODY, classification="personal", created_at=_CREATED_AT, entry_id=101
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.UNAVAILABLE, vault_ref=None, tags=()
    )


def test_get_creek_vault_client_returns_local_fallback_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no CREEK_VAULT_URL configured, the FastAPI provider yields the local fallback.

    The provider now takes the caller's user id, since a configured vault belongs
    to exactly one user; with no vault configured there is nobody it could belong
    to, so the id chosen here is immaterial.
    """
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    client = get_creek_vault_client(_ANY_USER_ID)
    assert isinstance(client, LocalFallbackCreekVaultClient)


def _logged_fields(caplog: pytest.LogCaptureFixture, field: str) -> list[object]:
    """Return every value of the structured ``field`` across the captured records."""
    return [
        value for record in caplog.records if (value := getattr(record, field, None)) is not None
    ]


async def _write_with(
    caplog: pytest.LogCaptureFixture,
    ingest: VaultIngestResult | Exception,
    body: str = _BODY,
) -> VaultWriteOutcome:
    """Run one write against a fake scripted with ``ingest``, capturing its logs afresh."""
    caplog.clear()
    client = RecordingVaultClient(ingest=ingest)
    return await store_and_classify(
        client, body=body, classification="personal", created_at=_CREATED_AT, entry_id=_ENTRY_ID
    )


@pytest.mark.asyncio
async def test_contract_failure_and_unavailability_log_distinct_reasons(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """One degraded outcome, two operator stories: a rejected payload is not a missing vault.

    Both failures must stay invisible to the caller (the entry is saved either
    way) and yet be countable apart, since a contract fault is fixed by changing
    adepthood and an availability fault is not.
    """
    caplog.set_level(logging.DEBUG)
    contract_outcome = await _write_with(
        caplog,
        CreekVaultContractError(
            "creek vault rejected the request", code=VaultErrorCode.INVALID_REQUEST
        ),
    )
    contract_reasons = _logged_fields(caplog, "reason")
    unavailable_outcome = await _write_with(
        caplog, CreekVaultUnavailableError("creek vault call failed: creek.journal")
    )
    unavailable_reasons = _logged_fields(caplog, "reason")

    assert contract_outcome == unavailable_outcome == _DEGRADED_OUTCOME
    assert contract_reasons == [VaultDegradeReason.CONTRACT.value]
    assert unavailable_reasons == [VaultDegradeReason.UNAVAILABLE.value]


@pytest.mark.asyncio
async def test_auth_failure_is_logged_as_auth_not_unavailable(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A rejected credential is its own reason: rotating a key is not restarting a vault."""
    caplog.set_level(logging.DEBUG)
    outcome = await _write_with(caplog, CreekVaultAuthError("creek vault rejected the credential"))
    assert outcome == _DEGRADED_OUTCOME
    assert _logged_fields(caplog, "reason") == [VaultDegradeReason.AUTH.value]


@pytest.mark.parametrize(
    ("ingest", "expected"),
    [
        pytest.param(
            CreekCapabilityUnsupportedError("creek vault capability unsupported: creek.journal"),
            VaultDegradeReason.UNSUPPORTED_CAPABILITY,
            id="unsupported_capability",
        ),
        pytest.param(
            VaultIngestResult(stored=False, vault_ref=None),
            VaultDegradeReason.NOT_STORED,
            id="not_stored",
        ),
    ],
)
@pytest.mark.asyncio
async def test_unsupported_capability_and_not_stored_log_their_own_reasons(
    ingest: VaultIngestResult | Exception,
    expected: VaultDegradeReason,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A refused capability and a vault that simply did not store are separately countable."""
    caplog.set_level(logging.DEBUG)
    outcome = await _write_with(caplog, ingest)
    assert outcome == _DEGRADED_OUTCOME
    assert _logged_fields(caplog, "reason") == [expected.value]


@pytest.mark.asyncio
async def test_successful_ingest_logs_the_action(caplog: pytest.LogCaptureFixture) -> None:
    """A durable write records which action the vault took, so edits stay visible."""
    caplog.set_level(logging.DEBUG)
    outcome = await _write_with(
        caplog,
        VaultIngestResult(stored=True, vault_ref="ref-a", action=VaultIngestAction.UPDATED),
    )
    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.INGESTED, vault_ref="ref-a", tags=()
    )
    assert _logged_fields(caplog, "action") == [VaultIngestAction.UPDATED.value]


@pytest.mark.parametrize(
    "ingest",
    [
        pytest.param(
            CreekVaultContractError(_SENTINEL_ERROR_TEXT, code=VaultErrorCode.INVALID_REQUEST),
            id="contract",
        ),
        pytest.param(CreekVaultAuthError(_SENTINEL_ERROR_TEXT), id="auth"),
        pytest.param(CreekVaultUnavailableError(_SENTINEL_ERROR_TEXT), id="unavailable"),
        pytest.param(CreekCapabilityUnsupportedError(_SENTINEL_ERROR_TEXT), id="unsupported"),
        pytest.param(VaultIngestResult(stored=False, vault_ref=None), id="not_stored"),
    ],
)
@pytest.mark.asyncio
async def test_degrade_logs_never_carry_the_entry_body_or_a_raw_vault_code(
    ingest: VaultIngestResult | Exception,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Every degrade log is a static message plus content-free fields -- no body, no vault prose."""
    caplog.set_level(logging.DEBUG)
    await _write_with(caplog, ingest, body=_SENTINEL_BODY)

    assert caplog.records
    for sentinel in (_SENTINEL_BODY, _SENTINEL_ERROR_TEXT):
        assert sentinel not in caplog.text
        for record in caplog.records:
            assert sentinel not in record.getMessage()
            assert sentinel not in str(record.__dict__)
    for code in _logged_fields(caplog, "code"):
        assert code in {member.value for member in VaultErrorCode}


def test_vault_degrade_reason_wire_values_are_stable() -> None:
    """The degrade reasons carry the exact strings telemetry will count."""
    assert [reason.value for reason in VaultDegradeReason] == [
        "contract",
        "auth",
        "unavailable",
        "unsupported_capability",
        "not_stored",
    ]


@pytest.mark.asyncio
async def test_intimate_entry_records_no_telemetry_outcome() -> None:
    """An intimate entry is counted nowhere: the short-circuit precedes telemetry too.

    Driven through the real local-fallback client, which records an outcome for
    every capability it is asked for -- so an empty counter can only mean the
    write path never reached it, rather than that nothing here records anything.
    """
    reset_vault_telemetry_for_tests()

    outcome = await store_and_classify(
        LocalFallbackCreekVaultClient(),
        body=_SENTINEL_BODY,
        classification="intimate",
        created_at=_CREATED_AT,
        entry_id=_ENTRY_ID,
    )

    assert outcome.status is VaultWriteStatus.SKIPPED_INTIMATE
    assert vault_outcome_counts() == {}


# A real vault URL and credential for the handshake pin below: the point of that
# test is that a *real* adapter, not a fake, is what the write path awaits.
_VAULT_URL = "https://vault.example.test"
_VAULT_API_KEY = "creek-vault-write-path-key"  # pragma: allowlist secret

_VaultClientFactory = Callable[[_VaultHandler], httpx.AsyncClient]

# Every way the capability probe can end badly, from a socket that never opened
# to a vault that answered fluently in a contract version we cannot read.
_UNUSABLE_VAULT_HANDLERS = [
    pytest.param(_vault_raising_handler(httpx.ConnectError("refused")), id="connection_refused"),
    pytest.param(_vault_raising_handler(httpx.InvalidURL("unbuildable")), id="unbuildable_request"),
    pytest.param(_vault_raising_handler(httpx.ReadTimeout("no answer")), id="timed_out"),
    pytest.param(
        _vault_json_handler({"detail": "boom"}, HTTPStatus.INTERNAL_SERVER_ERROR),
        id="server_error",
    ),
    pytest.param(
        _vault_json_handler({"detail": "unauthorized"}, HTTPStatus.UNAUTHORIZED),
        id="unauthorized",
    ),
    pytest.param(_vault_text_handler("<html><body>Bad Gateway</body></html>"), id="non_json_body"),
    pytest.param(
        _vault_json_handler(_vault_capability_payload([CreekCapability.JOURNAL.value], "0.3.0")),
        id="incompatible_contract_version",
    ),
]


@pytest_asyncio.fixture
async def vault_http_clients() -> AsyncGenerator[_VaultClientFactory, None]:
    """Yield a factory for MockTransport-backed clients, closing each afterwards."""
    created: list[httpx.AsyncClient] = []

    def _build(handler: _VaultHandler) -> httpx.AsyncClient:
        """Build one in-memory client and register it for teardown."""
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        created.append(client)
        return client

    yield _build
    for client in created:
        await client.aclose()


@pytest.mark.parametrize("handler", _UNUSABLE_VAULT_HANDLERS)
@pytest.mark.asyncio
async def test_a_failed_handshake_degrades_the_write_and_never_propagates(
    handler: _VaultHandler,
    vault_http_clients: _VaultClientFactory,
) -> None:
    """``store_and_classify`` awaits ``handshake()`` unguarded, which only holds if it cannot raise.

    That bare ``await`` is deliberate and stays that way: guarding it would mean
    catching ``Exception``, which this repository refuses and which the adapter's
    own counting wrapper argues against -- an unrelated internal bug must stay
    the loud defect it is. So the invariant it rests on is pinned here instead,
    at the call site, against a real :class:`HttpCreekVaultClient` rather than a
    fake that has been told not to raise. Every failure a probe can meet ends the
    same way: the write reports UNAVAILABLE, the caller persists the entry, and
    nothing reaches the router.
    """
    client = HttpCreekVaultClient(
        _VAULT_URL, _VAULT_API_KEY, http_client=vault_http_clients(handler)
    )

    outcome = await store_and_classify(
        client,
        body=_BODY,
        classification="personal",
        created_at=_CREATED_AT,
        entry_id=_ENTRY_ID,
    )

    assert outcome == VaultWriteOutcome(
        status=VaultWriteStatus.UNAVAILABLE, vault_ref=None, tags=()
    )
