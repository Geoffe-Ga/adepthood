"""Recorders at every sink outside the primary journal boundary, for the Intimate matrix (#3159).

The Intimate egress matrix (``tests/security/test_intimate_egress_matrix.py``)
plants a canary in an entry and asks one question of every place the canary
could leave through: did it arrive? A recorder answers that for one sink. Each
writes what it saw into one shared :class:`Ledger`, in arrival order, so a test
can ask what crossed a seam before or after a point in its own flow -- a
reclassification, a restart -- with a single read.

The recorders, and the :mod:`privacy.sinks` rows each one stands for:

* :class:`RecordingVault` -- the Creek vault client every journal, corpus and
  pipeline path resolves. Every verb records its arguments, and a small model
  of the remote side (:attr:`RecordingVault.remote`) keeps what the vault would
  still hold after ingests and withdrawals, so "no copy remains" is a read of
  state rather than an inference from calls. Stands for the ``net.creek_*``
  recipients and the vault-side stores behind them (``vault.*``), which nothing
  reaches except through this client.
* :func:`record_provider_dials` -- the model provider's one dial,
  ``services.botmason.generate_response``, wrapped at **every module that binds
  it**, found by object identity rather than by a list, so a new binding site is
  recorded without an edit here. Stands for ``net.openai`` and ``net.anthropic``.
* :func:`record_classifier_inputs` -- what the corpus classifier submits for
  classification, at its request to its model (after its own tier refusal).
* :func:`corpus_fragments` -- the ``corpusfragment`` table itself
  (``db.corpusfragment.content``): a state sink, read after the flow.
* :class:`TelemetryRecorder` -- every log record any logger emitted during the
  flow (``telemetry.root_log``, ``telemetry.access_log`` and the other log
  transports) plus the production Sentry client's serialized envelopes
  (``telemetry.sentry_envelope``).

Each recorder is reachable: the matrix runs every cell's Personal twin and
requires the canary to *arrive* where that twin says it should, because an
"absent" pass from a silent recorder proves nothing.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import sys
from dataclasses import dataclass, field
from types import ModuleType
from typing import TYPE_CHECKING, Final

from sqlmodel import select

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultClassificationPass,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultJournalWithdrawResult,
    VaultLinkPass,
    VaultLinkStage,
    VaultPipelineJob,
    VaultReflection,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultVoiceDraftDeleteResult,
    VaultVoiceDraftRequest,
    VaultVoiceDraftResult,
    VaultWheelBalance,
)
from models.corpus_fragment import CorpusFragment
from services import botmason, frequency_classification

# Bound by import, as the neighbouring seam suites bind theirs: the private
# request the classifier makes to its model is the seam this recorder watches.
from services.frequency_classification import _reply_within as reply_within
from tests.helpers.telemetry_canaries import probes

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Iterator, Sequence

    import pytest
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from services.botmason import ImagePayload, LLMResponse


class Recorder(enum.StrEnum):
    """Every recorder the matrix installs, by the seam it watches."""

    PROVIDER = "provider dial"
    VAULT = "creek vault client"
    CLASSIFIER = "classifier input"
    CORPUS = "corpus fragment store"
    TELEMETRY = "telemetry"


@dataclass(frozen=True, slots=True)
class Event:
    """One call that crossed a recorded seam, rendered as text."""

    seq: int
    recorder: Recorder
    verb: str
    payload: str


@dataclass
class Ledger:
    """Every recorded crossing, in order, plus an optional pause on the first one.

    The pause is how the matrix holds an operation *in flight*: armed, the first
    crossing at one of :attr:`pause_on` recorders signals :attr:`paused` and waits
    for :attr:`release`, so a reclassification can be sent while the dial is
    open.
    """

    events: list[Event] = field(default_factory=list)
    pause_on: frozenset[Recorder] = frozenset()
    paused: asyncio.Event = field(default_factory=asyncio.Event)
    release: asyncio.Event = field(default_factory=asyncio.Event)

    def record(self, recorder: Recorder, verb: str, payload: str) -> None:
        """Append one crossing."""
        self.events.append(Event(len(self.events), recorder, verb, payload))

    async def dial(self, recorder: Recorder, verb: str, payload: str) -> None:
        """Append one crossing, holding it open first if the pause is armed here."""
        if recorder in self.pause_on and not self.paused.is_set():
            self.paused.set()
            await self.release.wait()
        self.record(recorder, verb, payload)

    def arm_pause(self, recorders: frozenset[Recorder]) -> None:
        """Hold the next crossing at any of ``recorders`` until :attr:`release` is set."""
        self.paused = asyncio.Event()
        self.release = asyncio.Event()
        self.pause_on = recorders

    def disarm_pause(self) -> None:
        """Stop pausing, and let anything still held go."""
        self.pause_on = frozenset()
        self.release.set()

    def mark(self) -> int:
        """The sequence number the next crossing will carry."""
        return len(self.events)

    def since(self, mark: int, recorder: Recorder | None = None) -> list[Event]:
        """Every crossing from ``mark`` on, optionally at one recorder."""
        return [e for e in self.events[mark:] if recorder is None or e.recorder is recorder]

    def carrying(self, canary: str, *, since: int = 0) -> list[Event]:
        """Every crossing from ``since`` on whose payload carries ``canary``."""
        return [e for e in self.events[since:] if carries(e.payload, canary)]


def carries(blob: str, canary: str) -> bool:
    """Whether any probe of ``canary`` appears in ``blob``."""
    return any(fragment in blob for fragment in probes(canary))


# ── The vault ────────────────────────────────────────────────────────────────

#: Everything a fully connected vault advertises, so no path stands down for a
#: capability the double never claimed -- a stand-down would read as absence.
FULL_VAULT_CAPABILITIES: Final = frozenset(
    {
        CreekCapability.JOURNAL,
        CreekCapability.JOURNAL_WITHDRAW,
        CreekCapability.UPLOAD,
        CreekCapability.CLASSIFY,
        CreekCapability.REFLECT,
        CreekCapability.WHEEL,
        CreekCapability.PIPELINE,
        CreekCapability.VOICE_DRAFTS,
    }
)

_EMPTY_PASS: Final = VaultClassificationPass(
    total=0,
    classified=0,
    preserved_manual=0,
    preserved_llm=0,
    privacy_tiers_assigned=0,
    retiered=0,
    praxis_marked=0,
    tags_extracted=0,
    complete=True,
)


def _journal_key(entry_id: int) -> str:
    return f"journal:{entry_id}"


class RecordingVault:
    """A connected, fully capable Creek vault that records every call it is sent.

    :attr:`remote` models what the vault would still hold: an ingest or a
    voice-draft PUT stores its text under its stable key, and a withdrawal or a
    draft DELETE removes it. ``lose_ingest_acks`` stores the body and then fails
    the call, which is the "remote commit, local acknowledgment lost" fault C11's
    release test injects.
    """

    def __init__(self, ledger: Ledger) -> None:
        """Start connected, empty, and acknowledging every write."""
        self.ledger = ledger
        self.remote: dict[str, str] = {}
        self.lose_ingest_acks = False
        self.fail_withdrawals = False

    async def _dial(self, verb: str, payload: str) -> None:
        await self.ledger.dial(Recorder.VAULT, verb, payload)

    async def handshake(self) -> HandshakeResult:
        """Record the probe and answer fully capable."""
        await self._dial("handshake", "")
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=FULL_VAULT_CAPABILITIES,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Always available."""
        return True

    def supports(self, capability: CreekCapability, /) -> bool:
        """Every capability a connected vault can have."""
        return capability in FULL_VAULT_CAPABILITIES

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Record the body, keep it remotely, and acknowledge it (or lose the ack)."""
        await self._dial("ingest", f"{request.tier} {request.body}")
        self.remote[_journal_key(request.entry_id)] = request.body
        if self.lose_ingest_acks:
            msg = "synthetic lost acknowledgment after a remote commit"
            raise CreekVaultUnavailableError(msg)
        return VaultIngestResult(
            stored=True,
            vault_ref=f"vault-ref-{request.entry_id}",
            action=VaultIngestAction.CREATED,
        )

    async def withdraw_journal_entry(self, entry_id: int, /) -> VaultJournalWithdrawResult:
        """Record the content-free withdrawal and forget the copy, unless failing."""
        await self._dial("withdraw_journal_entry", str(entry_id))
        if self.fail_withdrawals:
            msg = "synthetic withdrawal outage"
            raise CreekVaultUnavailableError(msg)
        self.remote.pop(_journal_key(entry_id), None)
        return VaultJournalWithdrawResult(withdrawn=True)

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Record the document and keep it remotely."""
        await self._dial("upload", f"{request.filename} {request.content_base64}")
        self.remote[f"upload:{request.external_id}"] = request.content_base64
        return VaultUploadResult(stored=True, vault_ref=f"upload-{request.external_id}")

    async def classify(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Record the body sent for tagging."""
        await self._dial("classify", f"{tier_ceiling} {body}")
        return VaultClassification(tags=("courage",))

    async def classify_corpus(self) -> VaultClassificationPass | VaultPipelineJob:
        """Record the content-free whole-vault pass."""
        await self._dial("classify_corpus", "")
        return _EMPTY_PASS

    async def link_corpus(self, stage: VaultLinkStage, /) -> VaultLinkPass | VaultPipelineJob:
        """Record the content-free linker stage."""
        await self._dial("link_corpus", stage.value)
        return VaultLinkPass(
            stage=stage,
            fragment_count=0,
            link_count=0,
            largest_cluster_fragments=0,
            clusters_split=0,
            oversized_discarded=0,
        )

    async def pipeline_job(
        self, job: VaultPipelineJob, /
    ) -> VaultClassificationPass | VaultLinkPass | VaultPipelineJob:
        """Record the poll and land an empty pass."""
        await self._dial("pipeline_job", str(job.stage))
        return _EMPTY_PASS

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Record the body sent for reflection and answer with nothing to say."""
        await self._dial("reflect", f"{tier_ceiling} {body}")
        return VaultReflection(
            status=VaultReflectionStatus.EMPTY,
            notes=(),
            essay=None,
            essay_grounded=False,
            routed_tier=VaultTierCeiling.PERSONAL,
        )

    async def wheel(self) -> VaultWheelBalance:
        """Record the content-free read."""
        await self._dial("wheel", "")
        return VaultWheelBalance(aspects=())

    async def upsert_voice_draft(self, request: VaultVoiceDraftRequest, /) -> VaultVoiceDraftResult:
        """Record the AI-authored draft and keep it remotely."""
        await self._dial("upsert_voice_draft", f"{request.tier} {request.content}")
        self.remote[f"draft:{request.external_id}"] = request.content
        return VaultVoiceDraftResult(
            stored=True, vault_ref=f"draft-{request.external_id}", action=VaultIngestAction.CREATED
        )

    async def delete_voice_draft(
        self, external_id: str, tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        """Record the content-free retraction and forget the draft."""
        await self._dial("delete_voice_draft", f"{tier_ceiling} {external_id}")
        self.remote.pop(f"draft:{external_id}", None)
        return VaultVoiceDraftDeleteResult(deleted=True)

    def remote_copies_carrying(self, canary: str) -> list[str]:
        """Every key whose remotely held text still carries ``canary``."""
        return sorted(key for key, text in self.remote.items() if carries(text, canary))


# ── Binding sites, by identity ───────────────────────────────────────────────


def _source_modules() -> Iterator[ModuleType]:
    """Every loaded application module (not tests, not third-party)."""
    for name, module in tuple(sys.modules.items()):
        if not isinstance(module, ModuleType) or name.startswith("tests"):
            continue
        source = getattr(module, "__file__", None) or ""
        if "/backend/src/" in source.replace("\\", "/"):
            yield module


def binding_sites(origin: object) -> list[tuple[ModuleType, str]]:
    """Every ``(module, name)`` in the application whose binding *is* ``origin``.

    Identity, not spelling: an alias imported under another name in another
    module is the same object, and is found.
    """
    return [
        (module, name)
        for module in _source_modules()
        for name, value in tuple(vars(module).items())
        if value is origin
    ]


def record_provider_dials(
    monkeypatch: pytest.MonkeyPatch,
    ledger: Ledger,
    *,
    classifier_reply: str,
) -> list[str]:
    """Wrap the provider dial at every binding site; return the sites wrapped.

    The wrapper records everything the provider would receive -- the prompt, the
    history, the system prompt and any images; never the key -- and then answers
    through the real ``generate_response`` (the armed stub seam), except at the
    classifier's binding, which gets ``classifier_reply`` so a Personal twin's
    entry really is ontologized and reaches the corpus.
    """
    origin = botmason.generate_response

    def _wrap(module: ModuleType) -> Callable[..., Awaitable[LLMResponse]]:
        async def _recorded(
            user_message: str,
            conversation_history: list[dict[str, str]],
            system_prompt: str | None = None,
            api_key: str | None = None,
            images: Sequence[ImagePayload] | None = None,
        ) -> LLMResponse:
            payload = repr((user_message, conversation_history, system_prompt, images))
            await ledger.dial(Recorder.PROVIDER, module.__name__, payload)
            if module is frequency_classification:
                return botmason.LLMResponse(
                    text=classifier_reply,
                    provider="stub",
                    model=botmason.STUB_MODEL_NAME,
                    prompt_tokens=0,
                    completion_tokens=0,
                )
            return await origin(user_message, conversation_history, system_prompt, api_key, images)

        return _recorded

    sites = [(m, n) for m, n in binding_sites(origin) if m is not botmason]
    for module, name in sites:
        monkeypatch.setattr(module, name, _wrap(module))
    return [f"{module.__name__}.{name}" for module, name in sites]


def record_classifier_inputs(monkeypatch: pytest.MonkeyPatch, ledger: Ledger) -> None:
    """Record what the frequency classifier submits for classification.

    The seam is the classifier's own request to its model, *after* its tier
    refusal: ``classify_frequencies`` is deliberately handed every entry and
    refuses a non-egress tier itself (``services.corpus_ingest`` states no tier
    predicate of its own), so a recorder on its argument would read that design
    as a leak. What leaves for classification is what this records.
    """
    origin = reply_within

    async def _recorded(
        content: str, *, api_key: str | None, timeout_seconds: float | None
    ) -> LLMResponse:
        await ledger.dial(Recorder.CLASSIFIER, "classify", content)
        return await origin(content, api_key=api_key, timeout_seconds=timeout_seconds)

    monkeypatch.setattr(frequency_classification, "_reply_within", _recorded)


async def corpus_fragments(factory: async_sessionmaker[AsyncSession]) -> list[str]:
    """Every corpus fragment's decrypted content, for every account."""
    async with factory() as session:
        rows = (await session.execute(select(CorpusFragment))).scalars().all()
        return [row.content for row in rows]


# ── Telemetry ────────────────────────────────────────────────────────────────


class _ListHandler(logging.Handler):
    """Keep every record, rendered with its message, arguments and extras."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.rendered: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
        except (TypeError, ValueError):
            message = str(record.msg)
        self.rendered.append(f"{record.name} {message} {record.__dict__!r}")


@dataclass
class TelemetryRecorder:
    """Every log record and every Sentry envelope a flow produced."""

    handler: _ListHandler
    sentry_events: list[dict[str, object]]

    def blobs(self) -> list[str]:
        """Every log record and every serialized envelope, as text."""
        return [*self.handler.rendered, *(repr(event) for event in self.sentry_events)]

    def carrying(self, canary: str) -> list[str]:
        """Every captured blob that carries ``canary``."""
        return [blob for blob in self.blobs() if carries(blob, canary)]


def _non_propagating_loggers() -> list[logging.Logger]:
    """Every configured logger whose records would never reach the root handler."""
    return [
        candidate
        for candidate in tuple(logging.Logger.manager.loggerDict.values())
        if isinstance(candidate, logging.Logger) and not candidate.propagate
    ]


def install_telemetry_recorder(
    monkeypatch: pytest.MonkeyPatch, sentry_events: list[dict[str, object]]
) -> TelemetryRecorder:
    """Attach one handler to the root and to every logger that does not propagate.

    The root is lowered to ``DEBUG`` for the test, so a record no deployment
    would emit at its default level is still read: the property is that no
    record carries content, not that none is printed today. ``monkeypatch``
    restores every handler list and the level afterwards.
    """
    handler = _ListHandler()
    root = logging.getLogger()
    monkeypatch.setattr(root, "level", logging.DEBUG)
    for logger in (root, *_non_propagating_loggers()):
        monkeypatch.setattr(logger, "handlers", [*logger.handlers, handler])
    return TelemetryRecorder(handler=handler, sentry_events=sentry_events)
