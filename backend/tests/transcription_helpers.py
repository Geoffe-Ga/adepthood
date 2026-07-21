"""Shared fixtures for the transcribe-page endpoint's test modules.

Extracted from ``test_transcription_endpoint.py`` so the privacy regression
suite (``test_transcription_privacy.py``) can reuse the same sentinel
constants, image bytes, and provider-patching helpers without duplicating
them or creating a circular import between the two test modules. This module
has no ``test_`` prefix so pytest never collects it as a test file itself.
"""

from __future__ import annotations

import base64
from http import HTTPStatus

import pytest
from httpx import AsyncClient

from services.botmason import LLMResponse

#: Marker text a stubbed provider response returns so tests can grep logs for it.
SENTINEL_TEXT = "SENTINEL_TRANSCRIPTION_TEXT_9f3c2a"

#: Minimal valid JPEG magic-byte prefix padded to a plausible body length.
JPEG_BYTES = b"\xff\xd8\xff" + b"\x00" * 64
#: Minimal valid PNG magic-byte prefix padded to a plausible body length.
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
#: Minimal valid RIFF/WEBP container padded to a plausible body length.
WEBP_BYTES = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 64


async def signup(client: AsyncClient, username: str = "transcriber") -> dict[str, str]:
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


def b64(raw: bytes) -> str:
    """Base64-encode raw image bytes for the request payload."""
    return base64.b64encode(raw).decode()


def payload(raw: bytes, media_type: str = "image/jpeg") -> dict[str, str]:
    """Build a transcribe-page request body from raw image bytes."""
    return {"image_base64": b64(raw), "media_type": media_type}


def priced_response(text: str) -> LLMResponse:
    """Return a non-stub LLMResponse (provider=openai) for usage-log tests."""
    return LLMResponse(
        text=text, provider="openai", model="gpt-4o-mini", prompt_tokens=11, completion_tokens=7
    )


def patch_generate_response(monkeypatch: pytest.MonkeyPatch, response: LLMResponse) -> None:
    """Patch the router's LLM seam to return a canned response."""

    async def _fake(*args: object, **kwargs: object) -> LLMResponse:
        del args, kwargs
        return response

    monkeypatch.setattr("routers.transcription.generate_response", _fake)


def patch_generate_response_raises(monkeypatch: pytest.MonkeyPatch, exc: Exception) -> None:
    """Patch the router's LLM seam to raise ``exc`` on every call."""

    async def _boom(*args: object, **kwargs: object) -> LLMResponse:
        del args, kwargs
        raise exc

    monkeypatch.setattr("routers.transcription.generate_response", _boom)
