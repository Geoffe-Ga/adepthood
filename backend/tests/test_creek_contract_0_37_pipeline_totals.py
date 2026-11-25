"""Creek contract 0.37's whole-corpus stage totals, read without moving the 0.22 pin (#3795).

0.37 (Creek-Vault#2147) adds ``totals`` to ``GET /v1/pipeline/status``: how many
documents the caller ever uploaded, and for every pipeline stage how many of
them it covered, left partial, or failed. The route's ``documents`` list is
clamped to the newest 200, so this is the only honest "x of y" for a larger
corpus. Creek sends ``totals`` to a caller declaring 0.37 and serves a caller
declaring 0.34 to 0.36 the body its minor published, with no ``totals`` key.

So the read declares the newest of the two minors the vault's handshake lists:
0.37 to a vault that lists it, 0.34 to one that lists only that, and nothing to
one that lists neither. Every other call keeps its own minor.

These tests drive the real adapter against a ``MockTransport`` vault and pin:
the snapshot is the producer's; which minor is declared to which vault; that
each minor's answer is parsed against that minor's own closed shape; and that
totals which contradict themselves refuse the whole answer.

Expectations are literals, never values read off the pin, for the reason
``tests/test_creek_contract_0_21.py`` gives.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Callable
from http import HTTPStatus
from pathlib import Path
from typing import Any, Final

import httpx
import jsonschema
import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapabilityUnsupportedError,
    CreekVaultPayloadError,
)
from domain.vault_pipeline_status import (
    PIPELINE_STATUS_SINCE_MINOR,
    PIPELINE_TOTALS_SINCE_MINOR,
    VaultDocumentStage,
    VaultPipelineStatus,
    VaultStageTotal,
)
from services import creek_vault_pipeline_status_wire as wire
from services.creek_vault_client import HttpCreekVaultClient

#: The reviewed Creek-Vault commit the snapshot was copied from (a git SHA, not a secret).
_PINNED_COMMIT: Final = "f9af05de25ea4e499a1144098ec6d7ce8c20c012"  # pragma: allowlist secret
_FIXTURES: Final = Path(__file__).parent / "fixtures"
_ROOT: Final = _FIXTURES / "creek_pipeline_status_v037"
_V034: Final = _FIXTURES / "creek_pipeline_status_v034"
_BASE: Final = _FIXTURES / "creek_v1" / "examples"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "contract-037-test-key"  # pragma: allowlist secret
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"
_STATUS_PATH: Final = "/v1/pipeline/status"

#: The minor that carries totals, and the one that first served the read. Literals.
_TOTALS_MINOR: Final = "0.37"
_STATUS_MINOR: Final = "0.34"
#: The base pin's minor: a vault that does not list it is not usable at all.
_PINNED_MINOR: Final = "0.22"
_LIMIT: Final = 50
#: The published success cell's corpus: 1240 documents.
_PUBLISHED_DOCUMENTS: Final = 1240
_PUBLISHED_EMBEDDED: Final = 900
#: Every stage Creek counts, in pipeline order.
_STAGES_IN_ORDER: Final = (
    "ingested",
    "classified",
    "praxis_scanned",
    "linked:embeddings",
    "linked:temporal",
    "linked:eddies",
    "linked:threads",
)
_INGESTED: Final = 0
_CLASSIFIED: Final = 1


def _json(path: Path) -> dict[str, Any]:
    """Load one vendored JSON document."""
    loaded: dict[str, Any] = json.loads(path.read_bytes())
    return loaded


def _capabilities() -> dict[str, Any]:
    """The 0.37 capability document: 0.37 and 0.34 both listed."""
    return _json(_ROOT / "examples" / "capabilities" / "success.json")


def _capabilities_listing(*minors: str) -> dict[str, Any]:
    """The 0.37 capability document, listing only ``minors`` and adepthood's own pin."""
    return _capabilities() | {"supported_contract_minors": [*minors, _PINNED_MINOR]}


def _success() -> dict[str, Any]:
    """The published 0.37 answer: one page of documents, and the corpus totals."""
    return _json(_ROOT / "pipeline-status" / "success.json")


def _empty() -> dict[str, Any]:
    """The published 0.37 answer for a vault nobody has uploaded to."""
    return _json(_ROOT / "pipeline-status" / "empty.json")


def _untotalled() -> dict[str, Any]:
    """The body Creek serves a 0.34 caller: the published answer with no ``totals`` key."""
    body = _success()
    del body["totals"]
    return body


class _StatusVault:
    """A vault answering its handshake and the status read, recording each request."""

    def __init__(self, capabilities: dict[str, Any], body: object) -> None:
        """Serve ``capabilities``, and ``body`` for anything else."""
        self.capabilities = capabilities
        self.body = body
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer it."""
        self.requests.append(request)
        if request.url.path == "/v1/capabilities":
            return httpx.Response(HTTPStatus.OK, json=self.capabilities)
        return httpx.Response(HTTPStatus.OK, json=self.body)

    def status_requests(self) -> list[httpx.Request]:
        """Every request that reached the status route."""
        return [request for request in self.requests if request.url.path == _STATUS_PATH]


async def _status(vault: _StatusVault) -> VaultPipelineStatus:
    """Handshake, then read the status through the real adapter."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http, managed=True)
        await client.handshake()
        return await client.pipeline_status(_LIMIT)


def test_the_snapshot_is_pinned_to_the_producer_manifest_and_the_pin_stays_0_22() -> None:
    """Every copied byte matches Creek's manifest; the base pin does not move."""
    vendor = _json(_ROOT / "vendor.json")
    manifest = _json(_ROOT / "manifest.json")
    assert vendor["commit"] == _PINNED_COMMIT
    assert vendor["contract_version"] == manifest["contract_version"] == "0.37.0"
    assert CONTRACT_VERSION == "0.22.0"
    assert PIPELINE_TOTALS_SINCE_MINOR == _TOTALS_MINOR
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


def test_the_totals_vocabulary_is_creeks_published_one() -> None:
    """One row per published stage, in the order Creek lists them, and never a fourth count."""
    schema = _json(_ROOT / "schemas" / "PipelineStatusResponse.schema.json")
    defs = schema["$defs"]
    assert [stage.value for stage in VaultDocumentStage] == list(_STAGES_IN_ORDER)
    assert set(_STAGES_IN_ORDER) == set(defs["PipelineStage"]["enum"])
    stages = defs["PipelineTotals"]["properties"]["stages"]
    assert stages["minItems"] == stages["maxItems"] == len(VaultDocumentStage)
    assert set(defs["PipelineStageTotal"]["properties"]) == {
        "stage",
        "covered",
        "partial",
        "failed",
    }
    assert set(defs["PipelineTotals"]["properties"]) == {"documents", "stages"}
    assert [row["stage"] for row in _success()["totals"]["stages"]] == list(_STAGES_IN_ORDER)


def test_every_answer_this_suite_serves_is_one_creek_publishes() -> None:
    """The 0.37 cells validate at 0.37; the body without totals validates at 0.34."""
    totalled = _json(_ROOT / "schemas" / "PipelineStatusResponse.schema.json")
    jsonschema.validate(_success(), totalled)
    jsonschema.validate(_empty(), totalled)
    untotalled = _json(_V034 / "schemas" / "PipelineStatusResponse.schema.json")
    body = _untotalled()
    # 0.34 pinned fragments under ``01-Fragments`` alone; the cell's one is.
    jsonschema.validate(body, untotalled)


@pytest.mark.asyncio
async def test_a_vault_listing_0_37_is_asked_at_0_37_and_its_totals_are_read() -> None:
    """The read declares 0.37, and the published totals come back stage by stage."""
    vault = _StatusVault(_capabilities(), _success())
    status = await _status(vault)
    (request,) = vault.status_requests()
    assert request.headers[_CONTRACT_HEADER] == _TOTALS_MINOR
    assert vault.requests[0].headers.get(_CONTRACT_HEADER) is None
    totals = status.totals
    assert totals is not None
    assert totals.documents == _PUBLISHED_DOCUMENTS
    assert [row.stage.value for row in totals.stages] == list(_STAGES_IN_ORDER)
    assert totals.stages[_INGESTED] == VaultStageTotal(
        stage=VaultDocumentStage.INGESTED, covered=_PUBLISHED_DOCUMENTS, partial=0, failed=0
    )
    by_stage = {row.stage: row for row in totals.stages}
    assert by_stage[VaultDocumentStage.LINKED_EMBEDDINGS].covered == _PUBLISHED_EMBEDDED
    eddies = by_stage[VaultDocumentStage.LINKED_EDDIES]
    assert (eddies.covered, eddies.partial, eddies.failed) == (0, _PUBLISHED_DOCUMENTS, 0)
    # The page itself is read exactly as it was at 0.34.
    assert len(status.documents) == 1
    assert status.documents_withheld == 1


@pytest.mark.asyncio
async def test_the_published_empty_answer_counts_nothing_at_every_stage() -> None:
    """A vault nobody uploaded to still lists every stage, all at zero."""
    status = await _status(_StatusVault(_capabilities(), _empty()))
    totals = status.totals
    assert totals is not None
    assert totals.documents == 0
    assert [(row.covered, row.partial, row.failed) for row in totals.stages] == [(0, 0, 0)] * len(
        _STAGES_IN_ORDER
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("minors", [("0.34",), ("0.36", "0.35", "0.34")])
async def test_a_vault_listing_only_an_earlier_minor_is_asked_at_0_34(
    minors: tuple[str, ...],
) -> None:
    """Folders, documents and jobs still answer; there are simply no totals."""
    vault = _StatusVault(_capabilities_listing(*minors), _untotalled())
    status = await _status(vault)
    (request,) = vault.status_requests()
    assert request.headers[_CONTRACT_HEADER] == _STATUS_MINOR
    assert status.totals is None
    assert len(status.folders) > 0
    assert len(status.documents) == 1
    assert len(status.jobs) == 1


@pytest.mark.asyncio
async def test_a_vault_listing_0_37_without_0_34_is_still_asked() -> None:
    """A future image that retired 0.34 serves the read at 0.37 all the same."""
    vault = _StatusVault(_capabilities_listing(_TOTALS_MINOR), _success())
    status = await _status(vault)
    (request,) = vault.status_requests()
    assert request.headers[_CONTRACT_HEADER] == _TOTALS_MINOR
    assert status.totals is not None


@pytest.mark.asyncio
async def test_a_vault_listing_neither_minor_is_never_asked() -> None:
    """The deployed 0.22-era image would answer 409, so the read is not attempted."""
    capabilities = _json(_BASE / "capabilities" / "success.json")
    vault = _StatusVault(capabilities, _success())
    with pytest.raises(CreekCapabilityUnsupportedError):
        await _status(vault)
    assert vault.status_requests() == []


@pytest.mark.asyncio
async def test_a_0_37_answer_without_totals_is_a_payload_fault() -> None:
    """Creek always sends ``totals`` at 0.37; an answer without it is not 0.37's."""
    vault = _StatusVault(_capabilities(), _untotalled())
    with pytest.raises(CreekVaultPayloadError):
        await _status(vault)


@pytest.mark.asyncio
async def test_a_0_34_answer_carrying_totals_is_a_payload_fault() -> None:
    """0.34's published body is closed; a key it never had refuses the answer."""
    vault = _StatusVault(_capabilities_listing(_STATUS_MINOR), _success())
    with pytest.raises(CreekVaultPayloadError):
        await _status(vault)


def _with_totals(**changes: object) -> dict[str, Any]:
    """The published answer with its ``totals`` object changed."""
    body = _success()
    body["totals"] = body["totals"] | changes
    return body


def _with_stage(index: int, **changes: object) -> dict[str, Any]:
    """The published answer with one stage's totals changed."""
    body = copy.deepcopy(_success())
    body["totals"]["stages"][index] = body["totals"]["stages"][index] | changes
    return body


def _with_stages(reorder: Callable[[list[dict[str, Any]]], list[dict[str, Any]]]) -> dict[str, Any]:
    """The published answer with its stage rows rearranged by ``reorder``."""
    body = copy.deepcopy(_success())
    body["totals"]["stages"] = reorder(body["totals"]["stages"])
    return body


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        _success() | {"totals": None},
        _with_totals(documents=-1),
        _with_totals(filenames=["on-attention.html"]),
        _with_stage(_CLASSIFIED, stage="published"),
        _with_stage(_CLASSIFIED, covered=-1),
        _with_stage(_CLASSIFIED, partial=-1),
        _with_stage(_CLASSIFIED, failed=-1),
        _with_stage(_CLASSIFIED, covered=_PUBLISHED_DOCUMENTS + 1),
        _with_stage(_CLASSIFIED, partial=1),
        _with_stage(_CLASSIFIED, covered=True),
        _with_stage(_CLASSIFIED, title="a heading"),
        _with_stages(lambda rows: rows[:-1]),
        _with_stages(lambda rows: [*rows, rows[-1]]),
        _with_stages(lambda rows: [rows[1], rows[0], *rows[2:]]),
        _with_stages(lambda rows: [rows[0], rows[0], *rows[2:]]),
    ],
    ids=[
        "null-totals",
        "negative-documents",
        "extra-totals-field",
        "unknown-stage",
        "negative-covered",
        "negative-partial",
        "negative-failed",
        "covered-above-documents",
        "counts-summing-above-documents",
        "boolean-count",
        "extra-stage-field",
        "a-stage-missing",
        "a-stage-too-many",
        "stages-out-of-order",
        "a-stage-twice",
    ],
)
async def test_totals_off_the_published_shape_are_a_payload_fault(body: object) -> None:
    """Strict: totals that Creek never published, or that contradict themselves, are refused."""
    vault = _StatusVault(_capabilities(), body)
    with pytest.raises(CreekVaultPayloadError):
        await _status(vault)


def test_the_parser_reads_each_minors_own_shape() -> None:
    """Asked for totals it requires them; not asked, it refuses them."""
    totalled = json.dumps(_success()).encode()
    untotalled = json.dumps(_untotalled()).encode()
    read = wire.pipeline_status_from(totalled, totalled=True)
    assert read is not None
    assert read.totals is not None
    plain = wire.pipeline_status_from(untotalled)
    assert plain is not None
    assert plain.totals is None
    assert wire.pipeline_status_from(untotalled, totalled=True) is None
    assert wire.pipeline_status_from(totalled) is None
