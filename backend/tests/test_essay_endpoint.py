"""Tests for the lazy essay-expansion endpoint (journal-resonance-06)."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.care import MEDICATION_GUARDRAIL
from models.journal_entry import JournalClassification, JournalEntry
from models.llm_usage_log import LLMUsageLog
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from models.wallet_audit import (
    REASON_REFUND_FAILED_ESSAY,
    REASON_REFUND_NO_ESSAY,
    REASON_SPEND_MONTHLY,
    REASON_SPEND_OFFERING,
    WalletAudit,
)
from routers import journal as journal_router
from services import botmason as botmason_service
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, STUB_PROSE_PREFIX, LLMResponse
from services.usage import DEFAULT_MONTHLY_CAP

_BODY = "I walked by the river and the willow bent without breaking."
# The explicit ask a client sends once the writer has seen a letter's price.
_PRICED = {"price_acknowledged": True}


async def _signup(client: AsyncClient, username: str = "essay") -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    return {"Authorization": f"Bearer {payload['token']}"}, int(payload["user_id"])


async def _seed_marginalia(session: AsyncSession, user_id: int, *, body: str = _BODY) -> int:
    entry = JournalEntry(sender="user", user_id=user_id, message=body)
    session.add(entry)
    await session.flush()
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=6,
        anchor_text="I walk",
        note="A beginning.",
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    return note.id


class _CountingLLM:
    """Patches the LLM seam, returning fixed text and counting calls."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.calls = 0

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        self.calls += 1
        return LLMResponse(
            text=self.text,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


@pytest.mark.asyncio
async def test_legacy_empty_entry_refuses_essay_expansion_before_provider_contact(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pre-fix empty parent cannot become input to a later expanded reflection."""
    headers, user_id = await _signup(async_client, "legacy_empty_essay")
    marg_id = await _seed_marginalia(db_session, user_id, body="")
    fake = _CountingLLM("This must never be generated.")
    monkeypatch.setattr(marginalia_service, "generate_response", fake)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json() == {"detail": "journal_message_empty"}
    assert fake.calls == 0


@pytest.mark.asyncio
async def test_essay_generates_then_caches(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """First call generates + caches; the second returns it without a new LLM call."""
    headers, user_id = await _signup(async_client)
    marg_id = await _seed_marginalia(db_session, user_id)
    fake = _CountingLLM("A warm letter about beginnings.")
    monkeypatch.setattr(marginalia_service, "generate_response", fake)

    first = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )
    assert first.status_code == HTTPStatus.OK
    body = first.json()
    assert body["essay"] == "A warm letter about beginnings."
    assert body["essay_generated_at"] is not None
    assert "user_id" not in body
    assert fake.calls == 1

    async def _must_not_recache(*_args: object, **_kwargs: object) -> Marginalia:
        raise AssertionError("a cached essay reached the cache-and-commit seam")

    monkeypatch.setattr(journal_router, "_cache_essay", _must_not_recache)
    second = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert second.status_code == HTTPStatus.OK
    assert second.json()["essay"] == "A warm letter about beginnings."
    assert fake.calls == 1  # cached — no second LLM call


@pytest.mark.asyncio
async def test_essay_other_users_marginalia_is_404(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A user can't expand another user's margin note."""
    _alice_headers, alice_id = await _signup(async_client, "alice_e")
    bob_headers, _bob_id = await _signup(async_client, "bob_e")
    marg_id = await _seed_marginalia(db_session, alice_id)
    monkeypatch.setattr(marginalia_service, "generate_response", _CountingLLM("x"))
    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=bob_headers, json=_PRICED
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_essay_is_sanitized_and_length_capped(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stored essay is sanitized and capped to the column limit."""
    headers, user_id = await _signup(async_client, "cap")
    marg_id = await _seed_marginalia(db_session, user_id)
    # Oversized text with an embedded zero-width space.
    monkeypatch.setattr(
        marginalia_service, "generate_response", _CountingLLM("clean\u200bword " + "x" * 20000)
    )
    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )
    assert resp.status_code == HTTPStatus.OK
    essay = resp.json()["essay"]
    assert len(essay) <= 10_000
    assert "\u200b" not in essay


# --- The essay economy (#623): one unit for a first letter, reopening free --


async def _wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """Return ``(monthly_messages_used, offering_balance)`` read fresh from the row."""
    session.expire_all()
    user = await session.get(User, user_id)
    assert user is not None
    return user.monthly_messages_used, user.offering_balance


async def _audit_reasons(session: AsyncSession, user_id: int) -> list[str]:
    """Every wallet audit reason written for ``user_id``, oldest first."""
    result = await session.execute(
        select(WalletAudit.reason)
        .where(col(WalletAudit.user_id) == user_id)
        .order_by(col(WalletAudit.id))
    )
    return list(result.scalars())


async def _usage_rows(session: AsyncSession, user_id: int) -> int:
    """How many LLM usage rows the ledger holds for ``user_id``."""
    result = await session.execute(
        select(LLMUsageLog.id).where(col(LLMUsageLog.user_id) == user_id)
    )
    return len(list(result.scalars()))


@pytest.mark.asyncio
async def test_first_server_paid_essay_spends_one_unit_and_cached_reopen_is_free(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ratified economy: the first letter costs one unit, reopening it costs nothing."""
    headers, user_id = await _signup(async_client, "priced_essay")
    marg_id = await _seed_marginalia(db_session, user_id)
    fake = _CountingLLM("A warm letter about beginnings.")
    monkeypatch.setattr(marginalia_service, "generate_response", fake)
    baseline_used, baseline_balance = await _wallet(db_session, user_id)

    first = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert first.status_code == HTTPStatus.OK, first.text
    assert first.json()["essay"] == "A warm letter about beginnings."
    assert await _wallet(db_session, user_id) == (baseline_used + 1, baseline_balance)
    assert await _audit_reasons(db_session, user_id) == [REASON_SPEND_MONTHLY]
    assert first.json()["remaining_messages"] == DEFAULT_MONTHLY_CAP - (baseline_used + 1)
    assert first.json()["remaining_balance"] == baseline_balance
    assert first.json()["monthly_reset_date"] is not None
    usage_after_first = await _usage_rows(db_session, user_id)

    second = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert second.status_code == HTTPStatus.OK, second.text
    assert second.json()["essay"] == "A warm letter about beginnings."
    assert second.json()["remaining_messages"] == DEFAULT_MONTHLY_CAP - (baseline_used + 1)
    assert await _wallet(db_session, user_id) == (baseline_used + 1, baseline_balance)
    assert await _audit_reasons(db_session, user_id) == [REASON_SPEND_MONTHLY]
    assert await _usage_rows(db_session, user_id) == usage_after_first
    assert fake.calls == 1


# --- A permanently exhausted balance is not a transient outage --------------

_BYOK_HEADER = "X-LLM-API-Key"
_BYOK_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret
_PROVIDER_PROSE = (
    "Error code: 429 - You exceeded your current quota, please check your plan and billing details."
)


def _refuse_for_credit(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch the essay LLM seam to refuse the way an empty account does."""

    async def _refuse(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> None:
        del prompt, history, system_prompt, api_key
        raise botmason_service.LLMCreditExhaustedError(_PROVIDER_PROSE, provider="openai")

    monkeypatch.setattr(marginalia_service, "generate_response", _refuse)


async def _assert_no_essay_cached(session: AsyncSession, marg_id: int) -> None:
    """A refused pass leaves both the note and its usage ledger exactly as they were."""
    note = await session.get(Marginalia, marg_id)
    assert note is not None
    await session.refresh(note)
    assert note.essay is None
    assert note.essay_generated_at is None
    result = await session.execute(
        select(LLMUsageLog).where(col(LLMUsageLog.journal_entry_id) == note.journal_entry_id)
    )
    assert list(result.scalars()) == []


@pytest.mark.asyncio
async def test_essay_provider_error_is_502_without_partial_writes(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A transient provider failure crosses the release boundary without persisting state."""

    async def _fail(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> None:
        del prompt, history, system_prompt, api_key
        raise botmason_service.LLMProviderError("provider down")

    monkeypatch.setattr(marginalia_service, "generate_response", _fail)
    headers, user_id = await _signup(async_client, "essay_provider")
    marg_id = await _seed_marginalia(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.BAD_GATEWAY, resp.text
    assert resp.json()["detail"] == "llm_provider_error"
    await _assert_no_essay_cached(db_session, marg_id)


@pytest.mark.asyncio
async def test_essay_byok_credit_exhausted_is_402(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The essay path is a second door onto the same provider -- and the same refusal."""
    _refuse_for_credit(monkeypatch)
    headers, user_id = await _signup(async_client, "essay_byok")
    marg_id = await _seed_marginalia(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay",
        headers={**headers, _BYOK_HEADER: _BYOK_KEY},
    )

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json()["detail"] == "llm_credit_exhausted"
    await _assert_no_essay_cached(db_session, marg_id)


@pytest.mark.asyncio
async def test_essay_server_key_credit_exhausted_is_503(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A spent server key on the essay path gets the operator's code, not the reader's."""
    _refuse_for_credit(monkeypatch)
    headers, user_id = await _signup(async_client, "essay_server")
    marg_id = await _seed_marginalia(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE, resp.text
    assert resp.json()["detail"] == "llm_service_credit_exhausted"
    await _assert_no_essay_cached(db_session, marg_id)


# --- A completion that is not a letter is refused, not published (#2762) ----


class _EchoingLLM:
    """Patches the LLM seam the way the stub provider used to behave.

    It answers every prompt with that prompt, wrapped in the stub's canned
    sentence -- the exact string the reporter was shown as their letter.
    """

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del history, system_prompt, api_key
        self.calls += 1
        return LLMResponse(
            text=f'{STUB_PROSE_PREFIX} "{prompt}" — Let the Archetypal Wavelength guide you.',
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


@pytest.mark.asyncio
async def test_stub_provider_essay_is_a_letter_not_the_prompt(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The default provider, unpatched, end to end -- the regression that matters.

    Deliberately no monkeypatch on the LLM seam: every other test here injects a
    fake that returns well-formed prose, which is exactly why nobody looked at
    what the documented default (``BOTMASON_PROVIDER`` unset -> ``stub``) hands
    the writer. It handed them the prompt.
    """
    headers, user_id = await _signup(async_client, "stub_letter")
    marg_id = await _seed_marginalia(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    essay = resp.json()["essay"]
    assert essay is not None
    assert MEDICATION_GUARDRAIL not in essay
    assert "<entry>" not in essay
    assert STUB_PROSE_PREFIX not in essay


@pytest.mark.asyncio
async def test_an_echoed_prompt_is_refused_and_never_cached(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Any provider that echoes is refused -- the stub is only the reliable one.

    The writer gets the existing no-letter state (a note with no essay, the same
    shape the privacy floor returns), not the prompt and not an error blaming
    them. Nothing is cached, so asking again later is still possible.
    """
    echo = _EchoingLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", echo)
    headers, user_id = await _signup(async_client, "echo_refused")
    marg_id = await _seed_marginalia(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["essay"] is None
    assert resp.json()["essay_generated_at"] is None
    await _assert_no_essay_cached(db_session, marg_id)
    assert echo.calls == 1


@pytest.mark.asyncio
async def test_a_refused_essay_can_be_asked_for_again_and_then_succeeds(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Not caching the refusal is what makes the second ask reach the provider."""
    monkeypatch.setattr(marginalia_service, "generate_response", _EchoingLLM())
    headers, user_id = await _signup(async_client, "echo_retry")
    marg_id = await _seed_marginalia(db_session, user_id)
    refused = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )
    assert refused.json()["essay"] is None

    recovered = _CountingLLM("A warm letter about beginnings.")
    monkeypatch.setattr(marginalia_service, "generate_response", recovered)
    retry = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert retry.status_code == HTTPStatus.OK, retry.text
    assert retry.json()["essay"] == "A warm letter about beginnings."
    assert recovered.calls == 1


@pytest.mark.asyncio
async def test_a_letter_quoting_the_writer_is_published(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guard's one real risk, pinned: quoting the writer is what a letter does."""
    letter = (
        "You wrote, \u201cI walked by the river and the willow bent without breaking,\u201d "
        "and then moved straight past it. Stand there a moment longer."
    )
    monkeypatch.setattr(marginalia_service, "generate_response", _CountingLLM(letter))
    headers, user_id = await _signup(async_client, "quoting")
    marg_id = await _seed_marginalia(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["essay"] == letter


@pytest.mark.asyncio
async def test_a_blank_completion_is_not_cached_as_a_letter(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty essay is not a letter, and caching one strands the note forever."""
    monkeypatch.setattr(marginalia_service, "generate_response", _CountingLLM("   \n  "))
    headers, user_id = await _signup(async_client, "blank_essay")
    marg_id = await _seed_marginalia(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["essay"] is None
    await _assert_no_essay_cached(db_session, marg_id)


@pytest.mark.asyncio
async def test_the_resonance_adapter_sends_its_own_system_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The adapter's docstring and its call agree about the system role.

    ``generate_response`` reads ``system_prompt=None`` as "use the BotMason chat
    persona", so passing ``None`` shipped the chat persona -- operator-swappable
    via ``BOTMASON_SYSTEM_PROMPT`` -- into a task that deliberately is not chat.
    """
    seen: dict[str, object] = {}

    async def _capture(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, api_key
        seen["system_prompt"] = system_prompt
        return LLMResponse(
            text="ok",
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _capture)

    assert await marginalia_service.BotmasonResonanceLLM(None).complete("hello") == "ok"
    assert seen["system_prompt"] == marginalia_service.RESONANCE_SYSTEM_PROMPT
    assert seen["system_prompt"] != botmason_service.get_system_prompt()


# --- Essay economy (#623): the acknowledgement, the refund matrix, balances --

_METERED_PROVIDER = "anthropic"
_METERED_MODEL = "claude-sonnet-5"
_METERED_TOKENS = 100
_LETTER = "A warm letter about beginnings."
_OFFERINGS = 3


class _MeteredLLM:
    """Answers with fixed text carrying real token counts, so it is metered."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.calls = 0

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        self.calls += 1
        return LLMResponse(
            text=self.text,
            provider=_METERED_PROVIDER,
            model=_METERED_MODEL,
            prompt_tokens=_METERED_TOKENS,
            completion_tokens=_METERED_TOKENS,
        )


async def _set_wallet(session: AsyncSession, user_id: int, *, used: int, balance: int) -> None:
    """Put the user's two wallet buckets at exact values."""
    user = await session.get(User, user_id)
    assert user is not None
    user.monthly_messages_used = used
    user.offering_balance = balance
    session.add(user)
    await session.commit()


def _essay_path(marg_id: int) -> str:
    return f"/journal/marginalia/{marg_id}/essay"


@pytest.mark.asyncio
async def test_unacknowledged_server_paid_essay_is_409_and_uncharged(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A client that asks on open without showing the price is refused, not billed."""
    headers, user_id = await _signup(async_client, "unacked")
    marg_id = await _seed_marginalia(db_session, user_id)
    fake = _CountingLLM(_LETTER)
    monkeypatch.setattr(marginalia_service, "generate_response", fake)
    before = await _wallet(db_session, user_id)

    bare = await async_client.post(_essay_path(marg_id), headers=headers)
    declined = await async_client.post(
        _essay_path(marg_id), headers=headers, json={"price_acknowledged": False}
    )

    for resp in (bare, declined):
        assert resp.status_code == HTTPStatus.CONFLICT, resp.text
        assert resp.json() == {"detail": journal_router.ESSAY_PRICE_UNACKNOWLEDGED}
    assert journal_router.ESSAY_PRICE_UNACKNOWLEDGED == "essay_price_unacknowledged"
    assert fake.calls == 0
    assert await _wallet(db_session, user_id) == before
    assert await _audit_reasons(db_session, user_id) == []


@pytest.mark.asyncio
async def test_byok_essay_is_never_charged_and_needs_no_acknowledgement(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The caller's own key pays its provider, so the wallet is never touched."""
    headers, user_id = await _signup(async_client, "byok_free")
    marg_id = await _seed_marginalia(db_session, user_id)
    fake = _CountingLLM(_LETTER)
    monkeypatch.setattr(marginalia_service, "generate_response", fake)
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        _essay_path(marg_id), headers={**headers, _BYOK_HEADER: _BYOK_KEY}
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["essay"] == _LETTER
    assert fake.calls == 1
    assert await _wallet(db_session, user_id) == before
    assert await _audit_reasons(db_session, user_id) == []
    assert resp.json()["remaining_messages"] == DEFAULT_MONTHLY_CAP - before[0]


@pytest.mark.asyncio
async def test_cached_essay_reopens_without_acknowledgement_or_charge(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reopening a letter the writer already paid for asks for nothing."""
    headers, user_id = await _signup(async_client, "cached_bare")
    marg_id = await _seed_marginalia(db_session, user_id)
    monkeypatch.setattr(marginalia_service, "generate_response", _CountingLLM(_LETTER))
    await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)
    after_first = await _wallet(db_session, user_id)

    reopened = await async_client.post(_essay_path(marg_id), headers=headers)

    assert reopened.status_code == HTTPStatus.OK, reopened.text
    assert reopened.json()["essay"] == _LETTER
    assert await _wallet(db_session, user_id) == after_first
    assert await _audit_reasons(db_session, user_id) == [REASON_SPEND_MONTHLY]


@pytest.mark.asyncio
async def test_intimate_essay_is_never_charged_and_never_dialled(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The privacy floor returns before the price gate and before any charge."""
    headers, user_id = await _signup(async_client, "intimate_free")
    marg_id = await _seed_marginalia(db_session, user_id)
    note = await db_session.get(Marginalia, marg_id)
    assert note is not None
    entry = await db_session.get(JournalEntry, note.journal_entry_id)
    assert entry is not None
    entry.classification = JournalClassification.INTIMATE
    db_session.add(entry)
    await db_session.commit()
    fake = _CountingLLM(_LETTER)
    monkeypatch.setattr(marginalia_service, "generate_response", fake)
    before = await _wallet(db_session, user_id)

    for body in (None, _PRICED):
        resp = await async_client.post(_essay_path(marg_id), headers=headers, json=body)
        assert resp.status_code == HTTPStatus.OK, resp.text
        assert resp.json()["essay"] is None

    assert fake.calls == 0
    assert await _wallet(db_session, user_id) == before
    assert await _audit_reasons(db_session, user_id) == []


@pytest.mark.asyncio
async def test_cross_tenant_essay_is_404_charges_nobody_and_writes_nothing(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Charging stays scoped by ``Marginalia.user_id``: a foreign note bills no one."""
    _alice_headers, alice_id = await _signup(async_client, "alice_priced")
    bob_headers, bob_id = await _signup(async_client, "bob_priced")
    marg_id = await _seed_marginalia(db_session, alice_id)
    fake = _CountingLLM(_LETTER)
    monkeypatch.setattr(marginalia_service, "generate_response", fake)
    alice_before = await _wallet(db_session, alice_id)
    bob_before = await _wallet(db_session, bob_id)

    resp = await async_client.post(_essay_path(marg_id), headers=bob_headers, json=_PRICED)

    assert resp.status_code == HTTPStatus.NOT_FOUND, resp.text
    assert fake.calls == 0
    assert await _wallet(db_session, alice_id) == alice_before
    assert await _wallet(db_session, bob_id) == bob_before
    assert await _audit_reasons(db_session, alice_id) == []
    assert await _audit_reasons(db_session, bob_id) == []
    assert await _usage_rows(db_session, alice_id) == 0
    assert await _usage_rows(db_session, bob_id) == 0
    note = await db_session.get(Marginalia, marg_id)
    assert note is not None
    await db_session.refresh(note)
    assert note.essay is None


@pytest.mark.asyncio
async def test_empty_wallet_essay_is_402_before_provider(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The wallet hard stop: nothing to spend means no dial and no usage row."""
    headers, user_id = await _signup(async_client, "empty_wallet")
    marg_id = await _seed_marginalia(db_session, user_id)
    await _set_wallet(db_session, user_id, used=DEFAULT_MONTHLY_CAP, balance=0)
    fake = _MeteredLLM(_LETTER)
    monkeypatch.setattr(marginalia_service, "generate_response", fake)

    resp = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json() == {"detail": "insufficient_offerings"}
    assert fake.calls == 0
    assert await _usage_rows(db_session, user_id) == 0
    assert await _wallet(db_session, user_id) == (DEFAULT_MONTHLY_CAP, 0)
    assert await _audit_reasons(db_session, user_id) == []


@pytest.mark.asyncio
async def test_essay_spends_an_offering_once_the_month_is_used_up(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one wallet: monthly first, then the purchased balance."""
    headers, user_id = await _signup(async_client, "offering_spend")
    marg_id = await _seed_marginalia(db_session, user_id)
    await _set_wallet(db_session, user_id, used=DEFAULT_MONTHLY_CAP, balance=_OFFERINGS)
    monkeypatch.setattr(marginalia_service, "generate_response", _CountingLLM(_LETTER))

    resp = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert await _wallet(db_session, user_id) == (DEFAULT_MONTHLY_CAP, _OFFERINGS - 1)
    assert await _audit_reasons(db_session, user_id) == [REASON_SPEND_OFFERING]
    assert resp.json()["remaining_messages"] == 0
    assert resp.json()["remaining_balance"] == _OFFERINGS - 1


def _fail_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch the essay LLM seam to fail the way a transient outage does."""

    async def _fail(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> None:
        del prompt, history, system_prompt, api_key
        raise botmason_service.LLMProviderError("provider down")

    monkeypatch.setattr(marginalia_service, "generate_response", _fail)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("break_provider", "status"),
    [
        (_fail_provider, HTTPStatus.BAD_GATEWAY),
        (_refuse_for_credit, HTTPStatus.SERVICE_UNAVAILABLE),
    ],
)
async def test_failed_server_paid_essay_is_refunded(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    break_provider: object,
    status: HTTPStatus,
) -> None:
    """A provider error or a spent server key hands the reserved unit back."""
    assert callable(break_provider)
    break_provider(monkeypatch)
    headers, user_id = await _signup(async_client, f"failed_{status.value}")
    marg_id = await _seed_marginalia(db_session, user_id)
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)

    assert resp.status_code == status, resp.text
    assert await _wallet(db_session, user_id) == before
    assert await _audit_reasons(db_session, user_id) == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_FAILED_ESSAY,
    ]


@pytest.mark.asyncio
async def test_byok_credit_exhausted_essay_charges_nothing(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A spent BYOK key was never our charge, so there is nothing to refund."""
    _refuse_for_credit(monkeypatch)
    headers, user_id = await _signup(async_client, "byok_spent")
    marg_id = await _seed_marginalia(db_session, user_id)
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        _essay_path(marg_id), headers={**headers, _BYOK_HEADER: _BYOK_KEY}
    )

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert await _wallet(db_session, user_id) == before
    assert await _audit_reasons(db_session, user_id) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("completion", ["   \n  ", "ECHO"])
async def test_refused_essay_refunds(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    completion: str,
) -> None:
    """A blank or echoed completion is no letter, so its unit comes back."""
    llm = _EchoingLLM() if completion == "ECHO" else _CountingLLM(completion)
    monkeypatch.setattr(marginalia_service, "generate_response", llm)
    headers, user_id = await _signup(async_client, f"refused_{len(completion)}")
    marg_id = await _seed_marginalia(db_session, user_id)
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["essay"] is None
    assert resp.json()["remaining_messages"] == DEFAULT_MONTHLY_CAP - before[0]
    assert await _wallet(db_session, user_id) == before
    assert await _audit_reasons(db_session, user_id) == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_NO_ESSAY,
    ]


@pytest.mark.asyncio
async def test_refused_essay_is_still_metered(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The refund must not roll back the record of what the provider charged us."""
    monkeypatch.setattr(marginalia_service, "generate_response", _MeteredLLM("   "))
    headers, user_id = await _signup(async_client, "refused_metered")
    marg_id = await _seed_marginalia(db_session, user_id)
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert await _usage_rows(db_session, user_id) == 1
    assert await _wallet(db_session, user_id) == before
    assert await _audit_reasons(db_session, user_id) == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_NO_ESSAY,
    ]


@pytest.mark.asyncio
async def test_refused_essay_refunds_an_offering_into_the_offering_bucket(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A paid credit comes back as a paid credit, never as a free monthly slot."""
    headers, user_id = await _signup(async_client, "refused_offering")
    marg_id = await _seed_marginalia(db_session, user_id)
    await _set_wallet(db_session, user_id, used=DEFAULT_MONTHLY_CAP, balance=_OFFERINGS)
    monkeypatch.setattr(marginalia_service, "generate_response", _CountingLLM(" "))

    resp = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert await _wallet(db_session, user_id) == (DEFAULT_MONTHLY_CAP, _OFFERINGS)
    assert await _audit_reasons(db_session, user_id) == [
        REASON_SPEND_OFFERING,
        REASON_REFUND_NO_ESSAY,
    ]


@pytest.mark.asyncio
async def test_refused_then_landed_letter_nets_exactly_one_charge(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each attempt charges once and a refusal refunds once: never a double charge."""
    headers, user_id = await _signup(async_client, "retry_nets_one")
    marg_id = await _seed_marginalia(db_session, user_id)
    before_used, before_balance = await _wallet(db_session, user_id)
    monkeypatch.setattr(marginalia_service, "generate_response", _EchoingLLM())
    await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)
    monkeypatch.setattr(marginalia_service, "generate_response", _CountingLLM(_LETTER))

    landed = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)

    assert landed.json()["essay"] == _LETTER
    assert await _wallet(db_session, user_id) == (before_used + 1, before_balance)
    assert await _audit_reasons(db_session, user_id) == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_NO_ESSAY,
        REASON_SPEND_MONTHLY,
    ]


@pytest.mark.asyncio
async def test_unexpected_failure_after_charge_is_refunded(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A write that fails after the dial must not keep the writer's unit."""
    monkeypatch.setattr(marginalia_service, "generate_response", _CountingLLM(_LETTER))

    async def _broken_ledger(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(journal_router, "record_llm_usage", _broken_ledger)
    headers, user_id = await _signup(async_client, "late_failure")
    marg_id = await _seed_marginalia(db_session, user_id)
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)

    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR, resp.text
    assert await _wallet(db_session, user_id) == before
    assert await _audit_reasons(db_session, user_id) == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_FAILED_ESSAY,
    ]


@pytest.mark.asyncio
async def test_essay_response_carries_balances(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The last monthly unit leaves exactly zero, and an over-cap counter never goes negative."""
    headers, user_id = await _signup(async_client, "balances")
    marg_id = await _seed_marginalia(db_session, user_id)
    await _set_wallet(db_session, user_id, used=DEFAULT_MONTHLY_CAP - 1, balance=_OFFERINGS)
    monkeypatch.setattr(marginalia_service, "generate_response", _CountingLLM(_LETTER))

    last_slot = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)

    assert last_slot.json()["remaining_messages"] == 0
    assert last_slot.json()["remaining_balance"] == _OFFERINGS
    user = await db_session.get(User, user_id)
    assert user is not None
    assert last_slot.json()["monthly_reset_date"].startswith(
        user.monthly_reset_date.date().isoformat()
    )
    # An operator lowering the cap below what was already used reports zero.
    await _set_wallet(db_session, user_id, used=DEFAULT_MONTHLY_CAP + 1, balance=_OFFERINGS)
    reopened = await async_client.post(_essay_path(marg_id), headers=headers)
    assert reopened.json()["remaining_messages"] == 0


def test_essay_costs_one_wallet_unit() -> None:
    """The ratified price (#623): one unit per first letter, the wallet's only unit."""
    assert journal_router.ESSAY_PRICE_UNITS == 1
