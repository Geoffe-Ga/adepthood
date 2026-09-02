"""Tests for :mod:`services.frequency_source` -- one authority per fragment.

Two properties carry this suite. **The vault wins outright**: when it answers,
the operator-side classifier is not merely ignored, it is never entered, and the
test that pins this uses a fake that raises on invocation rather than one that
returns something distinguishable -- the same technique
``test_intimate_content_never_reaches_a_provider`` uses, and for the same reason.
A test asserting only on the returned value would still pass after both models
had been billed.

**The join is on the code, never on the name.** A vault tag is an ``F1``..``F10``
code, and the two labelings of these ten positions agree on six of them and
diverge on the middle four -- so a tag carrying a *name* or a *colour* must be
refused rather than resolved, because resolving it would look correct for six
positions and be silently wrong for four.
"""

from __future__ import annotations

import ast
import json
import logging
import pathlib
from types import SimpleNamespace
from typing import Any

import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultContractError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflection,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelBalance,
)
from domain.frequencies import FREQUENCY_COLORS, FREQUENCY_NAMES, Frequency
from models.journal_entry import JournalClassification
from services import frequency_classification as fc
from services import frequency_source as fs
from services.botmason import LLMCreditExhaustedError
from services.creek_vault_read import _DEGRADED_EVENT, VaultReadDegradeReason
from tests.vault_client_doubles import NoPipelineVaultDouble

_ONTOLOGY_VERSION = "aptitude-wavelength/2026-05-23"
_BODY = "A day I finally said the thing out loud."
_EXPECTED_SOURCE_COUNT = 3

# What the operator-side classifier answers if it is ever reached, and the
# conviction it answers with. Deliberately a frequency the vault never returns in
# these tests, so a blended answer is visible rather than plausible.
_OPERATOR_ONLY_CODE = Frequency.F7
_OPERATOR_WEIGHT = 0.5


class RecordingClassifyVaultClient(NoPipelineVaultDouble):
    """A scriptable, call-recording fake CreekVaultClient (classify path only)."""

    def __init__(
        self,
        *,
        available: bool = True,
        capabilities: frozenset[CreekCapability] = frozenset({CreekCapability.CLASSIFY}),
        classification: VaultClassification | None = None,
        error: Exception | None = None,
    ) -> None:
        """Store the scripted handshake outcome and classify behavior."""
        self.handshake_calls = 0
        self.classify_calls: list[tuple[str, VaultTierCeiling]] = []
        self._available = available
        self._capabilities = capabilities
        self._classification = classification
        self._error = error

    async def handshake(self) -> HandshakeResult:
        """Record the call and return the scripted availability/capabilities."""
        self.handshake_calls += 1
        return HandshakeResult(
            available=self._available,
            contract_version=CONTRACT_VERSION,
            ontology_version=_ONTOLOGY_VERSION,
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
        """Unused on the classify path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Unused on the classify path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def classify(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Record the call, then raise the scripted error or return the scripted tags."""
        self.classify_calls.append((body, tier_ceiling))
        if self._error is not None:
            raise self._error
        assert self._classification is not None
        return self._classification

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Unused on the classify path; raises if a test calls it by mistake."""
        raise NotImplementedError((body, tier_ceiling))

    async def wheel(self) -> VaultWheelBalance:
        """Unused on the classify path; raises if a test calls it by mistake."""
        raise NotImplementedError


def _vault(tags: tuple[str, ...]) -> RecordingClassifyVaultClient:
    """A reachable vault advertising CLASSIFY that answers with ``tags``."""
    return RecordingClassifyVaultClient(classification=VaultClassification(tags=tags))


def _forbid_operator(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any operator-side classification an outright test failure.

    Raises rather than returning a sentinel, so a selector that calls both sides
    and discards one cannot pass by returning the vault's answer anyway.
    """

    async def explode(content: str, **kwargs: object) -> fc.FrequencyClassification:
        msg = f"the operator-side classifier ran on {len(content)} chars: {sorted(kwargs)}"
        raise AssertionError(msg)

    monkeypatch.setattr(fs, "classify_frequencies", explode)


def _operator_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Route the operator-side classifier's provider to a fake with a fixed answer."""
    reply = json.dumps(
        {
            "weights": {_OPERATOR_ONLY_CODE.value: _OPERATOR_WEIGHT},
            "overall_confidence": _OPERATOR_WEIGHT,
        }
    )

    async def fake(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(text=reply)

    monkeypatch.setattr(fc, "generate_response", fake)


def _degrade_records(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    """Return the attribute dict of every record carrying the static degrade event.

    The dict rather than the record: the fields the read path attaches travel in
    ``extra`` and are not attributes ``LogRecord`` declares, so reading them off
    the object is untypeable without a suppression.
    """
    return [record.__dict__ for record in caplog.records if record.getMessage() == _DEGRADED_EVENT]


# --- provenance --------------------------------------------------------------


def test_a_classification_names_one_of_exactly_three_sources() -> None:
    """Vault, operator, or nobody -- a fourth would be an unrecorded producer."""
    assert len(fc.ClassificationSource) == _EXPECTED_SOURCE_COUNT
    assert set(fc.ClassificationSource) == {
        fc.ClassificationSource.VAULT,
        fc.ClassificationSource.OPERATOR,
        fc.ClassificationSource.NONE,
    }


def test_unclassified_records_that_nobody_classified_it() -> None:
    """The degrade sentinel is not attributed to either side.

    ``NONE`` is the third value: a fragment that reached no model at all is a
    different fact from one an operator-side model read and found nothing in.
    """
    assert fc.UNCLASSIFIED.source is fc.ClassificationSource.NONE
    assert not fc.UNCLASSIFIED.is_classified()


@pytest.mark.asyncio
async def test_the_operator_classifier_stamps_its_own_provenance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A parsed provider reply is recorded as operator-side, not left blank."""
    _operator_answers(monkeypatch)

    result = await fc.classify_frequencies(_BODY, classification=JournalClassification.PERSONAL)

    assert result.source is fc.ClassificationSource.OPERATOR
    assert result.weights == {_OPERATOR_ONLY_CODE: _OPERATOR_WEIGHT}


# --- the vault wins ----------------------------------------------------------


@pytest.mark.asyncio
async def test_the_operator_classifier_is_never_entered_when_the_vault_answers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fake raises on invocation, so "called and discarded" cannot pass here.

    This is the acceptance criterion in its strongest form: the operator-side
    path is not reached at all, rather than reached and outvoted.
    """
    _forbid_operator(monkeypatch)
    client = _vault(("F3",))

    result = await fs.select_frequency_classification(
        client, _BODY, classification=JournalClassification.PERSONAL
    )

    assert result.source is fc.ClassificationSource.VAULT
    assert result.weights == {Frequency.F3: fs.VAULT_TAG_WEIGHT}
    assert result.overall_confidence == fs.VAULT_TAG_CONFIDENCE
    assert client.classify_calls == [(_BODY, VaultTierCeiling.PERSONAL)]


@pytest.mark.asyncio
async def test_a_vault_answer_is_never_blended_with_the_operator_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One source per fragment: the operator's frequency is absent, not merged in."""
    _operator_answers(monkeypatch)
    client = _vault(("F3",))

    result = await fs.select_frequency_classification(
        client, _BODY, classification=JournalClassification.PERSONAL
    )

    assert set(result.weights) == {Frequency.F3}


@pytest.mark.asyncio
async def test_every_frequency_code_is_a_tag_the_vault_may_return(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """All ten positions project; rejecting one the vault may send would strand it."""
    _forbid_operator(monkeypatch)
    client = _vault(tuple(code.value for code in Frequency))

    result = await fs.select_frequency_classification(
        client, _BODY, classification=JournalClassification.PUBLIC
    )

    assert set(result.weights) == set(Frequency)


@pytest.mark.asyncio
async def test_a_repeated_tag_is_one_position_not_two(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tags name positions; a vault repeating one asserts it once."""
    _forbid_operator(monkeypatch)
    client = _vault(("F3", "F3"))

    result = await fs.select_frequency_classification(
        client, _BODY, classification=JournalClassification.PERSONAL
    )

    assert result.weights == {Frequency.F3: fs.VAULT_TAG_WEIGHT}


@pytest.mark.asyncio
async def test_the_public_tier_reaches_the_vault_at_the_open_ceiling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fragment's own tier is what bounds the call, not a fixed ceiling."""
    _forbid_operator(monkeypatch)
    client = _vault(("F1",))

    await fs.select_frequency_classification(
        client, _BODY, classification=JournalClassification.PUBLIC
    )

    assert client.classify_calls == [(_BODY, VaultTierCeiling.OPEN)]


# --- INTIMATE refuses before either path -------------------------------------


@pytest.mark.asyncio
async def test_intimate_refuses_before_either_path_is_entered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Not a degradation, and not even a handshake.

    The operator classifier raises on any call and the vault records every one,
    so this fails if the refusal is moved below either entry point.
    """
    _forbid_operator(monkeypatch)
    client = _vault(("F3",))

    with pytest.raises(fc.IntimateContentRefusedError):
        await fs.select_frequency_classification(
            client, _BODY, classification=JournalClassification.INTIMATE
        )

    assert client.handshake_calls == 0
    assert client.classify_calls == []


# --- every vault failure degrades to the operator ----------------------------


@pytest.mark.asyncio
async def test_an_unavailable_vault_degrades_without_calling_classify(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No vault reachable: the operator answers and classify is never called."""
    _operator_answers(monkeypatch)
    client = RecordingClassifyVaultClient(
        available=False, classification=VaultClassification(tags=("F3",))
    )

    result = await fs.select_frequency_classification(
        client, _BODY, classification=JournalClassification.PERSONAL
    )

    assert result.source is fc.ClassificationSource.OPERATOR
    assert result.weights == {_OPERATOR_ONLY_CODE: _OPERATOR_WEIGHT}
    assert client.classify_calls == []


@pytest.mark.asyncio
async def test_a_vault_that_does_not_advertise_classify_degrades(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A capability never advertised is not a capability to call and then catch."""
    _operator_answers(monkeypatch)
    client = RecordingClassifyVaultClient(
        capabilities=frozenset(), classification=VaultClassification(tags=("F3",))
    )

    result = await fs.select_frequency_classification(
        client, _BODY, classification=JournalClassification.PERSONAL
    )

    assert result.source is fc.ClassificationSource.OPERATOR
    assert client.classify_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (
            CreekVaultUnavailableError("creek vault call failed: creek.classify"),
            VaultReadDegradeReason.UNAVAILABLE,
        ),
        (
            CreekCapabilityUnsupportedError("capability not advertised: creek.classify"),
            VaultReadDegradeReason.UNSUPPORTED_CAPABILITY,
        ),
        (
            CreekVaultContractError("creek vault refused: creek.classify"),
            VaultReadDegradeReason.CONTRACT,
        ),
        (
            CreekVaultPayloadError("creek vault answer unreadable: creek.classify"),
            VaultReadDegradeReason.PAYLOAD,
        ),
        (
            CreekVaultAuthError("creek vault rejected our credential: creek.classify"),
            VaultReadDegradeReason.AUTH,
        ),
    ],
    ids=["unavailable", "unsupported_capability", "contract", "payload", "auth"],
)
async def test_every_seam_error_degrades_silently_and_is_logged(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
    reason: VaultReadDegradeReason,
) -> None:
    """A vault that cannot answer never fails a write -- it is logged and stepped around."""
    _operator_answers(monkeypatch)
    client = RecordingClassifyVaultClient(error=error)

    with caplog.at_level(logging.WARNING, logger="services.creek_vault_read"):
        result = await fs.select_frequency_classification(
            client, _BODY, classification=JournalClassification.PERSONAL
        )

    assert result.source is fc.ClassificationSource.OPERATOR
    records = _degrade_records(caplog)
    assert len(records) == 1
    assert records[0]["capability"] == CreekCapability.CLASSIFY.value
    assert records[0]["reason"] == reason.value


# --- an unreadable or empty vault answer -------------------------------------


@pytest.mark.asyncio
async def test_a_tag_outside_the_ontology_rejects_the_whole_answer(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Partial acceptance is how a shared vocabulary drifts apart quietly.

    The recognised ``F3`` is discarded along with the eleventh code rather than
    kept, mirroring the operator-side parser's all-or-nothing rule.
    """
    _operator_answers(monkeypatch)
    client = _vault(("F3", "F11"))

    with caplog.at_level(logging.WARNING, logger="services.creek_vault_read"):
        result = await fs.select_frequency_classification(
            client, _BODY, classification=JournalClassification.PERSONAL
        )

    assert result.source is fc.ClassificationSource.OPERATOR
    assert Frequency.F3 not in result.weights
    records = _degrade_records(caplog)
    assert len(records) == 1
    assert records[0]["reason"] == VaultReadDegradeReason.PAYLOAD.value


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tag",
    [FREQUENCY_NAMES[Frequency.F5], FREQUENCY_COLORS[Frequency.F5]],
    ids=["by_name", "by_colour"],
)
async def test_a_tag_naming_a_position_rather_than_coding_it_is_refused(
    monkeypatch: pytest.MonkeyPatch, tag: str
) -> None:
    """The wire form is the code; a name or a colour is not resolved to a position.

    F5 is one of the four positions where the two labelings diverge, so a name
    join would agree with six of the ten and be wrong here while looking right.
    Refusing the tag keeps that disagreement loud.
    """
    _operator_answers(monkeypatch)
    client = _vault((tag,))

    result = await fs.select_frequency_classification(
        client, _BODY, classification=JournalClassification.PERSONAL
    )

    assert result.source is fc.ClassificationSource.OPERATOR
    assert Frequency.F5 not in result.weights


@pytest.mark.asyncio
async def test_an_empty_tag_tuple_is_a_vault_that_did_not_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty tuple is the absence of an answer, not an answer of absence.

    ``VaultIngestResult.tags`` says so outright -- "a vault that does not return
    them yields an empty tuple" -- so treating it as an authoritative "no
    frequency here" would silently keep the entry out of the corpus.
    """
    _operator_answers(monkeypatch)
    client = _vault(())

    result = await fs.select_frequency_classification(
        client, _BODY, classification=JournalClassification.PERSONAL
    )

    assert result.source is fc.ClassificationSource.OPERATOR
    assert result.weights == {_OPERATOR_ONLY_CODE: _OPERATOR_WEIGHT}


@pytest.mark.asyncio
async def test_an_unreadable_vault_answer_and_a_failing_operator_still_never_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The degrade of a degrade is UNCLASSIFIED, never an exception into the write."""
    client = _vault(("F11",))

    async def down(**_kwargs: object) -> SimpleNamespace:
        raise fc.LLMProviderError

    monkeypatch.setattr(fc, "generate_response", down)

    result = await fs.select_frequency_classification(
        client, _BODY, classification=JournalClassification.PERSONAL
    )

    assert result is fc.UNCLASSIFIED
    assert result.source is fc.ClassificationSource.NONE


@pytest.mark.asyncio
async def test_an_operator_side_balance_that_is_spent_propagates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The one operator-side condition that is not a degrade reaches the caller here.

    Unlike every failure above, a spent balance says nothing about this content
    and everything about the key: it will refuse the next call too. This seam
    threads the caller's own key, so it is the one place a caller could be told
    a bill is theirs to settle -- which is only possible if the condition still
    has its identity by the time it arrives.
    """
    client = _vault(("F11",))

    async def refusing(**_kwargs: object) -> SimpleNamespace:
        raise LLMCreditExhaustedError("credit balance is too low", provider="anthropic")

    monkeypatch.setattr(fc, "generate_response", refusing)

    with pytest.raises(LLMCreditExhaustedError) as refused:
        await fs.select_frequency_classification(
            client, _BODY, classification=JournalClassification.PERSONAL
        )

    assert refused.value.provider == "anthropic"


# --- the dependency runs one way ---------------------------------------------


def _imported_modules(path: pathlib.Path) -> set[str]:
    """Every module name a source file imports, however it spells the import."""
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            names.add(node.module)
    return names


def test_the_operator_classifier_never_imports_the_vault_seam() -> None:
    """Selector to classifier, never back.

    The operator-side path is the floor every deployment has; making it depend on
    the vault seam would mean a deployment with no vault importing one anyway,
    and would leave nowhere for the precedence rule to live but inside the very
    module it is supposed to be able to bypass.
    """
    imported = _imported_modules(pathlib.Path(fc.__file__))

    assert not [name for name in imported if "creek_vault" in name]
