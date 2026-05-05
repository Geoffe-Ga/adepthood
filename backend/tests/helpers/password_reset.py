"""Shared parsing helpers for password-reset endpoint tests.

The fixture definitions (``email_sender``, ``wire_email_sender``)
live in ``backend/tests/conftest.py`` so pytest auto-discovers them
without test modules needing to import-and-re-export them.  This
file holds only plain helpers that are imported normally.
"""

from __future__ import annotations

# Marker substring written by ``_build_reset_email`` -- the helpers
# below split on this to recover the plaintext token from a captured
# message body.  Keeping the constant here means a future template
# rename is one fix, not three.
_RESET_LINK_TOKEN_MARKER = "reset-password?token="


def extract_reset_token(body: str) -> str:
    """Pull the plaintext reset token out of a rendered email body.

    The reset email contains both ``reset-password?token=<X>`` and
    ``cancel-reset?token=<X>``; the value is the same on both lines.
    We parse the first occurrence and stop at the next newline.
    """
    start = body.index(_RESET_LINK_TOKEN_MARKER) + len(_RESET_LINK_TOKEN_MARKER)
    end = body.index("\n", start)
    return body[start:end]
