"""Schemas for the practice share-link feature.

Wire DTOs for the four share-link endpoints:

* ``POST /practices/{practice_id}/share-link`` -- :class:`ShareLinkCreateRequest`
  in, :class:`ShareLinkResponse` out.
* ``GET /practices/share/{token}`` -- :class:`ShareLinkPreviewResponse`.
* ``POST /practices/share/{token}/import`` -- :class:`ShareLinkImportResponse`.
* ``DELETE /practices/share-links/{share_link_id}`` -- 204, no body.

``ShareLinkPreviewResponse`` deliberately omits the original
``submitted_by_user_id`` so the preview cannot be turned into a
user-id enumeration oracle.  The owner's display handle (currently the
email's local part; populated by the router) sits in
``created_by_display_name`` instead.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# Upper bounds for the optional knobs the owner sets when minting a
# link.  ``MAX_EXPIRY_DAYS`` caps the wall-clock window so a forgotten
# link cannot live indefinitely; ``MAX_USES_CAP`` keeps the redemption
# counter inside a sane band so a typo (``max_uses=1000000``) doesn't
# masquerade as an unlimited link.  ``None`` on either field means the
# corresponding gate is disabled.
MAX_EXPIRY_DAYS = 365
MAX_USES_CAP = 1_000


class ShareLinkCreateRequest(BaseModel):
    """Owner-supplied knobs for a new share link.

    Both fields are optional: omitting ``expires_in_days`` mints a
    never-expiring link and omitting ``max_uses`` mints an unlimited
    one.  The router resolves ``expires_in_days`` into a concrete
    ``expires_at`` against ``datetime.now(UTC)`` at mint time so the
    persisted row is timezone-aware and not vulnerable to clock drift
    on the client.
    """

    expires_in_days: int | None = Field(default=None, ge=1, le=MAX_EXPIRY_DAYS)
    max_uses: int | None = Field(default=None, ge=1, le=MAX_USES_CAP)


class ShareLinkResponse(BaseModel):
    """Owner-facing view of a freshly minted (or listed) share link.

    Echoes back the ``token`` so the client can paste it into a
    share-sheet URL without an extra round trip.  ``use_count`` lets
    the owner see how many redemptions have happened; ``revoked_at``
    surfaces the terminal state for the active-links list rendered
    inside ``ShareSheet``.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    token: str
    practice_id: int
    created_at: datetime
    expires_at: datetime | None
    max_uses: int | None
    use_count: int
    revoked_at: datetime | None


class ShareLinkPreviewResponse(BaseModel):
    """Recipient-facing preview returned by ``GET /practices/share/{token}``.

    Mirrors the fields a normal practice GET returns minus anything
    that would leak the owner's user id.  The frontend renders this
    inside ``SharePreviewScreen`` with an Import button.
    """

    practice_id: int
    stage_number: int
    name: str
    description: str
    instructions: str
    default_duration_minutes: float
    mode: str
    mode_config: dict[str, Any]
    created_by_display_name: str | None = None
    expires_at: datetime | None = None
    max_uses: int | None = None
    use_count: int = 0


class ShareLinkImportResponse(BaseModel):
    """Result of redeeming a share link into a private draft.

    ``practice_id`` is the recipient's *new* copy -- the frontend
    navigates straight to its detail screen.  ``approved`` is always
    ``False`` so the frontend can keep the "draft / awaiting approval"
    badge in lockstep with the catalog filter.
    """

    practice_id: int
    stage_number: int
    name: str
    approved: bool
