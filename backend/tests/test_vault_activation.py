"""Demand-provisioned private-vault lifecycle contract for issue #2677."""

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
from models.user import User
from models.user_vault_config import UserVaultConfig
from models.vault_activation import VaultActivation, VaultTeardownReceipt
from schemas.vault_activation import (
    VaultKeyCeremonyChallenge,
    VaultKeyCeremonySubmission,
)
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
        self.fail_delete = False
        self.fail_ceremony_code: str | None = None
        self.last_ceremony_submission: VaultKeyCeremonySubmission | None = None
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
        deleting = replace(current, state="deleting", retryable=False, failure_reason=None)
        self.jobs[current.activation_id] = deleting
        return deleting

    async def key_ceremony(self, job_id: str) -> VaultKeyCeremonyChallenge:
        """Return one public challenge without exposing the requester bearer."""
        self._before_network()
        self.calls.append(("key_ceremony", job_id))
        current = next(job for job in self.jobs.values() if job.job_id == job_id)
        return VaultKeyCeremonyChallenge(
            protocol_version="1.0.0",
            job_id=current.job_id,
            activation_id=current.activation_id,
            ceremony_id="ceremony-001",
            server_nonce="A" * 43,
            expires_at=datetime(2026, 9, 8, tzinfo=UTC),
        )

    async def complete_key_ceremony(
        self,
        job_id: str,
        submission: VaultKeyCeremonySubmission,
    ) -> CreekProvisioningJob:
        """Accept only the already-wrapped artifact and settle the fake job."""
        self._before_network()
        self.calls.append(("complete_key_ceremony", job_id))
        if self.fail_ceremony_code is not None:
            raise ProvisioningRejectedError(self.fail_ceremony_code)
        self.last_ceremony_submission = submission
        current = next(job for job in self.jobs.values() if job.job_id == job_id)
        completed = replace(
            current,
            state="ready",
            retryable=False,
            failure_reason=None,
            attested_confidential=False,
        )
        self.jobs[current.activation_id] = completed
        return completed


@pytest.fixture(autouse=True)
def _encrypted_handoff(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> Generator[None, None, None]:
    """Configure both encrypted storage and a mounted callback bearer."""
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    token_file = tmp_path / "handoff-token"
    token_file.write_text(_HANDOFF_TOKEN, encoding="utf-8")
    monkeypatch.setenv("CREEK_PROVISIONING_HANDOFF_AUTH_FILE", str(token_file))
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


def _ceremony_payload(activation_id: str) -> dict[str, object]:
    """Return a protocol-valid ciphertext-only completion body."""
    binding = {
        "protocol_version": "1.0.0",
        "activation_id": activation_id,
        "ceremony_id": "ceremony-001",
        "server_nonce": "A" * 43,
        "client_nonce": "B" * 43,
    }
    return {
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
            "binding": binding,
        },
        "attestation": None,
        "key_release": None,
    }


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

    assert journal.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}
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
        "retryable": False,
        "failure_reason": None,
        "credential_received": False,
        "attested_confidential": None,
    }
    rows = (await db_session.execute(select(VaultActivation))).scalars().all()
    assert len(rows) == 1
    assert rows[0].user_id == user_id
    assert rows[0].consumer_identity.startswith("adepthood-user-")
    assert [call[0] for call in creek_client.calls] == ["activate", "activate"]
    assert _CREDENTIAL not in str(first)
    assert _VAULT_URL not in str(first)


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
    assert journal.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}


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
    )

    def assert_released() -> None:
        assert not db_session.in_transaction()

    creek_client.assert_released = assert_released

    response = await async_client.get("/vault/activation", headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json()["state"] == "ready"
    assert response.json()["credential_received"] is True
    assert response.json()["attested_confidential"] is False


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
async def test_handed_off_connection_stays_inert_until_ceremony_is_ready(
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
async def test_key_ceremony_proxy_releases_the_transaction_and_forwards_only_ciphertext(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """The browser can complete Creek's ceremony without learning its service bearer."""
    headers, _, _ = await _signup(async_client, "ceremony-proxy")
    await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    activation.state = "awaiting_key_ceremony"
    db_session.add(activation)
    await db_session.commit()
    current = creek_client.jobs[activation.activation_id]
    creek_client.jobs[activation.activation_id] = replace(
        current,
        state="awaiting_key_ceremony",
    )

    def assert_released() -> None:
        assert not db_session.in_transaction()

    creek_client.assert_released = assert_released
    challenge = await async_client.get(
        "/vault/activation/key-ceremony",
        headers=headers,
    )
    payload = _ceremony_payload(activation.activation_id)
    completed = await async_client.put(
        "/vault/activation/key-ceremony",
        headers=headers,
        json=payload,
    )

    assert challenge.status_code == HTTPStatus.OK
    assert challenge.json() == {
        "protocol_version": "1.0.0",
        "job_id": activation.creek_job_id,
        "activation_id": activation.activation_id,
        "ceremony_id": "ceremony-001",
        "server_nonce": "A" * 43,
        "expires_at": "2026-09-08T00:00:00Z",
    }
    assert completed.status_code == HTTPStatus.OK
    assert completed.json()["state"] == "awaiting_handoff"
    assert creek_client.last_ceremony_submission is not None
    forwarded = creek_client.last_ceremony_submission.model_dump(mode="json")
    assert forwarded == payload
    assert "passphrase" not in forwarded
    assert "recovery_key" not in forwarded
    assert "recovery_code" not in forwarded


@pytest.mark.asyncio
async def test_key_ceremony_proxy_rejects_secret_fields_without_echo_or_forwarding(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A client bug cannot put passphrases onto the operator-controlled hop."""
    headers, _, _ = await _signup(async_client, "ceremony-secret-refusal")
    await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    activation.state = "awaiting_key_ceremony"
    db_session.add(activation)
    await db_session.commit()
    canary = "never-forward-this-passphrase"
    payload = _ceremony_payload(activation.activation_id)
    payload["passphrase"] = canary

    refused = await async_client.put(
        "/vault/activation/key-ceremony",
        headers=headers,
        json=payload,
    )

    assert refused.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert canary not in refused.text
    assert canary not in caplog.text
    assert creek_client.last_ceremony_submission is None
    assert not any(call[0] == "complete_key_ceremony" for call in creek_client.calls)


@pytest.mark.asyncio
async def test_key_ceremony_proxy_preserves_stable_expiry_failure(
    async_client: AsyncClient,
    db_session: AsyncSession,
    creek_client: FakeProvisioningClient,
) -> None:
    """The recovery UI can distinguish an expired allocation and start over."""
    headers, _, _ = await _signup(async_client, "ceremony-expired")
    await _activate(async_client, headers)
    activation = (await db_session.execute(select(VaultActivation))).scalar_one()
    activation.state = "awaiting_key_ceremony"
    db_session.add(activation)
    await db_session.commit()
    creek_client.fail_ceremony_code = "ceremony_expired"

    refused = await async_client.put(
        "/vault/activation/key-ceremony",
        headers=headers,
        json=_ceremony_payload(activation.activation_id),
    )

    assert refused.status_code == HTTPStatus.CONFLICT
    assert refused.json() == {"detail": "ceremony_expired"}


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
    """The checked contract documents every public lifecycle rung, never handoff data."""
    document = app.openapi()
    assert set(document["paths"]["/vault/activation"]) >= {"get", "post"}
    assert "post" in document["paths"]["/vault/activation/retry"]
    assert set(document["paths"]["/vault/activation/key-ceremony"]) >= {"get", "put"}
    response_schema = document["components"]["schemas"]["VaultActivationResponse"]
    properties = response_schema["properties"]
    assert set(properties) == {
        "active",
        "state",
        "retryable",
        "failure_reason",
        "credential_received",
        "attested_confidential",
    }
    assert properties["state"]["enum"] == [
        "inactive",
        "submitting",
        "pending",
        "provisioning",
        "awaiting_key_ceremony",
        "awaiting_handoff",
        "ready",
        "failed",
        "deleting",
        "deleted",
    ]
    serialized = str(response_schema)
    assert "vault_url" not in serialized
    assert "consumer_credential" not in serialized
    ceremony_schemas = document["components"]["schemas"]
    ceremony_schema = str(ceremony_schemas)
    assert "VaultKeyCeremonyChallenge" in ceremony_schema
    assert "VaultKeyCeremonySubmission" in ceremony_schema
    submission_properties = ceremony_schemas["VaultKeyCeremonySubmission"]["properties"]
    assert "passphrase" not in submission_properties
    assert "recovery_key" not in submission_properties
    assert "recovery_code" not in ceremony_schema.lower()
