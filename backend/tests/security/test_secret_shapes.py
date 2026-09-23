"""Each secret shape the draft redactor knows, caught -- and ordinary text, left alone.

One positive per pattern, so deleting any single pattern turns exactly one test
red, and a set of negatives so a pattern loosened into eating ordinary triage
text (a bare path, a version number, a dotted screen token) is caught too.
"""

from __future__ import annotations

import pytest

from security.secret_shapes import (
    REDACTED_BEARER,
    REDACTED_EMAIL,
    REDACTED_JWT,
    REDACTED_KEY,
    REDACTED_URL,
    redact_secret_shapes,
)

_JWT = (
    "eyJhbGciOiJIUzI1NiJ9"  # pragma: allowlist secret
    ".eyJzdWIiOiI0MiJ9"  # pragma: allowlist secret
    ".c2lnbmF0dXJlLWJ5dGVz"  # pragma: allowlist secret
)


@pytest.mark.parametrize(
    ("text", "secret", "marker"),
    [
        (f"the token was {_JWT} in the bar", _JWT, REDACTED_JWT),
        (
            "header said Bearer abc123.def-456_ghi",
            "abc123.def-456_ghi",
            REDACTED_BEARER,
        ),
        (
            "key sk-live0123456789abcdef leaked",  # pragma: allowlist secret
            "sk-live0123456789abcdef",  # pragma: allowlist secret
            REDACTED_KEY,
        ),
        (
            "gh token ghp_0123456789abcdefABCDEF0123 here",  # pragma: allowlist secret
            "ghp_0123456789abcdefABCDEF0123",  # pragma: allowlist secret
            REDACTED_KEY,
        ),
        (
            "slack xoxb-1234567890-abcdefgh here",  # pragma: allowlist secret
            "xoxb-1234567890-abcdefgh",  # pragma: allowlist secret
            REDACTED_KEY,
        ),
        (
            "aws AKIAABCDEFGHIJKLMNOP here",  # pragma: allowlist secret
            "AKIAABCDEFGHIJKLMNOP",  # pragma: allowlist secret
            REDACTED_KEY,
        ),
        (
            "opened https://app.example.com/reset?token=s3cr3t&u=4 and it broke",
            "token=s3cr3t",
            REDACTED_URL,
        ),
        ("write to me at tester.one+beta@mail.example.org please", "tester.one", REDACTED_EMAIL),
    ],
)
def test_each_secret_shape_is_replaced_by_its_marker(text: str, secret: str, marker: str) -> None:
    """The secret is gone and the marker naming its kind is in its place."""
    redacted = redact_secret_shapes(text)
    assert secret not in redacted
    assert marker in redacted


@pytest.mark.parametrize(
    "text",
    [
        "It broke on https://app.example.com/journal/shelf after I tapped save.",
        "Build 1.4.2+318 on journal.shelf, control habit_offer.accept.",
        "The bearer of bad news is the sync banner.",
        "I asked someone @ the office and they saw it too.",
        "Tapped task-list twice; nothing happened.",
    ],
)
def test_ordinary_triage_text_is_left_alone(text: str) -> None:
    """A bare path, a version, a dotted token or a stray @ is not a secret."""
    assert redact_secret_shapes(text) == text


def test_a_url_takes_the_address_inside_it_with_it() -> None:
    """URLs are redacted first, so their query's address is not half-redacted."""
    redacted = redact_secret_shapes("see https://x.example.com/?email=a@b.example.com ok")
    assert redacted == f"see {REDACTED_URL} ok"
