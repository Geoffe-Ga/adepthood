"""Opt-in Adepthood journal lifecycle against a real Creek ``/v1`` service.

Mock transports prove every response branch, but only a disposable Creek vault
can prove that the source page, fragment, retrieval index and derived reads all
converge on absence. This test therefore stays skipped unless an operator
provides a real loopback service and its disposable vault root. It drives the
real Adepthood router and HTTP adapter; no Creek implementation or contract fake
lives in this repository.

Run from ``backend/`` after starting Creek 0.16 against an empty disposable
vault::

    ADEPHOOD_REAL_CREEK_URL=http://127.0.0.1:8830 \
    ADEPHOOD_REAL_CREEK_TOKEN=<disposable bearer> \
    ADEPHOOD_REAL_CREEK_VAULT=/path/to/disposable/vault \
      pytest tests/test_vault_journal_withdraw_real_creek.py

The marker is synthetic and unique per run. Never point this test at a personal
or production vault: its final act intentionally withdraws what it created.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import get_creek_vault_client
from main import app
from models.journal_entry import JournalEntry
from services import creek_vault_pipeline as pipeline
from services.creek_vault_client import CONTRACT_MINOR, HttpCreekVaultClient

_CREEK_URL_ENV = "ADEPHOOD_REAL_CREEK_URL"
_CREEK_TOKEN_ENV = "ADEPHOOD_REAL_CREEK_TOKEN"
_CREEK_VAULT_ENV = "ADEPHOOD_REAL_CREEK_VAULT"
_REQUIRED_ENV = (_CREEK_URL_ENV, _CREEK_TOKEN_ENV, _CREEK_VAULT_ENV)
_MISSING_LIVE_CONFIGURATION = any(not os.environ.get(name) for name in _REQUIRED_ENV)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        _MISSING_LIVE_CONFIGURATION,
        reason="real disposable Creek URL, bearer and vault root were not supplied",
    ),
]


@dataclass(frozen=True, slots=True)
class _LiveProof:
    """Dependencies and observations shared by the four lifecycle phases."""

    app_http: httpx.AsyncClient
    proof_http: httpx.AsyncClient
    session: AsyncSession
    vault: Path
    marker: bytes
    app_headers: Mapping[str, str]
    proof_headers: Mapping[str, str]
    baseline_wheel: int


def _creek_headers(token: str) -> dict[str, str]:
    """Build the authenticated, negotiated read headers used for proof calls."""
    return {
        "Authorization": f"Bearer {token}",
        "X-Creek-Tier-Ceiling": "personal",
        "X-Creek-Contract-Version": CONTRACT_MINOR,
    }


def _files_containing(vault: Path, marker: bytes) -> tuple[Path, ...]:
    """Return every regular vault file still carrying the synthetic marker."""
    found: list[Path] = []
    for path in vault.rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            if marker in path.read_bytes():
                found.append(path.relative_to(vault))
        except OSError:
            pytest.fail("the disposable vault became unreadable during withdrawal proof")
    return tuple(sorted(found))


def _disposable_vault() -> Path:
    """Resolve and reject any live-test vault that is not obviously disposable."""
    vault = Path(os.environ[_CREEK_VAULT_ENV]).resolve(strict=True)
    assert "tmp" in vault.parts or "private" in vault.parts, "use a disposable vault path"
    return vault


async def _signup(client: httpx.AsyncClient) -> dict[str, str]:
    """Create one disposable Adepthood user and return its auth header."""
    response = await client.post(
        "/auth/signup",
        json={
            "email": f"real-creek-{uuid4().hex}@example.com",
            "password": f"Aa1-{uuid4().hex}",
        },
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _wheel_total(client: httpx.AsyncClient, headers: Mapping[str, str]) -> int:
    """Return all fragments visible to Creek's wheel, classified or not."""
    response = await client.get("/v1/wheel", headers=headers)
    assert response.status_code == HTTPStatus.OK
    payload = response.json()
    return int(payload["total_classified"]) + int(payload["unclassified"])


async def _row(session: AsyncSession, entry_id: int) -> JournalEntry:
    """Refresh and return the journal row mutated by the live router."""
    session.expire_all()
    entry = await session.get(JournalEntry, entry_id)
    assert entry is not None
    return entry


async def _create_public(proof: _LiveProof) -> tuple[int, str]:
    """Mirror one public page and prove its files and wheel membership."""
    created = await proof.app_http.post(
        "/journal/",
        json={"message": proof.marker.decode(), "classification": "public"},
        headers=proof.app_headers,
    )
    assert created.status_code == HTTPStatus.CREATED
    entry_id = int(created.json()["id"])
    await pipeline.wait_for_vault_pipeline_tasks()
    created_row = await _row(proof.session, entry_id)
    assert created_row.vault_ref is not None
    assert len(_files_containing(proof.vault, proof.marker)) == 2
    assert await _wheel_total(proof.proof_http, proof.proof_headers) == proof.baseline_wheel + 1
    return entry_id, created_row.vault_ref


async def _make_intimate(proof: _LiveProof, entry_id: int, original_ref: str) -> None:
    """Withdraw the mirror and prove every plaintext and derived read is absent."""
    privatized = await proof.app_http.patch(
        f"/journal/{entry_id}",
        json={"classification": "intimate"},
        headers=proof.app_headers,
    )
    assert privatized.status_code == HTTPStatus.OK
    private_row = await _row(proof.session, entry_id)
    assert private_row.classification == "intimate"
    assert private_row.vault_ref is None
    assert private_row.vault_tags is None
    assert _files_containing(proof.vault, proof.marker) == ()
    assert await _wheel_total(proof.proof_http, proof.proof_headers) == proof.baseline_wheel
    refused = await proof.proof_http.post(
        "/v1/reflections",
        json={"entry_ref": original_ref},
        headers=proof.proof_headers,
    )
    assert refused.status_code == HTTPStatus.FORBIDDEN
    assert refused.json()["code"] == "privacy_refused"


async def _remirror_personal(proof: _LiveProof, entry_id: int, original_ref: str) -> None:
    """Return the page to Personal once without duplicating its stable resource."""
    remirrored = await proof.app_http.patch(
        f"/journal/{entry_id}",
        json={"classification": "personal"},
        headers=proof.app_headers,
    )
    assert remirrored.status_code == HTTPStatus.OK
    await pipeline.wait_for_vault_pipeline_tasks()
    assert (await _row(proof.session, entry_id)).vault_ref == original_ref
    assert len(_files_containing(proof.vault, proof.marker)) == 2

    repeated = await proof.app_http.patch(
        f"/journal/{entry_id}",
        json={"classification": "personal"},
        headers=proof.app_headers,
    )
    assert repeated.status_code == HTTPStatus.OK
    assert (await _row(proof.session, entry_id)).vault_ref == original_ref
    assert len(_files_containing(proof.vault, proof.marker)) == 2


async def _delete(proof: _LiveProof, entry_id: int, original_ref: str) -> None:
    """Delete the page and prove both storage and derived reads stay absent."""
    deleted = await proof.app_http.delete(f"/journal/{entry_id}", headers=proof.app_headers)
    assert deleted.status_code == HTTPStatus.NO_CONTENT
    deleted_row = await _row(proof.session, entry_id)
    assert deleted_row.deleted_at is not None
    assert deleted_row.vault_ref is None
    assert deleted_row.vault_tags is None
    assert _files_containing(proof.vault, proof.marker) == ()
    assert await _wheel_total(proof.proof_http, proof.proof_headers) == proof.baseline_wheel
    refused = await proof.proof_http.post(
        "/v1/reflections",
        json={"entry_ref": original_ref},
        headers=proof.proof_headers,
    )
    assert refused.status_code == HTTPStatus.FORBIDDEN
    assert refused.json()["code"] == "privacy_refused"


@pytest.mark.asyncio
async def test_public_intimate_personal_delete_converges_in_real_creek(
    async_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """One stable id leaves every real Creek surface on privacy and deletion."""
    creek_url = os.environ[_CREEK_URL_ENV].rstrip("/")
    creek_token = os.environ[_CREEK_TOKEN_ENV]
    vault = _disposable_vault()
    marker = f"Adepthood withdrawal proof {uuid4().hex}".encode()

    async with (
        httpx.AsyncClient(timeout=30) as vault_http,
        httpx.AsyncClient(base_url=creek_url, timeout=30) as proof_http,
    ):
        vault_client = HttpCreekVaultClient(creek_url, creek_token, http_client=vault_http)
        handshake = await vault_client.handshake()
        assert handshake.available
        assert {capability.value for capability in handshake.capabilities} >= {
            "creek.journal",
            "creek.journal_withdraw",
        }
        app.dependency_overrides[get_creek_vault_client] = lambda: vault_client
        proof_headers = _creek_headers(creek_token)
        proof = _LiveProof(
            app_http=async_client,
            proof_http=proof_http,
            session=db_session,
            vault=vault,
            marker=marker,
            app_headers=await _signup(async_client),
            proof_headers=proof_headers,
            baseline_wheel=await _wheel_total(proof_http, proof_headers),
        )
        try:
            entry_id, original_ref = await _create_public(proof)
            await _make_intimate(proof, entry_id, original_ref)
            await _remirror_personal(proof, entry_id, original_ref)
            await _delete(proof, entry_id, original_ref)
        finally:
            app.dependency_overrides.pop(get_creek_vault_client, None)
            await pipeline.close_vault_pipeline_tasks()
