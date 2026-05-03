"""Single-use, time-limited password-reset tokens.

The plaintext token is emailed to the user and never stored.  We persist
a bcrypt digest (cost 10 -- these are 256-bit randoms, not human input,
so cost-12 is wasted).  On confirm the digest is recomputed and matched
in constant time.  Rows live for the TTL window plus a 7-day audit tail
so abuse investigation can replay the trail; a periodic cleanup job
(out of scope here, mirrors the ``RevokedToken`` cleanup) prunes old
rows.

See ``routers.auth`` for the request / confirm / cancel endpoints and
``services.email`` for the email port that ships the plaintext token to
the registered address.
"""

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime
from sqlmodel import Field, SQLModel


class PasswordResetToken(SQLModel, table=True):
    """A bcrypt-digested password-reset token with a single-use lifecycle.

    State transitions:

    * ``created`` -- row inserted with ``used_at`` and ``cancelled_at``
      both ``NULL``.
    * ``confirmed`` -- ``used_at`` set when the user posts to
      ``/auth/password-reset/confirm`` with a matching token.
    * ``cancelled`` -- ``cancelled_at`` set when the user taps the
      "this wasn't me" link (``/auth/password-reset/cancel``).

    Either terminal state rejects subsequent confirms with the same
    generic 400 so an attacker cannot distinguish "already used" from
    "wrong token".
    """

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(
        foreign_key="user.id",
        index=True,
        nullable=False,
        ondelete="CASCADE",
    )
    token_hash: str = Field(nullable=False, max_length=128)
    requested_ip: str = Field(default="", max_length=64)
    requested_user_agent: str = Field(default="", max_length=256)
    expires_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, index=True),
    )
    used_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    cancelled_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
