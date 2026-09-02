"""Unit tests for the Creek Vault reflection seam.

The seam now hands back a structured :class:`~domain.creek_vault.VaultReflection`
rather than a string, so the six reflection outcomes stay distinguishable all the
way to the consumer: an empty answer is a legitimate answer, a schema failure is
observable apart from vault absence, and a care escalation is not a degrade at
all. The strict marginalia JSON the cloud contract expects is built here, at the
``ResonanceLLM`` seam that owns it, rather than in the transport adapter.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator, Sequence
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultCareEscalationError,
    CreekVaultContractError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultErrorCode,
    VaultIngestRequest,
    VaultIngestResult,
    VaultPraxisKind,
    VaultPraxisStatus,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultRelatedEddy,
    VaultRelatedPraxis,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelBalance,
)
from domain.resonance import ResonanceLLM, generate_marginalia
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_read import _DEGRADED_EVENT, VaultReadDegradeReason
from services.creek_vault_reflect import (
    VaultRelatedSurfaces,
    VaultResonanceLLM,
    related_surfaces,
    select_reflection_llm,
)
from tests.vault_client_doubles import NoPipelineVaultDouble

_BODY = "the body under reflection"

# A body plus two verbatim substrings of it, so the vault's quotes anchor for
# real rather than being paraphrases the resonance pass would drop.
_LOOP_STALL_QUOTE = "I stalled again"
_LOOP_RIVER_QUOTE = "the river kept moving"
_LOOP_BODY = f"{_LOOP_STALL_QUOTE} this week, and yet {_LOOP_RIVER_QUOTE} without me."

_RIVER_NOTE = "Motion keeps answering the weeks you call stalled."
_STALL_NOTE = "You name the stall plainly before anything else."

# Free model prose a vault may attach alongside real notes. It is not the user's
# own words, so it must reach no marginalia contract, no anchored note, and no
# log record -- which is why it is a sentinel rather than plausible prose.
_SENTINEL_ESSAY = "SENTINEL_VAULT_ESSAY_DO_NOT_RENDER"

_VAULT_URL = "https://vault.example.test"
_API_KEY = "creek-vault-reflect-key"  # pragma: allowlist secret
_CAPABILITIES_PATH = "/v1/capabilities"


def _note(kind: str, quote: str, note: str) -> VaultReflectionNote:
    """Build one already-projected reflection note."""
    return VaultReflectionNote(kind=kind, quote=quote, note=note)


def _reflection(
    *notes: VaultReflectionNote,
    status: VaultReflectionStatus = VaultReflectionStatus.OK,
    essay: str | None = None,
    routed_tier: VaultTierCeiling = VaultTierCeiling.PERSONAL,
    related_praxis: tuple[VaultRelatedPraxis, ...] = (),
    related_eddies: tuple[VaultRelatedEddy, ...] = (),
) -> VaultReflection:
    """Build the structured reflection a wired vault hands back."""
    return VaultReflection(
        status=status,
        notes=notes,
        essay=essay,
        essay_grounded=False,
        routed_tier=routed_tier,
        related_praxis=related_praxis,
        related_eddies=related_eddies,
    )


# One compiled page of each kind, as the adapter hands them across the seam. Both
# are sentinels rather than plausible prose: every assertion below is about
# whether they travelled, so a value that could be mistaken for something the
# fallback produced would weaken the test.
_PRAXIS = VaultRelatedPraxis(
    title="Rest before the collapse",
    praxis_type=VaultPraxisKind.PRACTICE,
    status=VaultPraxisStatus.ACTIVE,
    excerpt="The page's own opening lines.",
)
_EDDY = VaultRelatedEddy(
    title="Rest and Ruin",
    description="A cluster the writer keeps returning to.",
    fragment_count=12,
    formed="2026-03-04",
)


class RecordingVaultClient(NoPipelineVaultDouble):
    """A scriptable, call-recording fake CreekVaultClient (reflect path only)."""

    def __init__(
        self,
        *,
        available: bool = True,
        capabilities: frozenset[CreekCapability] = frozenset({CreekCapability.REFLECT}),
        reflect_result: VaultReflection | None = None,
        reflect_error: Exception | None = None,
    ) -> None:
        """Store the scripted handshake outcome and reflect behavior."""
        self.handshake_calls = 0
        self.reflect_calls: list[tuple[str, VaultTierCeiling]] = []
        self._available = available
        self._capabilities = capabilities
        self._reflect_result = reflect_result if reflect_result is not None else _reflection()
        self._reflect_error = reflect_error

    async def handshake(self) -> HandshakeResult:
        """Record the call and return the scripted availability/capabilities."""
        self.handshake_calls += 1
        return HandshakeResult(
            available=self._available,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Return the scripted availability."""
        return self._available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether ``capability`` is in the scripted capability set."""
        return capability in self._capabilities

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Unused on the reflect path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Unused on this path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def classify(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Unused on the reflect path; raises if a test calls it by mistake."""
        raise NotImplementedError((body, tier_ceiling))

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Record the call, then raise the scripted error or return the scripted reflection."""
        self.reflect_calls.append((body, tier_ceiling))
        if self._reflect_error is not None:
            raise self._reflect_error
        return self._reflect_result

    async def wheel(self) -> VaultWheelBalance:
        """Unused on the reflect path; raises if a test calls it by mistake."""
        raise NotImplementedError


class RecordingFallbackLLM:
    """A stub ``ResonanceLLM`` that records every prompt it is given."""

    def __init__(self, result: str = "fallback reflection") -> None:
        """Store the sentinel completion text and start an empty prompt log."""
        self.prompts: list[str] = []
        self._result = result

    async def complete(self, prompt: str) -> str:
        """Record ``prompt`` and return the sentinel completion."""
        self.prompts.append(prompt)
        return self._result


class _RecordingTransportHandler:
    """A MockTransport handler that records every request that reached the wire."""

    def __init__(self, capabilities: Sequence[str]) -> None:
        """Store the advertised capabilities and start an empty request log."""
        self._capabilities = list(capabilities)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer the capability probe or a bare reflection."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(
                HTTPStatus.OK,
                json={
                    "available": True,
                    "capabilities": self._capabilities,
                    "contract_version": CONTRACT_VERSION,
                    "ontology_version": "1.0.0",
                    "attestation": None,
                },
            )
        return httpx.Response(HTTPStatus.OK, json={})


def _degrade_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return every captured record carrying the read path's static degrade event."""
    return [record for record in caplog.records if record.getMessage() == _DEGRADED_EVENT]


def _degrade_signature(record: logging.LogRecord) -> tuple[object, object]:
    """Return the (reason, code) pair one degrade record reports."""
    return (getattr(record, "reason", None), getattr(record, "code", None))


class _SpiedClientFactory:
    """Builds HTTP vault clients over a recording transport, keeping every handler.

    The handler rather than the client is what the care-gate test asserts on: a
    spy on the client's own methods would still pass if the handshake had already
    put bytes on the wire, which is precisely the guarantee at stake.
    """

    def __init__(self) -> None:
        """Start empty handler and transport registries."""
        self.handlers: list[_RecordingTransportHandler] = []
        self.transports: list[httpx.AsyncClient] = []

    def __call__(self, capabilities: Sequence[str]) -> HttpCreekVaultClient:
        """Build one spied client and register its handler and transport."""
        handler = _RecordingTransportHandler(capabilities)
        self.handlers.append(handler)
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.transports.append(http)
        return HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)

    async def aclose(self) -> None:
        """Close every transport this factory built."""
        for http in self.transports:
            await http.aclose()


@pytest_asyncio.fixture
async def spied_clients() -> AsyncGenerator[_SpiedClientFactory, None]:
    """Yield a factory for HTTP vault clients over a recording in-memory transport."""
    factory = _SpiedClientFactory()
    yield factory
    await factory.aclose()


@pytest.mark.asyncio
async def test_ok_reflection_reaches_marginalia_as_the_strict_json_contract() -> None:
    """A vault's own notes anchor as marginalia through the canonical mapping, no fallback.

    This is the acceptance criterion the whole seam exists for: notes computed in
    the user's own enclave reach their Higher Self, in their own words, without a
    cloud call. The two quotes are verbatim substrings of the body, so they anchor
    for real rather than being paraphrases the resonance pass would drop.
    """
    fallback = RecordingFallbackLLM()
    client = RecordingVaultClient(
        reflect_result=_reflection(
            _note("connection", _LOOP_RIVER_QUOTE, _RIVER_NOTE),
            _note("theme", _LOOP_STALL_QUOTE, _STALL_NOTE),
        )
    )
    llm = VaultResonanceLLM(
        client, body=_LOOP_BODY, tier_ceiling=VaultTierCeiling.PERSONAL, fallback=fallback
    )

    anchored = await generate_marginalia(_LOOP_BODY, llm=llm)

    assert [(note.kind, note.anchor_text, note.note) for note in anchored.notes] == [
        ("connection", _LOOP_RIVER_QUOTE, _RIVER_NOTE),
        ("theme", _LOOP_STALL_QUOTE, _STALL_NOTE),
    ]
    assert fallback.prompts == []
    assert client.reflect_calls == [(_LOOP_BODY, VaultTierCeiling.PERSONAL)]


@pytest.mark.asyncio
async def test_the_marginalia_contract_is_built_at_this_seam_not_in_the_adapter() -> None:
    """complete() serializes the structured notes into the strict JSON the cloud returns.

    The transport adapter answers with a domain value; the ``{"notes": [...]}``
    string is this seam's own contract with ``generate_marginalia``, so it is
    built here where that contract lives.
    """
    client = RecordingVaultClient(
        reflect_result=_reflection(_note("connection", _LOOP_RIVER_QUOTE, _RIVER_NOTE))
    )
    fallback = RecordingFallbackLLM()
    adapter = VaultResonanceLLM(
        client, body=_LOOP_BODY, tier_ceiling=VaultTierCeiling.PERSONAL, fallback=fallback
    )

    completion = await adapter.complete("this prompt is never sent to the vault")

    assert json.loads(completion) == {
        "notes": [{"kind": "connection", "quote": _LOOP_RIVER_QUOTE, "note": _RIVER_NOTE}]
    }
    assert fallback.prompts == []


@pytest.mark.parametrize(
    "reflection",
    [
        pytest.param(_reflection(status=VaultReflectionStatus.EMPTY), id="empty_status"),
        pytest.param(_reflection(), id="ok_with_zero_notes"),
    ],
)
@pytest.mark.asyncio
async def test_empty_and_noteless_reflections_defer_silently(
    reflection: VaultReflection,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A vault with nothing to say defers to the cloud without recording a degrade.

    Both of these are the vault answering successfully, so recording a failure
    would train an operator to ignore the one signal that means something. The
    prompt is passed through verbatim, since the fallback's contract is the
    ordinary prompt-in/completion-out seam.
    """
    caplog.set_level(logging.DEBUG)
    client = RecordingVaultClient(reflect_result=reflection)
    fallback = RecordingFallbackLLM("fallback text")
    adapter = VaultResonanceLLM(
        client, body=_BODY, tier_ceiling=VaultTierCeiling.PERSONAL, fallback=fallback
    )

    result = await adapter.complete("the exact prompt")

    assert result == "fallback text"
    assert fallback.prompts == ["the exact prompt"]
    assert _degrade_records(caplog) == []


@pytest.mark.parametrize(
    ("error", "reason", "code"),
    [
        pytest.param(
            CreekVaultPayloadError("creek vault returned an unreadable response"),
            VaultReadDegradeReason.PAYLOAD,
            None,
            id="payload",
        ),
        pytest.param(
            CreekVaultContractError(
                "creek vault rejected the request", code=VaultErrorCode.PRIVACY_REFUSED
            ),
            VaultReadDegradeReason.CONTRACT,
            VaultErrorCode.PRIVACY_REFUSED,
            id="privacy_refused",
        ),
        pytest.param(
            CreekVaultContractError(
                "creek vault rejected the request", code=VaultErrorCode.NOT_FOUND
            ),
            VaultReadDegradeReason.CONTRACT,
            VaultErrorCode.NOT_FOUND,
            id="not_found",
        ),
        pytest.param(
            CreekVaultUnavailableError(
                "creek vault call failed", code=VaultErrorCode.TEMPORARILY_UNAVAILABLE
            ),
            VaultReadDegradeReason.UNAVAILABLE,
            VaultErrorCode.TEMPORARILY_UNAVAILABLE,
            id="temporarily_unavailable",
        ),
        pytest.param(
            CreekVaultUnavailableError("creek vault call failed"),
            VaultReadDegradeReason.UNAVAILABLE,
            None,
            id="unavailable",
        ),
        pytest.param(
            CreekCapabilityUnsupportedError("creek vault capability unsupported"),
            VaultReadDegradeReason.UNSUPPORTED_CAPABILITY,
            None,
            id="capability_unsupported",
        ),
    ],
)
@pytest.mark.asyncio
async def test_vault_errors_defer_and_are_logged_with_distinct_reasons(
    error: Exception,
    reason: VaultReadDegradeReason,
    code: VaultErrorCode | None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Every vault failure looks the same to the user and different to an operator.

    A read degrade is invisible by design -- the cloud answers instead -- so this
    record is the only place anyone can see one happen, and a shared reason would
    make a vault bug worth reporting upstream indistinguishable from
    infrastructure worth restoring. That is the defect this pins closed.
    """
    caplog.set_level(logging.DEBUG)
    client = RecordingVaultClient(reflect_error=error)
    fallback = RecordingFallbackLLM("fallback text")
    adapter = VaultResonanceLLM(
        client, body=_BODY, tier_ceiling=VaultTierCeiling.OPEN, fallback=fallback
    )

    result = await adapter.complete("the exact prompt")

    assert result == "fallback text"
    assert fallback.prompts == ["the exact prompt"]
    records = _degrade_records(caplog)
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    assert getattr(records[0], "capability", None) == CreekCapability.REFLECT.value
    assert _degrade_signature(records[0]) == (reason.value, None if code is None else code.value)


@pytest.mark.asyncio
async def test_the_six_degrade_signatures_are_pairwise_distinct(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The six failure modes must not collapse onto one another in the record.

    Asserted jointly as well as per-case, because a per-case assertion is
    satisfied by six reasons that happen to coincide; only comparing them proves
    a schema failure is countable apart from vault absence.
    """
    caplog.set_level(logging.DEBUG)
    errors: list[Exception] = [
        CreekVaultPayloadError("unreadable"),
        CreekVaultContractError("rejected", code=VaultErrorCode.PRIVACY_REFUSED),
        CreekVaultContractError("rejected", code=VaultErrorCode.NOT_FOUND),
        CreekVaultUnavailableError("failed", code=VaultErrorCode.TEMPORARILY_UNAVAILABLE),
        CreekVaultUnavailableError("failed"),
        CreekCapabilityUnsupportedError("unsupported"),
    ]
    for error in errors:
        adapter = VaultResonanceLLM(
            RecordingVaultClient(reflect_error=error),
            body=_BODY,
            tier_ceiling=VaultTierCeiling.OPEN,
            fallback=RecordingFallbackLLM(),
        )
        await adapter.complete("a prompt")

    signatures = [_degrade_signature(record) for record in _degrade_records(caplog)]
    assert len(signatures) == len(errors)
    assert len(set(signatures)) == len(errors)


@pytest.mark.asyncio
async def test_escalation_propagates_out_of_complete() -> None:
    """A care escalation is never swallowed into cloud prose -- it leaves the seam.

    Falling back here would answer a person in acute distress with exactly the
    model prose Creek's care guard refused to generate, so the fallback must not
    be reached at all.
    """
    client = RecordingVaultClient(reflect_error=CreekVaultCareEscalationError())
    fallback = RecordingFallbackLLM()
    adapter = VaultResonanceLLM(
        client, body=_BODY, tier_ceiling=VaultTierCeiling.PERSONAL, fallback=fallback
    )

    with pytest.raises(CreekVaultCareEscalationError):
        await adapter.complete("the exact prompt")

    assert fallback.prompts == []


@pytest.mark.asyncio
async def test_essay_never_reaches_the_marginalia_contract(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The vault's free prose is carried on the value and rendered nowhere at all.

    An essay is the model's own writing rather than the user's, so it belongs to
    no anchored note, no marginalia JSON, and no log line -- the whole point of
    the Higher Self is that it speaks in words the user actually wrote.
    """
    caplog.set_level(logging.DEBUG)
    client = RecordingVaultClient(
        reflect_result=_reflection(
            _note("connection", _LOOP_RIVER_QUOTE, _RIVER_NOTE),
            essay=_SENTINEL_ESSAY,
        )
    )
    fallback = RecordingFallbackLLM()
    adapter = VaultResonanceLLM(
        client, body=_LOOP_BODY, tier_ceiling=VaultTierCeiling.PERSONAL, fallback=fallback
    )

    completion = await adapter.complete("a prompt")
    anchored = await generate_marginalia(_LOOP_BODY, llm=adapter)

    assert _SENTINEL_ESSAY not in completion
    assert json.loads(completion) == {
        "notes": [{"kind": "connection", "quote": _LOOP_RIVER_QUOTE, "note": _RIVER_NOTE}]
    }
    assert anchored.notes != []
    for note in anchored.notes:
        assert _SENTINEL_ESSAY not in note.note
        assert _SENTINEL_ESSAY not in note.anchor_text
    assert _SENTINEL_ESSAY not in caplog.text


@pytest.mark.asyncio
async def test_care_gate_short_circuits_before_any_transport_call(
    spied_clients: _SpiedClientFactory,
) -> None:
    """A care-flagged entry puts nothing on the wire, asserted at the transport itself.

    On distress adepthood does not ask the vault, and the guarantee that matters
    is the byte count rather than the call count: a spy on the client's own
    methods would still pass if the handshake had already left the process.
    """
    client = spied_clients([CreekCapability.REFLECT.value])
    fallback = RecordingFallbackLLM()

    result = await select_reflection_llm(
        client, body=_BODY, classification="personal", care_flagged=True, fallback=fallback
    )

    assert result is fallback
    assert spied_clients.handlers[-1].requests == []


@pytest.mark.asyncio
async def test_unknown_classification_short_circuits_before_any_transport_call(
    spied_clients: _SpiedClientFactory,
) -> None:
    """An unrecognized classification fails closed at the transport, never widening a tier."""
    client = spied_clients([CreekCapability.REFLECT.value])
    fallback = RecordingFallbackLLM()

    result = await select_reflection_llm(
        client, body=_BODY, classification="not_a_real_tier", care_flagged=False, fallback=fallback
    )

    assert result is fallback
    assert spied_clients.handlers[-1].requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("available", "capabilities"),
    [
        (False, frozenset({CreekCapability.REFLECT})),
        (True, frozenset()),
    ],
    ids=["handshake_unavailable", "reflect_unsupported"],
)
async def test_select_reflection_llm_falls_back_when_not_reflect_ready(
    available: bool, capabilities: frozenset[CreekCapability]
) -> None:
    """An unavailable vault, or one that never advertises REFLECT, falls back."""
    client = RecordingVaultClient(available=available, capabilities=capabilities)
    fallback = RecordingFallbackLLM()

    result = await select_reflection_llm(
        client, body=_BODY, classification="personal", care_flagged=False, fallback=fallback
    )

    assert result is fallback
    assert client.handshake_calls == 1
    assert client.reflect_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("classification", "expected_ceiling"),
    [
        ("personal", VaultTierCeiling.PERSONAL),
        ("public", VaultTierCeiling.OPEN),
    ],
)
async def test_select_reflection_llm_returns_vault_adapter_with_resolved_tier(
    classification: str, expected_ceiling: VaultTierCeiling
) -> None:
    """An available, REFLECT-capable vault yields a VaultResonanceLLM at the right tier."""
    client = RecordingVaultClient(
        reflect_result=_reflection(_note("theme", _LOOP_STALL_QUOTE, _STALL_NOTE))
    )
    fallback = RecordingFallbackLLM()

    result: ResonanceLLM = await select_reflection_llm(
        client, body=_BODY, classification=classification, care_flagged=False, fallback=fallback
    )

    assert isinstance(result, VaultResonanceLLM)
    completion = await result.complete("any prompt")
    assert json.loads(completion) == {
        "notes": [{"kind": "theme", "quote": _LOOP_STALL_QUOTE, "note": _STALL_NOTE}]
    }
    assert client.reflect_calls == [(_BODY, expected_ceiling)]


@pytest.mark.asyncio
async def test_related_pages_of_a_rendered_reflection_reach_the_consumer() -> None:
    """The compiled pages of the reflection actually used are readable off the seam.

    The ``ResonanceLLM`` contract is prompt-in/string-out, so the pages cannot
    ride the completion: they are not the user's own words and have no place in
    the marginalia contract. They are read back from the adapter instead, which
    keeps one pass's answer with the pass that produced it.
    """
    client = RecordingVaultClient(
        reflect_result=_reflection(
            _note("theme", _LOOP_STALL_QUOTE, _STALL_NOTE),
            related_praxis=(_PRAXIS,),
            related_eddies=(_EDDY,),
        )
    )
    adapter = VaultResonanceLLM(
        client,
        body=_LOOP_BODY,
        tier_ceiling=VaultTierCeiling.PERSONAL,
        fallback=RecordingFallbackLLM(),
    )

    completion = await adapter.complete("any prompt")

    assert "Rest and Ruin" not in completion
    assert related_surfaces(adapter) == VaultRelatedSurfaces(praxis=(_PRAXIS,), eddies=(_EDDY,))


@pytest.mark.parametrize(
    "reflection",
    [
        pytest.param(
            _reflection(
                status=VaultReflectionStatus.EMPTY,
                related_praxis=(_PRAXIS,),
                related_eddies=(_EDDY,),
            ),
            id="empty_status",
        ),
        pytest.param(
            _reflection(related_praxis=(_PRAXIS,), related_eddies=(_EDDY,)),
            id="ok_with_zero_notes",
        ),
    ],
)
@pytest.mark.asyncio
async def test_a_deferred_reflection_surfaces_no_related_pages(
    reflection: VaultReflection,
) -> None:
    """Pages never surface beside a reflection the writer is not reading.

    Both cases fall back to the cloud, so what lands in the margin is the cloud's
    answer -- and pages presented as related to *it* would be relating the user's
    own corpus to prose their vault never wrote.
    """
    client = RecordingVaultClient(reflect_result=reflection)
    adapter = VaultResonanceLLM(
        client, body=_BODY, tier_ceiling=VaultTierCeiling.PERSONAL, fallback=RecordingFallbackLLM()
    )

    await adapter.complete("any prompt")

    assert related_surfaces(adapter) == VaultRelatedSurfaces()


@pytest.mark.asyncio
async def test_a_degraded_vault_surfaces_no_related_pages() -> None:
    """A vault that failed mid-call surfaced nothing, so neither does the seam."""
    client = RecordingVaultClient(reflect_error=CreekVaultUnavailableError("vault is down"))
    adapter = VaultResonanceLLM(
        client, body=_BODY, tier_ceiling=VaultTierCeiling.PERSONAL, fallback=RecordingFallbackLLM()
    )

    await adapter.complete("any prompt")

    assert related_surfaces(adapter) == VaultRelatedSurfaces()


def test_a_cloud_llm_surfaces_no_related_pages() -> None:
    """Only a vault knows about compiled pages, so every other LLM surfaces none.

    Asked of the seam rather than of the caller: the router holds whichever
    ``ResonanceLLM`` ``select_reflection_llm`` chose, and making it branch on the
    concrete type would put that knowledge in two places.
    """
    assert related_surfaces(RecordingFallbackLLM()) == VaultRelatedSurfaces()


def test_nothing_surfaces_before_the_reflection_is_asked_for() -> None:
    """A freshly bound adapter has no answer yet, so it reports none."""
    adapter = VaultResonanceLLM(
        RecordingVaultClient(),
        body=_BODY,
        tier_ceiling=VaultTierCeiling.PERSONAL,
        fallback=RecordingFallbackLLM(),
    )

    assert related_surfaces(adapter) == VaultRelatedSurfaces()
