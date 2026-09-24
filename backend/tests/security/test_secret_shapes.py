"""Each secret shape the draft redactor knows, caught -- and ordinary text, left alone.

One positive per pattern, so deleting any single pattern turns exactly one test
red, and a set of negatives so a pattern loosened into eating ordinary triage
text (a bare path, a version number, a dotted screen token) is caught too.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from security.secret_shapes import (
    APP_LINK_SCHEME,
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


# Every link shape this application itself emits, from the sweep for #2925's
# review: the reset and cancel links in both reset emails (web origin and the
# ``adepthood://`` deep link), and the practice share link, whose capability
# token rides in the PATH rather than a query. Any one of them pasted into an
# operator note must not survive into a draft.
_SECRET_TOKEN = "SeCrEtToKeN0123456789"  # pragma: allowlist secret
_EMITTED_LINKS = (
    f"adepthood://reset-password?token={_SECRET_TOKEN}",
    f"adepthood://cancel-reset?token={_SECRET_TOKEN}",
    f"adepthood://practices/share/{_SECRET_TOKEN}",
    f"https://app.example.com/reset-password?token={_SECRET_TOKEN}",
    f"https://app.example.com/cancel-reset?token={_SECRET_TOKEN}",
    f"http://localhost:8081/reset-password?token={_SECRET_TOKEN}",
)


@pytest.mark.parametrize("link", _EMITTED_LINKS)
def test_every_link_the_app_emits_is_redacted(link: str) -> None:
    """Reset, cancel and share links, over every scheme the app uses."""
    redacted = redact_secret_shapes(f"it said {link} and then broke")
    assert _SECRET_TOKEN not in redacted
    assert redacted == f"it said {REDACTED_URL} and then broke"


@pytest.mark.parametrize(
    "link",
    [
        f"exp://192.168.1.4:8081/--/reset-password?token={_SECRET_TOKEN}",
        f"intent://reset-password?token={_SECRET_TOKEN}",
        f"myapp+beta://x?code={_SECRET_TOKEN}",
    ],
)
def test_a_link_with_a_query_is_redacted_whatever_its_scheme(link: str) -> None:
    """The query is where the secret lives, and the scheme does not change that."""
    assert _SECRET_TOKEN not in redact_secret_shapes(link)


def test_the_redacted_app_scheme_is_the_one_the_app_registers() -> None:
    """The scheme the client registers in app.json is the one redacted wholesale."""
    app_json = Path(__file__).resolve().parents[3] / "frontend" / "app.json"
    registered = json.loads(app_json.read_text(encoding="utf-8"))["expo"]["scheme"]
    assert registered == APP_LINK_SCHEME
