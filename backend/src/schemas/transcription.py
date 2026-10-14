"""Request/response DTOs for the stateless single-page transcription endpoint.

The Journal Photographer sends one captured image of text (a page, a screenshot,
a photo of a screen) as base64 image bytes and receives back the faithful
transcribed body text. The contract is deliberately
*stateless*: nothing on either DTO is persisted as a journal entry. The endpoint
runs the vision LLM and returns the text for the client to place into a draft;
no row is written for the image or its transcription, and no ``journal_entry_id``
is associated with the (metered) call.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# The only image media types the vision path accepts, mirroring
# ``services.botmason._ALLOWED_IMAGE_MEDIA_TYPES``. Declaring them as a
# ``Literal`` rejects any other value at the schema layer with a FastAPI-shaped
# 422 before the handler runs (and before any wallet or LLM work).
TranscribeMediaType = Literal["image/jpeg", "image/png", "image/webp"]

# Typed as a plain string, not a ``Literal`` of the tiers, on purpose: the
# router judges it with :func:`domain.privacy_tier.admits_egress`, the one
# allowlist, so ``intimate``, an unknown tier, the empty string and a
# wrong-case spelling all get the same typed 403 ``tier_refused`` rather than
# some of them a schema 422. Required, so a client that declares nothing is
# refused by the schema before the handler runs (#3059 AC15).
_CLASSIFICATION_DESCRIPTION = (
    "The declared privacy tier of the entry the page belongs to. Only `personal` "
    "and `public` may be read; any other value, `intimate` included, is refused "
    "403 `tier_refused` before anything is charged or sent to a model."
)


class TranscribePageRequest(BaseModel):
    """One captured image of text (a page, screenshot, or screen) to transcribe.

    ``image_base64`` is the base64-encoded image bytes and ``media_type`` its
    declared MIME type. ``classification`` is the tier of the entry the page
    belongs to, judged before anything else. No field is stored: the request
    is stateless, so the bytes live only for the duration of the single vision
    call.
    """

    image_base64: str = Field(
        min_length=1,
        description="Base64-encoded image bytes.",
        # Kept out of ``repr()``/``str()`` so the raw image payload can never
        # leak into logs or tracebacks that stringify the model.
        repr=False,
    )
    media_type: TranscribeMediaType = Field(description="Declared image MIME type.")
    classification: str = Field(description=_CLASSIFICATION_DESCRIPTION)


class DirectAdmissionRequest(BaseModel):
    """What a device declares before reading a page with its own vendor (ADR 0009).

    Only the page's tier: never the page, never the key. The server admits a
    read only for a tier that may leave the primary boundary, so it never
    admits an Intimate page to a vendor it cannot see.
    """

    classification: str = Field(description=_CLASSIFICATION_DESCRIPTION)


class TranscribePageResponse(BaseModel):
    """The transcribed body text for one page.

    ``text`` is the faithful transcription the client places into a draft
    journal entry. It is returned only, never persisted here: the endpoint
    writes no journal row, keeping the transcription contract stateless.
    """

    text: str = Field(
        description="Faithful transcribed body text for the page.",
        # Kept out of ``repr()``/``str()`` so the transcribed page text can never
        # leak into logs or tracebacks that stringify the model.
        repr=False,
    )
