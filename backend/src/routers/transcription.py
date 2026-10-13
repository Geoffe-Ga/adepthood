"""Journal transcription API — stateless single-image text transcription.

The Journal Photographer posts one captured image (base64 image bytes) — a
handwritten or printed page, a screenshot, a photo of a screen — and receives
back the faithful transcribed body text for a draft entry. The endpoint is
deliberately stateless: it writes no journal row and associates the metered LLM
call with no ``journal_entry_id``. Ordering is strict — validate the image
before charging, charge before the LLM call, and roll the charge back on any
provider failure or unusable reply (no text found, or a refusal) — so a
rejected, failed, or refused request never bills the wallet.

Privacy invariant: the base64 payload and the transcribed text are never logged,
interpolated into an exception message, or otherwise emitted anywhere. Only
metadata (user id, token count) is logged.

**A writer's own key never reaches this router** (ADR 0009 phase (a), #3067).
A device holding a key reads the page by calling its vendor directly, after
asking :func:`direct_admission` -- which carries neither the key nor the page
-- whether the operator's external-AI incident switch is on. This route takes no
``X-LLM-API-Key`` header: one sent anyway by a stale client is not declared,
never read, never forwarded and never logged, so the request is keyless and is
refused ``llm_key_required`` unless the armed stub test seam answers it.
"""

from __future__ import annotations

import base64
import binascii
import logging
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from domain.transcription import (
    TranscriptionVerdict,
    build_transcription_prompt,
    classify_transcription,
)
from error_responses import build_router
from errors import bad_gateway, unprocessable
from rate_limit import limiter
from rate_limit_keys import per_user_rate_limit_key
from routers.auth import get_current_user
from schemas.transcription import TranscribePageRequest, TranscribePageResponse
from services.botmason import (
    ImagePayload,
    LLMProviderError,
    LLMResponse,
    generate_response,
)
from services.generation_access import require_ai_payer
from services.generation_guardrails import generation_slot
from services.llm_usage import (
    GenerationFeature,
    GenerationKey,
    GenerationOutcome,
    GenerationSettlement,
    log_generation_settled,
    record_llm_usage,
)
from services.privacy_suspension import require_external_ai_available
from services.wallet import preflight_deduction

logger = logging.getLogger(__name__)

# A page is one dial: there is no corrective retry on the transcription path.
_TRANSCRIPTION_ATTEMPTS = 1

router = build_router(
    prefix="/journal",
    tags=["journal"],
    # 402 is a payer refusal: this route never holds a key of the writer's own
    # (a device with one calls its vendor directly), so ``require_ai_payer``
    # refuses ``llm_key_required`` unless the armed stub test seam answers, and
    # ``preflight_deduction`` refuses an empty wallet on that seam.
    # 429 is the generation guardrails' (#623): the concurrent slot and the
    # wallet's daily ceiling; 503 is the slot failing closed.
    extra_statuses=(
        status.HTTP_402_PAYMENT_REQUIRED,
        status.HTTP_429_TOO_MANY_REQUESTS,
        status.HTTP_502_BAD_GATEWAY,
        status.HTTP_503_SERVICE_UNAVAILABLE,
    ),
)

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

# The same budget again, keyed on the account rather than the address. An
# unusable read (no text found, or a refusal) is rolled back uncharged (#2851),
# so the per-address limit alone would let one user buy unmetered provider
# calls by rotating addresses; this axis follows the identity instead.
TRANSCRIBE_USER_RATE_LIMIT = "20/minute"

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


async def _run_transcription(session: AsyncSession, image: ImagePayload) -> LLMResponse:
    """Run the keyless vision call for one page; roll back on any provider error.

    No key is ever passed: only the armed stub test seam can answer a keyless
    call, and the payer gate has already refused one it cannot. The vision and
    spent-balance arms this once mapped needed a writer's key reaching a vendor
    from here, which no longer happens -- a device with a key reads the page
    itself -- so a provider failure is the one condition left, and it rolls the
    staged debit back before answering 502 ``llm_provider_error``.
    """
    try:
        return await generate_response(
            "",
            [],
            system_prompt=build_transcription_prompt(),
            images=[image],
        )
    except LLMProviderError as exc:
        await session.rollback()
        raise bad_gateway("llm_provider_error") from exc


async def _reject_unusable_reply(
    session: AsyncSession, response: LLMResponse, user_id: int
) -> None:
    """Refuse a reply that is not page text, before it is metered or billed.

    A ``[no text found]`` sentinel (or an empty reply) and a short refusal are
    typed 422s (``no_text_found`` / ``transcription_refused``), never the page's
    text. The transaction is rolled back, discarding the server-path debit that
    ``preflight_deduction`` staged; the usage row has not been staged yet. This
    is a plain rollback rather than ``wallet.refund_one_message``: the writer is
    charged nothing and no usage row is kept, and the metadata-only log line
    below keeps the token count as the provider-cost trace. Only the verdict and
    metadata are logged — never the reply text or the image (privacy invariant).
    """
    verdict = classify_transcription(response.text)
    if verdict is TranscriptionVerdict.TRANSCRIBED:
        return
    await session.rollback()
    logger.info(
        "journal_page_transcription_unusable",
        extra={
            "user_id": user_id,
            "verdict": verdict.value,
            "total_tokens": response.total_tokens,
        },
    )
    raise unprocessable(verdict.value)


@router.post("/transcribe-page", response_model=TranscribePageResponse)
# Account axis registered first (decorators register bottom-up), as on
# ``POST /feedback/``: slowapi bills each bucket until one refuses, so an
# account that has spent its own budget stops draining the address budget it
# shares with everyone else behind that address.
@limiter.limit(TRANSCRIBE_RATE_LIMIT)
@limiter.limit(TRANSCRIBE_USER_RATE_LIMIT, key_func=per_user_rate_limit_key)
async def transcribe_page(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: TranscribePageRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TranscribePageResponse:
    """Transcribe one keyless image of text on the armed stub seam, or refuse.

    Stateless: no journal row is written and the metered call carries no
    ``journal_entry_id``. Strict ordering — an operator's external-AI
    suspension answers 503 ``ai_suspended`` before anything else (#3075), then
    the payer gate runs, then the image is validated (422 without any charge).
    This route holds no key of the writer's own -- a device with one reads the
    page by calling its vendor directly (ADR 0009 phase (a), #3067) -- so
    outside the armed stub test seam the gate refuses 402 ``llm_key_required``
    before the body is decoded and before the slot or the wallet is touched
    (#3096). On the seam the wallet is
    deducted (402 ``insufficient_offerings`` when out of capacity). A provider
    failure rolls the transaction back so a failed pass never bills, and so
    does a reply that is no text or a refusal (422 ``no_text_found`` /
    ``transcription_refused``). Usage is committed atomically with the charge.

    Only metadata (user id, total tokens) is logged — never the base64 image
    payload or the transcribed text.
    """
    require_external_ai_available()
    # The payer gate precedes validation: outside the stub seam a keyless page
    # can only be refused, so its body is never decoded.
    await require_ai_payer(session, current_user, None)
    image = _validate_image(payload.image_base64, payload.media_type)
    # One of the user's two concurrent generation slots (#623), held from
    # before the charge until the page settles; transcription keeps its own
    # 20/minute budget rather than the resonance/essay minute bucket.
    async with generation_slot(session, current_user):
        spent = await preflight_deduction(session, current_user)
        key = GenerationKey.for_spend(spent)
        response = await _run_transcription(session, image)
        await _reject_unusable_reply(session, response, current_user)
        usage = await record_llm_usage(
            session,
            user_id=current_user,
            journal_entry_id=None,
            responses=[response],
            generation=key,
        )
        await session.commit()
    # The kept page's settlement line (#623 PR3): counts only, never the page.
    # A refused or failed page rolls its charge back and is not a settled
    # generation, so it has no line here.
    log_generation_settled(
        GenerationSettlement(
            feature=GenerationFeature.TRANSCRIPTION,
            user_id=current_user,
            key=key,
            bucket=spent.bucket,
            outcome=GenerationOutcome.KEPT,
            attempts=_TRANSCRIPTION_ATTEMPTS,
            usage=usage,
        )
    )
    logger.info(
        "journal_page_transcribed",
        extra={"user_id": current_user, "total_tokens": response.total_tokens},
    )
    return TranscribePageResponse(text=response.text)


@router.post(
    "/transcribe-page/direct-admission",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    dependencies=[Depends(get_current_user)],
)
# The page-read budget, on both axes, so a device reading its own pages keeps
# the pace this route always allowed one capture session.
@limiter.limit(TRANSCRIBE_RATE_LIMIT)
@limiter.limit(TRANSCRIBE_USER_RATE_LIMIT, key_func=per_user_rate_limit_key)
async def direct_admission(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
) -> Response:
    """Say whether a device may read a page by calling its own vendor directly.

    A writer's own key never reaches this server (ADR 0009 phase (a), #3067):
    the device sends the page straight to the vendor that key belongs to. What
    the device cannot know is whether an operator has switched external AI off
    for a privacy incident (#3075), the one control meant to stop a BYOK call
    too, so it asks here first. The request carries no body, no key and no page;
    the answer is 204 with no body, or 503 ``ai_suspended``. Nothing is charged,
    metered or logged beyond the access line every request gets.
    """
    require_external_ai_available()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
