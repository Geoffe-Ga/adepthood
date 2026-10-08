"""No generation without someone to pay for it, and never a canned stub (#3096).

The owner's decision (b07-e4): rather than "generating" a canned, text-replaced
reflection, essay or transcription, refuse to generate anything at all unless
the account has BotMason credits available or has configured its own OpenAI or
Anthropic key.

So every user-facing AI route admits through one payer gate, at the same point
the operator's ``ai_suspended`` switch admits it (#3075): after the route's free
exits, before the minute bucket, the concurrent slot, the wallet or any dial. A
refusal is a 402 carrying one of the two payer details the client already routes
to its "add credits or a key" surface, and it costs the writer nothing.

The stub provider survives only as an explicit test seam
(``BOTMASON_STUB_SEAM``), which the suite arms in ``conftest.py`` and every
test here disarms to see what a real deployment does.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import TYPE_CHECKING, Final

import pytest
from fastapi import HTTPException
from sqlmodel import col, select

from main import validate_stub_seam_config
from models.generation_slot import GenerationSlot
from models.llm_usage_log import LLMUsageLog
from models.marginalia import Marginalia
from models.user import User
from models.wallet_audit import WalletAudit
from services import botmason
from services.generation_access import (
    CREDITS_OR_KEY_REQUIRED,
    KEY_REQUIRED,
    require_ai_payer,
)
from services.wallet import has_generation_capacity
from tests.incident.test_privacy_suspension import (
    _MINUTE_BUCKET_ROUTES,
    _call_route,
    arm_anthropic,
    count_rows,
    record_admission,
    record_minute_bucket,
    signup,
    wallet,
)
from tests.provider_transport import ANTHROPIC_KEY

if TYPE_CHECKING:
    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession

_ROUTES: Final = ("resonance", "essay", "detect", "transcribe")
_STUB_PREFIXES: Final = (botmason.STUB_PROSE_PREFIX, "BotMason gazes at your")


def disarm_stub_seam(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run as a real deployment does: no stub seam, the default ``stub`` provider."""
    monkeypatch.delenv(botmason.STUB_SEAM_ENV_VAR, raising=False)
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.delenv("LLM_API_KEY", raising=False)


def configure_server_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    """A real, server-paid Anthropic provider and no stub seam."""
    monkeypatch.delenv(botmason.STUB_SEAM_ENV_VAR, raising=False)
    monkeypatch.setenv("BOTMASON_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_API_KEY", ANTHROPIC_KEY)


async def empty_wallet(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch, user_id: int
) -> None:
    """No free monthly messages and no purchased credits."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "0")
    user = await session.get(User, user_id)
    assert user is not None
    user.offering_balance = 0
    session.add(user)
    await session.commit()


async def stub_text_rows(session: AsyncSession) -> list[str]:
    """Every persisted note or letter that reads like the stub's canned prose."""
    await session.rollback()
    rows = (await session.execute(select(Marginalia))).scalars().all()
    texts = [text for row in rows for text in (row.note, row.essay) if text]
    return [text for text in texts if text.startswith(_STUB_PREFIXES)]


# --- the leaf: no stub answer without the explicit seam -----------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("with_image", [False, True])
async def test_generate_response_never_answers_from_the_stub_unarmed(
    monkeypatch: pytest.MonkeyPatch, *, with_image: bool
) -> None:
    """With no real provider and no seam, the leaf refuses rather than inventing text."""
    disarm_stub_seam(monkeypatch)
    images = (
        [botmason.ImagePayload(media_type="image/png", data="aGVsbG8=")] if with_image else None
    )

    with pytest.raises(botmason.NoGenerationSourceError) as raised:
        await botmason.generate_response("hello", [], images=images)

    assert isinstance(raised.value, botmason.LLMProviderError)
    assert str(raised.value) == KEY_REQUIRED


@pytest.mark.asyncio
async def test_the_armed_seam_still_serves_the_canned_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Control: the same call with the seam armed is the stub's canned sentence."""
    disarm_stub_seam(monkeypatch)
    monkeypatch.setenv(botmason.STUB_SEAM_ENV_VAR, "true")

    response = await botmason.generate_response("hello", [])

    assert response.text.startswith(botmason.STUB_PROSE_PREFIX)
    assert response.provider == botmason.STUB_PROVIDER_NAME


@pytest.mark.parametrize("value", ["", "false", "1", "yes", "TRUE "])
def test_only_the_exact_word_true_arms_the_seam(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """The seam fails shut: anything but ``true`` (case/space-insensitive) leaves it off."""
    monkeypatch.setenv(botmason.STUB_SEAM_ENV_VAR, value)

    assert botmason.stub_seam_armed() is (value.strip().lower() == "true")


def test_vision_is_unavailable_on_an_unarmed_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """Transcription cannot fall through to a canned page outside the seam."""
    disarm_stub_seam(monkeypatch)
    monkeypatch.setenv("ENV", "development")

    assert botmason.vision_provider_available(None) is False


# --- the boot: the seam never fronts real users --------------------------------


def test_production_boot_refuses_an_armed_stub_seam(monkeypatch: pytest.MonkeyPatch) -> None:
    """A production process with the seam armed would serve canned text: refuse to boot."""
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv(botmason.STUB_SEAM_ENV_VAR, "true")

    with pytest.raises(RuntimeError, match=botmason.STUB_SEAM_ENV_VAR):
        validate_stub_seam_config()


@pytest.mark.parametrize(("env", "seam"), [("production", None), ("development", "true")])
def test_boot_passes_without_the_seam_or_outside_production(
    monkeypatch: pytest.MonkeyPatch, env: str, seam: str | None
) -> None:
    """Only the production-plus-armed combination is refused."""
    monkeypatch.setenv("ENV", env)
    if seam is None:
        monkeypatch.delenv(botmason.STUB_SEAM_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(botmason.STUB_SEAM_ENV_VAR, seam)

    validate_stub_seam_config()


# --- the gate itself ----------------------------------------------------------


@pytest.mark.asyncio
async def test_gate_admits_a_personal_key_with_an_empty_wallet_on_a_stub_server(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A BYOK key is a payer by itself: no credits and no server provider needed."""
    disarm_stub_seam(monkeypatch)
    _, user_id, _ = await signup(async_client, "gate_byok")
    await empty_wallet(db_session, monkeypatch, user_id)

    await require_ai_payer(db_session, user_id, ANTHROPIC_KEY)


@pytest.mark.asyncio
async def test_gate_refuses_an_unarmed_stub_server_even_with_credits(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Credits cannot buy a reply from a server with no real provider: a key is the way."""
    disarm_stub_seam(monkeypatch)
    _, user_id, _ = await signup(async_client, "gate_stub_credits")
    assert await has_generation_capacity(db_session, user_id) is True

    with pytest.raises(HTTPException) as raised:
        await require_ai_payer(db_session, user_id, None)

    assert raised.value.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert raised.value.detail == KEY_REQUIRED


@pytest.mark.asyncio
async def test_gate_lets_a_vault_bound_caller_past_the_stub_check(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A vault answers a vault-bound pass, never the app provider, so its absence is moot."""
    disarm_stub_seam(monkeypatch)
    _, user_id, _ = await signup(async_client, "gate_vault")

    await require_ai_payer(db_session, user_id, None, app_provider=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("app_provider", [True, False])
async def test_gate_refuses_an_empty_wallet_without_a_key(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    *,
    app_provider: bool,
) -> None:
    """No credits and no key is refused whichever side would have answered."""
    configure_server_provider(monkeypatch)
    _, user_id, _ = await signup(async_client, f"gate_empty_{app_provider}")
    await empty_wallet(db_session, monkeypatch, user_id)

    with pytest.raises(HTTPException) as raised:
        await require_ai_payer(db_session, user_id, None, app_provider=app_provider)

    assert raised.value.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert raised.value.detail == CREDITS_OR_KEY_REQUIRED


@pytest.mark.asyncio
async def test_capacity_counts_purchased_credits_and_a_due_monthly_reset(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Capacity is free monthly room, or a purchased balance -- read, never spent."""
    _, user_id, _ = await signup(async_client, "capacity")
    await empty_wallet(db_session, monkeypatch, user_id)
    assert await has_generation_capacity(db_session, user_id) is False

    user = await db_session.get(User, user_id)
    assert user is not None
    user.offering_balance = 1
    db_session.add(user)
    await db_session.commit()
    assert await has_generation_capacity(db_session, user_id) is True
    assert await wallet(db_session, user_id) == (0, 1)

    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "3")
    user = await db_session.get(User, user_id)
    assert user is not None
    user.offering_balance = 0
    user.monthly_messages_used = 3
    db_session.add(user)
    await db_session.commit()
    assert await has_generation_capacity(db_session, user_id) is False


# --- the routes: refused, free, and never stub text ---------------------------


async def _assert_refused_for_free(
    db_session: AsyncSession,
    user_id: int,
    before_wallet: tuple[int, int],
    before_audit: int,
) -> None:
    """Nothing about the account changed: no charge, no audit, no slot, no usage, no note."""
    assert await wallet(db_session, user_id) == before_wallet
    assert await count_rows(db_session, WalletAudit) == before_audit
    assert await count_rows(db_session, GenerationSlot) == 0
    assert await count_rows(db_session, LLMUsageLog) == 0
    assert await stub_text_rows(db_session) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("route", _ROUTES)
async def test_stub_server_refuses_every_ai_route_with_key_required(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    """A deployment with no real provider answers 402 ``llm_key_required``, never canned text."""
    disarm_stub_seam(monkeypatch)
    minute = record_minute_bucket(monkeypatch)
    admitted = record_admission(monkeypatch)
    headers, user_id, _ = await signup(async_client, f"stub_{route}")
    before_wallet = await wallet(db_session, user_id)
    before_audit = await count_rows(db_session, WalletAudit)

    resp = await _call_route(route, async_client, db_session, headers, user_id)

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json() == {"detail": KEY_REQUIRED}
    assert admitted == []
    if route in _MINUTE_BUCKET_ROUTES:
        assert minute == []
    await _assert_refused_for_free(db_session, user_id, before_wallet, before_audit)


@pytest.mark.asyncio
@pytest.mark.parametrize("route", _ROUTES)
async def test_empty_wallet_without_a_key_is_refused_before_any_slot(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    """No credits and no key: 402 before the minute bucket, the slot, the wallet or a dial."""
    configure_server_provider(monkeypatch)
    stub = arm_anthropic(monkeypatch)
    minute = record_minute_bucket(monkeypatch)
    admitted = record_admission(monkeypatch)
    headers, user_id, _ = await signup(async_client, f"empty_{route}")
    await empty_wallet(db_session, monkeypatch, user_id)
    before_wallet = await wallet(db_session, user_id)
    before_audit = await count_rows(db_session, WalletAudit)

    resp = await _call_route(route, async_client, db_session, headers, user_id)

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json() == {"detail": CREDITS_OR_KEY_REQUIRED}
    assert admitted == []
    assert stub.request_count == 0
    if route in _MINUTE_BUCKET_ROUTES:
        assert minute == []
    await _assert_refused_for_free(db_session, user_id, before_wallet, before_audit)


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["resonance", "essay", "detect"])
async def test_a_personal_key_proceeds_on_a_stub_server_with_an_empty_wallet(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    """With a key, generation proceeds as today: it reaches the key's own provider."""
    disarm_stub_seam(monkeypatch)
    stub = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, f"byok_{route}")
    await empty_wallet(db_session, monkeypatch, user_id)
    before_wallet = await wallet(db_session, user_id)

    resp = await _call_route(
        route, async_client, db_session, {**headers, "X-LLM-API-Key": ANTHROPIC_KEY}, user_id
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert stub.request_count >= 1
    assert await wallet(db_session, user_id) == before_wallet
    assert await stub_text_rows(db_session) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["resonance", "essay", "detect"])
async def test_credits_on_a_real_provider_proceed_as_today(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    """With credits and a configured server provider, the route dials as it always has."""
    configure_server_provider(monkeypatch)
    stub = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, f"credits_{route}")

    resp = await _call_route(route, async_client, db_session, headers, user_id)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert stub.request_count >= 1
    usage = await db_session.execute(select(LLMUsageLog).where(col(LLMUsageLog.user_id) == user_id))
    assert all(row.provider != botmason.STUB_PROVIDER_NAME for row in usage.scalars().all())
