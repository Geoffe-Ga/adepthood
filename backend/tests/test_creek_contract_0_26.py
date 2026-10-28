"""Creek contract 0.26's job ``failure_code``, read without moving the 0.22 pin.

0.26 (Creek-Vault#1877) adds one field to ``GET /v1/jobs/{job_id}``: a job
whose writer request key was refused by its vendor ends ``failed`` with
``failure_code: "request_key_rejected"``, and every other outcome is ``null``.
Creek publishes the key only to a caller declaring minor 0.26 or later, and it
refuses any minor its ``supported_contract_minors`` does not list -- so the
deployed vaults still on an older image must keep hearing 0.22.

The move is pinned on four facts: the pin stays 0.22; the job-status poll
declares 0.26 exactly when the vault's handshake lists it and 0.22 otherwise;
every other versioned call keeps 0.22 either way; and the field is read
tolerantly, so an absent, null or unknown code reads as "no code" rather than
as an unreadable status.

Expectations are literals, never values read off the pin, for the reason
``tests/test_creek_contract_0_21.py`` gives.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Final
from uuid import UUID

import httpx
import jsonschema
import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    JOB_FAILURE_CODE_SINCE_MINOR,
    VaultJobFailureCode,
    VaultPipelineJob,
    VaultPipelineJobState,
    VaultPipelineStage,
)
from services.creek_vault_client import HttpCreekVaultClient

#: The reviewed Creek-Vault commit the snapshot was copied from (a git SHA, not a secret).
_PINNED_COMMIT: Final = "426088eb819221a6f4d50e0292e205ee03b9a815"  # pragma: allowlist secret
_ROOT: Final = Path(__file__).parent / "fixtures" / "creek_jobs_v026"
_BASE: Final = Path(__file__).parent / "fixtures" / "creek_v1" / "examples"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "contract-026-test-key"  # pragma: allowlist secret
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"
_JOB_ID: Final = "33333333-3333-4333-8333-333333333333"
_JOB: Final = VaultPipelineJob(
    job_id=UUID(_JOB_ID),
    stage=VaultPipelineStage.CLASSIFY,
    state=VaultPipelineJobState.QUEUED,
)

#: The minor the job poll declares against a vault that lists it. A literal.
_FAILURE_CODE_MINOR: Final = "0.26"
#: The minor every other call -- and the poll against an older vault -- declares.
_PINNED_MINOR: Final = "0.22"


def _json(path: Path) -> dict[str, Any]:
    """Load one vendored JSON document."""
    loaded: dict[str, Any] = json.loads(path.read_bytes())
    return loaded


def _failed_status(**extra: object) -> dict[str, object]:
    """A failed job-status document, with any 0.26 fields the test adds."""
    return {"status": "ok", "job_id": _JOB_ID, "state": "failed", "result": None, **extra}


def test_the_snapshot_is_pinned_to_the_producer_manifest_and_the_pin_stays_0_22() -> None:
    """Every copied byte matches Creek's manifest; the base pin does not move."""
    vendor = _json(_ROOT / "vendor.json")
    manifest = _json(_ROOT / "manifest.json")
    assert vendor["commit"] == _PINNED_COMMIT
    assert vendor["contract_version"] == manifest["contract_version"] == "0.26.0"
    assert CONTRACT_VERSION == "0.22.0"
    assert JOB_FAILURE_CODE_SINCE_MINOR == _FAILURE_CODE_MINOR
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


def test_the_failure_code_vocabulary_is_exactly_creeks() -> None:
    """Adepthood names every published code and invents none."""
    schema = _json(_ROOT / "schemas" / "JobStatusResponse.schema.json")
    published = set(schema["$defs"]["JobFailureCode"]["enum"])
    assert {code.value for code in VaultJobFailureCode} == published


def test_the_rejected_key_document_this_suite_serves_is_one_creek_publishes() -> None:
    """The failed body the fakes below answer validates against the 0.26 schema."""
    schema = _json(_ROOT / "schemas" / "JobStatusResponse.schema.json")
    jsonschema.validate(_failed_status(failure_code="request_key_rejected"), schema)
    jsonschema.validate(_failed_status(failure_code=None), schema)
    jsonschema.validate(_failed_status(), schema)


class _JobVault:
    """A vault answering its handshake and one failed job, recording each header."""

    def __init__(self, capabilities: dict[str, Any], status: dict[str, object]) -> None:
        """Serve ``capabilities`` and ``status``; record what each request declared."""
        self.capabilities = capabilities
        self.status = status
        self.declared: dict[str, str | None] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer the handshake, the classification admission and the job poll."""
        self.declared[request.url.path] = request.headers.get(_CONTRACT_HEADER)
        if request.url.path == "/v1/capabilities":
            return httpx.Response(200, json=self.capabilities)
        if request.url.path == "/v1/classifications":
            return httpx.Response(
                202, json={"status": "accepted", "job_id": _JOB_ID, "state": "queued"}
            )
        return httpx.Response(200, json=self.status)


async def _poll(vault: _JobVault) -> object:
    """Handshake, admit one pass, and poll its job through the real adapter."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
        handshake = await client.handshake()
        assert handshake.available
        await client.classify_corpus()
        return await client.pipeline_job(_JOB)


@pytest.mark.asyncio
async def test_a_vault_listing_0_26_is_polled_at_0_26_and_its_code_is_read() -> None:
    """The poll alone declares 0.26, and the published code survives the parse."""
    vault = _JobVault(
        _json(_ROOT / "examples" / "capabilities" / "success.json"),
        _failed_status(failure_code="request_key_rejected"),
    )
    polled = await _poll(vault)
    assert vault.declared[f"/v1/jobs/{_JOB_ID}"] == _FAILURE_CODE_MINOR
    assert vault.declared["/v1/classifications"] == _PINNED_MINOR
    assert vault.declared["/v1/capabilities"] is None
    assert isinstance(polled, VaultPipelineJob)
    assert polled.state is VaultPipelineJobState.FAILED
    assert polled.failure_code is VaultJobFailureCode.REQUEST_KEY_REJECTED


@pytest.mark.asyncio
async def test_a_vault_whose_window_stops_below_0_26_keeps_hearing_0_22() -> None:
    """An older image is never sent a minor it would refuse with 409."""
    capabilities = _json(_BASE / "capabilities" / "success.json")
    assert _FAILURE_CODE_MINOR not in capabilities["supported_contract_minors"]
    vault = _JobVault(capabilities, _failed_status())
    polled = await _poll(vault)
    assert vault.declared[f"/v1/jobs/{_JOB_ID}"] == _PINNED_MINOR
    assert isinstance(polled, VaultPipelineJob)
    assert polled.state is VaultPipelineJobState.FAILED
    assert polled.failure_code is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extra",
    [
        {},
        {"failure_code": None},
        {"failure_code": "a_code_published_after_0_26"},
        {"failure_code": 401},
    ],
    ids=["absent", "null", "unknown", "wrong-typed"],
)
async def test_any_other_failure_code_reads_as_no_code(extra: dict[str, object]) -> None:
    """A code adepthood cannot act on is not a code, and not an unreadable status."""
    vault = _JobVault(
        _json(_ROOT / "examples" / "capabilities" / "success.json"), _failed_status(**extra)
    )
    polled = await _poll(vault)
    assert isinstance(polled, VaultPipelineJob)
    assert polled.state is VaultPipelineJobState.FAILED
    assert polled.failure_code is None


@pytest.mark.asyncio
async def test_a_code_on_a_job_that_did_not_fail_is_ignored() -> None:
    """Only a failed job carries a reason; a running one with a code is still running."""
    status: dict[str, object] = {
        "status": "ok",
        "job_id": _JOB_ID,
        "state": "running",
        "result": None,
    }
    status["failure_code"] = "request_key_rejected"
    vault = _JobVault(_json(_ROOT / "examples" / "capabilities" / "success.json"), status)
    polled = await _poll(vault)
    assert isinstance(polled, VaultPipelineJob)
    assert polled.state is VaultPipelineJobState.RUNNING
    assert polled.failure_code is None
