"""Demand-provisioned managed-vault lifecycle contract for issue #2677."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import UTC, datetime
from http import HTTPStatus
from typing import TYPE_CHECKING, cast

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select, text
from sqlmodel import col

from dependencies.creek_vault import resolve_creek_vault_client
from main import app
from models.account_deletion_audit import AccountDeletionAudit
from models.user import User
from models.user_vault_config import UserVaultConfig
from models.vault_activation import VaultActivation, VaultTeardownReceipt
from services import journal_encryption
from services.creek_provisioning import (
    reconcile_vault_teardowns,
    request_vault_teardown,
    resume_vault_activations,
)
from services.creek_provisioning_client import (
    CreekProvisioningJob,
    ProvisioningRejectedError,
    ProvisioningUnavailableError,
    get_creek_provisioning_client,
)
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.managed_vault_rollout import (
    MANAGED_VAULT_ENABLED_ENV_VAR,
    MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Generator
    from pathlib import Path

    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

_PASSWORD = "securepassword123"  # pragma: allowlist secret
_HANDOFF_TOKEN = "handoff-test-token-" + "h" * 48
_CREDENTIAL = "consumer-credential-" + "c" * 48
_VAULT_URL = "https://vault-user-001.example.test/v1"


class FakeProvisioningClient:
    """Deterministic Creek double with an optional transaction assertion."""

    def __init__(self) -> None:
        """Initialize an empty idempotent job ledger and call recorder."""
        self.calls: list[tuple[str, str]] = []
        self.jobs: dict[str, CreekProvisioningJob] = {}
        self.fail_activate = False
        self.reject_activate = False
        self.fail_delete = False
        self.delete_state = "deleting"
        self.assert_released: object | None = None

    def _before_network(self) -> None:
        if self.assert_released is not None:
            assert callable(self.assert_released)
            self.assert_released()

    async def activate(self, activation_id: str, consumer_identity: str) -> CreekProvisioningJob:
        self._before_network()
        self.calls.append(("activate", f"{activation_id}:{consumer_identity}"))
        if self.fail_activate:
            raise ProvisioningUnavailableError("provisioning unavailable")
        if self.reject_activate:
            raise ProvisioningRejectedError("provisioning rejected")
        existing = self.jobs.get(activation_id)
        if existing is not None:
            return existing
        job = CreekProvisioningJob(
            job_id=f"job-{len(self.jobs) + 1:03d}",
            activation_id=activation_id,
            state="pending",
            attempts=0,
            retryable=False,
            failure_reason=None,
            attested_confidential=None,
        )
        self.jobs[activation_id] = job
        return job

    async def status(self, job_id: str) -> CreekProvisioningJob:
        self._before_network()
        self.calls.append(("status", job_id))
        return next(job for job in self.jobs.values() if job.job_id == job_id)

    async def retry(self, job_id: str) -> CreekProvisioningJob:
        self._before_network()
        self.calls.append(("retry", job_id))
        current = await self.status(job_id)
        retried = replace(current, state="pending", retryable=False, failure_reason=None)
        self.jobs[current.activation_id] = retried
        return retried

    async def delete(self, job_id: str) -> CreekProvisioningJob:
        self._before_network()
        self.calls.append(("delete", job_id))
        if self.fail_delete:
            raise ProvisioningUnavailableError("provisioning unavailable")
        current = await self.status(job_id)
        deleting = replace(current, state=self.delete_state, retryable=False, failure_reason=None)
        self.jobs[current.activation_id] = deleting
        return deleting


@pytest.fixture(autouse=True)
def _encrypted_handoff(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> Generator[None, None, None]:
    """Configure both encrypted storage and a mounted callback bearer."""
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    token_file = tmp_path / "handoff-token"
    token_file.write_text(_HANDOFF_TOKEN, encoding="utf-8")
    control_token_file = tmp_path / "control-token"
    control_token_file.write_text("control-test-token-" + "t" * 48, encoding="utf-8")
    monkeypatch.setenv("CREEK_PROVISIONING_HANDOFF_AUTH_FILE", str(token_file))
    monkeypatch.setenv("CREEK_PROVISIONING_AUTH_FILE", str(control_token_file))
    monkeypatch.setenv("CREEK_PROVISIONING_URL", "https://creek-control.example.test")
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.setenv(
        MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR,
        ",".join(str(i) for i in range(1, 101)),
    )
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


@pytest.fixture
def creek_client() -> FakeProvisioningClient:
    """Wire a fake only into the activation routes that explicitly request it."""
    client = FakeProvisioningClient()
    app.dependency_overrides[get_creek_provisioning_client] = lambda: client
    return client


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int, str]:
    email = f"{username}@example.com"
    response = await client.post(
        "/auth/signup",
        json={"email": email, "password": _PASSWORD},
    )
    assert response.status_code == HTTPStatus.OK
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"], email


async def _activate(client: AsyncClient, headers: dict[str, str]) -> dict[str, object]:
    response = await client.post("/vault/activation", headers=headers)
    assert response.status_code == HTTPStatus.ACCEPTED
    return cast("dict[str, object]", response.json())


async def _handoff(
    client: AsyncClient,
    activation: VaultActivation,
    *,
    credential: str = _CREDENTIAL,
) -> int:
    response = await client.post(
        "/internal/vault-provisioning/completions",
        headers={"Authorization": f"Bearer {_HANDOFF_TOKEN}"},
        json={
            "job_id": activation.creek_job_id,
            "consumer_identity": activation.consumer_identity,
            "vault_url": _VAULT_URL,
            "consumer_credential": credential,
        },
    )
    return response.status_code


@pytest.mark.asyncio
async def test_signup_and_first_journal_save_make_zero_provisioning_calls(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """The low door stays independent of an optional private-vault service."""
    headers, _, _ = await _signup(async_client, "zero-provisioning")

    journal = await async_client.post(
        "/journal/",
        headers=headers,
        json={"message": "A first entry remains available.", "classification": "personal"},
    )

    assert journal.status_code == HTTPStatus.CREATED
    assert creek_client.calls == []
    assert (await db_session.execute(select(VaultActivation))).scalars().all() == []


@pytest.mark.asyncio
async def test_activation_is_idempotent_secret_free_and_releases_the_transaction(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """Duplicate explicit requests submit one durable Creek identity and job."""
    headers, user_id, _ = await _signup(async_client, "activate-once")

    def assert_released() -> None:
        assert not db_session.in_transaction()

    creek_client.assert_released = assert_released

    first = await _activate(async_client, headers)
    second = await _activate(async_client, headers)

    assert second == first
    assert first == {
        "active": True,
        "state": "pending",
        "new_activation_available": True,
        "retryable": False,
        "failure_reason": None,
        "credential_received": False,
        "attested_confidential": None,
        "custody_mode": None,
    }
    rows = (await db_session.execute(select(VaultActivation))).scalars().all()
    assert len(rows) == 1
    assert rows[0].user_id == user_id
    assert rows[0].consumer_identity.startswith("adepthood-user-")
    assert [call[0] for call in creek_client.calls] == ["activate", "activate"]
    assert _CREDENTIAL not in str(first)
    assert _VAULT_URL not in str(first)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "rollout_case",
    [("false", "1"), ("true", "99999")],
    ids=("emergency-disabled", "account-ineligible"),
)
async def test_unavailable_rollout_refuses_new_activation_without_an_oracle(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
    monkeypatch: pytest.MonkeyPatch,
    rollout_case: tuple[str, str],
) -> None:
    """Disabled and ineligible accounts receive one identical, side-effect-free answer."""
    enabled, pilot_ids = rollout_case
    headers, _, _ = await _signup(async_client, f"rollout-{enabled}-{pilot_ids}")
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, enabled)
    monkeypatch.setenv(MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR, pilot_ids)

    status_response = await async_client.get("/vault/activation", headers=headers)
    activation_response = await async_client.post("/vault/activation", headers=headers)

    assert status_response.status_code == HTTPStatus.OK
    assert status_response.json() == {
        "active": False,
        "state": "inactive",
        "new_activation_available": False,
        "retryable": False,
        "failure_reason": None,
        "credential_received": False,
        "attested_confidential": None,
        "custody_mode": None,
    }
    assert activation_response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert activation_response.json() == {"detail": "managed_vault_activation_unavailable"}
    assert creek_client.calls == []
    assert (await db_session.execute(select(VaultActivation))).scalars().all() == []


@pytest.mark.asyncio
async def test_emergency_disable_preserves_existing_status_and_upstream_retry(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The kill switch blocks only new resources, never recovery of an allocated one."""
    headers, _, _ = await _signup(async_client, "rollout-existing")
    await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    job = creek_client.jobs[activation.activation_id]
    creek_client.jobs[activation.activation_id] = replace(
        job,
        state="failed",
        retryable=True,
        failure_reason="provider_unavailable",
    )
    status_response = await async_client.get("/vault/activation", headers=headers)
    assert status_response.json()["state"] == "failed"
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "false")

    retry_response = await async_client.post("/vault/activation/retry", headers=headers)

    assert retry_response.status_code == HTTPStatus.ACCEPTED
    assert retry_response.json()["state"] == "pending"
    assert retry_response.json()["new_activation_available"] is False
    assert any(call[0] == "retry" for call in creek_client.calls)


@pytest.mark.asyncio
async def test_emergency_disable_preserves_idempotent_retry_after_lost_response(
    async_client: AsyncClient,
    creek_client: FakeProvisioningClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A durable activation may already own resources when its first response was lost."""
    headers, _, _ = await _signup(async_client, "rollout-unallocated-retry")
    creek_client.fail_activate = True
    failed = await _activate(async_client, headers)
    assert failed["retryable"] is True
    creek_client.fail_activate = False
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "false")

    status_response = await async_client.get("/vault/activation", headers=headers)
    retry_response = await async_client.post("/vault/activation/retry", headers=headers)

    assert status_response.json()["retryable"] is True
    assert retry_response.status_code == HTTPStatus.ACCEPTED
    assert retry_response.json()["state"] == "pending"
    assert retry_response.json()["new_activation_available"] is False
    assert [call[0] for call in creek_client.calls].count("activate") == 2


@pytest.mark.asyncio
async def test_concurrent_activations_share_one_record_and_upstream_job(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    creek_client: FakeProvisioningClient,
) -> None:
    """The database closes the two-request race before any billable duplication."""
    headers, _, _ = await _signup(concurrent_async_client, "concurrent-activation")

    responses = await asyncio.gather(
        *[concurrent_async_client.post("/vault/activation", headers=headers) for _ in range(8)]
    )

    assert [response.status_code for response in responses] == [HTTPStatus.ACCEPTED] * 8
    async with concurrent_session_factory() as session:
        activations = (await session.execute(select(VaultActivation))).scalars().all()
    assert len(activations) == 1
    assert len({job.job_id for job in creek_client.jobs.values()}) == 1


@pytest.mark.asyncio
async def test_provider_outage_is_retryable_and_never_blocks_writing(
    async_client: AsyncClient,
    creek_client: FakeProvisioningClient,
) -> None:
    """A Creek failure costs only the optional capability."""
    headers, _, _ = await _signup(async_client, "provider-down")
    creek_client.fail_activate = True

    failed = await _activate(async_client, headers)
    journal = await async_client.post(
        "/journal/",
        headers=headers,
        json={"message": "The journal still works.", "classification": "personal"},
    )

    assert failed["state"] == "failed"
    assert failed["retryable"] is True
    assert failed["failure_reason"] == "provider_unavailable"
    assert journal.status_code == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_provider_rejection_is_not_retryable(
    async_client: AsyncClient,
    creek_client: FakeProvisioningClient,
) -> None:
    """A bounded Creek refusal cannot be retried as though it were an outage."""
    headers, _, _ = await _signup(async_client, "provider-rejection")
    creek_client.reject_activate = True

    failed = await _activate(async_client, headers)
    refused_retry = await async_client.post("/vault/activation/retry", headers=headers)

    assert failed["state"] == "failed"
    assert failed["retryable"] is False
    assert failed["failure_reason"] == "provider_rejected"
    assert refused_retry.status_code == HTTPStatus.CONFLICT
    assert refused_retry.json() == {"detail": "vault_activation_not_retryable"}
    assert [call[0] for call in creek_client.calls] == ["activate"]


@pytest.mark.asyncio
async def test_retry_reuses_the_same_activation_after_provider_recovery(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """The retry rung never mints a second local or upstream idempotency key."""
    headers, _, _ = await _signup(async_client, "retry-activation")
    creek_client.fail_activate = True
    failed = await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    original_id = activation.activation_id
    creek_client.fail_activate = False

    def assert_released() -> None:
        assert not db_session.in_transaction()

    creek_client.assert_released = assert_released

    retried = await async_client.post("/vault/activation/retry", headers=headers)

    assert failed["retryable"] is True
    assert retried.status_code == HTTPStatus.ACCEPTED
    assert retried.json()["state"] == "pending"
    await db_session.refresh(activation)
    assert activation.activation_id == original_id
    assert len((await db_session.execute(select(VaultActivation))).scalars().all()) == 1


@pytest.mark.asyncio
async def test_one_time_handoff_is_encrypted_idempotent_and_never_returned(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """The internal callback stores the connection once through UserVaultConfig."""
    del creek_client
    headers, user_id, _ = await _signup(async_client, "handoff")
    await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()

    assert await _handoff(async_client, activation) == HTTPStatus.NO_CONTENT
    assert await _handoff(async_client, activation) == HTTPStatus.NO_CONTENT
    conflict = await _handoff(async_client, activation, credential=_CREDENTIAL + "different")

    assert conflict == HTTPStatus.CONFLICT
    config = (
        await db_session.execute(
            select(UserVaultConfig).where(col(UserVaultConfig.user_id) == user_id),
        )
    ).scalar_one()
    assert config.api_key == _CREDENTIAL
    raw = (await db_session.execute(text("SELECT api_key FROM uservaultconfig"))).scalar_one()
    assert raw != _CREDENTIAL
    assert _CREDENTIAL not in raw
    assert config.provisioned is True
    public_connection = await async_client.get("/vault/connection", headers=headers)
    assert public_connection.json() == {"connected": True, "vault_url": None}
    assert _VAULT_URL not in public_connection.text


@pytest.mark.asyncio
async def test_malformed_or_unauthenticated_handoff_echoes_no_secret(
    async_client: AsyncClient,
    creek_client: FakeProvisioningClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Callback refusal bodies never quote attacker-controlled credential material."""
    del creek_client
    headers, _, _ = await _signup(async_client, "bad-handoff")
    await _activate(async_client, headers)
    canary = "malformed-secret-that-must-not-echo"
    payload = {"job_id": "job-001", "consumer_credential": canary}

    unauthenticated = await async_client.post(
        "/internal/vault-provisioning/completions",
        json=payload,
    )
    malformed = await async_client.post(
        "/internal/vault-provisioning/completions",
        headers={"Authorization": f"Bearer {_HANDOFF_TOKEN}"},
        json=payload,
    )

    assert unauthenticated.status_code == HTTPStatus.UNAUTHORIZED
    assert malformed.status_code == HTTPStatus.BAD_REQUEST
    assert canary not in unauthenticated.text
    assert canary not in malformed.text
    assert canary not in caplog.text
    assert _HANDOFF_TOKEN not in caplog.text


@pytest.mark.asyncio
async def test_authenticated_handoff_cannot_mix_two_activations(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """A valid service bearer cannot join one job to another consumer identity."""
    del creek_client
    first_headers, first_user_id, _ = await _signup(async_client, "handoff-owner-one")
    second_headers, second_user_id, _ = await _signup(async_client, "handoff-owner-two")
    await _activate(async_client, first_headers)
    await _activate(async_client, second_headers)
    activations = {
        activation.user_id: activation
        for activation in (await db_session.execute(select(VaultActivation))).scalars().all()
    }

    mixed = await async_client.post(
        "/internal/vault-provisioning/completions",
        headers={"Authorization": f"Bearer {_HANDOFF_TOKEN}"},
        json={
            "job_id": activations[first_user_id].creek_job_id,
            "consumer_identity": activations[second_user_id].consumer_identity,
            "vault_url": _VAULT_URL,
            "consumer_credential": _CREDENTIAL,
        },
    )

    assert mixed.status_code == HTTPStatus.UNAUTHORIZED
    assert mixed.json() == {"detail": "invalid_provisioning_handoff"}
    assert (await db_session.execute(select(UserVaultConfig))).scalars().all() == []


@pytest.mark.asyncio
async def test_handoff_after_terminal_failure_is_refused_without_storing_connection(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """A late callback cannot attach a credential to an allocation Creek rejected."""
    del creek_client
    headers, _, _ = await _signup(async_client, "late-failed-handoff")
    await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    activation.state = "failed"
    activation.retryable = False
    activation.failure_reason = "provider_rejected"
    db_session.add(activation)
    await db_session.commit()

    refused = await _handoff(async_client, activation)

    assert refused == HTTPStatus.CONFLICT
    assert (await db_session.execute(select(UserVaultConfig))).scalars().all() == []
    await db_session.refresh(activation)
    assert activation.credential_received_at is None
    assert activation.state == "failed"


@pytest.mark.asyncio
async def test_polling_after_a_restart_reaches_ready_only_after_handoff(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """A durable row plus Creek status is enough to resume after process loss."""
    headers, _, _ = await _signup(async_client, "resume")
    await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    assert await _handoff(async_client, activation) == HTTPStatus.NO_CONTENT
    current = creek_client.jobs[activation.activation_id]
    creek_client.jobs[activation.activation_id] = replace(
        current,
        state="ready",
        attested_confidential=False,
        custody_mode="provider_managed",
    )

    def assert_released() -> None:
        assert not db_session.in_transaction()

    creek_client.assert_released = assert_released

    response = await async_client.get("/vault/activation", headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json()["state"] == "ready"
    assert response.json()["credential_received"] is True
    assert response.json()["attested_confidential"] is False
    assert response.json()["custody_mode"] == "provider_managed"


@pytest.mark.asyncio
async def test_ready_status_arriving_before_handoff_remains_pollable(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """Network reordering cannot strand a valid late one-time handoff in failed."""
    headers, _, _ = await _signup(async_client, "handoff-reordered")
    await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    current = creek_client.jobs[activation.activation_id]
    creek_client.jobs[activation.activation_id] = replace(
        current,
        state="ready",
        attested_confidential=False,
        custody_mode="provider_managed",
    )

    before_handoff = await async_client.get("/vault/activation", headers=headers)
    assert before_handoff.json()["state"] == "awaiting_handoff"
    assert before_handoff.json()["retryable"] is False

    assert await _handoff(async_client, activation) == HTTPStatus.NO_CONTENT
    after_handoff = await async_client.get("/vault/activation", headers=headers)

    assert after_handoff.json()["state"] == "ready"
    assert after_handoff.json()["credential_received"] is True


@pytest.mark.asyncio
async def test_startup_recovery_polls_a_durable_inflight_job(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """Lifespan recovery needs only the persisted job handle after a hard crash."""
    _, user_id, _ = await _signup(async_client, "lifespan-resume")
    job = await creek_client.activate("activation-resume", "adepthood-user-resume")
    db_session.add(
        VaultActivation(
            user_id=user_id,
            activation_id=job.activation_id,
            consumer_identity="adepthood-user-resume",
            creek_job_id=job.job_id,
            state="pending",
        )
    )
    await db_session.commit()
    creek_client.jobs[job.activation_id] = replace(job, state="provisioning")

    @asynccontextmanager
    async def same_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    await resume_vault_activations(same_session, creek_client)

    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    assert activation.state == "provisioning"
    assert ("status", job.job_id) in creek_client.calls


@pytest.mark.asyncio
async def test_startup_recovery_preserves_admitted_idempotency_after_emergency_disable(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A submitting row may represent a lost response and resumes by stable identity."""
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "false")
    _, user_id, _ = await _signup(async_client, "lifespan-disabled")
    db_session.add(
        VaultActivation(
            user_id=user_id,
            activation_id="activation-disabled",
            consumer_identity="adepthood-user-disabled",
            state="submitting",
        )
    )
    await db_session.commit()

    @asynccontextmanager
    async def same_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    await resume_vault_activations(same_session, creek_client)

    assert creek_client.calls == [("activate", "activation-disabled:adepthood-user-disabled")]
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    assert activation.state == "pending"
    assert activation.creek_job_id is not None


@pytest.mark.asyncio
async def test_handed_off_connection_stays_inert_until_provider_reports_ready(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Receiving a credential cannot expose a plaintext-before-protection window."""
    del creek_client
    headers, user_id, _ = await _signup(async_client, "not-ready")
    await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    assert await _handoff(async_client, activation) == HTTPStatus.NO_CONTENT

    pending_client = await resolve_creek_vault_client(db_session, user_id)
    assert isinstance(pending_client, LocalFallbackCreekVaultClient)

    async def publicly_resolved(
        _session: AsyncSession,
        _hostname: str,
    ) -> None:
        return None

    monkeypatch.setattr(
        "dependencies.creek_vault.classify_resolved_user_vault_url_off_the_pool",
        publicly_resolved,
    )
    activation.state = "ready"
    db_session.add(activation)
    await db_session.commit()

    ready_client = await resolve_creek_vault_client(db_session, user_id)
    assert not isinstance(ready_client, LocalFallbackCreekVaultClient)


@pytest.mark.asyncio
async def test_retired_ceremony_state_becomes_a_visible_terminal_failure(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """A pre-v2 job cannot strand the account on a ceremony that no longer exists."""
    headers, _, _ = await _signup(async_client, "retired-ceremony")
    await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    current = creek_client.jobs[activation.activation_id]
    creek_client.jobs[activation.activation_id] = replace(
        current,
        state="awaiting_key_ceremony",
        custody_mode="wrapped_artifact_only",
        attested_confidential=False,
    )

    transitioned = await async_client.get("/vault/activation", headers=headers)

    assert transitioned.status_code == HTTPStatus.OK
    assert transitioned.json() == {
        "active": True,
        "state": "failed",
        "new_activation_available": True,
        "retryable": False,
        "failure_reason": "provider_rejected",
        "credential_received": False,
        "attested_confidential": False,
        "custody_mode": "wrapped_artifact_only",
    }
    await db_session.refresh(activation)
    assert activation.state == "failed"

    assert (
        await async_client.get("/vault/activation/key-ceremony", headers=headers)
    ).status_code == HTTPStatus.NOT_FOUND
    assert (
        await async_client.put("/vault/activation/key-ceremony", headers=headers, json={})
    ).status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_account_deletion_queues_upstream_teardown_and_retains_only_a_receipt(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """Local erasure succeeds while a content-free durable delete stays resumable."""
    headers, _, email = await _signup(async_client, "teardown")
    await _activate(async_client, headers)

    def assert_released() -> None:
        assert not db_session.in_transaction()

    creek_client.assert_released = assert_released

    deleted = await async_client.request(
        "DELETE",
        "/users/me",
        headers=headers,
        json={"confirm_email": email},
    )

    assert deleted.status_code == HTTPStatus.OK
    assert deleted.json()["vault"]["configured"] is True
    assert deleted.json()["vault"]["purged"] is False
    assert "reconciling" in deleted.json()["vault"]["guidance"]
    assert any(call[0] == "delete" for call in creek_client.calls)
    assert (await db_session.execute(select(VaultActivation))).scalars().all() == []
    receipts = (await db_session.execute(select(VaultTeardownReceipt))).scalars().all()
    assert len(receipts) == 1
    assert receipts[0].state == "deleting"
    assert not hasattr(receipts[0], "user_id")
    assert email not in repr(receipts[0])
    audit = (await db_session.execute(select(AccountDeletionAudit))).scalar_one()
    assert audit.vault_disposition == "deleting"


@pytest.mark.asyncio
async def test_account_deletion_reports_a_completed_provisioned_teardown(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """A synchronous Creek confirmation outranks all manual-vault guidance."""
    headers, _, email = await _signup(async_client, "teardown-complete")
    await _activate(async_client, headers)
    creek_client.delete_state = "deleted"

    deleted = await async_client.request(
        "DELETE",
        "/users/me",
        headers=headers,
        json={"confirm_email": email},
    )

    assert deleted.status_code == HTTPStatus.OK
    assert deleted.json()["vault"] == {
        "configured": True,
        "purged": True,
        "guidance": "Creek confirmed that the provisioned managed-vault allocation was deleted.",
    }
    teardown = (await db_session.execute(select(VaultTeardownReceipt))).scalar_one()
    assert teardown.state == "deleted"
    assert teardown.confirmed_at is not None
    audit = (await db_session.execute(select(AccountDeletionAudit))).scalar_one()
    assert audit.vault_disposition == "deleted"


@pytest.mark.asyncio
async def test_upstream_delete_outage_never_blocks_local_account_erasure(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """A failed remote request leaves only a retryable, content-free receipt."""
    headers, user_id, email = await _signup(async_client, "teardown-outage")
    await _activate(async_client, headers)
    creek_client.fail_delete = True

    deleted = await async_client.request(
        "DELETE",
        "/users/me",
        headers=headers,
        json={"confirm_email": email},
    )

    assert deleted.status_code == HTTPStatus.OK
    assert await db_session.get(User, user_id) is None
    assert (await db_session.execute(select(VaultActivation))).scalars().all() == []
    receipt = (await db_session.execute(select(VaultTeardownReceipt))).scalar_one()
    assert receipt.state == "failed"
    assert receipt.retryable is True
    assert receipt.failure_reason == "provider_unavailable"
    assert email not in repr(receipt)
    audit = (await db_session.execute(select(AccountDeletionAudit))).scalar_one()
    assert audit.vault_disposition == "failed"


@pytest.mark.asyncio
async def test_teardown_reconciliation_is_idempotent_after_process_restart(
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """A retained receipt keeps polling until Creek confirms zero billable resources."""
    job = await creek_client.activate("activation-teardown", "adepthood-user-teardown")
    creek_client.jobs[job.activation_id] = replace(job, state="deleted")
    db_session.add(
        VaultTeardownReceipt(
            creek_job_id=job.job_id,
            state="deleting",
            retryable=False,
            failure_reason=None,
            requested_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        ),
    )
    await db_session.commit()

    @asynccontextmanager
    async def same_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    await reconcile_vault_teardowns(same_session, creek_client)
    await reconcile_vault_teardowns(same_session, creek_client)

    receipts = (await db_session.execute(select(VaultTeardownReceipt))).scalars().all()
    assert receipts == []


@pytest.mark.asyncio
async def test_concurrent_teardown_requests_share_one_content_free_receipt(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    creek_client: FakeProvisioningClient,
) -> None:
    """Duplicate deletion attempts converge at the database uniqueness boundary."""
    headers, _, _ = await _signup(concurrent_async_client, "teardown-race")
    await _activate(concurrent_async_client, headers)

    async def request_once() -> None:
        async with concurrent_session_factory() as session:
            activation = (await session.execute(select(VaultActivation))).scalar_one()
            await request_vault_teardown(session, activation, creek_client)

    await asyncio.gather(request_once(), request_once())

    async with concurrent_session_factory() as session:
        receipts = (await session.execute(select(VaultTeardownReceipt))).scalars().all()
    assert len(receipts) == 1
    assert receipts[0].creek_job_id == next(iter(creek_client.jobs.values())).job_id


@pytest.mark.asyncio
async def test_restart_retries_a_delete_request_that_never_reached_creek(
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """A provider outage leaves an actionable receipt, not a permanent orphan."""
    job = await creek_client.activate("activation-delete-retry", "adepthood-user-delete")
    receipt = VaultTeardownReceipt(
        creek_job_id=job.job_id,
        state="failed",
        retryable=True,
        failure_reason="provider_unavailable",
    )
    db_session.add(receipt)
    await db_session.commit()

    @asynccontextmanager
    async def same_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    await reconcile_vault_teardowns(same_session, creek_client)

    await db_session.refresh(receipt)
    assert receipt.state == "deleting"
    assert ("delete", job.job_id) in creek_client.calls


@pytest.mark.asyncio
async def test_stuck_teardown_is_visible_only_to_operations(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The admin surface reveals cleanup state without an account or content."""
    member_headers, _, _ = await _signup(async_client, "teardown-member")
    admin_headers, admin_id, _ = await _signup(async_client, "teardown-admin")
    admin = await db_session.get(User, admin_id)
    assert admin is not None
    admin.is_admin = True
    db_session.add(admin)
    db_session.add(
        VaultTeardownReceipt(
            creek_job_id="job-stuck",
            state="failed",
            attempts=3,
            retryable=True,
            failure_reason="provider_unavailable",
        )
    )
    await db_session.commit()

    refused = await async_client.get("/admin/vault-teardowns", headers=member_headers)
    visible = await async_client.get("/admin/vault-teardowns", headers=admin_headers)

    assert refused.status_code == HTTPStatus.FORBIDDEN
    assert visible.status_code == HTTPStatus.OK
    assert visible.json() == [
        {
            "creek_job_id": "job-stuck",
            "state": "failed",
            "attempts": 3,
            "retryable": True,
            "failure_reason": "provider_unavailable",
        }
    ]


def test_activation_openapi_is_stable_and_contains_no_connection_secret() -> None:
    """The checked contract exposes custody truth without a ceremony or handoff data."""
    document = app.openapi()
    assert set(document["paths"]["/vault/activation"]) >= {"get", "post"}
    assert "post" in document["paths"]["/vault/activation/retry"]
    assert document["paths"]["/vault/activation"]["get"]["summary"] == (
        "Get Managed Vault Activation"
    )
    assert document["paths"]["/vault/activation"]["post"]["summary"] == ("Activate Managed Vault")
    assert document["paths"]["/vault/activation/retry"]["post"]["summary"] == (
        "Retry Managed Vault Activation"
    )
    assert "/vault/activation/key-ceremony" not in document["paths"]
    response_schema = document["components"]["schemas"]["VaultActivationResponse"]
    assert response_schema["description"] == (
        "Everything the frontend may learn about managed-vault progress."
    )
    properties = response_schema["properties"]
    assert set(properties) == {
        "active",
        "state",
        "new_activation_available",
        "retryable",
        "failure_reason",
        "credential_received",
        "attested_confidential",
        "custody_mode",
    }
    assert properties["state"]["enum"] == [
        "inactive",
        "submitting",
        "pending",
        "provisioning",
        "awaiting_handoff",
        "ready",
        "failed",
        "deleting",
        "deleted",
    ]
    serialized = str(response_schema)
    assert "vault_url" not in serialized
    assert "consumer_credential" not in serialized
    assert properties["custody_mode"]["anyOf"][0]["enum"] == [
        "provider_managed",
        "wrapped_artifact_only",
    ]
    schemas = str(document["components"]["schemas"])
    assert "VaultKeyCeremony" not in schemas
    assert "passphrase" not in schemas.lower()
    assert "recovery_key" not in schemas.lower()
