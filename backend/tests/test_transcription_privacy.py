"""Permanent privacy regression suite for POST /journal/transcribe-page.

The Journal Photographer's stateless transcription endpoint promises that a
photographed page's image bytes and its transcribed text are never persisted,
logged, or otherwise leaked anywhere outside the single request that carries
them. These tests are tripwires: each one pins one facet of that promise so
that any future change which starts persisting or logging image bytes /
transcript text turns this suite (and therefore CI) red. Sections:

    A -- the LLMUsageLog table schema stays free of content-bearing columns
    B -- no log record leaks the base64 payload or the transcribed text on
         any of the four response paths (success, 422, 402, 502)
    C -- the source tree carries no multipart/UploadFile upload surface
    D -- the route carries no image data in its URL, and the access log's
         structured extras stay inside a closed allow-list
    E -- the vision provider calls forward a closed set of SDK kwargs
    F -- the Sentry context allow-list stays closed
    G -- the request/response DTOs never leak their payload through repr/str
"""

from __future__ import annotations

import base64
import logging
import re
from pathlib import Path
from typing import ClassVar

import anthropic
import openai
import pytest
from fastapi.routing import APIRoute
from httpx import AsyncClient
from sqlalchemy import JSON, LargeBinary, Text

from main import app as main_app
from models.llm_usage_log import LLMUsageLog
from schemas.transcription import TranscribePageRequest, TranscribePageResponse
from sentry import SentryContext
from services.botmason import ImagePayload, LLMProviderError, generate_response
from tests.transcription_helpers import (
    JPEG_BYTES,
    SENTINEL_TEXT,
    b64,
    patch_generate_response,
    patch_generate_response_raises,
    payload,
    priced_response,
    signup,
)

_ENDPOINT = "/journal/transcribe-page"

# ── A: usage-log stays content-free ────────────────────────────────────────

# Longest metadata string the usage log may hold (provider/model names) --
# anything unbounded is an admission a content column slipped in.
_MAX_METADATA_STRING_LENGTH = 128


def _is_string_family_column(column_type: object) -> bool:
    """Return True when ``column_type`` belongs to SQLAlchemy's string family.

    Detects both a plain ``String``/``Text`` type AND SQLModel's ``AutoString``
    wrapper, which is a ``TypeDecorator`` and therefore NOT an ``isinstance``
    match for ``sqlalchemy.String`` even though it behaves like one.
    """
    length = getattr(column_type, "length", None)
    return isinstance(length, int) or "String" in type(column_type).__name__


def _bounded_length(column_type: object) -> int | None:
    """Return ``column_type.length`` when it is a bound integer, else ``None``."""
    length = getattr(column_type, "length", None)
    return length if isinstance(length, int) else None


def test_usage_log_schema_stays_content_free() -> None:
    """No LLMUsageLog column may hold free-text content, prompts, or images.

    Two failure modes are guarded: an explicit ``Text``/``LargeBinary``/``JSON``
    column, and the sneakier case of an unbounded ``str`` field (SQLModel's
    ``AutoString`` with ``length is None``), which behaves like a content
    column but is not caught by a naive ``isinstance(col.type, String)`` check.
    """
    columns = LLMUsageLog.__table__.columns  # type: ignore[attr-defined]
    for column in columns:
        column_type = column.type
        # Adding a content/prompt/response/image column here is a privacy
        # regression, not a feature -- this table is append-only observability
        # metadata.
        assert not isinstance(column_type, Text | LargeBinary | JSON)
        if _is_string_family_column(column_type):
            # The bound is a proxy for "short metadata identifier" (provider /
            # model name), not a content guarantee -- it is deliberately tight
            # so a wide free-text column cannot masquerade as metadata.
            length = _bounded_length(column_type)
            assert length is not None
            assert length <= _MAX_METADATA_STRING_LENGTH


# ── B: no content in logs across all four response paths ──────────────────

_PRIVACY_MARKER = b"PRIVACY_SENTINEL_MARKER_7d1e2a9c"
_MARKED_JPEG_BYTES = b"\xff\xd8\xff" + _PRIVACY_MARKER + b"\x00" * 64


def _assert_no_privacy_leak(
    records: list[logging.LogRecord], encoded: str, marker_b64: str
) -> None:
    """Assert no record's message or ``__dict__`` carries the payload, marker, or reply text.

    Both the base64 forms (full payload and standalone marker) and the raw
    decoded ASCII marker are checked, so a regression that logs the decoded
    image bytes is caught as well as one that logs the encoded string.
    """
    raw_marker = _PRIVACY_MARKER.decode()
    for record in records:
        for blob in (record.getMessage(), str(record.__dict__)):
            assert encoded not in blob
            assert marker_b64 not in blob
            assert raw_marker not in blob
            assert SENTINEL_TEXT not in blob


@pytest.mark.asyncio
async def test_success_path_logs_no_image_or_text_content(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A successful transcription never logs the base64 payload or the reply text."""
    patch_generate_response(monkeypatch, priced_response(SENTINEL_TEXT))
    headers = await signup(async_client, "privacy_success")
    encoded = b64(_MARKED_JPEG_BYTES)
    marker_b64 = base64.b64encode(_PRIVACY_MARKER).decode()

    with caplog.at_level(logging.DEBUG):
        resp = await async_client.post(_ENDPOINT, json=payload(_MARKED_JPEG_BYTES), headers=headers)

    assert resp.status_code == 200
    _assert_no_privacy_leak(caplog.records, encoded, marker_b64)


@pytest.mark.asyncio
async def test_validation_failure_logs_no_image_content(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """A 422 magic-byte mismatch never logs the offending base64 payload."""
    headers = await signup(async_client, "privacy_422")
    encoded = b64(_MARKED_JPEG_BYTES)
    marker_b64 = base64.b64encode(_PRIVACY_MARKER).decode()

    with caplog.at_level(logging.DEBUG):
        resp = await async_client.post(
            _ENDPOINT, json=payload(_MARKED_JPEG_BYTES, "image/png"), headers=headers
        )

    assert resp.status_code == 422
    assert resp.json()["detail"] == "invalid_image"
    _assert_no_privacy_leak(caplog.records, encoded, marker_b64)


@pytest.mark.asyncio
@pytest.mark.usefixtures("zero_monthly_cap")
async def test_wallet_exhausted_logs_no_image_content(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """A 402 wallet-exhaustion rejection never logs the base64 payload."""
    headers = await signup(async_client, "privacy_402")
    encoded = b64(_MARKED_JPEG_BYTES)
    marker_b64 = base64.b64encode(_PRIVACY_MARKER).decode()

    with caplog.at_level(logging.DEBUG):
        resp = await async_client.post(_ENDPOINT, json=payload(_MARKED_JPEG_BYTES), headers=headers)

    assert resp.status_code == 402
    _assert_no_privacy_leak(caplog.records, encoded, marker_b64)


@pytest.mark.asyncio
async def test_provider_failure_logs_no_image_or_text_content(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A 502 provider failure never logs the base64 payload or any reply text."""
    patch_generate_response_raises(monkeypatch, LLMProviderError("upstream exploded"))
    headers = await signup(async_client, "privacy_502")
    encoded = b64(_MARKED_JPEG_BYTES)
    marker_b64 = base64.b64encode(_PRIVACY_MARKER).decode()

    with caplog.at_level(logging.DEBUG):
        resp = await async_client.post(_ENDPOINT, json=payload(_MARKED_JPEG_BYTES), headers=headers)

    assert resp.status_code == 502
    _assert_no_privacy_leak(caplog.records, encoded, marker_b64)


# ── C: no multipart/upload surface anywhere in the source tree ────────────

_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
_UPLOAD_FILE_PATTERN = re.compile(r"\bUploadFile\b")
_FILE_CALL_PATTERN = re.compile(r"\bFile\(")
_MULTIPART_PATTERN = re.compile(r"multipart", re.IGNORECASE)


def test_no_multipart_upload_surface_in_source_tree() -> None:
    """No backend source file references UploadFile, File(...), or multipart.

    Starlette spools multipart uploads to disk (temp files); the transcribe
    endpoint takes base64 in the JSON body precisely to keep image bytes in
    request-scoped memory only, never touching disk. Any of these tokens
    reappearing in ``src/`` is a regression back toward disk-backed uploads.
    """
    for path in _SRC_DIR.rglob("*.py"):
        text = path.read_text()
        assert not _UPLOAD_FILE_PATTERN.search(text), path
        assert not _FILE_CALL_PATTERN.search(text), path
        assert not _MULTIPART_PATTERN.search(text), path


def test_no_python_multipart_dependency() -> None:
    """``python-multipart`` is absent from both requirement files."""
    backend_dir = _SRC_DIR.parent
    for filename in ("requirements.txt", "requirements-dev.txt"):
        text = (backend_dir / filename).read_text()
        assert "python-multipart" not in text


# ── D: request-log safety ──────────────────────────────────────────────────


def test_transcribe_route_has_no_path_parameters() -> None:
    """The registered route path is body-only -- no image data ever rides the URL."""
    matching = [
        route
        for route in main_app.routes
        if isinstance(route, APIRoute) and route.path == _ENDPOINT
    ]
    assert matching, f"no registered route found for {_ENDPOINT}"
    assert "{" not in matching[0].path


# ``makeLogRecord({})`` omits attributes the logging machinery only populates
# while a record is emitted (``message`` via ``getMessage``/formatting,
# ``asctime`` when a formatter renders it, ``taskName`` under asyncio on 3.12+).
# They are standard LogRecord fields, never caller-supplied ``extra=`` keys, so
# the allow-list check must not treat them as custom extras.
_STANDARD_LATE_LOG_RECORD_KEYS = frozenset({"message", "asctime", "taskName"})
_BASELINE_LOG_RECORD_KEYS = (
    frozenset(logging.makeLogRecord({}).__dict__) | _STANDARD_LATE_LOG_RECORD_KEYS
)
_ALLOWED_ACCESS_LOG_EXTRA_KEYS = frozenset(
    {"http_method", "http_path", "http_status", "elapsed_ms"}
)


@pytest.mark.asyncio
async def test_access_log_extras_stay_within_allowlist_and_leak_nothing(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """RequestLoggingMiddleware's access-log extras never grow past the allow-list or leak bytes."""
    headers = await signup(async_client, "access_log_check")
    encoded = b64(_MARKED_JPEG_BYTES)

    with caplog.at_level(logging.INFO, logger="adepthood.access"):
        resp = await async_client.post(_ENDPOINT, json=payload(_MARKED_JPEG_BYTES), headers=headers)

    assert resp.status_code == 200
    completed = [r for r in caplog.records if r.message == "request_completed"]
    assert completed, "expected a request_completed record from RequestLoggingMiddleware"
    record = completed[-1]
    extra_keys = set(record.__dict__) - _BASELINE_LOG_RECORD_KEYS
    assert extra_keys <= _ALLOWED_ACCESS_LOG_EXTRA_KEYS
    for key in extra_keys:
        assert encoded not in str(getattr(record, key))


# ── E: provider call hygiene -- closed set of vision SDK kwargs ───────────


class _KwargRecordingOpenAIClient:
    """Stands in for ``openai.AsyncOpenAI``; records the ``create()`` call kwargs."""

    last_create_kwargs: ClassVar[dict[str, object]] = {}

    def __init__(self, **_ctor_kwargs: object) -> None:
        outer_cls = type(self)

        class _Completions:
            @staticmethod
            async def create(**call_kwargs: object) -> object:
                outer_cls.last_create_kwargs = call_kwargs
                message = type("Msg", (), {"content": "vision transcription"})()
                choice = type("Choice", (), {"message": message})()
                usage = type("Usage", (), {"prompt_tokens": 5, "completion_tokens": 3})()
                return type("Completion", (), {"choices": [choice], "usage": usage})()

        self.chat = type("Chat", (), {"completions": _Completions()})()


class _KwargRecordingAnthropicClient:
    """Stands in for ``anthropic.AsyncAnthropic``; records the ``create()`` call kwargs."""

    last_create_kwargs: ClassVar[dict[str, object]] = {}

    def __init__(self, **_ctor_kwargs: object) -> None:
        outer_cls = type(self)

        class _Messages:
            @staticmethod
            async def create(**call_kwargs: object) -> object:
                outer_cls.last_create_kwargs = call_kwargs
                block = type("Block", (), {"text": "vision transcription"})()
                usage = type("Usage", (), {"input_tokens": 5, "output_tokens": 3})()
                return type("Message", (), {"content": [block], "usage": usage})()

        self.messages = _Messages()


_OPENAI_CREATE_KWARGS = frozenset({"model", "messages", "max_tokens"})
_ANTHROPIC_CREATE_KWARGS = frozenset({"model", "max_tokens", "system", "messages"})


@pytest.mark.asyncio
async def test_openai_vision_call_uses_closed_set_of_kwargs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The OpenAI vision call forwards exactly model/messages/max_tokens -- no metadata/user."""
    monkeypatch.setattr(openai, "AsyncOpenAI", _KwargRecordingOpenAIClient)
    monkeypatch.delenv("LLM_MODEL", raising=False)
    image = ImagePayload(data=b64(JPEG_BYTES), media_type="image/jpeg")

    await generate_response(
        "",
        [],
        system_prompt="Transcribe this page.",
        api_key="sk-server-key",  # pragma: allowlist secret
        images=[image],
    )

    assert set(_KwargRecordingOpenAIClient.last_create_kwargs) == _OPENAI_CREATE_KWARGS


@pytest.mark.asyncio
async def test_anthropic_vision_call_uses_closed_set_of_kwargs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The Anthropic vision call forwards exactly model/max_tokens/system/messages."""
    monkeypatch.setattr(anthropic, "AsyncAnthropic", _KwargRecordingAnthropicClient)
    monkeypatch.delenv("LLM_MODEL", raising=False)
    image = ImagePayload(data=b64(JPEG_BYTES), media_type="image/jpeg")

    await generate_response(
        "",
        [],
        system_prompt="Transcribe this page.",
        api_key="sk-ant-server-key",  # pragma: allowlist secret
        images=[image],
    )

    assert set(_KwargRecordingAnthropicClient.last_create_kwargs) == _ANTHROPIC_CREATE_KWARGS


# ── F: Sentry allow-list stays closed ──────────────────────────────────────


def test_sentry_context_allowlist_is_closed() -> None:
    """SentryContext's allowed keys are locked to the three request-identity fields."""
    assert set(SentryContext.__annotations__) == {
        "request_id",
        "request_path",
        "request_method",
    }


# ── G: schema repr redaction -- Field(repr=False) on the payload/text ─────

_REPR_SENTINEL_IMAGE_B64 = "UkVQUl9TRU5USU5FTF9CQVNFNjRfUEFZTE9BRA=="
_REPR_SENTINEL_TEXT = "REPR_SENTINEL_TRANSCRIPTION_TEXT_4b7f"


def test_transcribe_request_repr_never_leaks_image_base64() -> None:
    """A TranscribePageRequest's repr()/str() must never surface the raw base64 image payload.

    The ``image_base64`` field must keep ``Field(repr=False)`` so pydantic's
    generated repr (which also backs ``str``) omits the payload; without it the
    value would leak into any log line or traceback that stringifies the model.
    """
    request = TranscribePageRequest(image_base64=_REPR_SENTINEL_IMAGE_B64, media_type="image/jpeg")

    assert _REPR_SENTINEL_IMAGE_B64 not in repr(request)
    assert _REPR_SENTINEL_IMAGE_B64 not in str(request)


def test_transcribe_response_repr_never_leaks_transcribed_text() -> None:
    """A TranscribePageResponse's repr()/str() must never surface the transcribed text.

    The ``text`` field must keep ``Field(repr=False)`` for the same reason as the
    request DTO above: the transcript must never leak into a stringified model.
    """
    response = TranscribePageResponse(text=_REPR_SENTINEL_TEXT)

    assert _REPR_SENTINEL_TEXT not in repr(response)
    assert _REPR_SENTINEL_TEXT not in str(response)
