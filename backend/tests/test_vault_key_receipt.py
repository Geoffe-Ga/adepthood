"""Who paid is decided from the vault's receipt, not from adepthood's guess (#3483).

Before #3483 a vault-bound pass was billed and labelled as paid by the writer's
own key whenever the key had a valid prefix and the vault's handshake
advertised its vendor -- a guess made *before* the dial. Two things defeat that
guess: a forged, prefix-valid key on a vault that answers anyway (a local
model, Creek-Vault#1849), and a handshake that changes between the admission
probe and the dial, so the key never rides it.

The vault says which route answered in every model-backed response
(``inference_source``, contract 0.19). ``request_key:<vendor>`` is the only
receipt that the writer's key paid, so:

* the pass is labelled ``own_key`` -- and named for its vendor -- only when that
  receipt names the vendor whose key adepthood relayed;
* a pass that relayed a key (and so took no credit) and came back with any
  other receipt is refused: nothing is kept, nothing is charged, and the
  writer is never handed a free reading.

This file pins the pure halves: the receipt's vocabulary, the adapter's
refusal, and the pass-level label. The seam-crossing cases -- the local
fallback, the handshake race and the forged key, through the real HTTP client
-- are in ``tests/security/test_ai_boundary_network_matrix.py``.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Final, cast

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import (
    CreekVaultClient,
    VaultKeyProvider,
    VaultProviderKey,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
    spent_request_key,
)
from main import app
from models.marginalia import Marginalia
from models.user import User
from models.wallet_audit import WalletAudit
from services.creek_vault_reflect import VaultResonanceLLM, reflection_receipt
from services.creek_vault_relay import forwarding_provider_key
from services.inference_provenance import PassReceipts, pass_provenance
from services.marginalia import VAULT_RECEIPT, vault_receipt
from services.reflection_boundary import (
    REFLECTION_SOURCE_UNAVAILABLE,
    ReflectionBoundary,
    VaultSourceUnavailableError,
    VaultSourceUnavailableReason,
)
from tests.provider_transport import ANTHROPIC_KEY
from tests.support.reflecting_vault import ReflectingVaultClient

_PASSWORD: Final = "correct-horse-battery-staple-1"  # pragma: allowlist secret
_BODY: Final = "The heron waited at the edge of the reeds until the water stilled."
_QUOTE: Final = "The heron waited"
_VAULT_NOTE: Final = "The vault reads: patience, again, in your own words."
_ANTHROPIC: Final = VaultProviderKey(provider=VaultKeyProvider.ANTHROPIC, _secret=ANTHROPIC_KEY)


def _answer(source: str | None, *, notes: bool = True) -> VaultReflection:
    """A vault reflection carrying one note (or none) and the route it names."""
    return VaultReflection(
        status=VaultReflectionStatus.OK if notes else VaultReflectionStatus.EMPTY,
        notes=(VaultReflectionNote(kind="theme", quote=_QUOTE, note=_VAULT_NOTE),) if notes else (),
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.PERSONAL,
        inference_source=source,
    )


# --- the receipt's vocabulary ------------------------------------------------------


@pytest.mark.parametrize(
    ("source", "spent"),
    [
        ("request_key:anthropic", VaultKeyProvider.ANTHROPIC),
        ("request_key:openai", VaultKeyProvider.OPENAI),
        ("request_key:mistral", None),
        ("pool:creek", None),
        ("pool:attested:anthropic", None),
        ("local", None),
        (None, None),
    ],
)
def test_only_a_request_key_receipt_names_a_spent_key(
    source: str | None, spent: VaultKeyProvider | None
) -> None:
    """A pool, a local model, an unknown vendor and no receipt at all spent no writer key."""
    assert spent_request_key(source) is spent


# --- the adapter: a relayed key the vault did not spend is no answer --------------


def _adapter(source: str | None, *, notes: bool = True) -> VaultResonanceLLM:
    """The vault adapter over a vault answering with ``source``."""
    vault = ReflectingVaultClient(reflect_result=_answer(source, notes=notes))
    return VaultResonanceLLM(
        cast("CreekVaultClient", vault), body=_BODY, tier_ceiling=VaultTierCeiling.PERSONAL
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["local", "pool:creek", "request_key:openai", None])
async def test_notes_written_without_the_relayed_key_are_refused(source: str | None) -> None:
    """The key went to the vault and came back unspent: the notes are not this pass's to keep."""
    llm = _adapter(source)

    with forwarding_provider_key(_ANTHROPIC), pytest.raises(VaultSourceUnavailableError) as refused:
        await llm.complete("unused")

    assert refused.value.reason is VaultSourceUnavailableReason.KEY_NOT_SPENT
    assert _VAULT_NOTE not in str(refused.value)


@pytest.mark.asyncio
async def test_notes_written_with_the_relayed_key_carry_its_receipt() -> None:
    """The vault spent the very key it was handed: the notes stand, receipted with the vendor."""
    llm = _adapter("request_key:anthropic")

    with forwarding_provider_key(_ANTHROPIC):
        completion = await llm.complete("unused")

    assert _VAULT_NOTE in completion
    assert reflection_receipt(llm, ()) == vault_receipt(VaultKeyProvider.ANTHROPIC)


@pytest.mark.asyncio
async def test_an_empty_answer_with_a_relayed_key_is_not_refused() -> None:
    """Nothing to keep is nothing given away: a vault with nothing to say still answers empty."""
    llm = _adapter(None, notes=False)

    with forwarding_provider_key(_ANTHROPIC):
        completion = await llm.complete("unused")

    assert completion == '{"notes": []}'
    assert reflection_receipt(llm, ()) == VAULT_RECEIPT


@pytest.mark.asyncio
async def test_a_keyless_pass_keeps_whatever_route_the_vault_named() -> None:
    """No key was relayed, so there is no key to have spent: a pool answer is the vault's answer."""
    llm = _adapter("pool:creek")

    assert _VAULT_NOTE in await llm.complete("unused")
    assert reflection_receipt(llm, ()) == VAULT_RECEIPT


# --- the label: own_key only on a matching receipt --------------------------------


def _receipts(spent: VaultKeyProvider | None) -> PassReceipts:
    return PassReceipts(notes=vault_receipt(spent), detection=None, detection_checked=False)


def test_a_matching_receipt_is_paid_by_the_key_and_names_its_vendor() -> None:
    """The relayed vendor and the receipt's vendor agree: the writer's key paid."""
    provenance = pass_provenance(
        _receipts(VaultKeyProvider.ANTHROPIC), byok=True, charge_kept=False, vault_key=_ANTHROPIC
    )

    assert provenance.paid_by == "own_key"
    assert provenance.own_key_vendor == "anthropic"


@pytest.mark.parametrize(
    "spent", [None, VaultKeyProvider.OPENAI], ids=["no_key_spent", "another_vendor"]
)
def test_a_relayed_key_without_its_receipt_is_never_labelled_own_key(
    spent: VaultKeyProvider | None,
) -> None:
    """A valid prefix and an advertising handshake are not evidence the key paid."""
    provenance = pass_provenance(
        _receipts(spent), byok=True, charge_kept=False, vault_key=_ANTHROPIC
    )

    assert provenance.paid_by == "free"
    assert provenance.own_key_vendor is None


def test_a_receipt_for_a_key_adepthood_never_relayed_is_not_own_key() -> None:
    """The vault's word alone is not enough either: the key must also be the one adepthood sent."""
    provenance = pass_provenance(
        _receipts(VaultKeyProvider.ANTHROPIC), byok=False, charge_kept=True, vault_key=None
    )

    assert provenance.paid_by == "wallet"
    assert provenance.own_key_vendor is None


# --- the route -------------------------------------------------------------------


async def _keyed_writer(
    client: AsyncClient, username: str, source: str | None
) -> tuple[dict[str, str], int]:
    """A writer bound to a managed vault that spends Anthropic keys, and one entry."""
    vault = ReflectingVaultClient(reflect_result=_answer(source))
    vault.request_key_providers = frozenset({VaultKeyProvider.ANTHROPIC})
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND
    signup = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert signup.status_code == HTTPStatus.OK
    headers = {"Authorization": f"Bearer {signup.json()['token']}"}
    created = await client.post(
        "/journal/", json={"message": _BODY, "classification": "personal"}, headers=headers
    )
    assert created.status_code == HTTPStatus.CREATED
    return {**headers, "X-LLM-API-Key": ANTHROPIC_KEY}, int(created.json()["id"])


async def _uncharged(session: AsyncSession, username: str) -> None:
    """Neither bucket moved and no wallet row -- spend or refund -- was written."""
    await session.rollback()
    user = (
        await session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()
    assert user.monthly_messages_used == 0
    audits = await session.execute(
        select(func.count()).select_from(WalletAudit).where(col(WalletAudit.user_id) == user.id)
    )
    assert audits.scalar_one() == 0


@pytest.mark.asyncio
async def test_a_local_fallback_reading_is_refused_and_keeps_no_notes(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The vault fell back to its own model: a retryable 503, no notes, no charge."""
    headers, entry_id = await _keyed_writer(async_client, "local_fallback", "local")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE, resp.text
    assert resp.json()["detail"] == REFLECTION_SOURCE_UNAVAILABLE
    await _uncharged(db_session, "local_fallback")
    kept = await db_session.execute(
        select(func.count())
        .select_from(Marginalia)
        .where(col(Marginalia.journal_entry_id) == entry_id)
    )
    assert kept.scalar_one() == 0


@pytest.mark.asyncio
async def test_a_reading_the_key_paid_is_labelled_from_the_receipt(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``request_key:anthropic`` back: kept, free of credits, and named for its vendor."""
    headers, entry_id = await _keyed_writer(async_client, "receipted", "request_key:anthropic")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert _VAULT_NOTE in resp.text
    assert resp.json()["provenance"]["paid_by"] == "own_key"
    assert resp.json()["provenance"]["own_key_vendor"] == "anthropic"
    await _uncharged(db_session, "receipted")
