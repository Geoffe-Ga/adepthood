"""A ``free_only`` resonance request answers only the pass's free exits (#3389).

A client whose payer preflight read an empty wallet must still let the server
answer an intimate entry with its privacy message and a distressed entry with
care: neither costs anything, and only the server can see either. It cannot
send an ordinary request for that, though. A wallet refilled since the read
would then be charged for a reading nobody disclosed a price for. So it asks
with ``?free_only=true``, which admits nothing that could charge or dial:

| Case                                     | Expected                              |
|------------------------------------------|---------------------------------------|
| intimate entry, empty wallet             | 200 private message, nothing dialled  |
| distressed entry, empty wallet           | 200 care surface, no reflection       |
| distressed entry, funded wallet          | 200 care surface, no charge           |
| ordinary entry, empty wallet             | 402 ``insufficient_offerings``        |
| ordinary entry, funded wallet            | 409 ``resonance_payment_unconfirmed`` |
| ordinary entry, a key the provider takes | 409, and the key pays nothing         |

Every row also asserts the wallet and its audit trail did not move and that no
vault or provider was reached.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Final

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import (
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
)
from main import app
from models.journal_entry import JournalClassification
from models.llm_usage_log import LLMUsageLog
from models.wallet_audit import WalletAudit
from services.generation_access import CREDITS_OR_KEY_REQUIRED, RESONANCE_PAYMENT_UNCONFIRMED
from services.reflection_boundary import ReflectionBoundary
from services.resonance_care import INTIMATE_PRIVATE_MESSAGE
from tests.incident.test_privacy_suspension import (
    arm_anthropic,
    count_rows,
    seed_entry,
    signup,
    wallet,
)
from tests.provider_transport import ANTHROPIC_KEY, TransportStub
from tests.support.reflecting_vault import ReflectingVaultClient

_FREE_ONLY: Final = {"free_only": "true"}
_BYOK_HEADER: Final = "X-LLM-API-Key"
_BODY: Final = "The heron waited at the edge of the reeds until the water stilled."
_DISTRESS_BODY: Final = "I keep thinking I want to kill myself and end my life tonight."
_QUOTE: Final = "The heron waited"
_VAULT_NOTE: Final = "The vault reads: patience, again, in your own words."


def _bind_to_answering_vault() -> ReflectingVaultClient:
    """Serve a vault that would answer with one note, and bind the caller to it."""
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


def _empty_the_wallet(monkeypatch: pytest.MonkeyPatch) -> None:
    """No monthly allowance; a fresh account holds no purchased offerings either."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "0")


class _Ledger:
    """What a free answer must leave alone: both buckets, the audit trail, the usage log."""

    def __init__(self, session: AsyncSession, user_id: int) -> None:
        self._session = session
        self._user_id = user_id
        self._before: tuple[tuple[int, int], int, int] | None = None

    async def _read(self) -> tuple[tuple[int, int], int, int]:
        return (
            await wallet(self._session, self._user_id),
            await count_rows(self._session, WalletAudit),
            await count_rows(self._session, LLMUsageLog),
        )

    async def snapshot(self) -> None:
        """Record the state the request must leave unchanged."""
        self._before = await self._read()

    async def assert_unchanged(self) -> None:
        """Nothing was charged, refunded, or logged as a provider call."""
        assert self._before is not None
        assert await self._read() == self._before


async def _ask(
    client: AsyncClient,
    headers: dict[str, str],
    entry_id: int,
) -> tuple[int, dict[str, object]]:
    resp = await client.post(f"/journal/{entry_id}/resonance", headers=headers, params=_FREE_ONLY)
    return resp.status_code, resp.json()


def _assert_nothing_dialled(vault: ReflectingVaultClient, provider: TransportStub) -> None:
    assert vault.reflect_calls == []
    assert provider.request_count == 0


@pytest.mark.asyncio
async def test_an_intimate_entry_gets_its_privacy_message_from_an_empty_wallet(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The privacy floor answers before any payer question, so an empty wallet is irrelevant."""
    provider = arm_anthropic(monkeypatch)
    vault = _bind_to_answering_vault()
    _empty_the_wallet(monkeypatch)
    headers, user_id, _ = await signup(async_client, "free_only_intimate")
    entry_id = await seed_entry(
        db_session, user_id, body=_BODY, classification=JournalClassification.INTIMATE
    )
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, body = await _ask(async_client, headers, entry_id)

    assert status == HTTPStatus.OK, body
    assert body["private"] is True
    assert body["private_message"] == INTIMATE_PRIVATE_MESSAGE
    assert body["marginalia"] == []
    assert body["care"] is None
    _assert_nothing_dialled(vault, provider)
    await ledger.assert_unchanged()


@pytest.mark.asyncio
@pytest.mark.parametrize("empty", [True, False], ids=["empty_wallet", "funded_wallet"])
async def test_a_distressed_entry_gets_care_and_no_reflection_whatever_the_wallet(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    *,
    empty: bool,
) -> None:
    """Care depends on no payer; a free-only request is never turned into a paid reading."""
    provider = arm_anthropic(monkeypatch)
    vault = _bind_to_answering_vault()
    if empty:
        _empty_the_wallet(monkeypatch)
    headers, user_id, _ = await signup(async_client, f"free_only_care_{empty}")
    entry_id = await seed_entry(db_session, user_id, body=_DISTRESS_BODY)
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, body = await _ask(async_client, headers, entry_id)

    assert status == HTTPStatus.OK, body
    assert body["care"] is not None
    assert body["marginalia"] == []
    assert body["private"] is False
    _assert_nothing_dialled(vault, provider)
    await ledger.assert_unchanged()


@pytest.mark.asyncio
async def test_an_ordinary_entry_on_an_empty_wallet_is_the_usual_free_refusal(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing free applies, so the writer gets the same 402 the refill dialog answers."""
    provider = arm_anthropic(monkeypatch)
    vault = _bind_to_answering_vault()
    _empty_the_wallet(monkeypatch)
    headers, user_id, _ = await signup(async_client, "free_only_refused")
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, body = await _ask(async_client, headers, entry_id)

    assert status == HTTPStatus.PAYMENT_REQUIRED, body
    assert body == {"detail": CREDITS_OR_KEY_REQUIRED}
    _assert_nothing_dialled(vault, provider)
    await ledger.assert_unchanged()


@pytest.mark.asyncio
async def test_a_wallet_refilled_since_the_preflight_is_not_charged_unannounced(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A payer exists now, but the writer was never shown this price: 409, nothing spent."""
    provider = arm_anthropic(monkeypatch)
    vault = _bind_to_answering_vault()
    headers, user_id, _ = await signup(async_client, "free_only_refilled")
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, body = await _ask(async_client, headers, entry_id)

    assert status == HTTPStatus.CONFLICT, body
    assert body == {"detail": RESONANCE_PAYMENT_UNCONFIRMED}
    _assert_nothing_dialled(vault, provider)
    await ledger.assert_unchanged()


@pytest.mark.asyncio
async def test_a_key_the_app_provider_would_take_pays_for_nothing_under_free_only(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A route that changed to the app provider still cannot spend the writer's key."""
    provider = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "free_only_byok")
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    ledger = _Ledger(db_session, user_id)
    await ledger.snapshot()

    status, body = await _ask(async_client, {**headers, _BYOK_HEADER: ANTHROPIC_KEY}, entry_id)

    assert status == HTTPStatus.CONFLICT, body
    assert body == {"detail": RESONANCE_PAYMENT_UNCONFIRMED}
    assert provider.request_count == 0
    await ledger.assert_unchanged()


@pytest.mark.asyncio
async def test_without_free_only_a_funded_vault_reading_still_takes_its_credit(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Control: the flag is opt-in, so the ordinary request path is unchanged."""
    arm_anthropic(monkeypatch)
    vault = _bind_to_answering_vault()
    headers, user_id, _ = await signup(async_client, "free_only_absent")
    entry_id = await seed_entry(db_session, user_id, body=_BODY)
    used_before, balance_before = await wallet(db_session, user_id)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert len(vault.reflect_calls) == 1
    assert await wallet(db_session, user_id) == (used_before + 1, balance_before)
