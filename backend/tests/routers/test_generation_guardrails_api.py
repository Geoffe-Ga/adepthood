"""The per-user generation guardrails, end to end through the routes (#623).

Decision record §1 (owner, 2026-09-05): "enforce generation limits per
authenticated user, not only per IP; maximum **5 LLM generations/minute/user**;
maximum **2 concurrent generations/user**; configurable launch ceiling of
**100 charged generations/day/user**; preserve idempotency/caching and the
wallet hard-stop".

Every refusal here must cost nothing and reach no provider, and every free
path (a cached letter, an intimate entry, a 404, a 402, a 409 price gate) must
spend nothing from the minute bucket.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, func, select

from domain.creek_vault import CreekVaultCareEscalationError
from domain.dates import utc_day_start
from models.generation_slot import GenerationSlot
from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from models.wallet_audit import WalletAudit
from routers import journal as journal_router
from routers import transcription as transcription_router
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMProviderError, LLMResponse
from services.generation_guardrails import (
    GENERATION_IN_PROGRESS,
    GENERATION_IN_PROGRESS_RETRY_AFTER_SECONDS,
    GENERATIONS_PER_MINUTE_PER_USER,
    MAX_CONCURRENT_GENERATIONS_PER_USER,
)
from services.usage import DAILY_GENERATION_CEILING_ENV, get_monthly_cap
from services.wallet import DAILY_GENERATION_LIMIT_REACHED, net_charged_generations_since
from tests.transcription_helpers import JPEG_BYTES, payload

_BODY = "I walked by the river and the willow bent without breaking."
_NOTES = json.dumps(
    {"notes": [{"kind": "theme", "quote": "I walked by the river", "note": "Water again."}]}
)
_PRICED = {"price_acknowledged": True}
_BYOK = {"X-LLM-API-Key": "sk-abcdef1234567890abcdef1234567890"}  # pragma: allowlist secret
_TRANSCRIBED = "A page of handwriting, transcribed faithfully into text."
_TRANSCRIBE = "/journal/transcribe-page"
_REOPENS = 10
# The refused requests' own entry, distinct so a failure names which one dialled.
_REFUSED_BODY = "Refused: I walked by the river and the willow bent without breaking."
_SETTLE_SECONDS = 20.0
_POLL_SECONDS = 0.02
# Resonance, essay and transcription: the three charged generations.
_CHARGED_ROUTES = 3
# The longest honest wait until the next UTC midnight.
_SECONDS_PER_DAY = 86_400


class _Provider:
    """The marginalia/essay seam: counts dials and can hold them open."""

    def __init__(self) -> None:
        self.calls = 0
        self.gate: asyncio.Event | None = None

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        self.calls += 1
        if self.gate is not None:
            await self.gate.wait()
        return LLMResponse(
            text=_NOTES,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


class _Transcriber:
    """The transcription seam: counts dials and answers usable page text."""

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, *_args: object, **_kwargs: object) -> LLMResponse:
        self.calls += 1
        return LLMResponse(
            text=_TRANSCRIBED,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> _Provider:
    """Patch the resonance and essay LLM seam."""
    fake = _Provider()
    monkeypatch.setattr(marginalia_service, "generate_response", fake)
    return fake


@pytest.fixture
def transcriber(monkeypatch: pytest.MonkeyPatch) -> _Transcriber:
    """Patch the transcription LLM seam."""
    fake = _Transcriber()
    monkeypatch.setattr(transcription_router, "generate_response", fake)
    return fake


async def _signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{name}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _entry(
    session: AsyncSession,
    user_id: int,
    classification: JournalClassification = JournalClassification.PERSONAL,
    body: str = _BODY,
) -> int:
    entry = JournalEntry(
        sender="user", user_id=user_id, message=body, classification=classification
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    assert entry.id is not None
    return entry.id


async def _note(
    session: AsyncSession,
    user_id: int,
    classification: JournalClassification = JournalClassification.PERSONAL,
    body: str = _BODY,
) -> int:
    entry_id = await _entry(session, user_id, classification, body)
    note = Marginalia(
        journal_entry_id=entry_id,
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


async def _wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    await session.rollback()
    session.expire_all()
    user = await session.get(User, user_id)
    assert user is not None
    return user.monthly_messages_used, user.offering_balance


async def _audit_rows(session: AsyncSession, user_id: int) -> int:
    await session.rollback()
    result = await session.execute(
        select(func.count()).select_from(WalletAudit).where(col(WalletAudit.user_id) == user_id)
    )
    return int(result.scalar_one())


async def _leases(session: AsyncSession) -> int:
    await session.rollback()
    result = await session.execute(select(func.count()).select_from(GenerationSlot))
    return int(result.scalar_one())


async def _resonate(client: AsyncClient, headers: dict[str, str], entry_id: int) -> Response:
    return await client.post(f"/journal/{entry_id}/resonance", headers=headers)


async def _essay(
    client: AsyncClient, headers: dict[str, str], note_id: int, body: dict[str, bool] | None = None
) -> Response:
    return await client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json=body or _PRICED
    )


async def _spend_the_minute(
    client: AsyncClient, session: AsyncSession, headers: dict[str, str], user_id: int
) -> None:
    """Five admitted generations, mixed across the two routes."""
    for index in range(GENERATIONS_PER_MINUTE_PER_USER):
        if index % 2:
            resp = await _essay(client, headers, await _note(session, user_id))
        else:
            resp = await _resonate(client, headers, await _entry(session, user_id))
        assert resp.status_code == HTTPStatus.OK, resp.text


def _assert_minute_refusal(resp: Response) -> None:
    assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS, resp.text
    assert resp.json() == {"detail": "rate_limit_exceeded"}
    assert int(resp.headers["Retry-After"]) >= 1


# --- the minute bucket ------------------------------------------------------------


@pytest.mark.asyncio
async def test_sixth_mixed_generation_in_a_minute_is_refused_and_costs_nothing(
    async_client: AsyncClient, db_session: AsyncSession, provider: _Provider
) -> None:
    """5 admitted across resonance and essay; the 6th is 429, uncharged and undialled."""
    headers, user_id = await _signup(async_client, "minute")
    await _spend_the_minute(async_client, db_session, headers, user_id)
    entry_id = await _entry(db_session, user_id)
    note_id = await _note(db_session, user_id)
    calls = provider.calls
    wallet = await _wallet(db_session, user_id)
    rows = await _audit_rows(db_session, user_id)

    _assert_minute_refusal(await _resonate(async_client, headers, entry_id))
    _assert_minute_refusal(await _essay(async_client, headers, note_id))

    assert provider.calls == calls
    assert await _wallet(db_session, user_id) == wallet
    assert await _audit_rows(db_session, user_id) == rows
    assert await _leases(db_session) == 0


@pytest.mark.asyncio
async def test_a_second_user_behind_the_same_address_is_unaffected(
    async_client: AsyncClient, db_session: AsyncSession, provider: _Provider
) -> None:
    """The bucket is keyed on the user, not on the shared address."""
    del provider
    alice, alice_id = await _signup(async_client, "alice_minute")
    bob, bob_id = await _signup(async_client, "bob_minute")
    await _spend_the_minute(async_client, db_session, alice, alice_id)

    resp = await _resonate(async_client, bob, await _entry(db_session, bob_id))

    assert resp.status_code == HTTPStatus.OK, resp.text
    # Bob's answer reports Bob's own wallet: one spend of his own, none of Alice's.
    assert resp.json()["remaining_messages"] == get_monthly_cap() - 1


@pytest.mark.asyncio
async def test_the_bucket_follows_the_user_across_a_refresh_and_a_new_address(
    async_client: AsyncClient,
    db_session: AsyncSession,
    provider: _Provider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rotated token from a different address still spends the same budget."""
    del provider
    monkeypatch.setenv("TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
    headers, user_id = await _signup(async_client, "rotator")
    first_address = {**headers, "X-Forwarded-For": "203.0.113.7"}
    await _spend_the_minute(async_client, db_session, first_address, user_id)
    refreshed = await async_client.post("/auth/refresh", headers=headers)
    assert refreshed.status_code == HTTPStatus.OK, refreshed.text
    rotated = {
        "Authorization": f"Bearer {refreshed.json()['token']}",
        "X-Forwarded-For": "198.51.100.42",
    }
    assert rotated["Authorization"] != headers["Authorization"]

    _assert_minute_refusal(
        await _resonate(async_client, rotated, await _entry(db_session, user_id))
    )


@pytest.mark.asyncio
async def test_cached_letter_reopens_are_free_and_never_spend_the_bucket(
    async_client: AsyncClient,
    db_session: AsyncSession,
    provider: _Provider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ten reopens of a cached letter, then the full five generations still run.

    The letter is first asked for from one address and reopened from another:
    the route's unchanged per-address 10/minute limit counts every request,
    reopens included, and is not what this test is about.
    """
    monkeypatch.setenv("TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
    headers, user_id = await _signup(async_client, "reopener")
    note_id = await _note(db_session, user_id)
    assert (await _essay(async_client, headers, note_id)).status_code == HTTPStatus.OK
    calls = provider.calls
    elsewhere = {**headers, "X-Forwarded-For": "203.0.113.9"}

    for _ in range(_REOPENS):
        reopened = await _essay(async_client, elsewhere, note_id)
        assert reopened.status_code == HTTPStatus.OK
        assert reopened.json()["essay"] is not None
    assert provider.calls == calls

    # One generation (the first letter) is spent; four remain.
    for _ in range(GENERATIONS_PER_MINUTE_PER_USER - 1):
        resp = await _resonate(async_client, headers, await _entry(db_session, user_id))
        assert resp.status_code == HTTPStatus.OK, resp.text
    _assert_minute_refusal(
        await _resonate(async_client, headers, await _entry(db_session, user_id))
    )


@pytest.mark.asyncio
async def test_free_exits_never_spend_the_bucket(
    async_client: AsyncClient, db_session: AsyncSession, provider: _Provider
) -> None:
    """Intimate pass and letter, 404s, a 402 and a 409 price gate leave all five."""
    del provider
    headers, user_id = await _signup(async_client, "free_exits")
    intimate_entry = await _entry(db_session, user_id, JournalClassification.INTIMATE)
    intimate_note = await _note(db_session, user_id, JournalClassification.INTIMATE)
    unpriced_note = await _note(db_session, user_id)
    for _ in range(GENERATIONS_PER_MINUTE_PER_USER + 1):
        assert (await _resonate(async_client, headers, intimate_entry)).status_code == HTTPStatus.OK
        assert (await _essay(async_client, headers, intimate_note)).status_code == HTTPStatus.OK
        assert (await _resonate(async_client, headers, 999_999)).status_code == (
            HTTPStatus.NOT_FOUND
        )
        assert (await _essay(async_client, headers, 999_999)).status_code == HTTPStatus.NOT_FOUND
        unpriced = await _essay(async_client, headers, unpriced_note, {"price_acknowledged": False})
        assert unpriced.status_code == HTTPStatus.CONFLICT
    # An empty wallet: 402 before the atomic hit.
    user = await db_session.get(User, user_id)
    assert user is not None
    user.monthly_messages_used = get_monthly_cap()
    user.offering_balance = 0
    await db_session.commit()
    for _ in range(GENERATIONS_PER_MINUTE_PER_USER + 1):
        broke = await _resonate(async_client, headers, await _entry(db_session, user_id))
        assert broke.status_code == HTTPStatus.PAYMENT_REQUIRED, broke.text
    user = await db_session.get(User, user_id)
    assert user is not None
    user.monthly_messages_used = 0
    await db_session.commit()

    await _spend_the_minute(async_client, db_session, headers, user_id)
    _assert_minute_refusal(
        await _resonate(async_client, headers, await _entry(db_session, user_id))
    )


@pytest.mark.asyncio
async def test_byok_generations_spend_the_minute_bucket_too(
    async_client: AsyncClient, db_session: AsyncSession, provider: _Provider
) -> None:
    """It is a generation limit, not a charge limit."""
    del provider
    headers, user_id = await _signup(async_client, "byok_minute")
    byok = {**headers, **_BYOK}
    for _ in range(GENERATIONS_PER_MINUTE_PER_USER):
        resp = await _resonate(async_client, byok, await _entry(db_session, user_id))
        assert resp.status_code == HTTPStatus.OK, resp.text

    _assert_minute_refusal(await _resonate(async_client, byok, await _entry(db_session, user_id)))


@pytest.mark.asyncio
async def test_the_minute_bucket_does_not_reach_transcription(
    async_client: AsyncClient,
    db_session: AsyncSession,
    provider: _Provider,
    transcriber: _Transcriber,
) -> None:
    """Record §4 scopes the five to resonance and essay; a page keeps its own 20."""
    headers, user_id = await _signup(async_client, "pages")
    await _spend_the_minute(async_client, db_session, headers, user_id)
    del provider

    for _ in range(GENERATIONS_PER_MINUTE_PER_USER + 1):
        page = await async_client.post(_TRANSCRIBE, headers=headers, json=payload(JPEG_BYTES))
        assert page.status_code == HTTPStatus.OK, page.text
    assert transcriber.calls == GENERATIONS_PER_MINUTE_PER_USER + 1


def test_transcription_keeps_its_own_twenty_per_minute() -> None:
    """Unchanged: both transcription axes stay at 20/minute."""
    assert transcription_router.TRANSCRIBE_RATE_LIMIT == "20/minute"
    assert transcription_router.TRANSCRIBE_USER_RATE_LIMIT == "20/minute"


# --- the daily ceiling ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_each_server_paid_route_adds_one_to_the_daily_count(
    async_client: AsyncClient,
    db_session: AsyncSession,
    provider: _Provider,
    transcriber: _Transcriber,
) -> None:
    """Resonance, essay and transcription all draw on the same ceiling."""
    del provider, transcriber
    headers, user_id = await _signup(async_client, "counted")
    since = utc_day_start(datetime.now(UTC))

    assert (await _resonate(async_client, headers, await _entry(db_session, user_id))).is_success
    assert (await _essay(async_client, headers, await _note(db_session, user_id))).is_success
    page = await async_client.post(_TRANSCRIBE, headers=headers, json=payload(JPEG_BYTES))
    assert page.status_code == HTTPStatus.OK, page.text

    await db_session.rollback()
    assert await net_charged_generations_since(db_session, user_id, since) == _CHARGED_ROUTES


@pytest.mark.asyncio
async def test_daily_refusal_on_every_charged_route_costs_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    provider: _Provider,
    transcriber: _Transcriber,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """At the brake (0) every charged route is 429, undialled, with nothing written."""
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, "0")
    headers, user_id = await _signup(async_client, "braked")
    entry_id = await _entry(db_session, user_id)
    note_id = await _note(db_session, user_id)
    wallet = await _wallet(db_session, user_id)

    refusals = [
        await _resonate(async_client, headers, entry_id),
        await _essay(async_client, headers, note_id),
        await async_client.post(_TRANSCRIBE, headers=headers, json=payload(JPEG_BYTES)),
    ]

    for resp in refusals:
        assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS, resp.text
        assert resp.json() == {"detail": DAILY_GENERATION_LIMIT_REACHED}
        assert 1 <= int(resp.headers["Retry-After"]) <= _SECONDS_PER_DAY
    assert provider.calls == 0
    assert transcriber.calls == 0
    assert await _wallet(db_session, user_id) == wallet
    assert await _audit_rows(db_session, user_id) == 0
    assert await _leases(db_session) == 0
    # The daily refusal comes after the peek, before the atomic hit: the minute is unspent.
    monkeypatch.delenv(DAILY_GENERATION_CEILING_ENV)
    await _spend_the_minute(async_client, db_session, headers, user_id)


@pytest.mark.asyncio
async def test_byok_is_never_counted_against_the_daily_ceiling(
    async_client: AsyncClient,
    db_session: AsyncSession,
    provider: _Provider,
    transcriber: _Transcriber,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the brake on, a caller's own key still generates on all three routes."""
    del provider, transcriber
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, "0")
    headers, user_id = await _signup(async_client, "byok_daily")
    byok = {**headers, **_BYOK}

    assert (await _resonate(async_client, byok, await _entry(db_session, user_id))).is_success
    letter = await async_client.post(
        f"/journal/marginalia/{await _note(db_session, user_id)}/essay", headers=byok
    )
    assert letter.status_code == HTTPStatus.OK, letter.text
    page = await async_client.post(_TRANSCRIBE, headers=byok, json=payload(JPEG_BYTES))
    assert page.status_code == HTTPStatus.OK, page.text
    assert await _audit_rows(db_session, user_id) == 0


@pytest.mark.asyncio
async def test_one_users_exhausted_limits_never_touch_another(
    async_client: AsyncClient,
    db_session: AsyncSession,
    provider: _Provider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every key is the authenticated user's own; B never sees or spends A's buckets."""
    del provider
    alice, alice_id = await _signup(async_client, "alice_all")
    bob, bob_id = await _signup(async_client, "bob_all")
    await _spend_the_minute(async_client, db_session, alice, alice_id)
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, str(GENERATIONS_PER_MINUTE_PER_USER))

    bob_resp = await _resonate(async_client, bob, await _entry(db_session, bob_id))

    assert bob_resp.status_code == HTTPStatus.OK, bob_resp.text
    assert bob_resp.json()["remaining_messages"] == get_monthly_cap() - 1
    _assert_minute_refusal(await _resonate(async_client, alice, await _entry(db_session, alice_id)))


# --- the concurrent slot -----------------------------------------------------------------


async def _wait_for_leases(
    factory: async_sessionmaker[AsyncSession], expected: int, user_id: int
) -> None:
    async def _poll() -> None:
        while True:
            async with factory() as session:
                held = await session.execute(
                    select(func.count())
                    .select_from(GenerationSlot)
                    .where(col(GenerationSlot.user_id) == user_id)
                )
                if held.scalar_one() == expected:
                    return
            await asyncio.sleep(_POLL_SECONDS)

    await asyncio.wait_for(_poll(), _SETTLE_SECONDS)


async def _wait_until(
    factory: async_sessionmaker[AsyncSession], user_id: int, *, spends: int, provider: _Provider
) -> None:
    """Wait for ``spends`` committed audit rows and one parked provider dial."""

    async def _poll() -> None:
        while True:
            async with factory() as session:
                if await _audit_rows(session, user_id) == spends and provider.calls == 1:
                    return
            await asyncio.sleep(_POLL_SECONDS)

    await asyncio.wait_for(_poll(), _SETTLE_SECONDS)


@pytest.mark.asyncio
async def test_a_third_concurrent_generation_is_refused_on_every_route(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    provider: _Provider,
    transcriber: _Transcriber,
) -> None:
    """Two in flight: a third resonance, essay or page is 429, uncharged and undialled."""
    client = concurrent_async_client
    headers, user_id = await _signup(client, "triple")
    other, other_id = await _signup(client, "triple_other")
    async with concurrent_session_factory() as session:
        entries = [await _entry(session, user_id) for _ in range(2)]
        refused_entry = await _entry(session, user_id, body=_REFUSED_BODY)
        refused_note = await _note(session, user_id, body=_REFUSED_BODY)
        other_entry = await _entry(session, other_id)
    provider.gate = asyncio.Event()

    in_flight = [asyncio.create_task(_resonate(client, headers, entry)) for entry in entries]
    other_task: asyncio.Task[Response] | None = None
    try:
        # Both in flight have taken a slot and committed their spend; the first
        # is parked in the provider and the second behind the account barrier,
        # so neither the wallet nor the dial count can move until the gate opens.
        await _wait_for_leases(
            concurrent_session_factory, MAX_CONCURRENT_GENERATIONS_PER_USER, user_id
        )
        await _wait_until(concurrent_session_factory, user_id, spends=2, provider=provider)
        async with concurrent_session_factory() as session:
            wallet = await _wallet(session, user_id)
            rows = await _audit_rows(session, user_id)
        calls = provider.calls

        refusals = [
            await _resonate(client, headers, refused_entry),
            await _essay(client, headers, refused_note),
            await client.post(_TRANSCRIBE, headers=headers, json=payload(JPEG_BYTES)),
        ]
        for resp in refusals:
            assert resp.status_code == HTTPStatus.TOO_MANY_REQUESTS, resp.text
            assert resp.json() == {"detail": GENERATION_IN_PROGRESS}
            assert resp.headers["Retry-After"] == str(GENERATION_IN_PROGRESS_RETRY_AFTER_SECONDS)
        assert provider.calls == calls
        assert transcriber.calls == 0
        async with concurrent_session_factory() as session:
            # The two in flight already paid before they took the barrier.
            assert await _wallet(session, user_id) == wallet
            assert await _audit_rows(session, user_id) == rows

        # Another user is admitted while this one is full.
        other_task = asyncio.create_task(_resonate(client, other, other_entry))
        await _wait_for_leases(concurrent_session_factory, 1, other_id)
    finally:
        provider.gate.set()
    finished = await asyncio.gather(*in_flight, *([other_task] if other_task else []))
    for done in finished:
        assert done.status_code == HTTPStatus.OK, done.text

    # Both finished: the next request is admitted and dials.
    provider.gate = None
    admitted = await _resonate(client, headers, refused_entry)
    assert admitted.status_code == HTTPStatus.OK, admitted.text
    async with concurrent_session_factory() as session:
        assert await _leases(session) == 0


# --- release on every exit -----------------------------------------------------------------


async def _raise_provider_error(*_args: object, **_kwargs: object) -> LLMResponse:
    raise LLMProviderError("provider down")


async def _raise_runtime_error(*_args: object, **_kwargs: object) -> None:
    raise RuntimeError("ledger unavailable")


async def _raise_care(*_args: object, **_kwargs: object) -> None:
    raise CreekVaultCareEscalationError


_EXIT_CASES = [
    (None, None, HTTPStatus.OK),
    ("marginalia_generate", _raise_provider_error, HTTPStatus.BAD_GATEWAY),
    ("pass_or_care", _raise_care, HTTPStatus.OK),
    ("record_usage", _raise_runtime_error, HTTPStatus.INTERNAL_SERVER_ERROR),
]


@pytest.mark.asyncio
@pytest.mark.usefixtures("provider")
@pytest.mark.parametrize("exit_case", _EXIT_CASES)
async def test_every_resonance_and_essay_exit_releases_its_slot(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    exit_case: tuple[str | None, object, HTTPStatus],
) -> None:
    """Success, provider error, care escalation and an unexpected error all free the slot."""
    seam, replacement, status = exit_case
    targets = {
        "marginalia_generate": (marginalia_service, "generate_response"),
        "pass_or_care": (journal_router, "_resonance_pass_or_care"),
        "record_usage": (journal_router, "record_llm_usage"),
    }
    if seam is not None:
        module, name = targets[seam]
        monkeypatch.setattr(module, name, replacement)
    headers, user_id = await _signup(async_client, f"exit_{seam}")

    resp = await _resonate(async_client, headers, await _entry(db_session, user_id))
    assert resp.status_code == status, resp.text
    assert await _leases(db_session) == 0
    if seam != "pass_or_care":
        essay = await _essay(async_client, headers, await _note(db_session, user_id))
        assert essay.status_code == status, essay.text
        assert await _leases(db_session) == 0


@pytest.mark.asyncio
async def test_refusal_exits_release_their_slot(
    async_client: AsyncClient,
    db_session: AsyncSession,
    provider: _Provider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 402 and a daily 429 raised inside the slot leave no lease behind."""
    del provider
    headers, user_id = await _signup(async_client, "refused_exits")
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, "0")
    assert (
        await _resonate(async_client, headers, await _entry(db_session, user_id))
    ).status_code == (HTTPStatus.TOO_MANY_REQUESTS)
    assert await _leases(db_session) == 0
    monkeypatch.delenv(DAILY_GENERATION_CEILING_ENV)
    user = await db_session.get(User, user_id)
    assert user is not None
    user.monthly_messages_used = get_monthly_cap()
    await db_session.commit()

    broke = await _essay(async_client, headers, await _note(db_session, user_id))

    assert broke.status_code == HTTPStatus.PAYMENT_REQUIRED, broke.text
    assert await _leases(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("text", "status"),
    [
        (_TRANSCRIBED, HTTPStatus.OK),
        ("[no text found]", HTTPStatus.UNPROCESSABLE_ENTITY),
    ],
)
async def test_every_transcription_exit_releases_its_slot(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    text: str,
    status: HTTPStatus,
) -> None:
    """A page that lands and a page with no text both free the slot."""

    async def _answer(*_args: object, **_kwargs: object) -> LLMResponse:
        return LLMResponse(
            text=text, provider="stub", model=STUB_MODEL_NAME, prompt_tokens=0, completion_tokens=0
        )

    monkeypatch.setattr(transcription_router, "generate_response", _answer)
    headers, _user_id = await _signup(async_client, f"page_{status.value}")

    resp = await async_client.post(_TRANSCRIBE, headers=headers, json=payload(JPEG_BYTES))

    assert resp.status_code == status, resp.text
    assert await _leases(db_session) == 0


@pytest.mark.asyncio
async def test_a_failed_page_releases_its_slot_and_charges_nothing(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider error on a page rolls the spend back and frees the slot."""
    monkeypatch.setattr(transcription_router, "generate_response", _raise_provider_error)
    headers, user_id = await _signup(async_client, "page_502")

    resp = await async_client.post(_TRANSCRIBE, headers=headers, json=payload(JPEG_BYTES))

    assert resp.status_code == HTTPStatus.BAD_GATEWAY, resp.text
    assert await _leases(db_session) == 0
    assert await _audit_rows(db_session, user_id) == 0
