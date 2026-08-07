"""Tests for the Creek Vault outcome counters in services.creek_vault_telemetry.

Two halves. The first is a unit suite over the module itself: the
error-to-outcome table, the counter arithmetic, the snapshot guarantee, and the
one static log event with its level tiering. The second is a content-safety
sweep that drives the *real* HTTP adapter through every failure and success
path an operator can reach, with sentinels planted in the entry body, the
credential, the vault's own note text, its fragment id, and its error prose --
then reads back every log record, every raised error, and every counter key to
prove none of them carries a byte a user or a vault chose.

Nothing here touches a network: each exchange runs over an
``httpx.MockTransport`` handler, exactly as ``test_creek_vault_http_client``
already does.
"""

from __future__ import annotations

import contextlib
import json
import logging
from collections.abc import AsyncGenerator, Callable, Coroutine, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio

from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultCareEscalationError,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    VaultErrorCode,
    VaultIngestAction,
    VaultIngestRequest,
    VaultTierCeiling,
)
from scripts.creek_contract_drift import BUNDLE_ROOT
from services.creek_vault_client import HttpCreekVaultClient, LocalFallbackCreekVaultClient
from services.creek_vault_telemetry import (
    VAULT_OUTCOME_EVENT,
    VaultCallTimedOutError,
    VaultTelemetryOutcome,
    outcome_for_error,
    record_vault_outcome,
    reset_vault_telemetry_for_tests,
    vault_outcome_counts,
)

_VAULT_URL = "https://vault.example.test"

_CAPABILITIES_PATH = "/v1/capabilities"

_ONTOLOGY_VERSION = "aptitude-wavelength/2026-05-23"

# A contract version two minor bumps away from the pin, which is the breaking
# change while the contract is still pre-1.0.
_SKEWED_CONTRACT_VERSION = "0.3.0"

_ENTRY_ID = 11

_CREATED_AT = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)

# Low-entropy fake strings, chosen so a secret scanner reads them as the prose
# they are. Each one stands for a different direction a leak could travel: the
# writer's own words and the credential go *out*, and the vault's fragment id,
# note text, and error prose come *back*. None of them may reach a log record, an
# exception, or a counter key.
_SENTINEL_BODY = "sentinel-entry-body-do-not-leak"
_SENTINEL_TOKEN = "sentinel-bearer-not-a-real-token"  # pragma: allowlist secret
_SENTINEL_NOTE = "sentinel-note-text-do-not-leak"
_SENTINEL_FRAGMENT = "sentinel-fragment-id-do-not-leak"

_SENTINELS: tuple[str, ...] = (
    _SENTINEL_BODY,
    _SENTINEL_TOKEN,
    _SENTINEL_NOTE,
    _SENTINEL_FRAGMENT,
)

# The capabilities a healthy scripted vault advertises: every ratified surface,
# so one handler serves the ingest, reflect, and wheel exchanges alike.
_RATIFIED_CAPABILITIES: tuple[str, ...] = (
    CreekCapability.JOURNAL.value,
    CreekCapability.REFLECT.value,
    CreekCapability.WHEEL.value,
)

Handler = Callable[[httpx.Request], httpx.Response]
ClientFactory = Callable[[Handler], httpx.AsyncClient]
VaultCall = Callable[[HttpCreekVaultClient], Coroutine[None, None, None]]
CounterKey = tuple[VaultTelemetryOutcome, CreekCapability]


def _ingest_request(body: str = _SENTINEL_BODY) -> VaultIngestRequest:
    """Build an open-tier ingest request carrying ``body``."""
    return VaultIngestRequest(
        entry_id=_ENTRY_ID,
        body=body,
        tier=VaultTierCeiling.OPEN,
        tier_ceiling=VaultTierCeiling.OPEN,
        created_at=_CREATED_AT,
    )


def _sentinel_error_body(code: VaultErrorCode) -> dict[str, object]:
    """Build a vault error body whose prose quotes the entry body straight back.

    A real vault would not do this, which is the point: the adapter must drop
    every string a vault chose, so a hostile one cannot use its own error prose
    as a channel into adepthood's logs.
    """
    return {
        "code": code.value,
        "message": f"could not store: {_SENTINEL_BODY}",
        "request_id": _SENTINEL_FRAGMENT,
    }


def _bundle_example(collection: str, state: str) -> dict[str, object]:
    """Return one vendored contract example body, decoded fresh on every call."""
    decoded = json.loads((BUNDLE_ROOT / f"examples/{collection}/{state}.json").read_bytes())
    assert isinstance(decoded, dict), state
    return decoded


def _reflection_with_sentinels() -> dict[str, object]:
    """Return the published reflection example with sentinel note text substituted.

    The note and the quote are the user's own words coming back out of the
    vault, so they are exactly the material a telemetry record must never carry.
    """
    body = _bundle_example("reflections", "success")
    body["notes"] = [{"kind": "pattern", "note": _SENTINEL_NOTE, "quote": _SENTINEL_BODY}]
    return body


@dataclass(frozen=True)
class _Reply:
    """One scripted answer to a capability call: a status plus a JSON or text body."""

    status: int = HTTPStatus.OK
    payload: object = None
    text: str | None = None
    error: Exception | None = None

    def to_response(self) -> httpx.Response:
        """Build the response this reply describes, or raise its transport failure."""
        if self.error is not None:
            raise self.error
        if self.text is not None:
            return httpx.Response(self.status, text=self.text)
        return httpx.Response(self.status, json=self.payload)


class _ScriptedVault:
    """Handler answering a capability document plus one scripted reply for every other route.

    One handler rather than three, because these tests care about *which
    outcome* a call records rather than about the wire shape of each exchange:
    the capability document is routed by path and everything else takes the one
    scripted answer, whichever capability asked for it.
    """

    def __init__(
        self,
        reply: _Reply | None = None,
        *,
        capabilities: Sequence[str] = _RATIFIED_CAPABILITIES,
        contract_version: str = CONTRACT_VERSION,
    ) -> None:
        """Store the advertised capability document and the one scripted answer."""
        self._reply = reply if reply is not None else _Reply(payload={})
        self._capabilities = list(capabilities)
        self._contract_version = contract_version

    def _capability_document(self) -> dict[str, object]:
        """Build the capability document this scripted vault advertises."""
        return {
            "available": True,
            "capabilities": self._capabilities,
            "contract_version": self._contract_version,
            "ontology_version": _ONTOLOGY_VERSION,
            "attestation": None,
        }

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer the capability document, or the scripted reply for anything else."""
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=self._capability_document())
        return self._reply.to_response()


_STORED_REPLY = _Reply(
    payload={"action": VaultIngestAction.CREATED.value, "fragment_id": _SENTINEL_FRAGMENT}
)
_NOT_STORED_REPLY = _Reply(payload={"action": VaultIngestAction.CREATED.value})
_GARBAGE_REPLY = _Reply(text=f"<html><body>{_SENTINEL_BODY}</body></html>")
_SERVER_ERROR_REPLY = _Reply(
    status=HTTPStatus.INTERNAL_SERVER_ERROR, payload={"detail": _SENTINEL_BODY}
)
_UNAUTHORIZED_REPLY = _Reply(status=HTTPStatus.UNAUTHORIZED, payload={"detail": _SENTINEL_TOKEN})
_INVALID_REQUEST_REPLY = _Reply(
    status=HTTPStatus.BAD_REQUEST, payload=_sentinel_error_body(VaultErrorCode.INVALID_REQUEST)
)
_PRIVACY_REFUSED_REPLY = _Reply(
    status=HTTPStatus.FORBIDDEN, payload=_sentinel_error_body(VaultErrorCode.PRIVACY_REFUSED)
)
_TIMEOUT_REPLY = _Reply(error=httpx.ReadTimeout("vault never answered"))


@pytest.fixture(autouse=True)
def _reset_vault_telemetry() -> Iterator[None]:
    """Empty the process-wide outcome counters around every test in this module."""
    reset_vault_telemetry_for_tests()
    yield
    reset_vault_telemetry_for_tests()


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


async def _handshaken(handler: Handler, http_clients: ClientFactory) -> HttpCreekVaultClient:
    """Build a client over ``handler`` and complete its handshake before returning it."""
    client = HttpCreekVaultClient(_VAULT_URL, _SENTINEL_TOKEN, http_client=http_clients(handler))
    await client.handshake()
    return client


async def _raised(call: Coroutine[None, None, object]) -> BaseException:
    """Await ``call`` and return the vault exception it raised."""
    try:
        await call
    except (CreekVaultError, CreekVaultCareEscalationError) as error:
        return error
    pytest.fail("expected the vault call to raise")


def test_the_outcome_event_is_one_static_string() -> None:
    """The log event is a constant, so an operator can grep for exactly one message."""
    assert VAULT_OUTCOME_EVENT == "creek vault outcome"


def test_outcome_wire_values_are_stable() -> None:
    """The outcomes carry the exact strings a dashboard will count, in a pinned order."""
    assert [outcome.value for outcome in VaultTelemetryOutcome] == [
        "vault_success",
        "vault_fallback_unconfigured",
        "vault_unavailable",
        "vault_timeout",
        "vault_auth_failed",
        "vault_incompatible_version",
        "vault_schema_failure",
        "vault_contract_failure",
        "vault_capability_unsupported",
        "vault_refused",
        "vault_escalated",
    ]


def test_a_timed_out_call_is_still_an_unavailable_error() -> None:
    """The timeout type subclasses unavailability, so every existing caller degrades unchanged."""
    error = VaultCallTimedOutError("creek vault call failed: creek.journal")
    assert isinstance(error, CreekVaultUnavailableError)
    assert isinstance(error, CreekVaultError)
    assert error.code is None


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        pytest.param(
            VaultCallTimedOutError("timed out"),
            VaultTelemetryOutcome.TIMEOUT,
            id="timed_out_before_unavailable",
        ),
        pytest.param(
            CreekVaultCareEscalationError(),
            VaultTelemetryOutcome.ESCALATED,
            id="care_escalation",
        ),
        pytest.param(
            CreekVaultAuthError("denied"),
            VaultTelemetryOutcome.AUTH_FAILED,
            id="auth_failed",
        ),
        pytest.param(
            CreekVaultContractError("refused", code=VaultErrorCode.PRIVACY_REFUSED),
            VaultTelemetryOutcome.REFUSED,
            id="privacy_refused",
        ),
        pytest.param(
            CreekVaultContractError("skewed", code=VaultErrorCode.INCOMPATIBLE_VERSION),
            VaultTelemetryOutcome.INCOMPATIBLE_VERSION,
            id="incompatible_version",
        ),
        pytest.param(
            CreekVaultContractError("rejected", code=VaultErrorCode.INVALID_REQUEST),
            VaultTelemetryOutcome.CONTRACT_FAILURE,
            id="invalid_request",
        ),
        pytest.param(
            CreekVaultContractError("rejected", code=VaultErrorCode.NOT_FOUND),
            VaultTelemetryOutcome.CONTRACT_FAILURE,
            id="not_found",
        ),
        pytest.param(
            CreekVaultContractError("rejected"),
            VaultTelemetryOutcome.CONTRACT_FAILURE,
            id="uncoded_contract_error",
        ),
        pytest.param(
            CreekVaultPayloadError("unreadable"),
            VaultTelemetryOutcome.SCHEMA_FAILURE,
            id="schema_failure",
        ),
        pytest.param(
            CreekCapabilityUnsupportedError("unsupported"),
            VaultTelemetryOutcome.CAPABILITY_UNSUPPORTED,
            id="capability_unsupported",
        ),
        pytest.param(
            CreekVaultUnavailableError("absent"),
            VaultTelemetryOutcome.UNAVAILABLE,
            id="plain_unavailable",
        ),
        pytest.param(
            CreekVaultError("something else"),
            VaultTelemetryOutcome.UNAVAILABLE,
            id="bare_vault_error",
        ),
        pytest.param(
            RuntimeError("not a vault error at all"),
            VaultTelemetryOutcome.UNAVAILABLE,
            id="unrelated_error",
        ),
    ],
)
def test_outcome_for_error_classifies_every_branch(
    error: BaseException, expected: VaultTelemetryOutcome
) -> None:
    """Each error type maps to its own outcome, most specific first.

    The ordering is the load-bearing part: a timeout is an unavailability
    subclass and a payload error is a vault error, so a table that tested the
    wide types first would silently collapse three stories into one.
    """
    assert outcome_for_error(error) is expected


def test_record_increments_the_key_it_was_given_and_accumulates() -> None:
    """Recording the same outcome twice counts two, on one key."""
    record_vault_outcome(VaultTelemetryOutcome.SUCCESS, CreekCapability.JOURNAL)
    assert vault_outcome_counts() == {
        (VaultTelemetryOutcome.SUCCESS, CreekCapability.JOURNAL): 1,
    }
    record_vault_outcome(VaultTelemetryOutcome.SUCCESS, CreekCapability.JOURNAL)
    assert vault_outcome_counts() == {
        (VaultTelemetryOutcome.SUCCESS, CreekCapability.JOURNAL): 2,
    }


def test_the_same_outcome_stays_apart_per_capability() -> None:
    """The capability is part of the key, so a failing wheel never hides behind a healthy ingest."""
    record_vault_outcome(VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.WHEEL)
    record_vault_outcome(VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.REFLECT)
    record_vault_outcome(VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.REFLECT)
    assert vault_outcome_counts() == {
        (VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.WHEEL): 1,
        (VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.REFLECT): 2,
    }


def test_the_returned_counts_are_a_snapshot_not_a_live_view() -> None:
    """A snapshot taken before a later record still reads the earlier number."""
    key: CounterKey = (VaultTelemetryOutcome.SUCCESS, CreekCapability.WHEEL)
    record_vault_outcome(*key)
    snapshot = vault_outcome_counts()
    record_vault_outcome(*key)
    assert snapshot[key] == 1
    assert vault_outcome_counts()[key] == 2


def test_reset_empties_the_counters() -> None:
    """The reset helper clears every key, so one module's counts never reach another's."""
    record_vault_outcome(VaultTelemetryOutcome.SUCCESS, CreekCapability.JOURNAL)
    record_vault_outcome(VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.WHEEL)
    reset_vault_telemetry_for_tests()
    assert vault_outcome_counts() == {}


def test_recording_emits_exactly_one_static_record_with_structured_fields(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """One record per call: a constant message plus content-free structured fields."""
    caplog.set_level(logging.DEBUG)
    record_vault_outcome(VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.JOURNAL)

    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.getMessage() == VAULT_OUTCOME_EVENT
    assert record.__dict__["outcome"] == VaultTelemetryOutcome.UNAVAILABLE.value
    assert record.__dict__["capability"] == CreekCapability.JOURNAL.value


def test_the_code_field_is_absent_when_no_code_was_named(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A failure the vault named no code for carries no ``code`` field at all."""
    caplog.set_level(logging.DEBUG)
    record_vault_outcome(VaultTelemetryOutcome.CONTRACT_FAILURE, CreekCapability.REFLECT)
    assert "code" not in caplog.records[0].__dict__


def test_the_code_field_carries_the_vaults_own_reason_when_it_named_one(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A recognized code reaches the log record, and only ever as its enum value."""
    caplog.set_level(logging.DEBUG)
    record_vault_outcome(
        VaultTelemetryOutcome.REFUSED,
        CreekCapability.REFLECT,
        code=VaultErrorCode.PRIVACY_REFUSED,
    )
    assert caplog.records[0].__dict__["code"] == VaultErrorCode.PRIVACY_REFUSED.value


# The severity each outcome is expected to log at. A deployment that never had a
# vault is a choice rather than a fault, so it stays at DEBUG; a healthy answer
# and a care handoff are both news worth one INFO line; everything else is a
# fault an operator may need to act on.
_SEVERITY_BY_OUTCOME: Mapping[VaultTelemetryOutcome, int] = {
    VaultTelemetryOutcome.FALLBACK_UNCONFIGURED: logging.DEBUG,
    VaultTelemetryOutcome.SUCCESS: logging.INFO,
    VaultTelemetryOutcome.ESCALATED: logging.INFO,
    VaultTelemetryOutcome.UNAVAILABLE: logging.WARNING,
    VaultTelemetryOutcome.TIMEOUT: logging.WARNING,
    VaultTelemetryOutcome.AUTH_FAILED: logging.WARNING,
    VaultTelemetryOutcome.INCOMPATIBLE_VERSION: logging.WARNING,
    VaultTelemetryOutcome.SCHEMA_FAILURE: logging.WARNING,
    VaultTelemetryOutcome.CONTRACT_FAILURE: logging.WARNING,
    VaultTelemetryOutcome.CAPABILITY_UNSUPPORTED: logging.WARNING,
    VaultTelemetryOutcome.REFUSED: logging.WARNING,
}


@pytest.mark.parametrize(
    ("outcome", "level"),
    [
        pytest.param(outcome, level, id=outcome.value)
        for outcome, level in _SEVERITY_BY_OUTCOME.items()
    ],
)
def test_each_outcome_is_logged_at_its_own_severity(
    outcome: VaultTelemetryOutcome, level: int, caplog: pytest.LogCaptureFixture
) -> None:
    """An unconfigured vault is DEBUG, a healthy answer INFO, and every fault WARNING.

    The tiering is what keeps a deployment that never had a vault from filling an
    operator's warning stream with a fact they already chose.
    """
    caplog.set_level(logging.DEBUG)
    record_vault_outcome(outcome, CreekCapability.JOURNAL)
    assert caplog.records[0].levelno == level


def test_every_outcome_has_a_declared_severity() -> None:
    """The severity table above covers the whole enum, so no outcome logs by accident."""
    assert set(_SEVERITY_BY_OUTCOME) == set(VaultTelemetryOutcome)


async def _drive_ingest_paths(http_clients: ClientFactory) -> list[BaseException]:
    """Drive every journal-ingest answer a real vault can give, returning what raised."""
    stored = await _handshaken(_ScriptedVault(_STORED_REPLY), http_clients)
    assert (await stored.ingest(_ingest_request())).vault_ref == _SENTINEL_FRAGMENT

    not_stored = await _handshaken(_ScriptedVault(_NOT_STORED_REPLY), http_clients)
    assert (await not_stored.ingest(_ingest_request())).stored is False

    failures = (_GARBAGE_REPLY, _SERVER_ERROR_REPLY, _UNAUTHORIZED_REPLY, _INVALID_REQUEST_REPLY)
    raised: list[BaseException] = []
    for reply in (*failures, _TIMEOUT_REPLY):
        client = await _handshaken(_ScriptedVault(reply), http_clients)
        raised.append(await _raised(client.ingest(_ingest_request())))
    return raised


async def _drive_read_paths(http_clients: ClientFactory) -> list[BaseException]:
    """Drive the reflection and wheel reads, returning the errors they raised."""
    reflecting = await _handshaken(
        _ScriptedVault(_Reply(payload=_reflection_with_sentinels())), http_clients
    )
    reflection = await reflecting.reflect(_SENTINEL_BODY, VaultTierCeiling.PERSONAL)
    assert reflection.notes[0].note == _SENTINEL_NOTE

    escalating = await _handshaken(
        _ScriptedVault(_Reply(payload=_bundle_example("reflections", "care-escalation"))),
        http_clients,
    )
    refusing = await _handshaken(_ScriptedVault(_PRIVACY_REFUSED_REPLY), http_clients)

    wheeling = await _handshaken(
        _ScriptedVault(_Reply(payload=_bundle_example("wheel", "success"))), http_clients
    )
    assert len((await wheeling.wheel()).aspects) == TOTAL_STAGES

    skewed = HttpCreekVaultClient(
        _VAULT_URL,
        _SENTINEL_TOKEN,
        http_client=http_clients(_ScriptedVault(contract_version=_SKEWED_CONTRACT_VERSION)),
    )
    assert (await skewed.handshake()).available is False

    return [
        await _raised(escalating.reflect(_SENTINEL_BODY, VaultTierCeiling.PERSONAL)),
        await _raised(refusing.reflect(_SENTINEL_BODY, VaultTierCeiling.PERSONAL)),
    ]


async def _drive_fallback_paths() -> list[BaseException]:
    """Drive every local-fallback capability, returning the errors the reads raised."""
    client = LocalFallbackCreekVaultClient()
    assert (await client.handshake()).available is False
    assert (await client.ingest(_ingest_request())).stored is False
    return [
        await _raised(client.classify(_SENTINEL_BODY, VaultTierCeiling.OPEN)),
        await _raised(client.reflect(_SENTINEL_BODY, VaultTierCeiling.OPEN)),
        await _raised(client.wheel()),
    ]


def _record_values(record: logging.LogRecord) -> list[str]:
    """Render every field of one log record as text, message included."""
    return [record.getMessage(), *[str(value) for value in record.__dict__.values()]]


@pytest.mark.asyncio
async def test_no_user_or_vault_content_reaches_telemetry_from_any_real_path(
    caplog: pytest.LogCaptureFixture,
    http_clients: ClientFactory,
) -> None:
    """A failure here means telemetry leaked content it must never carry.

    Every sentinel stands for material adepthood promised to keep out of its
    observability surface: the writer's own words, the bearer credential, and the
    note text, fragment id, and error prose a vault chose. If any of them turns up
    in a log record, in a raised error, or in a counter key, the seam has become a
    channel for exactly the content it exists to protect.
    """
    caplog.set_level(logging.DEBUG)

    raised = [
        *await _drive_ingest_paths(http_clients),
        *await _drive_read_paths(http_clients),
        *await _drive_fallback_paths(),
    ]

    assert raised
    assert vault_outcome_counts()
    for sentinel in _SENTINELS:
        assert sentinel not in caplog.text
        for record in caplog.records:
            for rendered in _record_values(record):
                assert sentinel not in rendered
        for error in raised:
            assert sentinel not in str(error)
            assert sentinel not in repr(error)
        for outcome, capability in vault_outcome_counts():
            assert sentinel not in outcome.value
            assert sentinel not in capability.value


@pytest.mark.asyncio
async def test_every_counter_key_is_a_pair_of_closed_enum_members(
    http_clients: ClientFactory,
) -> None:
    """Labels come from two closed enums, so a vault can never choose a telemetry label.

    This is the by-construction half of the content-safety guarantee: the sweep
    above proves no free text got through today, and this proves free text has
    nowhere to go at all.
    """
    await _drive_ingest_paths(http_clients)
    await _drive_read_paths(http_clients)
    await _drive_fallback_paths()

    counts = vault_outcome_counts()
    assert counts
    for outcome, capability in counts:
        assert isinstance(outcome, VaultTelemetryOutcome)
        assert isinstance(capability, CreekCapability)


async def _attempt_ingest(client: HttpCreekVaultClient) -> None:
    """Attempt one journal ingest, absorbing whatever vault failure it raises."""
    with contextlib.suppress(CreekVaultError, CreekVaultCareEscalationError):
        await client.ingest(_ingest_request())


async def _attempt_reflect(client: HttpCreekVaultClient) -> None:
    """Attempt one reflection, absorbing whatever vault failure it raises."""
    with contextlib.suppress(CreekVaultError, CreekVaultCareEscalationError):
        await client.reflect(_SENTINEL_BODY, VaultTierCeiling.PERSONAL)


async def _attempt_wheel(client: HttpCreekVaultClient) -> None:
    """Attempt one wheel read, absorbing whatever vault failure it raises."""
    with contextlib.suppress(CreekVaultError, CreekVaultCareEscalationError):
        await client.wheel()


async def _attempt_classify(client: HttpCreekVaultClient) -> None:
    """Attempt one classification, which this adapter always refuses."""
    with contextlib.suppress(CreekVaultError, CreekVaultCareEscalationError):
        await client.classify(_SENTINEL_BODY, VaultTierCeiling.OPEN)


_ONE_OUTCOME_ATTEMPTS: tuple[tuple[str, _ScriptedVault, VaultCall], ...] = (
    ("ingest_stored", _ScriptedVault(_STORED_REPLY), _attempt_ingest),
    ("ingest_not_stored", _ScriptedVault(_NOT_STORED_REPLY), _attempt_ingest),
    ("ingest_unreadable_2xx", _ScriptedVault(_GARBAGE_REPLY), _attempt_ingest),
    ("ingest_server_error", _ScriptedVault(_SERVER_ERROR_REPLY), _attempt_ingest),
    ("ingest_unauthorized", _ScriptedVault(_UNAUTHORIZED_REPLY), _attempt_ingest),
    ("ingest_invalid_request", _ScriptedVault(_INVALID_REQUEST_REPLY), _attempt_ingest),
    ("ingest_timeout", _ScriptedVault(_TIMEOUT_REPLY), _attempt_ingest),
    ("reflect_ok", _ScriptedVault(_Reply(payload=_reflection_with_sentinels())), _attempt_reflect),
    (
        "reflect_escalation",
        _ScriptedVault(_Reply(payload=_bundle_example("reflections", "care-escalation"))),
        _attempt_reflect,
    ),
    ("reflect_refused", _ScriptedVault(_PRIVACY_REFUSED_REPLY), _attempt_reflect),
    (
        "wheel_ok",
        _ScriptedVault(_Reply(payload=_bundle_example("wheel", "success"))),
        _attempt_wheel,
    ),
    ("classify_unsupported", _ScriptedVault(), _attempt_classify),
)


@pytest.mark.parametrize(
    ("handler", "attempt"),
    [pytest.param(handler, attempt, id=name) for name, handler, attempt in _ONE_OUTCOME_ATTEMPTS],
)
@pytest.mark.asyncio
async def test_exactly_one_outcome_is_recorded_per_attempt(
    handler: _ScriptedVault,
    attempt: VaultCall,
    http_clients: ClientFactory,
) -> None:
    """One capability attempt records one outcome -- never two, never none.

    The handshake is its own attempt and records its own outcome, so it is
    completed *before* the counters are cleared; what the assertion sees is the
    single capability call that followed.
    """
    client = await _handshaken(handler, http_clients)
    reset_vault_telemetry_for_tests()

    await attempt(client)

    assert sum(vault_outcome_counts().values()) == 1
