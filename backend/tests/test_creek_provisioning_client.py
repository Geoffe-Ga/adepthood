"""HTTP contract tests for Adepthood's Creek provisioning consumer."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from services.creek_provisioning_client import (
    HttpCreekProvisioningClient,
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
        "custody_mode": None,
        "status_url": "/control/v1/jobs/job-001",
    }


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
            headers={"Creek-Provisioning-Version": "2.0.0"},
            json=_job_payload(str(payload["activation_id"])),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as transport:
        client = HttpCreekProvisioningClient("https://control.example.test", _TOKEN, transport)
        job = await client.activate("activation-001", "adepthood-user-001")

    assert job.job_id == "job-001"
    assert job.custody_mode is None
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
            headers={"Creek-Provisioning-Version": "2.0.0"},
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
async def test_http_client_refuses_the_retired_v1_contract() -> None:
    """Adepthood cannot silently infer custody from a pre-v2 response."""

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            202,
            request=request,
            headers={"Creek-Provisioning-Version": "1.1.0"},
            json=_job_payload("activation-001"),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as transport:
        client = HttpCreekProvisioningClient("https://control.example.test", _TOKEN, transport)
        with pytest.raises(ProvisioningUnavailableError, match="contract unavailable"):
            await client.activate("activation-001", "adepthood-user-001")


@pytest.mark.asyncio
async def test_http_client_accepts_explicit_provider_managed_readiness() -> None:
    """The v2 ready response carries custody independently of lifecycle state."""
    payload = _job_payload("activation-001")
    payload.update(
        state="ready",
        custody_mode="provider_managed",
        attested_confidential=False,
    )

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            202,
            request=request,
            headers={"Creek-Provisioning-Version": "2.0.0"},
            json=payload,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as transport:
        client = HttpCreekProvisioningClient("https://control.example.test", _TOKEN, transport)
        job = await client.activate("activation-001", "adepthood-user-001")

    assert job.state == "ready"
    assert job.custody_mode == "provider_managed"
    assert job.attested_confidential is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("custody_mode", "attested_confidential"),
    [
        (None, False),
        ("provider_managed", True),
        ("wrapped_artifact_only", None),
        ("user_held", False),
    ],
)
async def test_ready_job_requires_explicit_non_confidential_custody(
    custody_mode: object,
    attested_confidential: object,
) -> None:
    """Ready is not itself custody evidence and cannot imply confidential compute."""
    payload = _job_payload("activation-001")
    payload.update(
        state="ready",
        custody_mode=custody_mode,
        attested_confidential=attested_confidential,
    )

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            202,
            request=request,
            headers={"Creek-Provisioning-Version": "2.0.0"},
            json=payload,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as transport:
        client = HttpCreekProvisioningClient("https://control.example.test", _TOKEN, transport)
        with pytest.raises(ProvisioningUnavailableError, match="response malformed"):
            await client.activate("activation-001", "adepthood-user-001")


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
            headers={"Creek-Provisioning-Version": "2.0.0"},
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
