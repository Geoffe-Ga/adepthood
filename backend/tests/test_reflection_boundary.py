"""Unit tests for :mod:`services.reflection_boundary` and the boundary resolver (#3061).

The boundary is decided from the server's own records, once per request: a
caller who owns a vault in any state is vault-bound, and a vault-bound caller is
never handed an app-provider adapter, whatever key they send.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from dependencies.creek_vault import OWNER_ENV_VAR, resolve_reflection_boundary
from models.user import User
from models.vault_activation import VaultActivation, VaultActivationState
from services import creek_vault_url_resolution
from services.marginalia import BotmasonResonanceLLM
from services.reflection_boundary import (
    REFLECTION_SOURCE_UNAVAILABLE,
    AppProviderRefusedError,
    ReflectionBoundary,
    VaultSourceUnavailableError,
    VaultSourceUnavailableReason,
    app_provider_llm,
    require_app_provider_llm,
)
from services.user_vault_config import store_vault_config

_PASSWORD = "secret12345"  # pragma: allowlist secret
_BYOK_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret
_VAULT_URL = "https://vault.example.test"
_VAULT_KEY = "creek-vault-boundary-unit-key"  # pragma: allowlist secret


def test_a_vault_bound_caller_gets_no_app_provider_even_with_a_key() -> None:
    """A BYOK key pays for a call; it does not consent to one."""
    assert app_provider_llm(ReflectionBoundary.VAULT_BOUND, _BYOK_KEY) is None
    assert app_provider_llm(ReflectionBoundary.VAULT_BOUND, None) is None


def test_an_app_provider_caller_gets_the_adapter() -> None:
    """With no vault, the app provider is the source, exactly as before."""
    assert isinstance(
        app_provider_llm(ReflectionBoundary.APP_PROVIDER, _BYOK_KEY), BotmasonResonanceLLM
    )


def test_require_refuses_loudly_under_the_vault_boundary() -> None:
    """A call site whose own boundary check went missing fails instead of dialling."""
    with pytest.raises(AppProviderRefusedError):
        require_app_provider_llm(ReflectionBoundary.VAULT_BOUND, _BYOK_KEY)

    assert isinstance(
        require_app_provider_llm(ReflectionBoundary.APP_PROVIDER, None), BotmasonResonanceLLM
    )


def test_the_unavailable_error_carries_only_closed_vocabulary() -> None:
    """The message is the static token; the reason is this module's own word."""
    error = VaultSourceUnavailableError(VaultSourceUnavailableReason.VAULT_ERROR)

    assert str(error) == REFLECTION_SOURCE_UNAVAILABLE
    assert error.reason is VaultSourceUnavailableReason.VAULT_ERROR


async def _user_id(client: AsyncClient, session: AsyncSession, username: str) -> int:
    """Sign up ``username`` and return its id."""
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK
    user = (
        await session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()
    assert user.id is not None
    return user.id


@pytest.fixture
def no_lookups(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail the test if the resolver ever resolves a host: it must read local state only."""

    async def _forbidden(host: str) -> tuple[str, ...]:
        msg = f"the boundary resolver looked up {host!r}"
        raise AssertionError(msg)

    monkeypatch.setattr(creek_vault_url_resolution, "resolve_host_addresses", _forbidden)


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_lookups")
async def test_no_row_and_no_binding_is_app_provider(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The floor: nothing connected, nothing bound."""
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    monkeypatch.delenv(OWNER_ENV_VAR, raising=False)
    user_id = await _user_id(async_client, db_session, "boundary_unit_none")

    assert await resolve_reflection_boundary(db_session, user_id) is ReflectionBoundary.APP_PROVIDER


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_lookups")
@pytest.mark.parametrize("state", ["ready", "not_ready", "plain"])
async def test_any_connection_row_is_vault_bound(
    async_client: AsyncClient, db_session: AsyncSession, state: str
) -> None:
    """Ready, still provisioning, or a plain stored connection: all are the writer's vault.

    A plain row's host would be re-judged (and possibly found undialable) only on
    the dial path; the resolver never looks, so an undialable host is
    vault-bound by construction -- ``no_lookups`` would fail the test otherwise.
    """
    user_id = await _user_id(async_client, db_session, f"boundary_unit_{state}")
    await store_vault_config(
        db_session,
        user_id,
        vault_url=_VAULT_URL,
        api_key=_VAULT_KEY,
        provisioned=state != "plain",
    )
    if state == "ready":
        db_session.add(
            VaultActivation(
                user_id=user_id,
                activation_id=f"activation-{user_id}",
                consumer_identity=f"consumer-{user_id}",
                state=VaultActivationState.READY.value,
            )
        )
        await db_session.commit()

    assert await resolve_reflection_boundary(db_session, user_id) is ReflectionBoundary.VAULT_BOUND


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_lookups")
async def test_the_deployment_owner_is_vault_bound_and_nobody_else(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The environment binding counts for its one bound user, never for anyone else."""
    owner = await _user_id(async_client, db_session, "boundary_unit_owner")
    other = await _user_id(async_client, db_session, "boundary_unit_other")
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv(OWNER_ENV_VAR, str(owner))

    assert await resolve_reflection_boundary(db_session, owner) is ReflectionBoundary.VAULT_BOUND
    assert await resolve_reflection_boundary(db_session, other) is ReflectionBoundary.APP_PROVIDER
