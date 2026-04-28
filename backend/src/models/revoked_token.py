"""Tracks revoked JWT IDs (jti) so a refreshed token cannot be replayed.

BUG-AUTH-013: ``/auth/refresh`` previously minted a new token without
invalidating the old one, so a stolen-and-refreshed token kept working
until its original ``exp``.  Storing the old ``jti`` here on every
refresh closes that window: ``get_current_user`` now consults this
table and rejects any token whose ``jti`` is present.

Rows expire naturally at ``expires_at`` (the same instant as the
revoked token's ``exp``); a periodic cleanup job can prune past-due
rows but is not required for correctness — the lookup is keyed on
``jti`` so an unbounded table only costs disk, not query time.
"""

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime
from sqlmodel import Field, SQLModel


class RevokedToken(SQLModel, table=True):
    """A JWT ``jti`` that was explicitly revoked (refreshed away).

    Tokens minted before this column existed have no ``jti`` claim and
    are treated as legacy-but-valid by ``get_current_user`` for the
    duration of their original 1-hour TTL — that's the grace window
    the prompt requires for the JWT-shape change so existing sessions
    don't all 401 at once on deploy.
    """

    jti: str = Field(primary_key=True, max_length=64)
    expires_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, index=True),
    )
    revoked_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
