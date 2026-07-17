"""Request/response DTOs for the stateless single-page transcription endpoint.

The Journal Photographer sends one photographed page as base64 image bytes and
receives back the faithful transcribed body text. The contract is deliberately
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


class TranscribePageRequest(BaseModel):
    """One photographed handwritten page submitted for transcription.

    ``image_base64`` is the base64-encoded image bytes and ``media_type`` its
    declared MIME type. Neither field is stored: the request is stateless, so
    the bytes live only for the duration of the single vision call.
    """

    image_base64: str = Field(min_length=1, description="Base64-encoded image bytes.")
    media_type: TranscribeMediaType = Field(description="Declared image MIME type.")


class TranscribePageResponse(BaseModel):
    """The transcribed body text for one page.

    ``text`` is the faithful transcription the client places into a draft
    journal entry. It is returned only, never persisted here: the endpoint
    writes no journal row, keeping the transcription contract stateless.
    """

    text: str = Field(description="Faithful transcribed body text for the page.")
