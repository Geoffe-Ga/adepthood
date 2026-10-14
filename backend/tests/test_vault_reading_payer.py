"""A vault-answered reading takes a credit, whatever key header it carries (#3258).

The owner's decision (2026-10-14, ADR 0009 decision 4): the writer's own key
pays only when the app's own provider will answer. Under the vault boundary the
key is never used -- the vault answers -- so a key header there is irrelevant:
the reading goes through the credit path, and a revoked entitlement is refused
``403 ai_access_revoked`` however well-formed the header is.

| Case                                | Expected                      |
|-------------------------------------|-------------------------------|
| vault answers, no key               | one credit charged            |
| vault answers, key present          | one credit charged            |
| app provider answers with the key   | no credit; the vendor bills   |
| vault, revoked, made-up key         | 403 ``ai_access_revoked``     |
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Final

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import (
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
)
from domain.entitlements import AI_ACCESS_REVOKED, REASON_REFUND, revoke_course_access
from main import app
from models.wallet_audit import WalletAudit
from services.generation_access import (
    CREDITS_OR_KEY_REQUIRED,
    payer_refusal,
    require_ai_payer,
)
from services.reflection_boundary import ReflectionBoundary
from tests.incident.test_privacy_suspension import (
    arm_anthropic,
    count_rows,
    seed_entry,
    signup,
    wallet,
)
from tests.provider_transport import ANTHROPIC_KEY
from tests.support.reflecting_vault import ReflectingVaultClient

_BYOK_HEADER: Final = "X-LLM-API-Key"
_BODY: Final = "The heron waited at the edge of the reeds until the water stilled."
_QUOTE: Final = "The heron waited"
_VAULT_NOTE: Final = "The vault reads: patience, again, in your own words."
_ONE_CREDIT: Final = 1
_REVOKED_BODY: Final = {"detail": AI_ACCESS_REVOKED}


def _bind_to_answering_vault() -> ReflectingVaultClient:
    """Serve a vault that answers with one note, and bind the caller to it."""
    vault = ReflectingVaultClient(
        reflect_result=VaultReflection(
            status=VaultReflectionStatus.OK,
            notes=(VaultReflectionNote(kind="theme", quote=_QUOTE, note=_VAULT_NOTE),),
            essay=None,
            essay_grounded=False,
            routed_tier=VaultTierCeiling.PERSONAL,
        )
    )
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND
    return vault


# --- the routes ---------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("with_key", [False, True], ids=["no_key", "key_present"])
async def test_a_vault_answered_reading_takes_one_credit_whatever_key_it_carries(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    *,
    with_key: bool,
) -> None:
    """The vault answers, so the key is irrelevant: one credit is charged either way."""
    provider = arm_anthropic(monkeypatch)
    vault = _bind_to_answering_vault()
    headers, user_id, _ = await signup(async_client, f"vault_paid_{with_key}")
    if with_key:
        headers = {**headers, _BYOK_HEADER: ANTHROPIC_KEY}
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    used_before, balance_before = await wallet(db_session, user_id)
    audit_before = await count_rows(db_session, WalletAudit)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert [note["note"] for note in resp.json()["marginalia"]] == [_VAULT_NOTE]
    assert len(vault.reflect_calls) == 1
    assert provider.request_count == 0
    assert await wallet(db_session, user_id) == (used_before + _ONE_CREDIT, balance_before)
    assert await count_rows(db_session, WalletAudit) == audit_before + _ONE_CREDIT


@pytest.mark.asyncio
async def test_a_revoked_member_with_a_made_up_key_is_refused_a_vault_reading(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A well-formed header is no way past a revocation when the vault would answer."""
    provider = arm_anthropic(monkeypatch)
    vault = _bind_to_answering_vault()
    headers, user_id, _ = await signup(async_client, "vault_revoked_fake_key")
    await revoke_course_access(db_session, user_id, REASON_REFUND)
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    before_wallet = await wallet(db_session, user_id)
    audit_before = await count_rows(db_session, WalletAudit)

    resp = await async_client.post(
        f"/journal/{entry_id}/resonance",
        headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY},
    )

    assert resp.status_code == HTTPStatus.FORBIDDEN, resp.text
    assert resp.json() == _REVOKED_BODY
    assert vault.reflect_calls == []
    assert provider.request_count == 0
    assert await wallet(db_session, user_id) == before_wallet
    assert await count_rows(db_session, WalletAudit) == audit_before


@pytest.mark.asyncio
async def test_an_app_provider_reading_with_a_key_takes_no_credit(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Control: the key pays its own vendor when the app's provider answers."""
    provider = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "app_provider_byok")
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    before_wallet = await wallet(db_session, user_id)
    audit_before = await count_rows(db_session, WalletAudit)

    resp = await async_client.post(
        f"/journal/{entry_id}/resonance",
        headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY},
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert provider.request_count > 0
    assert await wallet(db_session, user_id) == before_wallet
    assert await count_rows(db_session, WalletAudit) == audit_before


# --- the gate -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_gate_does_not_let_a_key_pay_for_a_vault_reading(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With the vault answering, a key does not stand in for an empty wallet."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "0")
    _, user_id, _ = await signup(async_client, "gate_vault_key_empty")

    with pytest.raises(HTTPException) as raised:
        await require_ai_payer(db_session, user_id, ANTHROPIC_KEY, app_provider=False)

    assert raised.value.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert raised.value.detail == CREDITS_OR_KEY_REQUIRED


@pytest.mark.asyncio
async def test_the_gate_refuses_a_revoked_vault_reading_carrying_a_key(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The revocation is answered before the key is considered on the vault side."""
    _, user_id, _ = await signup(async_client, "gate_vault_key_revoked")
    await revoke_course_access(db_session, user_id, REASON_REFUND)

    handed_back = await payer_refusal(db_session, user_id, ANTHROPIC_KEY, app_provider=False)

    assert handed_back is not None
    assert handed_back.status_code == HTTPStatus.FORBIDDEN
    assert handed_back.detail == AI_ACCESS_REVOKED
