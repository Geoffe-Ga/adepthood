"""Tracks failed login attempts for account lockout and audit logging."""

from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


class LoginAttempt(SQLModel, table=True):
    """Records each login attempt for brute-force protection and auditing.

    Failed attempts accumulate per email. After MAX_FAILED_ATTEMPTS consecutive
    failures, the account is locked for LOCKOUT_DURATION. A successful login
    resets the counter.
    """

    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(index=True)
    ip_address: str = Field(default="")
    success: bool = Field(default=False)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
