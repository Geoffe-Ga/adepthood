"""Tests for POST /journal/transcribe-page (stateless single-page transcription).

Specifies the endpoint before it exists: authentication, wallet metering (one
unit per success, rollback on provider failure), image validation (base64,
magic-byte / declared-type match, size cap), rate limiting, and the privacy
invariant that no log record ever carries the base64 payload or the
transcribed text.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from http import HTTPStatus
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from client_ip import TRUSTED_PROXIES_ENV_VAR
from errors import unprocessable
from models.llm_usage_log import LLMUsageLog
from models.user import User
from services import botmason as botmason_service
from services.botmason import STUB_SEAM_ENV_VAR, LLMProviderError, LLMVisionUnsupportedError
from tests.provider_transport import OPENAI_KEY, use_openai
from tests.transcription_helpers import JPEG_BYTES as _JPEG_BYTES
from tests.transcription_helpers import PNG_BYTES as _PNG_BYTES
from tests.transcription_helpers import REPORTED_REFUSAL as _REPORTED_REFUSAL
from tests.transcription_helpers import REPORTED_REFUSAL_CURLY as _REPORTED_REFUSAL_CURLY
from tests.transcription_helpers import SENTINEL_TEXT as _SENTINEL_TEXT
from tests.transcription_helpers import WEBP_BYTES as _WEBP_BYTES
from tests.transcription_helpers import b64 as _b64
from tests.transcription_helpers import patch_generate_response as _patch_generate_response
from tests.transcription_helpers import (
    patch_generate_response_raises as _patch_generate_response_raises,
)
from tests.transcription_helpers import payload as _payload
from tests.transcription_helpers import priced_response as _priced_response
from tests.transcription_helpers import signup as _signup

_ENDPOINT = "/journal/transcribe-page"
_RATE_LIMIT = 20
_MAX_IMAGE_BYTES = 5 * 1024 * 1024

_OVERSIZED_JPEG_BYTES = b"\xff\xd8\xff" + b"\x00" * (_MAX_IMAGE_BYTES + 10)


async def _wallet_snapshot(session: AsyncSession, email: str) -> tuple[int, int]:
    """Return (monthly_messages_used, offering_balance) for the user."""
    user = (await session.execute(select(User).where(col(User.email) == email))).scalar_one()
    return user.monthly_messages_used, user.offering_balance


def _units_spent(before: tuple[int, int], after: tuple[int, int]) -> int:
    """Return net wallet units consumed between two snapshots, either bucket."""
    before_monthly, before_offering = before
    after_monthly, after_offering = after
    return (after_monthly - before_monthly) + (before_offering - after_offering)


async def _usage_row_count(session: AsyncSession) -> int:
    """Return the total number of persisted LLMUsageLog rows."""
    result = await session.execute(select(func.count()).select_from(LLMUsageLog))
    return result.scalar_one()


async def _usage_rows_with_null_entry(session: AsyncSession) -> list[LLMUsageLog]:
    """Return LLMUsageLog rows written with no journal_entry_id (stateless calls)."""
    result = await session.execute(
        select(LLMUsageLog).where(col(LLMUsageLog.journal_entry_id).is_(None))
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_production_stub_provider_is_refused_before_wallet_deduction(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Production refuses canned vision before billing when only the stub resolves.

    A production process never has the stub test seam armed (its boot refuses
    it), so a keyless page on a stub server has nothing to answer it: 402
    ``llm_key_required``, never a canned transcription (#3096).
    """
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.setenv("ENV", "production")
    monkeypatch.delenv(STUB_SEAM_ENV_VAR, raising=False)
    preflight = AsyncMock()
    monkeypatch.setattr("routers.transcription.preflight_deduction", preflight)
    headers = await _signup(async_client, "production_stub")
    before = await _wallet_snapshot(db_session, "production_stub@example.com")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert resp.json()["detail"] == "llm_key_required"
    preflight.assert_not_awaited()
    after = await _wallet_snapshot(db_session, "production_stub@example.com")
    assert _units_spent(before, after) == 0
    assert await _usage_row_count(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("server_provider", ["real_provider", "stub"])
async def test_a_key_header_is_refused_before_slot_wallet_or_dial(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    server_provider: str,
) -> None:
    """A key sent to this route is not a payer: 402 before the slot, the charge or a dial.

    Page reading is client-direct (ADR 0009 phase (a), #3067): the device calls
    its own vendor, so the route declares no key header and a stale client's
    header is never read. Outside the stub seam the request is keyless and the
    payer gate refuses ``llm_key_required`` -- whatever provider the server is
    configured with, and with the vendor transport armed and counting.
    """
    transport = use_openai(monkeypatch, HTTPStatus.OK, {})
    monkeypatch.delenv(STUB_SEAM_ENV_VAR, raising=False)
    headers = {
        **await _signup(async_client, f"stale_key_{server_provider}"),
        "X-LLM-API-Key": OPENAI_KEY,
    }
    if server_provider == "stub":
        monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    preflight = AsyncMock()
    monkeypatch.setattr("routers.transcription.preflight_deduction", preflight)
    slots: list[str] = []

    @asynccontextmanager
    async def _slot(*_args: object, **_kwargs: object) -> AsyncIterator[None]:
        slots.append("slot")
        yield

    monkeypatch.setattr("routers.transcription.generation_slot", _slot)
    email = f"stale_key_{server_provider}@example.com"
    before = await _wallet_snapshot(db_session, email)

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json()["detail"] == "llm_key_required"
    preflight.assert_not_awaited()
    assert slots == []
    assert transport.request_count == 0
    assert _units_spent(before, await _wallet_snapshot(db_session, email)) == 0
    assert await _usage_row_count(db_session) == 0


@pytest.mark.asyncio
async def test_a_keyless_page_is_refused_before_its_body_is_decoded(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Outside the stub seam a keyless page can only be refused, so it is never decoded.

    The payer gate runs before image validation: a malformed body is answered
    ``llm_key_required``, not ``invalid_image``, and the decoder never sees it.
    """
    monkeypatch.delenv(STUB_SEAM_ENV_VAR, raising=False)
    decoded: list[str] = []

    def _spy(*_args: object) -> None:
        decoded.append("validated")
        raise unprocessable("invalid_image")

    monkeypatch.setattr("routers.transcription._validate_image", _spy)
    headers = await _signup(async_client, "keyless_undecoded")

    resp = await async_client.post(
        _ENDPOINT,
        json={
            "image_base64": "not!!base64!!",
            "media_type": "image/jpeg",
            "classification": "personal",
        },
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json()["detail"] == "llm_key_required"
    assert decoded == []


@pytest.mark.asyncio
async def test_development_stub_provider_returns_text_and_charges_one_unit(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Development keeps the walkable stub path and its existing wallet semantics."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.setenv("ENV", "development")
    headers = await _signup(async_client, "development_stub")
    before = await _wallet_snapshot(db_session, "development_stub@example.com")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert isinstance(resp.json()["text"], str)
    after = await _wallet_snapshot(db_session, "development_stub@example.com")
    assert _units_spent(before, after) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("raw", "media_type"),
    [
        (_JPEG_BYTES, "image/jpeg"),
        (_PNG_BYTES, "image/png"),
        (_WEBP_BYTES, "image/webp"),
    ],
    ids=["jpeg", "png", "webp"],
)
async def test_happy_path_per_media_type(
    async_client: AsyncClient, raw: bytes, media_type: str
) -> None:
    """Each declared media type with matching magic bytes succeeds."""
    username = f"media_{media_type.rsplit('/', maxsplit=1)[-1]}"
    headers = await _signup(async_client, username)

    resp = await async_client.post(_ENDPOINT, json=_payload(raw, media_type), headers=headers)

    assert resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_unauthenticated_is_401(async_client: AsyncClient) -> None:
    """A request with no Authorization header is rejected."""
    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES))
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_wallet_exhausted_is_402_and_uncharged(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """With no wallet capacity the call is 402 and neither bucket moves."""
    headers = await _signup(async_client, "broke_transcribe")
    before = await _wallet_snapshot(db_session, "broke_transcribe@example.com")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert resp.json()["detail"] == "insufficient_offerings"
    after = await _wallet_snapshot(db_session, "broke_transcribe@example.com")
    assert _units_spent(before, after) == 0
    assert await _usage_row_count(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_a_key_header_does_not_bypass_the_wallet(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no allowance, a key sent anyway buys nothing: 402, neither bucket, no usage.

    The key once let a page skip both buckets because the server spent it on
    the caller's behalf. The server no longer takes a key for a page read (ADR
    0009 phase (a), #3067), so the seam-answered page needs the wallet as any
    keyless one does.
    """
    _patch_generate_response(monkeypatch, _priced_response("never reached"))
    headers = await _signup(async_client, "stale_key_wallet")
    before = await _wallet_snapshot(db_session, "stale_key_wallet@example.com")

    resp = await async_client.post(
        _ENDPOINT,
        json=_payload(_JPEG_BYTES),
        headers={**headers, _BYOK_HEADER: _BYOK_KEY},
    )

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json()["detail"] == "insufficient_offerings"
    after = await _wallet_snapshot(db_session, "stale_key_wallet@example.com")
    assert after == before
    assert await _usage_row_count(db_session) == 0


@pytest.mark.asyncio
async def test_invalid_base64_is_422(async_client: AsyncClient) -> None:
    """Non-base64 image content is rejected as invalid_image."""
    headers = await _signup(async_client, "badb64")

    resp = await async_client.post(
        _ENDPOINT,
        json={
            "image_base64": "not!!base64!!",
            "media_type": "image/jpeg",
            "classification": "personal",
        },
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "invalid_image"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("raw", "declared_media_type"),
    [
        (_PNG_BYTES, "image/jpeg"),
        (_WEBP_BYTES, "image/png"),
        (_JPEG_BYTES, "image/webp"),
    ],
    ids=["png-bytes-declared-jpeg", "webp-bytes-declared-png", "jpeg-bytes-declared-webp"],
)
async def test_magic_byte_mismatch_is_422(
    async_client: AsyncClient, raw: bytes, declared_media_type: str
) -> None:
    """Valid base64 whose magic bytes disagree with the declared type is rejected."""
    username = f"mismatch_{declared_media_type.rsplit('/', maxsplit=1)[-1]}"
    headers = await _signup(async_client, username)

    resp = await async_client.post(
        _ENDPOINT, json=_payload(raw, declared_media_type), headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "invalid_image"


@pytest.mark.asyncio
async def test_oversized_image_is_422(async_client: AsyncClient) -> None:
    """A decoded payload over 5 MiB is rejected as image_too_large."""
    headers = await _signup(async_client, "oversized")

    resp = await async_client.post(_ENDPOINT, json=_payload(_OVERSIZED_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "image_too_large"


@pytest.mark.asyncio
async def test_boundary_image_is_422_not_500(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A near-maximal image caps out cleanly as image_too_large, never a 500.

    Exactly 5 MiB of decoded bytes encodes to a base64 string whose length slips
    past the decoded-size cap by rounding but exceeds the shared attachment's
    stricter encoded-length cap. It must surface as a clean 422 image_too_large
    with no charge, not an unhandled 500.
    """
    headers = await _signup(async_client, "boundary")
    before = await _wallet_snapshot(db_session, "boundary@example.com")
    boundary = b"\xff\xd8\xff" + b"\x00" * (_MAX_IMAGE_BYTES - 3)

    resp = await async_client.post(_ENDPOINT, json=_payload(boundary), headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "image_too_large"
    after = await _wallet_snapshot(db_session, "boundary@example.com")
    assert _units_spent(before, after) == 0


@pytest.mark.asyncio
async def test_unknown_media_type_is_422(async_client: AsyncClient) -> None:
    """An unsupported media_type fails Pydantic's Literal validation with 422."""
    headers = await _signup(async_client, "gifuser")

    resp = await async_client.post(
        _ENDPOINT, json=_payload(_JPEG_BYTES, "image/gif"), headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "username"),
    [
        (
            {
                "image_base64": "not!!base64!!",
                "media_type": "image/jpeg",
                "classification": "personal",
            },
            "nocharge_badb64",
        ),
        (_payload(_OVERSIZED_JPEG_BYTES), "nocharge_oversized"),
    ],
    ids=["invalid-base64", "oversized"],
)
async def test_validation_failure_does_not_charge(
    async_client: AsyncClient,
    db_session: AsyncSession,
    body: dict[str, str],
    username: str,
) -> None:
    """A 422 validation failure never touches either wallet bucket."""
    headers = await _signup(async_client, username)
    email = f"{username}@example.com"
    before = await _wallet_snapshot(db_session, email)

    resp = await async_client.post(_ENDPOINT, json=body, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    after = await _wallet_snapshot(db_session, email)
    assert _units_spent(before, after) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        pytest.param(LLMVisionUnsupportedError("provider lacks vision"), id="vision-unsupported"),
        pytest.param(
            botmason_service.LLMCreditExhaustedError("spent", provider="openai"),
            id="credit-exhausted-openai",
        ),
        pytest.param(
            botmason_service.LLMCreditExhaustedError("spent", provider="anthropic"),
            id="credit-exhausted-anthropic",
        ),
    ],
)
async def test_every_provider_failure_is_502_and_rolls_back_charge(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    failure: LLMProviderError,
) -> None:
    """Each provider failure the keyless seam path could see is one rolled-back 502.

    The 422 ``model_lacks_vision`` and the spent-balance codes this route once
    mapped described a writer's key reaching a vendor from here, which no
    longer happens (ADR 0009 phase (a), #3067). What is left is the rollback
    guarantee: whatever the failure, nothing is charged and nothing is metered.
    """
    _patch_generate_response_raises(monkeypatch, failure)
    headers = await _signup(async_client, f"failure_{type(failure).__name__.lower()}")
    email = f"failure_{type(failure).__name__.lower()}@example.com"
    before = await _wallet_snapshot(db_session, email)

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.BAD_GATEWAY, resp.text
    assert resp.json()["detail"] == "llm_provider_error"
    after = await _wallet_snapshot(db_session, email)
    assert _units_spent(before, after) == 0
    assert await _usage_row_count(db_session) == 0


@pytest.mark.asyncio
async def test_provider_error_is_502_and_rolls_back_charge(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An upstream provider failure surfaces llm_provider_error and refunds."""
    _patch_generate_response_raises(monkeypatch, LLMProviderError("provider down"))
    headers = await _signup(async_client, "providerdown")
    before = await _wallet_snapshot(db_session, "providerdown@example.com")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.BAD_GATEWAY
    assert resp.json()["detail"] == "llm_provider_error"
    after = await _wallet_snapshot(db_session, "providerdown@example.com")
    assert _units_spent(before, after) == 0
    assert await _usage_row_count(db_session) == 0


@pytest.mark.asyncio
async def test_priced_call_writes_one_usage_row_with_null_entry(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-stub response writes one LLMUsageLog row with no journal_entry_id."""
    _patch_generate_response(monkeypatch, _priced_response("transcribed body text"))
    headers = await _signup(async_client, "priced_transcribe")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.OK
    rows = await _usage_rows_with_null_entry(db_session)
    assert len(rows) == 1
    row = rows[0]
    assert row.provider == "openai"
    assert row.model == "gpt-4o-mini"
    assert row.prompt_tokens == 11
    assert row.completion_tokens == 7
    assert row.total_tokens == 18


@pytest.mark.asyncio
async def test_stub_provider_writes_no_usage_row(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stub-provider success writes zero LLMUsageLog rows."""
    headers = await _signup(async_client, "stub_transcribe")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert await _usage_row_count(db_session) == 0


@pytest.mark.asyncio
async def test_rate_limit_pinned_at_20_per_minute(async_client: AsyncClient) -> None:
    """The endpoint's rate limit is pinned at exactly 20 requests/minute."""
    headers = await _signup(async_client, "ratelimited")

    async def send() -> Response:
        return await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    for _ in range(_RATE_LIMIT - 1):
        await send()

    admitted = await send()
    assert admitted.status_code != HTTPStatus.TOO_MANY_REQUESTS

    throttled = await send()
    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == "rate_limit_exceeded"


# The in-process test transport reports this socket peer; trusting it as a
# proxy lets a test choose each request's client address via X-Forwarded-For.
_TEST_TRANSPORT_PEER_NET = "127.0.0.1/32"


def _from_address(headers: dict[str, str], address: str) -> dict[str, str]:
    """Return ``headers`` sent as if from client ``address`` behind the trusted proxy."""
    return {**headers, "X-Forwarded-For": address}


@pytest.mark.asyncio
async def test_rotating_client_addresses_does_not_buy_a_user_more_transcriptions(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The budget follows the account: a fresh address per request is still refused.

    An unusable read is uncharged (#2851), so the per-address limit alone would
    let one user buy unmetered provider calls by rotating addresses. A second
    account behind the address the first one moved to is unaffected.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TEST_TRANSPORT_PEER_NET)
    greedy = await _signup(async_client, "rotating_transcriber")

    for index in range(_RATE_LIMIT):
        admitted = await async_client.post(
            _ENDPOINT,
            json=_payload(_JPEG_BYTES),
            headers=_from_address(greedy, f"203.0.113.{index + 1}"),
        )
        assert admitted.status_code != HTTPStatus.TOO_MANY_REQUESTS

    rotated = await async_client.post(
        _ENDPOINT, json=_payload(_JPEG_BYTES), headers=_from_address(greedy, "198.51.100.7")
    )
    assert rotated.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert rotated.json()["detail"] == "rate_limit_exceeded"

    neighbour = await _signup(async_client, "neighbour_transcriber")
    unaffected = await async_client.post(
        _ENDPOINT, json=_payload(_JPEG_BYTES), headers=_from_address(neighbour, "198.51.100.7")
    )
    assert unaffected.status_code == HTTPStatus.OK


_REFUSED_RETRIES = 5


@pytest.mark.asyncio
async def test_a_refused_account_retry_does_not_spend_the_shared_address_budget(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The account axis is evaluated first, so its refusals cost the address nothing.

    slowapi bills each bucket until one refuses. An account out of budget that
    keeps retrying from a shared address must not eat that address's budget, or
    the next person behind it is throttled for someone else's loop.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TEST_TRANSPORT_PEER_NET)
    greedy = await _signup(async_client, "greedy_transcriber")
    for _ in range(_RATE_LIMIT):
        await async_client.post(
            _ENDPOINT, json=_payload(_JPEG_BYTES), headers=_from_address(greedy, "203.0.113.9")
        )
    for _ in range(_REFUSED_RETRIES):
        refused = await async_client.post(
            _ENDPOINT, json=_payload(_JPEG_BYTES), headers=_from_address(greedy, "198.51.100.9")
        )
        assert refused.status_code == HTTPStatus.TOO_MANY_REQUESTS

    neighbour = await _signup(async_client, "shared_address_transcriber")
    for _ in range(_RATE_LIMIT):
        admitted = await async_client.post(
            _ENDPOINT, json=_payload(_JPEG_BYTES), headers=_from_address(neighbour, "198.51.100.9")
        )
        assert admitted.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_no_log_record_leaks_base64_or_transcription_text(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No captured log record ever carries the base64 payload or the reply text."""
    _patch_generate_response(monkeypatch, _priced_response(_SENTINEL_TEXT))
    headers = await _signup(async_client, "privacy_check")
    encoded = _b64(_JPEG_BYTES)

    with caplog.at_level(logging.DEBUG):
        resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.OK
    for record in caplog.records:
        message = record.getMessage()
        assert encoded not in message
        assert _SENTINEL_TEXT not in message
        dict_blob = str(record.__dict__)
        assert encoded not in dict_blob
        assert _SENTINEL_TEXT not in dict_blob


# --- A key sent anyway never reaches a vendor, even one armed to answer -----

_BYOK_HEADER = "X-LLM-API-Key"
_BYOK_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret

#: OpenAI's real answer for a spent quota, captured verbatim. Served at the HTTP
#: transport so a dial, if one happened, would build the SDK's own error.
_OPENAI_QUOTA_BODY = {
    "error": {
        "message": "You exceeded your current quota, please check your plan and billing details.",
        "type": "insufficient_quota",
        "param": None,
        "code": "insufficient_quota",
    }
}
_HTTP_TOO_MANY_REQUESTS = 429


@pytest.mark.asyncio
async def test_a_key_header_never_reaches_a_vendor_transport(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No seam mocked: header -> route -> payer gate. The vendor transport stays untouched.

    This file once proved the whole relay chain here (a provider's quota body
    built into the SDK's error and mapped to 402). Page reading is client-direct
    now (ADR 0009 phase (a), #3067), so that chain runs on the device and is
    pinned in ``frontend/src/api/__tests__/byokDirect.test.ts``; what this route
    owes is that a key sent to it opens no transport at all.
    """
    stub = use_openai(monkeypatch, _HTTP_TOO_MANY_REQUESTS, _OPENAI_QUOTA_BODY)
    monkeypatch.delenv(STUB_SEAM_ENV_VAR, raising=False)
    headers = await _signup(async_client, "scan_real")
    before = await _wallet_snapshot(db_session, "scan_real@example.com")

    resp = await async_client.post(
        _ENDPOINT,
        json=_payload(_JPEG_BYTES),
        headers={**headers, _BYOK_HEADER: OPENAI_KEY},
    )

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json()["detail"] == "llm_key_required"
    assert stub.request_count == 0
    after = await _wallet_snapshot(db_session, "scan_real@example.com")
    assert _units_spent(before, after) == 0
    assert await _usage_row_count(db_session) == 0


# --- A refusal or an empty read is not the page's text (#2851) --------------


@pytest.mark.asyncio
async def test_refusal_reply_is_422_transcription_refused_and_uncharged(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reported refusal is a typed 422, and neither the debit nor a usage row persists."""
    _patch_generate_response(monkeypatch, _priced_response(_REPORTED_REFUSAL))
    headers = await _signup(async_client, "refusal_check")
    before = await _wallet_snapshot(db_session, "refusal_check@example.com")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "transcription_refused"
    after = await _wallet_snapshot(db_session, "refusal_check@example.com")
    assert _units_spent(before, after) == 0
    assert await _usage_row_count(db_session) == 0


_UNUSABLE_REPLIES = (
    pytest.param(_REPORTED_REFUSAL, "transcription_refused", id="refusal-ascii"),
    pytest.param(_REPORTED_REFUSAL_CURLY, "transcription_refused", id="refusal-curly"),
    pytest.param("  [no text found]\n", "no_text_found", id="no-text-sentinel"),
)


@pytest.mark.asyncio
@pytest.mark.parametrize(("reply", "detail"), _UNUSABLE_REPLIES)
async def test_unusable_reply_on_server_key_is_422_and_uncharged(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    reply: str,
    detail: str,
) -> None:
    """Server-paid: an unusable reply rolls the staged debit and usage row back."""
    _patch_generate_response(monkeypatch, _priced_response(reply))
    headers = await _signup(async_client, "unusable_server")
    before = await _wallet_snapshot(db_session, "unusable_server@example.com")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == detail
    after = await _wallet_snapshot(db_session, "unusable_server@example.com")
    assert _units_spent(before, after) == 0
    assert await _usage_row_count(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(("reply", "detail"), _UNUSABLE_REPLIES)
async def test_unusable_reply_with_a_stale_key_header_is_422_and_uncharged(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    reply: str,
    detail: str,
) -> None:
    """A key sent anyway changes nothing: the unusable reply rolls back, metering nothing."""
    _patch_generate_response(monkeypatch, _priced_response(reply))
    headers = await _signup(async_client, "unusable_stale_key")
    before = await _wallet_snapshot(db_session, "unusable_stale_key@example.com")

    resp = await async_client.post(
        _ENDPOINT,
        json=_payload(_JPEG_BYTES),
        headers={**headers, _BYOK_HEADER: _BYOK_KEY},
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == detail
    after = await _wallet_snapshot(db_session, "unusable_stale_key@example.com")
    assert _units_spent(before, after) == 0
    assert await _usage_row_count(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "page",
    [
        pytest.param("I can't sleep again tonight.", id="i-cant-sleep"),
        pytest.param(
            "I can't stop looking at the photo of Dad from 1987.\nHe looks so young.",
            id="photo-of-dad",
        ),
    ],
)
async def test_journal_page_opening_with_i_cant_is_transcribed_and_charged(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    page: str,
) -> None:
    """A real page that starts "I can't" is the writer's words, not a refusal."""
    _patch_generate_response(monkeypatch, _priced_response(page))
    headers = await _signup(async_client, "i_cant_page")
    before = await _wallet_snapshot(db_session, "i_cant_page@example.com")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["text"] == page
    after = await _wallet_snapshot(db_session, "i_cant_page@example.com")
    assert _units_spent(before, after) == 1
    assert await _usage_row_count(db_session) == 1
