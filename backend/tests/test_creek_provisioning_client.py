"""HTTP contract tests for Adepthood's Creek provisioning consumer."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from schemas.vault_activation import VaultKeyCeremonySubmission
from services.creek_provisioning_client import (
    HttpCreekProvisioningClient,
    ProvisioningRejectedError,
    ProvisioningUnavailableError,
    get_creek_provisioning_client,
)

_TOKEN = "control-plane-bearer-" + "t" * 48


def _job_payload(activation_id: str) -> dict[str, object]:
    stamp = datetime(2026, 9, 7, tzinfo=UTC).isoformat()
    return {
        "job_id": "job-001",
        "activation_id": activation_id,
        "state": "pending",
        "attempts": 0,
        "retryable": False,
        "failure_reason": None,
        "created_at": stamp,
        "updated_at": stamp,
        "attested_confidential": None,
        "status_url": "/control/v1/jobs/job-001",
    }


def _submission() -> VaultKeyCeremonySubmission:
    """Build one strictly valid ciphertext-only protocol body."""
    return VaultKeyCeremonySubmission.model_validate(
        {
            "protocol_version": "1.0.0",
            "ceremony_id": "ceremony-001",
            "server_nonce": "A" * 43,
            "recovery_saved": True,
            "wrapped_artifact": {
                "version": 2,
                "kdf": {
                    "algorithm": "argon2id",
                    "salt": "01" * 16,
                    "time_cost": 3,
                    "lanes": 4,
                    "memory_kib": 65536,
                },
                "passphrase_wrapped": {
                    "nonce": "02" * 12,
                    "ciphertext": "03" * 48,
                },
                "recovery_wrapped": {
                    "nonce": "04" * 12,
                    "ciphertext": "05" * 48,
                },
                "binding": {
                    "protocol_version": "1.0.0",
                    "activation_id": "activation-001",
                    "ceremony_id": "ceremony-001",
                    "server_nonce": "A" * 43,
                    "client_nonce": "B" * 43,
                },
            },
            "attestation": None,
            "key_release": None,
        }
    )


@pytest.mark.asyncio
async def test_http_client_sends_service_bearer_and_distinct_subject_identity() -> None:
    """Adepthood's one backend credential may name one opaque account subject."""
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        payload = json.loads(request.content)
        return httpx.Response(
            202,
            request=request,
            headers={"Creek-Provisioning-Version": "1.1.0"},
            json=_job_payload(str(payload["activation_id"])),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as transport:
        client = HttpCreekProvisioningClient("https://control.example.test", _TOKEN, transport)
        job = await client.activate("activation-001", "adepthood-user-001")

    assert job.job_id == "job-001"
    assert seen[0].headers["Authorization"] == f"Bearer {_TOKEN}"
    assert json.loads(seen[0].content)["consumer_identity"] == "adepthood-user-001"


@pytest.mark.asyncio
async def test_malformed_upstream_response_is_not_attached_to_the_safe_exception() -> None:
    """A surprising Creek body cannot leak through an exception chain or message."""
    canary = "upstream-body-secret-that-must-not-escape"

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            202,
            request=request,
            headers={"Creek-Provisioning-Version": "1.1.0"},
            json={"unexpected": canary},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as transport:
        client = HttpCreekProvisioningClient("https://control.example.test", _TOKEN, transport)
        with pytest.raises(ProvisioningUnavailableError) as caught:
            await client.activate("activation-001", "adepthood-user-001")

    assert caught.value.__cause__ is None
    assert canary not in repr(caught.value)
    assert _TOKEN not in repr(caught.value)


@pytest.mark.asyncio
async def test_http_client_relays_the_versioned_ceremony_without_secret_fields() -> None:
    """Both ceremony calls use the backend bearer while relaying only public material."""
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        headers = {"Creek-Provisioning-Version": "1.1.0"}
        if request.method == "GET":
            return httpx.Response(
                200,
                request=request,
                headers=headers,
                json={
                    "protocol_version": "1.0.0",
                    "job_id": "job-001",
                    "activation_id": "activation-001",
                    "ceremony_id": "ceremony-001",
                    "server_nonce": "A" * 43,
                    "expires_at": datetime(2026, 9, 8, tzinfo=UTC).isoformat(),
                },
            )
        payload = _job_payload("activation-001")
        payload["state"] = "ready"
        payload["attested_confidential"] = False
        return httpx.Response(200, request=request, headers=headers, json=payload)

    submission = _submission()
    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as transport:
        client = HttpCreekProvisioningClient("https://control.example.test", _TOKEN, transport)
        challenge = await client.key_ceremony("job-001")
        completed = await client.complete_key_ceremony("job-001", submission)

    assert challenge.ceremony_id == "ceremony-001"
    assert completed.state == "ready"
    assert [request.headers["Authorization"] for request in seen] == [
        f"Bearer {_TOKEN}",
        f"Bearer {_TOKEN}",
    ]
    forwarded = json.loads(seen[1].content)
    assert forwarded == submission.model_dump(mode="json")
    assert "passphrase" not in forwarded
    assert "recovery_code" not in forwarded


@pytest.mark.asyncio
async def test_http_client_retains_only_an_allowlisted_ceremony_error_code() -> None:
    """An upstream rejection can guide the UI without carrying its body or message."""
    canary = "raw-upstream-detail-that-must-not-escape"

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            request=request,
            headers={"Creek-Provisioning-Version": "1.1.0"},
            json={"code": "ceremony_expired", "message": canary},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as transport:
        client = HttpCreekProvisioningClient("https://control.example.test", _TOKEN, transport)
        with pytest.raises(ProvisioningRejectedError) as caught:
            await client.complete_key_ceremony("job-001", _submission())

    assert caught.value.code == "ceremony_expired"
    assert canary not in repr(caught.value)
    assert _TOKEN not in repr(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("state", "surprising_state"),
        ("attempts", -1),
        ("failure_reason", "x" * 65),
        ("job_id", ""),
        ("status_url", "https://example.test/" + "x" * 500),
    ],
)
async def test_upstream_fields_are_bounded_before_they_reach_persistence(
    field: str,
    value: object,
) -> None:
    """Creek cannot smuggle an unbounded or out-of-contract value into the DB."""
    payload = _job_payload("activation-001")
    payload[field] = value

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            202,
            request=request,
            headers={"Creek-Provisioning-Version": "1.1.0"},
            json=payload,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as transport:
        client = HttpCreekProvisioningClient("https://control.example.test", _TOKEN, transport)
        with pytest.raises(ProvisioningUnavailableError):
            await client.activate("activation-001", "adepthood-user-001")


def test_insecure_control_plane_url_never_builds_a_bearer_transport(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A remote plaintext URL is rejected before a bearer-carrying client exists."""
    token_file = tmp_path / "control-token"
    token_file.write_text(_TOKEN, encoding="utf-8")
    monkeypatch.setenv("CREEK_PROVISIONING_URL", "http://control.example.test")
    monkeypatch.setenv("CREEK_PROVISIONING_AUTH_FILE", str(token_file))

    def fail_transport(*_args: object, **_kwargs: object) -> None:
        pytest.fail("an insecure control-plane URL built an HTTP transport")

    monkeypatch.setattr("services.creek_provisioning_client.httpx.AsyncClient", fail_transport)

    client = get_creek_provisioning_client()

    assert client.__class__.__name__ == "_UnavailableProvisioningClient"
