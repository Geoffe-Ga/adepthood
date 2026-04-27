"""Security primitives — helpers applied at trust boundaries.

Each module here owns one boundary: input sanitization, header validation,
etc.  Routers and services import from here rather than rolling per-call-site
checks so the rule is centralised and consistent.
"""

from security.text_sanitize import (
    DEFAULT_MAX_TEXT_LENGTH,
    TextTooLongError,
    sanitize_user_text,
)

__all__ = [
    "DEFAULT_MAX_TEXT_LENGTH",
    "TextTooLongError",
    "sanitize_user_text",
]
