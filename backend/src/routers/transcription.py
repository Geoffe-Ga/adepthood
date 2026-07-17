"""Journal transcription API — stateless single-page handwriting transcription.

The Journal Photographer posts one photographed page (base64 image bytes) and
receives back the faithful transcribed body text for a draft entry. The endpoint
is deliberately stateless: it writes no journal row and associates the metered
LLM call with no ``journal_entry_id``. Ordering is strict — validate the image
before charging, charge before the LLM call, and roll the charge back on any
provider failure — so a rejected or failed request never bills the wallet.

Privacy invariant: the base64 payload and the transcribed text are never logged,
interpolated into an exception message, or otherwise emitted anywhere. Only
metadata (user id, token count) is logged.
"""

from __future__ import annotations

import base64
import binascii
import logging
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from domain.transcription import build_transcription_prompt
from errors import bad_gateway, unprocessable
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.transcription import TranscribePageRequest, TranscribePageResponse
from services.botmason import (
    ImagePayload,
    LLMProviderError,
    LLMResponse,
    LLMVisionUnsupportedError,
    generate_response,
    resolve_chat_api_key,
)
from services.llm_usage import record_llm_usage
from services.wallet import preflight_deduction

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/journal", tags=["journal"])

# Anthropic caps a single image at 5 MB of *decoded* bytes; larger attachments
# are rejected by the provider after we would have already burned the request,
# so we enforce the same ceiling locally before any wallet or LLM work.
MAX_TRANSCRIBE_IMAGE_BYTES = 5 * 1024 * 1024

# Cheap oversize pre-guard on the *encoded* string, so a huge payload is rejected
# without allocating the decoded bytes. Base64 expands raw bytes by 4/3; the
# ``+ 4`` absorbs the padding block so a legitimately max-sized image is not
# rejected by rounding.
_MAX_TRANSCRIBE_BASE64_CHARS = (MAX_TRANSCRIBE_IMAGE_BYTES * 4) // 3 + 4

# Twice the resonance endpoint's 10/minute: a single capture session can fan out
# to ~10 page calls, so the transcription limit is doubled to admit one whole
# session without throttling while still bounding abuse.
TRANSCRIBE_RATE_LIMIT = "20/minute"

# Magic-byte signatures used to confirm the decoded bytes match the declared
# media type. Literal byte prefixes keep the sniff dependency-free (no
# python-magic) and branch-light so complexity stays at xenon rank A.
_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_RIFF_MAGIC = b"RIFF"
_WEBP_MAGIC = b"WEBP"
# A WebP header is ``RIFF`` (0-4), a 4-byte size (4-8), then ``WEBP`` (8-12).
_WEBP_HEADER_LENGTH = 12


def _is_jpeg(raw: bytes) -> bool:
    """Return True when ``raw`` opens with the JPEG magic-byte prefix."""
    return raw.startswith(_JPEG_MAGIC)


def _is_png(raw: bytes) -> bool:
    """Return True when ``raw`` opens with the 8-byte PNG signature."""
    return raw.startswith(_PNG_MAGIC)


def _is_webp(raw: bytes) -> bool:
    """Return True when ``raw`` is a RIFF/WEBP container of at least header length."""
    return len(raw) >= _WEBP_HEADER_LENGTH and raw[0:4] == _RIFF_MAGIC and raw[8:12] == _WEBP_MAGIC


# Dispatch table mapping a declared media type to its pure magic-byte predicate,
# so the sniff is a single table lookup rather than a branch cascade.
_MAGIC_SNIFFERS: dict[str, Callable[[bytes], bool]] = {
    "image/jpeg": _is_jpeg,
    "image/png": _is_png,
    "image/webp": _is_webp,
}


def _decode_base64(image_base64: str) -> bytes:
    """Strictly decode base64, mapping any malformed input to 422 ``invalid_image``."""
    try:
        return base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise unprocessable("invalid_image") from exc


def _build_attachment(image_base64: str, media_type: str) -> ImagePayload:
    """Build the vision attachment, mapping its size-cap failure to ``image_too_large``.

    ``media_type`` is Literal-guarded upstream, so the only construction failure is
    the attachment's stricter encoded-length cap — a near-maximal payload that
    slips past the decoded cap by rounding — mapped to a clean 422 rather than
    surfacing later as a 500. This keeps :class:`ImagePayload` the single canonical
    size authority.
    """
    try:
        return ImagePayload(data=image_base64, media_type=media_type)
    except ValueError as exc:
        raise unprocessable("image_too_large") from exc


def _validate_image(image_base64: str, media_type: str) -> ImagePayload:
    """Validate the payload before any wallet or LLM work; return the attachment.

    Runs the cheapest checks first: an oversize pre-guard on the encoded string
    (no decode), then a strict base64 decode, then a decoded-size cap, then a
    magic-byte sniff against the declared ``media_type``. A mismatch or a decode
    failure is ``invalid_image``; an oversize payload is ``image_too_large``. The
    attachment is constructed here, before any charge, so no valid-looking payload
    reaches the wallet or LLM without passing every size gate. Never logs or
    interpolates the payload (privacy invariant).
    """
    if len(image_base64) > _MAX_TRANSCRIBE_BASE64_CHARS:
        raise unprocessable("image_too_large")
    raw = _decode_base64(image_base64)
    if len(raw) > MAX_TRANSCRIBE_IMAGE_BYTES:
        raise unprocessable("image_too_large")
    if not _MAGIC_SNIFFERS[media_type](raw):
        raise unprocessable("invalid_image")
    return _build_attachment(image_base64, media_type)


async def _run_transcription(
    session: AsyncSession, image: ImagePayload, api_key: str | None
) -> LLMResponse:
    """Run the vision LLM for one page; roll the charge back on any provider error.

    The wallet was already deducted, so a failure here must un-deduct it: both
    branches roll the session back before mapping the error. ``LLMVisionUnsupportedError``
    is checked first because it subclasses :class:`LLMProviderError` — a
    text-only model is a well-formed request the model cannot serve (422
    ``model_lacks_vision``), distinct from a genuine upstream failure (502
    ``llm_provider_error``).
    """
    try:
        return await generate_response(
            "",
            [],
            system_prompt=build_transcription_prompt(),
            api_key=resolve_chat_api_key(api_key),
            images=[image],
        )
    except LLMVisionUnsupportedError as exc:
        await session.rollback()
        raise unprocessable("model_lacks_vision") from exc
    except LLMProviderError as exc:
        await session.rollback()
        raise bad_gateway("llm_provider_error") from exc


@router.post("/transcribe-page", response_model=TranscribePageResponse)
@limiter.limit(TRANSCRIBE_RATE_LIMIT)
async def transcribe_page(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: TranscribePageRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    x_llm_api_key: Annotated[str | None, Header(alias="X-LLM-API-Key")] = None,
) -> TranscribePageResponse:
    """Transcribe one photographed handwritten page, charging one message.

    Stateless: no journal row is written and the metered call carries no
    ``journal_entry_id``. Strict ordering — the image is validated first (422
    without any charge), the wallet is deducted next (402 when out of capacity),
    then the vision LLM runs; a provider failure rolls the charge back so a
    failed pass never bills. Usage is metered (one row per real, non-stub call)
    and committed atomically with the charge.

    Only metadata (user id, total tokens) is logged — never the base64 image
    payload or the transcribed text.
    """
    image = _validate_image(payload.image_base64, payload.media_type)
    await preflight_deduction(session, current_user)
    response = await _run_transcription(session, image, x_llm_api_key)
    await record_llm_usage(
        session, user_id=current_user, journal_entry_id=None, responses=[response]
    )
    await session.commit()
    logger.info(
        "journal_page_transcribed",
        extra={"user_id": current_user, "total_tokens": response.total_tokens},
    )
    return TranscribePageResponse(text=response.text)
