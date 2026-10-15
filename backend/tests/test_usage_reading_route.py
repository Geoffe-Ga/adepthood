"""Price disclosures use the same server-owned route boundary as actual readings (#3262)."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from dependencies.creek_vault import OWNER_ENV_VAR
from models.user import User
from services import creek_vault_url_resolution
from services.user_vault_config import store_vault_config

_PASSWORD = "test-route-password"  # pragma: allowlist secret
_VAULT_URL = "https://private-vault.example.test"
_VAULT_KEY = "private-route-test-credential"  # pragma: allowlist secret


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("binding", "expected"),
    [
        ("none", "app_provider"),
        ("per_user", "vault_bound"),
        ("provisioned", "vault_bound"),
        ("deployment_owner", "vault_bound"),
        ("deployment_other", "app_provider"),
    ],
)
async def test_usage_reports_only_local_route_eligibility(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    binding: str,
    expected: str,
) -> None:
    """A binding is routing, never a claim that a remote vault is reachable or answers."""
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    monkeypatch.delenv(OWNER_ENV_VAR, raising=False)

    async def no_lookup(_host: str) -> tuple[str, ...]:
        raise AssertionError("a price snapshot must never dial or resolve the vault")

    monkeypatch.setattr(creek_vault_url_resolution, "resolve_host_addresses", no_lookup)
    email = f"route-{binding}@example.com"
    signup = await async_client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    assert signup.status_code == HTTPStatus.OK
    headers = {"Authorization": f"Bearer {signup.json()['token']}"}
    user = (await db_session.execute(select(User).where(col(User.email) == email))).scalar_one()
    assert user.id is not None
    if binding in {"per_user", "provisioned"}:
        await store_vault_config(
            db_session,
            user.id,
            vault_url=_VAULT_URL,
            api_key=_VAULT_KEY,
            provisioned=binding == "provisioned",
        )
    if binding.startswith("deployment_"):
        monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
        monkeypatch.setenv(
            OWNER_ENV_VAR, str(user.id if binding == "deployment_owner" else user.id + 1)
        )

    response = await async_client.get("/user/usage", headers=headers)
    assert response.status_code == HTTPStatus.OK
    payload = response.json()
    assert payload["resonance_route"] == expected
    assert set(payload) == {
        "monthly_messages_used",
        "monthly_messages_remaining",
        "monthly_cap",
        "monthly_reset_date",
        "offering_balance",
        "resonance_route",
    }
    assert payload["monthly_messages_used"] == 0
    assert payload["offering_balance"] == 0
    for private in (email, _PASSWORD, _VAULT_URL, _VAULT_KEY):
        assert private not in response.text


@pytest.mark.asyncio
async def test_usage_route_does_not_bypass_authentication(async_client: AsyncClient) -> None:
    response = await async_client.get("/user/usage")
    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert "resonance_route" not in response.json()
