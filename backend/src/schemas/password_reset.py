"""Pydantic schemas for the password-recovery flow.

Three tiny request shapes plus one response.  Each request mirrors the
``AuthRequest`` email-normalization rule (lower-case + strip) so the
column lookup uses the canonical form even when the user pasted in
``"  Foo@Bar.COM  "``.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, EmailStr, Field, field_validator

# Reset tokens are 256-bit ``secrets.token_urlsafe(32)`` values, which
# encode to 43 url-safe characters.  The bounds below give a generous
# floor (32 -- still 192 bits of entropy if the helper is ever swapped)
# and a ceiling that comfortably covers any future enlargement without
# leaving a request-body DoS lever wide open.
_TOKEN_MIN_LENGTH = 32
_TOKEN_MAX_LENGTH = 128

# Reuse the auth router's password length envelope so reset cannot
# bypass signup's rules.  These mirror ``_MIN_PASSWORD_LENGTH`` /
# ``_MAX_PASSWORD_LENGTH`` in ``routers.auth``; duplicated as
# constants here to keep the schema module standalone (importing the
# router would create a circular dep).
_MIN_PASSWORD_LENGTH = 8
_MAX_PASSWORD_LENGTH = 64


def _normalize_email_value(value: object) -> object:
    """Lower-case + strip an inbound email; pass non-strings through unchanged."""
    if isinstance(value, str):
        return value.strip().lower()
    return value


class PasswordResetRequest(BaseModel):
    """Body for ``POST /auth/password-reset/request``."""

    email: EmailStr

    @field_validator("email", mode="before")
    @classmethod
    def _normalize_email(cls, value: object) -> object:
        """Strip whitespace and lowercase before EmailStr validation."""
        return _normalize_email_value(value)


class PasswordResetConfirm(BaseModel):
    """Body for ``POST /auth/password-reset/confirm``.

    ``token`` is the plaintext value the user clicked through from
    the reset email; the server bcrypt-checks it against the stored
    digest.  ``new_password`` honours the same length envelope as
    signup so reset cannot smuggle a 4-character password through.
    """

    token: Annotated[str, Field(min_length=_TOKEN_MIN_LENGTH, max_length=_TOKEN_MAX_LENGTH)]
    new_password: Annotated[
        str,
        Field(min_length=_MIN_PASSWORD_LENGTH, max_length=_MAX_PASSWORD_LENGTH),
    ]


class PasswordResetCancel(BaseModel):
    """Body for ``POST /auth/password-reset/cancel``."""

    token: Annotated[str, Field(min_length=_TOKEN_MIN_LENGTH, max_length=_TOKEN_MAX_LENGTH)]


class PasswordResetAccepted(BaseModel):
    """Generic 202 response shape for ``request`` -- identical on hit and miss.

    The constant message body is part of the anti-enumeration contract
    (SPEC R4): an attacker who scrapes ``request`` cannot learn whether
    any email is registered because the bytes returned never differ.
    """

    message: str
