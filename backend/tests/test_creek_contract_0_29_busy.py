"""Creek contract 0.29's ``busy`` job failure code, read without moving the 0.22 pin.

0.29 (Creek-Vault#2090, #2075) adds a second member to the closed
``JobFailureCode`` of ``GET /v1/jobs/{job_id}``: a durable ``llm``
classification or ``embeddings`` link job whose pass could not take the vault
content-mutation lock within its bounded wait ends ``failed`` with
``failure_code: "busy"``. Nothing was written, and the condition is transient,
so the caller resubmits with backoff. Creek serves the code only to a caller
declaring 0.29 or later; a caller at 0.26-0.28 is served ``null`` for the same
failure, and one below 0.26 is served no key at all.

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
    VaultLinkStage,
    VaultPipelineJob,
    VaultPipelineJobState,
    VaultPipelineStage,
)
from domain.vault_job_failure import (
    BUSY_FAILURE_CODE_SINCE_MINOR,
    JOB_FAILURE_CODE_SINCE_MINOR_BY_CODE,
    TRANSIENT_JOB_FAILURE_CODES,
    failure_code_is_final,
)
from services.creek_vault_client import HttpCreekVaultClient

#: The reviewed Creek-Vault commit the snapshot was copied from (a git SHA, not a secret).
_PINNED_COMMIT: Final = "c8d671c1afd118741ee587c30f93fda2e7b8abc4"  # pragma: allowlist secret
_FIXTURES: Final = Path(__file__).parent / "fixtures"
_ROOT: Final = _FIXTURES / "creek_jobs_v029"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "contract-029-test-key"  # pragma: allowlist secret
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"
_NO_MINOR: Final = "0.0"
#: Creek's own gates, as literals: the ``failure_code`` key (0.26) and ``busy`` (0.29).
_FAILURE_CODE_KEY_SINCE: Final = (0, 26)
_BUSY_SINCE: Final = (0, 29)
_BUSY_MINOR: Final = "0.29"
_FAILURE_CODE_MINOR: Final = "0.26"
_PINNED_MINOR: Final = "0.22"
_JOBS: Final = "/v1/jobs/"
_ADMISSIONS: Final = {"classify": "/v1/classifications", "link": "/v1/links"}
_JOB_ID: Final = "66666666-6666-4666-8666-666666666666"
_BUSY: Final = "busy"


def _json(path: Path) -> dict[str, Any]:
    """Load one vendored JSON document."""
    loaded: dict[str, Any] = json.loads(path.read_bytes())
    return loaded


def _failed_status(**extra: object) -> dict[str, object]:
    """A failed job-status document, with any 0.26+ fields the test adds."""
    return {"status": "ok", "job_id": _JOB_ID, "state": "failed", "result": None, **extra}


def test_the_0_29_snapshot_is_pinned_to_the_producer_manifest_and_the_pin_stays_0_22() -> None:
    """Every copied byte matches Creek's manifest; the base pin does not move."""
    vendor = _json(_ROOT / "vendor.json")
    manifest = _json(_ROOT / "manifest.json")
    assert vendor["commit"] == _PINNED_COMMIT
    assert vendor["contract_version"] == manifest["contract_version"] == "0.29.0"
    assert CONTRACT_VERSION == "0.22.0"
    assert BUSY_FAILURE_CODE_SINCE_MINOR == "0.29"
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


def test_a_busy_document_is_one_creek_publishes() -> None:
    """The failed bodies this suite serves validate against the 0.29 schema, and 0.29 is listed."""
    schema = _json(_ROOT / "schemas" / "JobStatusResponse.schema.json")
    jsonschema.validate(_failed_status(failure_code=_BUSY), schema)
    jsonschema.validate(_failed_status(failure_code="request_key_rejected"), schema)
    jsonschema.validate(_failed_status(failure_code=None), schema)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(_failed_status(failure_code="a_code_creek_never_published"), schema)
    capabilities = _json(_ROOT / "examples" / "capabilities" / "success.json")
    assert "0.29" in capabilities["supported_contract_minors"]


def test_every_code_names_the_minor_creek_published_it_at() -> None:
    """The map is total, and each entry is Creek's own since-minor, as a literal."""
    assert dict(JOB_FAILURE_CODE_SINCE_MINOR_BY_CODE) == {
        VaultJobFailureCode.REQUEST_KEY_REJECTED: "0.26",
        VaultJobFailureCode.BUSY: "0.29",
    }
    assert set(JOB_FAILURE_CODE_SINCE_MINOR_BY_CODE) == set(VaultJobFailureCode)
    assert JOB_FAILURE_CODE_SINCE_MINOR == "0.26"
    assert VaultJobFailureCode.BUSY.value == _BUSY


#: Whether each published reason settles a failed run now. A new member must be
#: added here, deciding which it is, before :func:`failure_code_is_final` is green.
_FINALITY: Final[dict[VaultJobFailureCode | None, bool]] = {
    None: False,
    VaultJobFailureCode.REQUEST_KEY_REJECTED: True,
    VaultJobFailureCode.BUSY: False,
}


@pytest.mark.parametrize(("code", "final"), list(_FINALITY.items()), ids=str)
def test_only_a_refused_key_is_a_final_failure(
    code: VaultJobFailureCode | None, *, final: bool
) -> None:
    """A refused key is refused again; a busy vault or an unnamed failure may clear."""
    assert failure_code_is_final(code) is final


def test_the_finality_table_decides_every_code() -> None:
    """No member reaches the ladder without someone deciding whether it retries."""
    assert set(_FINALITY) == {None, *VaultJobFailureCode}
    assert frozenset({VaultJobFailureCode.BUSY}) == TRANSIENT_JOB_FAILURE_CODES


# -- the wire --------------------------------------------------------------------


def _minor(text: str) -> tuple[int, ...]:
    """A declared ``"0.29"``-style minor as comparable integers."""
    return tuple(int(part) for part in text.split("."))


def _capabilities(snapshot: str) -> dict[str, Any]:
    """A vendored handshake: the 0.29 image, the 0.26 image, or the base 0.22 one."""
    return _json(_FIXTURES / snapshot / "examples" / "capabilities" / "success.json")


def _served_busy(declared: str | None) -> dict[str, object]:
    """A job that met lock contention, as Creek serves it to a poll declaring ``declared``.

    Mirrors Creek's ``_served_failure_code``: ``busy`` at 0.29 or later, ``null``
    at 0.26-0.28, and no key at all below 0.26.
    """
    body = _failed_status()
    minor = _minor(declared or _NO_MINOR)
    if minor >= _FAILURE_CODE_KEY_SINCE:
        body["failure_code"] = _BUSY if minor >= _BUSY_SINCE else None
    return body


class _BusyVault:
    """A vault whose one admitted job is busy, recording what every request declared."""

    def __init__(self, capabilities: dict[str, Any]) -> None:
        """Serve ``capabilities`` at the handshake."""
        self.capabilities = capabilities
        self.declared: dict[str, str | None] = {}
        self.served: list[dict[str, object]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer the handshake, either admission, and the job poll."""
        declared = request.headers.get(_CONTRACT_HEADER)
        self.declared[request.url.path] = declared
        if request.url.path == "/v1/capabilities":
            return httpx.Response(200, json=self.capabilities)
        if request.url.path in _ADMISSIONS.values():
            return httpx.Response(
                202, json={"status": "accepted", "job_id": _JOB_ID, "state": "queued"}
            )
        body = _served_busy(declared)
        self.served.append(body)
        return httpx.Response(200, json=body)


async def _admit_and_poll(vault: _BusyVault, kind: str) -> object:
    """Handshake, admit one ``kind`` pass, and poll its job through the real adapter."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
        assert (await client.handshake()).available
        admitted = (
            await client.classify_corpus()
            if kind == "classify"
            else await client.link_corpus(VaultLinkStage.EMBEDDINGS)
        )
        assert isinstance(admitted, VaultPipelineJob)
        assert admitted.job_id == UUID(_JOB_ID)
        return await client.pipeline_job(admitted)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kind", "stage"),
    [("classify", VaultPipelineStage.CLASSIFY), ("link", VaultPipelineStage.EMBEDDINGS)],
)
async def test_a_vault_listing_0_29_is_polled_at_0_29_and_a_busy_job_reads_busy(
    kind: str, stage: VaultPipelineStage
) -> None:
    """The poll alone declares 0.29; Creek's busy body validates and parses as BUSY."""
    vault = _BusyVault(_capabilities("creek_jobs_v029"))
    polled = await _admit_and_poll(vault, kind)

    assert vault.declared[f"{_JOBS}{_JOB_ID}"] == _BUSY_MINOR
    assert vault.declared[_ADMISSIONS[kind]] == _PINNED_MINOR
    assert vault.declared["/v1/capabilities"] is None
    schema = _json(_ROOT / "schemas" / "JobStatusResponse.schema.json")
    assert vault.served == [_failed_status(failure_code=_BUSY)]
    jsonschema.validate(vault.served[0], schema)
    assert polled == VaultPipelineJob(
        job_id=UUID(_JOB_ID),
        stage=stage,
        state=VaultPipelineJobState.FAILED,
        failure_code=VaultJobFailureCode.BUSY,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("snapshot", "declared", "served"),
    [
        pytest.param(
            "creek_jobs_v029",
            _BUSY_MINOR,
            _failed_status(failure_code=_BUSY),
            id="lists-0.29",
        ),
        pytest.param(
            "creek_jobs_v026",
            _FAILURE_CODE_MINOR,
            _failed_status(failure_code=None),
            id="lists-0.26-not-0.29",
        ),
        pytest.param("creek_v1", _PINNED_MINOR, _failed_status(), id="lists-neither"),
    ],
)
async def test_the_poll_declares_the_newest_failure_code_minor_the_vault_lists(
    snapshot: str, declared: str, served: dict[str, object]
) -> None:
    """0.29 if listed, else 0.26 if listed, else the pin -- never a minor Creek would refuse."""
    vault = _BusyVault(_capabilities(snapshot))
    polled = await _admit_and_poll(vault, "classify")

    assert vault.declared[f"{_JOBS}{_JOB_ID}"] == declared
    assert vault.served == [served]
    assert isinstance(polled, VaultPipelineJob)
    assert polled.state is VaultPipelineJobState.FAILED
    expected = VaultJobFailureCode.BUSY if declared == _BUSY_MINOR else None
    assert polled.failure_code is expected


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", list(_ADMISSIONS))
async def test_every_admission_keeps_the_pin_against_a_0_29_vault(kind: str) -> None:
    """Only the read departs: the admissions, which may carry a writer key, stay on 0.22."""
    vault = _BusyVault(_capabilities("creek_jobs_v029"))
    await _admit_and_poll(vault, kind)

    versioned = {path: minor for path, minor in vault.declared.items() if minor is not None}
    assert versioned == {_ADMISSIONS[kind]: _PINNED_MINOR, f"{_JOBS}{_JOB_ID}": _BUSY_MINOR}
