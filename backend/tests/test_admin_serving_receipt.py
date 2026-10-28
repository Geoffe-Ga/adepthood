"""Tests for the operator-only serving receipt (issue #2871, B16 addendum).

The receipt is what a deploy reviewer captures to bind a live pilot run to the
build actually serving it. It must stay content-free and conservative: a closed
key set, no configured secret or pilot id, ``release`` only from the platform's
exact git SHA, and never a local-model or attestation claim the code cannot back.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.creek_vault import CONTRACT_VERSION
from models.user import User
from schemas.admin import ServingReceipt
from services.account_egress_barrier import ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR
from services.managed_vault_activation_config import (
    HANDOFF_AUTH_FILE_ENV_VAR,
    MANAGED_VAULT_ENABLED_ENV_VAR,
    PROVISIONING_AUTH_FILE_ENV_VAR,
)
from services.managed_vault_rollout import (
    MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR,
    ManagedVaultRolloutState,
    load_managed_vault_rollout,
)
from services.serving_receipt import (
    SERVING_RECEIPT_FIELDS,
    build_serving_receipt,
    served_release,
)

_RECEIPT_PATH = "/admin/serving-receipt"
_ADMIN_EMAIL = "receipt-admin@example.com"
_PLATFORM_SHA_ENV = "RAILWAY_GIT_COMMIT_SHA"
_SENTRY_RELEASE_ENV = "SENTRY_RELEASE"
_EXPECTED_FIELDS = frozenset(
    {
        "receipt_schema",
        "release",
        "content_version",
        "egress_barrier",
        "managed_vault_rollout",
        "creek_contract_version",
        "custody_modes_supported",
        "attested_confidential",
        "local_model",
    }
)
_PILOT_ID_SENTINEL = "987654321"


async def _signup(client: AsyncClient, email: str) -> dict[str, str]:
    """Sign up a user and return Authorization headers bearing their JWT."""
    credentials = {"email": email, "password": "secret12345"}  # pragma: allowlist secret
    resp = await client.post("/auth/signup", json=credentials)
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _admin_headers(client: AsyncClient, db_session: AsyncSession) -> dict[str, str]:
    """Sign up the receipt admin, promote them, and return their headers."""
    headers = await _signup(client, _ADMIN_EMAIL)
    await db_session.execute(
        update(User).where(col(User.email) == _ADMIN_EMAIL).values(is_admin=True)
    )
    await db_session.commit()
    return headers


async def _receipt(client: AsyncClient, db_session: AsyncSession) -> dict[str, object]:
    """Fetch the receipt as an admin and return the decoded body."""
    resp = await client.get(_RECEIPT_PATH, headers=await _admin_headers(client, db_session))
    assert resp.status_code == HTTPStatus.OK
    body: dict[str, object] = resp.json()
    return body


@pytest.mark.asyncio
async def test_receipt_requires_authentication(async_client: AsyncClient) -> None:
    """An anonymous caller is refused before any state is read."""
    resp = await async_client.get(_RECEIPT_PATH)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_receipt_refuses_non_admin(async_client: AsyncClient) -> None:
    """An ordinary member cannot read deployment state."""
    headers = await _signup(async_client, "member@example.com")
    resp = await async_client.get(_RECEIPT_PATH, headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_receipt_key_set_is_closed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Served keys, the builder's constant, and the schema are the same closed set."""
    body = await _receipt(async_client, db_session)
    assert set(body) == SERVING_RECEIPT_FIELDS == set(ServingReceipt.model_fields)
    assert set(body) == _EXPECTED_FIELDS


@pytest.mark.asyncio
async def test_receipt_reports_unknown_release_when_platform_sha_absent(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A Sentry label is never served as the build SHA, even when it looks like one."""
    sha_shaped_label = "c" * 40
    monkeypatch.delenv(_PLATFORM_SHA_ENV, raising=False)
    monkeypatch.setenv(_SENTRY_RELEASE_ENV, sha_shaped_label)
    resp = await async_client.get(
        _RECEIPT_PATH, headers=await _admin_headers(async_client, db_session)
    )
    assert resp.json()["release"] == "unknown"
    assert sha_shaped_label not in resp.text


@pytest.mark.parametrize("malformed", ["not-a-sha", "deadbeef", "A" * 40, "b" * 41])
@pytest.mark.asyncio
async def test_receipt_reports_unknown_for_malformed_platform_sha(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    malformed: str,
) -> None:
    """Anything but a full lowercase git SHA is reported as unknown, not echoed."""
    monkeypatch.setenv(_PLATFORM_SHA_ENV, malformed)
    body = await _receipt(async_client, db_session)
    assert body["release"] == "unknown"


@pytest.mark.asyncio
async def test_receipt_echoes_exact_platform_sha(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The platform's exact commit SHA is served verbatim."""
    sha = "b" * 40
    monkeypatch.setenv(_PLATFORM_SHA_ENV, sha)
    monkeypatch.setenv(_SENTRY_RELEASE_ENV, "c" * 40)
    body = await _receipt(async_client, db_session)
    assert body["release"] == sha


@pytest.mark.asyncio
async def test_receipt_never_claims_local_model_or_attestation(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No model digest or attestation exists to back a stronger claim."""
    body = await _receipt(async_client, db_session)
    assert body["local_model"] == "unknown"
    assert body["attested_confidential"] is False

    built = build_serving_receipt(db_session)
    assert built.local_model == "unknown"
    assert built.attested_confidential is False


@pytest.mark.asyncio
async def test_receipt_reports_pinned_contract_and_custody_modes(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The pinned client contract and the closed custody vocabulary are reported."""
    body = await _receipt(async_client, db_session)
    assert body["creek_contract_version"] == CONTRACT_VERSION
    assert body["custody_modes_supported"] == ["provider_managed", "wrapped_artifact_only"]
    assert body["receipt_schema"] == 1


@pytest.mark.asyncio
async def test_receipt_content_version_matches_health(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The receipt's content pin is the same value ``/health`` serves."""
    body = await _receipt(async_client, db_session)
    health = await async_client.get("/health")
    assert body["content_version"] == health.json()["content_version"]


@pytest.mark.asyncio
async def test_barrier_state_reports_disabled_when_env_false(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An explicit opt-out reads ``disabled``; unset on SQLite reads ``incomplete``."""
    headers = await _admin_headers(async_client, db_session)
    monkeypatch.setenv(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR, "false")
    disabled = await async_client.get(_RECEIPT_PATH, headers=headers)
    assert disabled.json()["egress_barrier"] == "disabled"

    monkeypatch.delenv(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR, raising=False)
    unset = await async_client.get(_RECEIPT_PATH, headers=headers)
    assert unset.json()["egress_barrier"] == "incomplete"


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        # Unset reads as switched off: the rollout is disabled, not ready.
        ({}, ManagedVaultRolloutState.DISABLED),
        ({MANAGED_VAULT_ENABLED_ENV_VAR: "false"}, ManagedVaultRolloutState.DISABLED),
        # Switched on with a pilot list but no mounted bearer files.
        (
            {
                MANAGED_VAULT_ENABLED_ENV_VAR: "true",
                MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR: _PILOT_ID_SENTINEL,
            },
            ManagedVaultRolloutState.INCOMPLETE,
        ),
        # A malformed switch is a defect, never quietly "ready".
        ({MANAGED_VAULT_ENABLED_ENV_VAR: "maybe"}, ManagedVaultRolloutState.INCOMPLETE),
    ],
)
@pytest.mark.asyncio
async def test_managed_rollout_reports_the_live_state(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    env: dict[str, str],
    expected: ManagedVaultRolloutState,
) -> None:
    """The receipt serves the rollout state the admission gate itself would read."""
    for name in (
        MANAGED_VAULT_ENABLED_ENV_VAR,
        MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR,
        PROVISIONING_AUTH_FILE_ENV_VAR,
        HANDOFF_AUTH_FILE_ENV_VAR,
    ):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)

    body = await _receipt(async_client, db_session)

    assert body["managed_vault_rollout"] == expected.value
    assert body["managed_vault_rollout"] == load_managed_vault_rollout().state.value


@pytest.mark.asyncio
async def test_managed_rollout_reports_state_only(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The rollout is reported as its state; the pilot allowlist never is."""
    monkeypatch.setenv("CREEK_MANAGED_VAULT_PILOT_USER_IDS", _PILOT_ID_SENTINEL)
    headers = await _admin_headers(async_client, db_session)
    resp = await async_client.get(_RECEIPT_PATH, headers=headers)
    assert resp.json()["managed_vault_rollout"] in {s.value for s in ManagedVaultRolloutState}
    assert _PILOT_ID_SENTINEL not in resp.text


@pytest.mark.asyncio
async def test_receipt_leaks_no_configured_secret(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No planted configuration value, nor the caller's email, reaches the body."""
    sentinels = {
        "CREEK_MANAGED_VAULT_PILOT_USER_IDS": "424242424242",
        "CREEK_PROVISIONING_AUTH_FILE": "/run/secrets/sentinel-control-bearer",
        "CREEK_PROVISIONING_HANDOFF_AUTH_FILE": "/run/secrets/sentinel-handoff-bearer",
        "SENTRY_DSN": "https://sentinelkey@o0.ingest.example.invalid/1",
        "CREEK_MANAGED_VAULT_ALERT_EMAIL": "sentinel-alerts@example.invalid",
        _SENTRY_RELEASE_ENV: "sentinel-release-label",
    }
    for name, value in sentinels.items():
        monkeypatch.setenv(name, value)
    headers = await _admin_headers(async_client, db_session)
    resp = await async_client.get(_RECEIPT_PATH, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    for value in sentinels.values():
        assert value not in resp.text
    assert _ADMIN_EMAIL not in resp.text


def test_served_release_reads_only_platform_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """With the platform SHA absent, no other variable can stand in for it."""
    monkeypatch.delenv(_PLATFORM_SHA_ENV, raising=False)
    for name in (_SENTRY_RELEASE_ENV, "GIT_COMMIT", "SOURCE_VERSION", "COMMIT_SHA"):
        monkeypatch.setenv(name, "d" * 40)
    assert served_release() == "unknown"
