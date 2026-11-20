"""Creek contract 0.34's pipeline status, read without moving the 0.22 pin (#3775).

0.34 (Creek-Vault#2124) adds ``GET /v1/pipeline/status?limit=``: every scaffolded
ontology folder with its count and the subsystem that fills it, the caller's
most recent uploads with the stages each whole-vault pass ran over them, and the
caller's newest durable pipeline jobs. It is not a new capability name: Creek
serves it to any caller declaring 0.34 and answers an earlier minor with ``409
incompatible_version``. So adepthood declares 0.34 on this one read, and only to
a vault whose handshake lists 0.34; everything else keeps hearing its own minor.

These tests drive the real adapter against a ``MockTransport`` vault and pin:
the snapshot is the producer's; the read declares 0.34 and nothing else does; a
vault that does not list 0.34 is never asked; the answer is parsed strictly, so
an off-schema answer is a payload fault; and failures are classified the way
every other ``/v1`` read's are.

Expectations are literals, never values read off the pin, for the reason
``tests/test_creek_contract_0_21.py`` gives.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime
from http import HTTPStatus
from pathlib import Path
from typing import Any, Final

import httpx
import jsonschema
import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapabilityUnsupportedError,
    CreekVaultContractError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    VaultErrorCode,
)
from domain.vault_pipeline_status import (
    PIPELINE_STATUS_MAX_LIMIT,
    PIPELINE_STATUS_SINCE_MINOR,
    VaultDocumentStage,
    VaultFolderWriterlessReason,
    VaultPipelineStatus,
    VaultStageOutcome,
    VaultStatusJobKind,
    VaultStatusJobState,
)
from services import creek_vault_pipeline_status_wire as wire
from services.creek_vault_client import HttpCreekVaultClient, LocalFallbackCreekVaultClient
from services.creek_vault_telemetry import VaultCallTimedOutError

#: The reviewed Creek-Vault commit the snapshot was copied from (a git SHA, not a secret).
_PINNED_COMMIT: Final = "9bcd4f1bf061521ab068587d4b3429117a5ffd23"  # pragma: allowlist secret
_ROOT: Final = Path(__file__).parent / "fixtures" / "creek_pipeline_status_v034"
_BASE: Final = Path(__file__).parent / "fixtures" / "creek_v1" / "examples"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "contract-034-test-key"  # pragma: allowlist secret
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"
_CEILING_HEADER: Final = "X-Creek-Tier-Ceiling"
_STATUS_PATH: Final = "/v1/pipeline/status"

#: The minor the status read declares. A literal.
_STATUS_MINOR: Final = "0.34"
#: How many folders ``creek init`` scaffolds outside ``00-Creek-Meta`` at 0.34.
_SCAFFOLDED_FOLDERS: Final = 63
_LIMIT: Final = 50


def _json(path: Path) -> dict[str, Any]:
    """Load one vendored JSON document."""
    loaded: dict[str, Any] = json.loads(path.read_bytes())
    return loaded


def _capabilities() -> dict[str, Any]:
    """The 0.34 capability document: 0.34 listed."""
    return _json(_ROOT / "examples" / "capabilities" / "success.json")


def _success() -> dict[str, Any]:
    """The published one-document, one-job answer."""
    return _json(_ROOT / "pipeline-status" / "success.json")


def _empty() -> dict[str, Any]:
    """The published answer for a vault nobody has uploaded to."""
    return _json(_ROOT / "pipeline-status" / "empty.json")


class _StatusVault:
    """A vault answering its handshake and the status read, recording each request."""

    def __init__(
        self,
        capabilities: dict[str, Any],
        answer: Callable[[httpx.Request], httpx.Response],
    ) -> None:
        """Serve ``capabilities``, and ``answer`` for anything else."""
        self.capabilities = capabilities
        self.answer = answer
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer it."""
        self.requests.append(request)
        if request.url.path == "/v1/capabilities":
            return httpx.Response(HTTPStatus.OK, json=self.capabilities)
        return self.answer(request)

    def status_requests(self) -> list[httpx.Request]:
        """Every request that reached the status route."""
        return [request for request in self.requests if request.url.path == _STATUS_PATH]


def _answering(
    body: object, status: int = HTTPStatus.OK
) -> Callable[[httpx.Request], httpx.Response]:
    """A status route that always answers ``body`` at ``status``."""

    def _answer(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    return _answer


async def _status(vault: _StatusVault, limit: int = _LIMIT) -> VaultPipelineStatus:
    """Handshake, then read the status through the real adapter."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http, managed=True)
        await client.handshake()
        return await client.pipeline_status(limit)


def test_the_snapshot_is_pinned_to_the_producer_manifest_and_the_pin_stays_0_22() -> None:
    """Every copied byte matches Creek's manifest; the base pin does not move."""
    vendor = _json(_ROOT / "vendor.json")
    manifest = _json(_ROOT / "manifest.json")
    assert vendor["commit"] == _PINNED_COMMIT
    assert vendor["contract_version"] == manifest["contract_version"] == "0.34.0"
    assert CONTRACT_VERSION == "0.22.0"
    assert PIPELINE_STATUS_SINCE_MINOR == _STATUS_MINOR
    upstream = {entry["path"]: entry["sha256"] for entry in manifest["files"]}
    assert set(vendor["files"]) == {
        path.relative_to(_ROOT).as_posix()
        for path in _ROOT.rglob("*.json")
        if path.name != "vendor.json"
    }
    for name, digest in vendor["files"].items():
        assert hashlib.sha256((_ROOT / name).read_bytes()).hexdigest() == digest
        if name != "manifest.json":
            assert upstream[name] == digest


def test_the_wire_vocabulary_is_creeks_published_one() -> None:
    """Stages, outcomes, reasons, job kinds and states, and the clamp, off the schema."""
    schema = _json(_ROOT / "schemas" / "PipelineStatusResponse.schema.json")
    query = _json(_ROOT / "schemas" / "PipelineStatusQuery.schema.json")
    defs = schema["$defs"]
    assert {stage.value for stage in VaultDocumentStage} == set(defs["PipelineStage"]["enum"])
    assert {outcome.value for outcome in VaultStageOutcome} == set(
        defs["PipelineStageOutcome"]["enum"]
    )
    assert {reason.value for reason in VaultFolderWriterlessReason} == set(
        defs["FolderWriterlessReason"]["enum"]
    )
    assert {state.value for state in VaultStatusJobState} == set(defs["JobState"]["enum"])
    assert {kind.value for kind in VaultStatusJobKind} == set(
        defs["PipelineJobSummary"]["properties"]["kind"]["enum"]
    )
    assert set(wire.JOB_METHODS) == set(defs["ClassificationMethod"]["enum"]) | set(
        defs["LinkMethod"]["enum"]
    )
    assert set(wire.JOB_FAILURE_CODES) == set(defs["JobFailureCode"]["enum"])
    assert defs["PipelineFolderStatus"]["properties"]["path"]["pattern"] == wire.FOLDER_PATH_PATTERN
    fragment_path = defs["PipelineDocumentStatus"]["properties"]["fragment_path"]["anyOf"][0]
    assert fragment_path["pattern"] == wire.FRAGMENT_PATH_PATTERN
    assert query["properties"]["limit"]["default"] == _LIMIT
    assert schema["properties"]["documents"]["maxItems"] == PIPELINE_STATUS_MAX_LIMIT


def test_every_answer_this_suite_serves_is_one_creek_publishes() -> None:
    """The bodies the fakes below answer validate against the 0.34 schema."""
    schema = _json(_ROOT / "schemas" / "PipelineStatusResponse.schema.json")
    jsonschema.validate(_success(), schema)
    jsonschema.validate(_empty(), schema)


@pytest.mark.asyncio
async def test_the_published_answer_is_read_and_only_the_status_read_declares_0_34() -> None:
    """The read declares 0.34 at the personal ceiling with the limit; the handshake is bare."""
    vault = _StatusVault(_capabilities(), _answering(_success()))
    status = await _status(vault)
    (request,) = vault.status_requests()
    assert request.headers[_CONTRACT_HEADER] == _STATUS_MINOR
    assert request.headers[_CEILING_HEADER] == "personal"
    assert request.headers["authorization"] == f"Bearer {_API_KEY}"
    assert dict(request.url.params) == {"limit": str(_LIMIT)}
    assert vault.requests[0].headers.get(_CONTRACT_HEADER) is None
    assert len(status.folders) == _SCAFFOLDED_FOLDERS
    substack = next(f for f in status.folders if f.path == "01-Fragments/Writing/Substack")
    assert substack.count == 212
    assert substack.writer == "ingest"
    assert substack.writer_reason is None
    assert substack.last_written_at == datetime(2026, 11, 20, 17, 2, 11, tzinfo=UTC)
    container = next(f for f in status.folders if f.path == "01-Fragments")
    assert container.writer is None
    assert container.writer_reason is VaultFolderWriterlessReason.CONTAINER
    (document,) = status.documents
    assert document.filename == "on-attention.html"
    assert document.fragment_path == "01-Fragments/Writing/Substack/on-attention.md"
    assert [stage.stage for stage in document.stages] == [
        VaultDocumentStage.INGESTED,
        VaultDocumentStage.CLASSIFIED,
        VaultDocumentStage.PRAXIS_SCANNED,
        VaultDocumentStage.LINKED_EDDIES,
    ]
    assert document.stages[-1].outcome is VaultStageOutcome.PARTIAL
    assert status.documents_withheld == 1
    (job,) = status.jobs
    assert job.kind is VaultStatusJobKind.LINK
    assert job.method == "embeddings"
    assert job.state is VaultStatusJobState.RUNNING
    assert job.failure_code is None


@pytest.mark.asyncio
async def test_the_published_empty_answer_is_every_folder_and_nothing_else() -> None:
    """A vault nobody uploaded to still lists its whole scaffold, all at zero."""
    vault = _StatusVault(_capabilities(), _answering(_empty()))
    status = await _status(vault)
    assert len(status.folders) == _SCAFFOLDED_FOLDERS
    assert all(folder.count == 0 for folder in status.folders)
    assert status.documents == ()
    assert status.jobs == ()
    assert status.documents_withheld == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [0, PIPELINE_STATUS_MAX_LIMIT + 1])
async def test_a_limit_creek_would_refuse_is_refused_before_any_request(limit: int) -> None:
    """A limit outside ``1..200`` is a caller's bug here, not an invalid_request there."""
    vault = _StatusVault(_capabilities(), _answering(_success()))
    with pytest.raises(ValueError, match="limit"):
        await _status(vault, limit)
    assert vault.status_requests() == []


@pytest.mark.asyncio
async def test_a_vault_that_does_not_list_0_34_is_never_asked() -> None:
    """The deployed 0.22-era image would answer 409, so the read is not attempted."""
    capabilities = _json(_BASE / "capabilities" / "success.json")
    assert _STATUS_MINOR not in capabilities.get("supported_contract_minors", [])
    vault = _StatusVault(capabilities, _answering(_success()))
    with pytest.raises(CreekCapabilityUnsupportedError):
        await _status(vault)
    assert vault.status_requests() == []


def _with_folder(**changes: object) -> dict[str, Any]:
    """The success answer with its first folder changed."""
    body = _success()
    body["folders"][0] = body["folders"][0] | changes
    return body


def _with_document(**changes: object) -> dict[str, Any]:
    """The success answer with its document changed."""
    body = _success()
    body["documents"][0] = body["documents"][0] | changes
    return body


def _with_job(**changes: object) -> dict[str, Any]:
    """The success answer with its job changed."""
    body = _success()
    body["jobs"][0] = body["jobs"][0] | changes
    return body


def _with(**changes: object) -> dict[str, Any]:
    """The success answer with envelope fields changed."""
    return _success() | changes


def _with_stage(**changes: object) -> dict[str, Any]:
    """The success answer with its document's first stage changed."""
    body = copy.deepcopy(_success())
    body["documents"][0]["stages"][0] = body["documents"][0]["stages"][0] | changes
    return body


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        _with(extra="field"),
        _with(status="partial"),
        _with(tier_ceiling="intimate"),
        _with(documents_withheld=-1),
        _with_folder(path="../etc"),
        _with_folder(count=-1),
        _with_folder(writer_reason="mystery"),
        _with_folder(title="a heading"),
        _with_document(fragment_path="02-Threads/elsewhere.md"),
        _with_document(fragment_count=0),
        _with_document(stages=[]),
        _with_document(body="the writing itself"),
        _with_stage(stage="published"),
        _with_stage(outcome="maybe"),
        _with_stage(at="yesterday"),
        _with_job(kind="voice"),
        _with_job(method="vibes"),
        _with_job(failure_code="the provider said no"),
        _with_job(state="sleeping"),
        [],
    ],
    ids=[
        "extra-envelope-field",
        "wrong-status",
        "unspellable-ceiling",
        "negative-withheld",
        "unsafe-folder-path",
        "negative-count",
        "unknown-writerless-reason",
        "extra-folder-field",
        "fragment-outside-fragments",
        "zero-fragments",
        "no-stages",
        "extra-document-field",
        "unknown-stage",
        "unknown-outcome",
        "unparseable-instant",
        "unknown-job-kind",
        "unknown-job-method",
        "prose-failure-code",
        "unknown-job-state",
        "not-an-object",
    ],
)
async def test_an_off_schema_answer_is_a_payload_fault(body: object) -> None:
    """Strict: a field Creek never published, or a value outside its vocabulary, is refused."""
    vault = _StatusVault(_capabilities(), _answering(body))
    with pytest.raises(CreekVaultPayloadError):
        await _status(vault)


@pytest.mark.asyncio
async def test_the_published_incompatible_version_answer_is_a_coded_contract_error() -> None:
    """A vault that listed 0.34 and then refused it says ``incompatible_version``."""
    body = _json(_ROOT / "examples" / "pipeline" / "incompatible-version.json")
    vault = _StatusVault(_capabilities(), _answering(body, HTTPStatus.CONFLICT))
    with pytest.raises(CreekVaultContractError) as raised:
        await _status(vault)
    assert raised.value.code is VaultErrorCode.INCOMPATIBLE_VERSION


@pytest.mark.asyncio
async def test_the_published_unavailable_answer_is_an_unavailable_vault() -> None:
    """``503 unavailable`` is the vault saying it cannot list itself."""
    body = _json(_ROOT / "examples" / "pipeline" / "unavailable-service.json")
    vault = _StatusVault(_capabilities(), _answering(body, HTTPStatus.SERVICE_UNAVAILABLE))
    with pytest.raises(CreekVaultUnavailableError):
        await _status(vault)


@pytest.mark.asyncio
async def test_a_vault_that_times_out_is_a_timed_out_call() -> None:
    """A slow vault is told apart from an absent one."""

    def _slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("synthetic slow vault", request=request)

    vault = _StatusVault(_capabilities(), _slow)
    with pytest.raises(VaultCallTimedOutError):
        await _status(vault)


@pytest.mark.asyncio
async def test_a_vault_that_drops_the_connection_is_unavailable() -> None:
    """An autostopped vault the edge could not wake is unavailable."""

    def _gone(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("synthetic autostopped vault", request=request)

    vault = _StatusVault(_capabilities(), _gone)
    with pytest.raises(CreekVaultUnavailableError):
        await _status(vault)


@pytest.mark.asyncio
async def test_the_no_vault_client_has_no_status_to_read() -> None:
    """The local fallback has no vault, and says so by raising."""
    client = LocalFallbackCreekVaultClient()
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.pipeline_status(_LIMIT)
