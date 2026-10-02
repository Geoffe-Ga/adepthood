"""The reset email must ship both representations of the same content.

#2537 made the link openable in a browser.  This pins the other half: the
message a user actually sees looks like the product rather than like a
raw URL dump, without the plain-text body losing anything.
"""

from __future__ import annotations

import re

import pytest

from routers.auth import _build_reset_email
from services.app_links import APP_BASE_URL_ENV_VAR

ORIGIN = "https://app.example.test"
# Prose standing an ASCII double hyphen in for a dash (#2823): whitespace or an
# edge on both sides, so "<!--" markup and a "--flag" are not mistaken for one.
ASCII_DOUBLE_HYPHEN_DASH = re.compile(r"(?:^|\s)--(?:\s|$)")
TOKEN = "tok3n-value"


@pytest.fixture(autouse=True)
def _origin(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the configured web origin; the builder must never read a header."""
    monkeypatch.setenv(APP_BASE_URL_ENV_VAR, ORIGIN)


def test_plain_text_body_is_unchanged_in_substance() -> None:
    """The text part stays the contract: both actions, both schemes."""
    payload = _build_reset_email("user@example.com", TOKEN)
    assert f"{ORIGIN}/reset-password?token={TOKEN}" in payload.body
    assert f"{ORIGIN}/cancel-reset?token={TOKEN}" in payload.body
    assert f"adepthood://reset-password?token={TOKEN}" in payload.body


def test_html_alternative_is_attached() -> None:
    """Without this the branded template is dead code nobody receives."""
    payload = _build_reset_email("user@example.com", TOKEN)
    assert payload.html is not None
    assert f"{ORIGIN}/reset-password?token={TOKEN}" in payload.html


def test_html_offers_every_action_the_text_does() -> None:
    """An HTML reader must not be shown fewer ways out than a text reader."""
    payload = _build_reset_email("user@example.com", TOKEN)
    assert payload.html is not None
    for action in ("/reset-password?token=", "/cancel-reset?token="):
        assert action in payload.html
    assert "adepthood://reset-password?token=" in payload.html


def test_every_part_of_the_email_uses_the_house_dash() -> None:
    """The plain-text part reads as the HTML part does: a spaced em dash (#2823)."""
    payload = _build_reset_email("user@example.com", TOKEN)
    assert "ignore this email \u2014 nothing happens until you click a link." in payload.body
    assert payload.html is not None
    for part in (payload.subject, payload.body, payload.html):
        assert ASCII_DOUBLE_HYPHEN_DASH.search(part) is None, part
