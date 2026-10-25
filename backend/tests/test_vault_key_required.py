"""A pool-less managed vault's keyless pass is refused before any charge (#3501).

A managed Creek vault ships no inference runtime and refuses its operator's
cloud key, so until the shared pool is up the only reflection it can write is
one powered by the writer's own key (ADR 0009's 2026-10-16 amendment, #3437).
Before Creek contract 0.20 adepthood could not see that ahead of time: it
charged a credit, dialled, was refused, refunded, and told the writer to "give
it a moment and try again" -- on 2026-10-21, deterministically, every time.

Creek 0.20 publishes ``keyless_inference`` on the handshake. When it is
``false`` and the pass carries no key the vault will spend, the pass is refused
with ``402 vault_key_required`` -- the existing add-a-key remedy -- before the
wallet, the vault's reflect route or any model is touched.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import TYPE_CHECKING, Final, cast

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlmodel import col

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import (
    CONTRACT_VERSION,
    HandshakeResult,
    VaultKeyProvider,
    VaultProviderKey,
)
from main import app
from models.user import User
from models.wallet_audit import WalletAudit
from services.creek_vault_client import _parse_handshake
from services.generation_access import VAULT_KEY_REQUIRED
from services.reflection_boundary import ReflectionBoundary
from services.usage import get_monthly_cap
from services.vault_byok import keyless_probe_due, keyless_vault_refusal
from tests.provider_transport import ANTHROPIC_KEY
from tests.support.reflecting_vault import ReflectingVaultClient

if TYPE_CHECKING:
    from httpx import AsyncClient, Response
    from sqlalchemy.ext.asyncio import AsyncSession

    from domain.creek_vault import CreekVaultClient

_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_BODY: Final = "I meditated by the river and the willow bent without breaking."
_DISTRESS_BODY: Final = "I keep thinking I want to kill myself and end my life tonight."
_MINOR: Final = ".".join(CONTRACT_VERSION.split(".")[:2])


def _handshake(*, keyless_inference: bool | None, available: bool = True) -> HandshakeResult:
    return HandshakeResult(
        available=available,
        contract_version=CONTRACT_VERSION,
        ontology_version="1.0.0",
        capabilities=frozenset(),
        attestation=None,
        keyless_inference=keyless_inference,
    )


def _document(**overrides: object) -> dict[str, object]:
    return {
        "contract_version": CONTRACT_VERSION,
        "supported_contract_minors": [_MINOR],
        "ontology_version": "1.0.0",
        "vault": {"available": True},
        "capabilities": ["reflections"],
        **overrides,
    }


# --- the handshake ----------------------------------------------------------------


def test_the_pin_is_at_least_contract_0_20() -> None:
    """``keyless_inference`` is a 0.20 field; a pin below 0.20 would never be told it."""
    major, minor = (int(part) for part in CONTRACT_VERSION.split(".")[:2])
    assert (major, minor) >= (0, 20)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(False, False), (True, True), (None, None), ("false", None), (0, None)],
    ids=["false", "true", "absent", "a-string", "a-zero"],
)
def test_keyless_inference_is_read_leniently(raw: object, expected: bool | None) -> None:
    """Only a literal boolean is believed; anything else is "not told" and changes nothing."""
    overrides = {} if raw is None else {"keyless_inference": raw}

    assert _parse_handshake(_document(**overrides)).keyless_inference is expected


@pytest.mark.parametrize(
    ("handshake", "refuses"),
    [
        (_handshake(keyless_inference=False), True),
        (_handshake(keyless_inference=True), False),
        (_handshake(keyless_inference=None), False),
        (_handshake(keyless_inference=False, available=False), False),
    ],
    ids=["pool-less", "pooled", "not-told", "unavailable"],
)
def test_only_an_available_vault_saying_false_refuses(
    handshake: HandshakeResult, refuses: bool
) -> None:
    """An unavailable vault is the existing 503 story, not a missing key."""
    assert handshake.refuses_keyless_inference() is refuses


# --- the decision -----------------------------------------------------------------


class _Vault:
    """A vault whose handshake is scripted and counted."""

    def __init__(self, handshake: HandshakeResult) -> None:
        self._handshake = handshake
        self.probes = 0

    async def handshake(self) -> HandshakeResult:
        self.probes += 1
        return self._handshake


class _Session:
    """Counts commits: no pooled connection may be held across the probe."""

    def __init__(self) -> None:
        self.commits = 0

    async def commit(self) -> None:
        self.commits += 1


async def _decide(
    vault: _Vault, *, due: bool = True, session: _Session | None = None
) -> HTTPException | None:
    return await keyless_vault_refusal(
        cast("AsyncSession", session or _Session()),
        cast("CreekVaultClient", vault),
        due=due,
    )


@pytest.mark.asyncio
async def test_a_keyless_pass_on_a_pool_less_vault_is_a_402_vault_key_required() -> None:
    """The refusal is a payer refusal, so care still answers a flagged entry first."""
    vault = _Vault(_handshake(keyless_inference=False))
    session = _Session()

    refusal = await _decide(vault, session=session)

    assert refusal is not None
    assert refusal.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert refusal.detail == VAULT_KEY_REQUIRED == "vault_key_required"
    assert vault.probes == 1
    assert session.commits == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("keyless", [True, None], ids=["pooled", "not-told"])
async def test_a_vault_that_may_answer_keyless_is_not_refused(keyless: bool | None) -> None:
    """A pooled vault, and one too old to say, are charged and dialled exactly as before."""
    assert await _decide(_Vault(_handshake(keyless_inference=keyless))) is None


@pytest.mark.asyncio
async def test_a_probe_that_is_not_due_never_reaches_the_vault() -> None:
    """``due`` is the whole gate: no commit, no handshake."""
    vault = _Vault(_handshake(keyless_inference=False))
    session = _Session()

    assert await _decide(vault, due=False, session=session) is None
    assert vault.probes == 0
    assert session.commits == 0


_KEY = VaultProviderKey(provider=VaultKeyProvider.ANTHROPIC, _secret=ANTHROPIC_KEY)


@pytest.mark.parametrize(
    ("boundary", "vault_key", "whatever_pays", "reaches", "due"),
    [
        (ReflectionBoundary.VAULT_BOUND, None, False, True, True),
        (ReflectionBoundary.VAULT_BOUND, _KEY, False, True, False),
        (ReflectionBoundary.APP_PROVIDER, None, False, True, False),
        (ReflectionBoundary.VAULT_BOUND, None, True, True, False),
        (ReflectionBoundary.VAULT_BOUND, None, False, False, False),
    ],
    ids=["keyless-vault-pass", "key-spent", "app-provider", "refused-whoever-pays", "no-dial"],
)
def test_the_probe_is_due_only_for_a_keyless_pass_that_reaches_the_vault(
    boundary: ReflectionBoundary,
    vault_key: VaultProviderKey | None,
    whatever_pays: bool,
    reaches: bool,
    due: bool,
) -> None:
    """Not due for a spent key, the app provider, a pass refused whoever pays, or a no-dial pass.

    A no-dial pass is a care-flagged entry or a classification with no vault tier;
    the refused-whoever-pays cases are ``free_only`` and a stale route (#3385/#3389).
    """
    assert (
        keyless_probe_due(
            boundary, vault_key, refused_whatever_pays=whatever_pays, reaches_vault=reaches
        )
        is due
    )


# --- the route --------------------------------------------------------------------


async def _writer(
    client: AsyncClient, username: str, body: str = _BODY
) -> tuple[dict[str, str], int]:
    """Sign up and write one personal entry; return its headers and id."""
    signup = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert signup.status_code == HTTPStatus.OK
    headers = {"Authorization": f"Bearer {signup.json()['token']}"}
    created = await client.post(
        "/journal/", json={"message": body, "classification": "personal"}, headers=headers
    )
    assert created.status_code == HTTPStatus.CREATED
    return headers, int(created.json()["id"])


def _vault_bound(
    *,
    keyless_inference: bool | None,
    request_key_providers: frozenset[VaultKeyProvider] = frozenset(),
) -> ReflectingVaultClient:
    vault = ReflectingVaultClient()
    vault.keyless_inference = keyless_inference
    vault.request_key_providers = request_key_providers
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND
    return vault


async def _resonance(
    client: AsyncClient, headers: dict[str, str], entry_id: int, *, key: str | None = None
) -> Response:
    sent = headers if key is None else {**headers, "X-LLM-API-Key": key}
    return await client.post(f"/journal/{entry_id}/resonance", headers=sent)


async def _wallet_untouched(session: AsyncSession, username: str) -> None:
    await session.rollback()
    user = (
        await session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()
    assert user.monthly_messages_used == 0
    audits = (
        await session.execute(
            select(func.count()).select_from(WalletAudit).where(col(WalletAudit.user_id) == user.id)
        )
    ).scalar_one()
    assert audits == 0, "neither a spend nor a refund may be written"


@pytest.mark.asyncio
async def test_the_pilot_pass_is_refused_before_the_wallet_or_the_reflect_route(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The exact 2026-10-21 pass: vault-bound, no key, a pool-less managed vault."""
    vault = _vault_bound(keyless_inference=False)
    headers, entry_id = await _writer(async_client, "pool_less_pilot")

    response = await _resonance(async_client, headers, entry_id)

    assert response.status_code == HTTPStatus.PAYMENT_REQUIRED, response.text
    assert response.json()["detail"] == "vault_key_required"
    assert vault.reflect_calls == []
    await _wallet_untouched(db_session, "pool_less_pilot")


@pytest.mark.asyncio
async def test_a_flagged_entry_still_gets_care_on_a_pool_less_vault(
    async_client: AsyncClient,
) -> None:
    """Care never depends on a model, a key or a wallet (NORTH-STAR §10)."""
    vault = _vault_bound(keyless_inference=False)
    headers, entry_id = await _writer(async_client, "pool_less_care", _DISTRESS_BODY)

    response = await _resonance(async_client, headers, entry_id)

    assert response.status_code == HTTPStatus.OK, response.text
    assert response.json()["care"] is not None
    assert vault.reflect_calls == []


@pytest.mark.asyncio
async def test_the_writers_own_key_still_reaches_a_pool_less_vault(
    async_client: AsyncClient,
) -> None:
    """The remedy the refusal names actually works: with the key, the vault is asked."""
    vault = _vault_bound(
        keyless_inference=False,
        request_key_providers=frozenset({VaultKeyProvider.ANTHROPIC}),
    )
    headers, entry_id = await _writer(async_client, "pool_less_keyed")

    response = await _resonance(async_client, headers, entry_id, key=ANTHROPIC_KEY)

    assert response.status_code == HTTPStatus.OK, response.text
    assert vault.reflect_calls


@pytest.mark.asyncio
async def test_a_pooled_vault_is_dialled_exactly_as_before(
    async_client: AsyncClient,
) -> None:
    """``keyless_inference: true`` changes nothing about a keyless pass."""
    vault = _vault_bound(keyless_inference=True)
    headers, entry_id = await _writer(async_client, "pooled_vault")

    response = await _resonance(async_client, headers, entry_id)

    assert response.status_code == HTTPStatus.OK, response.text
    assert vault.reflect_calls


@pytest.mark.asyncio
async def test_an_empty_wallet_is_told_to_add_a_key_not_to_refill(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Credits cannot buy what a pool-less vault will not write, so the key is the remedy named."""
    vault = _vault_bound(keyless_inference=False)
    headers, entry_id = await _writer(async_client, "pool_less_empty_wallet")
    user = (
        await db_session.execute(
            select(User).where(col(User.email) == "pool_less_empty_wallet@example.com")
        )
    ).scalar_one()
    user.monthly_messages_used = get_monthly_cap()
    user.offering_balance = 0
    db_session.add(user)
    await db_session.commit()

    response = await _resonance(async_client, headers, entry_id)

    assert response.status_code == HTTPStatus.PAYMENT_REQUIRED, response.text
    assert response.json()["detail"] == "vault_key_required"
    assert vault.reflect_calls == []
