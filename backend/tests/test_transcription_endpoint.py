"""Tests for POST /journal/transcribe-page (stateless single-page transcription).

Specifies the endpoint before it exists: authentication, wallet metering (one
unit per success, rollback on provider failure), image validation (base64,
magic-byte / declared-type match, size cap), rate limiting, and the privacy
invariant that no log record ever carries the base64 payload or the
transcribed text.
"""

from __future__ import annotations

import base64
import logging
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.llm_usage_log import LLMUsageLog
from models.user import User
from services.botmason import LLMProviderError, LLMResponse, LLMVisionUnsupportedError

_ENDPOINT = "/journal/transcribe-page"
_RATE_LIMIT = 20
_MAX_IMAGE_BYTES = 5 * 1024 * 1024

_JPEG_BYTES = b"\xff\xd8\xff" + b"\x00" * 64
_PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
_WEBP_BYTES = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 64
_OVERSIZED_JPEG_BYTES = b"\xff\xd8\xff" + b"\x00" * (_MAX_IMAGE_BYTES + 10)

_SENTINEL_TEXT = "SENTINEL_TRANSCRIPTION_TEXT_9f3c2a"


async def _signup(client: AsyncClient, username: str = "transcriber") -> dict[str, str]:
    """Create a user and return bearer auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _b64(raw: bytes) -> str:
    """Base64-encode raw image bytes for the request payload."""
    return base64.b64encode(raw).decode()


def _payload(raw: bytes, media_type: str = "image/jpeg") -> dict[str, str]:
    """Build a transcribe-page request body from raw image bytes."""
    return {"image_base64": _b64(raw), "media_type": media_type}


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


def _priced_response(text: str) -> LLMResponse:
    """Return a non-stub LLMResponse (provider=openai) for usage-log tests."""
    return LLMResponse(
        text=text, provider="openai", model="gpt-4o-mini", prompt_tokens=11, completion_tokens=7
    )


def _patch_generate_response(monkeypatch: pytest.MonkeyPatch, response: LLMResponse) -> None:
    """Patch the router's LLM seam to return a canned response."""

    async def _fake(*args: object, **kwargs: object) -> LLMResponse:
        del args, kwargs
        return response

    monkeypatch.setattr("routers.transcription.generate_response", _fake)


def _patch_generate_response_raises(monkeypatch: pytest.MonkeyPatch, exc: Exception) -> None:
    """Patch the router's LLM seam to raise ``exc`` on every call."""

    async def _boom(*args: object, **kwargs: object) -> LLMResponse:
        del args, kwargs
        raise exc

    monkeypatch.setattr("routers.transcription.generate_response", _boom)


@pytest.mark.asyncio
async def test_happy_path_stub_provider_charges_one_unit(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stub-provider transcription returns text and spends exactly one unit."""
    headers = await _signup(async_client, "happy")
    before = await _wallet_snapshot(db_session, "happy@example.com")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert isinstance(resp.json()["text"], str)
    after = await _wallet_snapshot(db_session, "happy@example.com")
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
async def test_invalid_base64_is_422(async_client: AsyncClient) -> None:
    """Non-base64 image content is rejected as invalid_image."""
    headers = await _signup(async_client, "badb64")

    resp = await async_client.post(
        _ENDPOINT,
        json={"image_base64": "not!!base64!!", "media_type": "image/jpeg"},
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
        ({"image_base64": "not!!base64!!", "media_type": "image/jpeg"}, "nocharge_badb64"),
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
async def test_model_lacks_vision_is_422_and_rolls_back_charge(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A vision-incapable model/provider surfaces model_lacks_vision and refunds."""
    _patch_generate_response_raises(monkeypatch, LLMVisionUnsupportedError("provider lacks vision"))
    headers = await _signup(async_client, "novision")
    before = await _wallet_snapshot(db_session, "novision@example.com")

    resp = await async_client.post(_ENDPOINT, json=_payload(_JPEG_BYTES), headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "model_lacks_vision"
    after = await _wallet_snapshot(db_session, "novision@example.com")
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
