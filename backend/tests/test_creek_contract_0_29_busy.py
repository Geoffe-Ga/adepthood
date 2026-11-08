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

import jsonschema
import pytest

from domain.creek_vault import (
    BUSY_FAILURE_CODE_SINCE_MINOR,
    CONTRACT_VERSION,
    JOB_FAILURE_CODE_SINCE_MINOR,
    JOB_FAILURE_CODE_SINCE_MINOR_BY_CODE,
    TRANSIENT_JOB_FAILURE_CODES,
    VaultJobFailureCode,
    failure_code_is_final,
)

#: The reviewed Creek-Vault commit the snapshot was copied from (a git SHA, not a secret).
_PINNED_COMMIT: Final = "c8d671c1afd118741ee587c30f93fda2e7b8abc4"  # pragma: allowlist secret
_ROOT: Final = Path(__file__).parent / "fixtures" / "creek_jobs_v029"
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
