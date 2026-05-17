"""Share-link tokens for forwarding a custom practice to another user.

A share link is a long-random URL-safe token bound to a single source
``practice_id``.  The owner mints the token via
``POST /practices/{practice_id}/share-link``; recipients preview the
shape of the practice with ``GET /practices/share/{token}`` and import
their own private copy with ``POST /practices/share/{token}/import``.

The token itself is the secret -- anyone who holds it can preview and
import.  Two enforcement levers narrow that window:

* ``expires_at`` -- optional wall-clock deadline.  Past-due tokens fail
  closed with 410 instead of 404 so the client can distinguish "you
  typo'd" from "the sender's link has aged out".
* ``max_uses`` / ``use_count`` -- optional redemption cap.  Each
  successful import increments ``use_count`` inside the same
  transaction that copies the practice so a race cannot exhaust the
  cap by even one redemption.
* ``revoked_at`` -- explicit revocation by the owner via
  ``DELETE /practices/share-links/{share_link_id}``.  Set once and
  never cleared -- a revoked link stays revoked.

Imported practices are independent copies (new row with
``approved=False`` and ``submitted_by_user_id`` set to the
recipient) so revoking the link does not retroactively unshare what
already landed in the recipient's catalog.
"""

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime
from sqlmodel import Field, SQLModel


class PracticeShareLink(SQLModel, table=True):
    """A token row authorising one or more imports of a source practice.

    ``token`` is a URL-safe base64 string minted from
    ``secrets.token_urlsafe(32)`` -- 32 random bytes encode to a 43-char
    string with 256 bits of entropy.  We store it plaintext (it is the
    capability) and index it for the point lookup the redeem endpoints
    do on every request.

    ``created_by_user_id`` is the owner who minted the link.  The DB
    keeps the FK as ``SET NULL`` on user deletion so audit history
    survives a right-to-be-forgotten purge.

    ``use_count`` starts at zero and ``UPDATE ... SET use_count =
    use_count + 1 WHERE ...`` increments atomically inside the import
    transaction so the cap holds even under concurrent redemptions.
    """

    id: int | None = Field(default=None, primary_key=True)
    token: str = Field(unique=True, index=True, max_length=64, nullable=False)
    practice_id: int = Field(foreign_key="practice.id", ondelete="CASCADE", index=True)
    created_by_user_id: int | None = Field(
        default=None, foreign_key="user.id", ondelete="SET NULL", index=True
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    expires_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    max_uses: int | None = Field(default=None)
    use_count: int = Field(default=0, nullable=False)
    revoked_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
