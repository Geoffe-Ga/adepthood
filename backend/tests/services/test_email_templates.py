"""Tests for the branded HTML half of outbound mail.

The plain-text body is the contract every client can render and the one
the dev console prints; the HTML part is an *alternative*, never a
replacement.  These tests pin that relationship, because an HTML-only
email is invisible to a text-only reader and an unstyled one is
indistinguishable from phishing.
"""

from __future__ import annotations

import re

import pytest

from services.email_templates import PALETTE, reset_email_html

ORIGIN = "https://app.aptitude.guru"
TOKEN = "cNpYTOeAELUeLkecSrgQZd0cYaK0zXsIqYvaCg9BPqM"  # pragma: allowlist secret


@pytest.fixture
def html() -> str:
    """Render the reset email once for the whole module."""
    return reset_email_html(ORIGIN, TOKEN)


def test_carries_both_https_actions(html: str) -> None:
    """Both actions the plain-text body offers must survive into the HTML."""
    assert f"{ORIGIN}/reset-password?token={TOKEN}" in html
    assert f"{ORIGIN}/cancel-reset?token={TOKEN}" in html


def test_keeps_the_native_deep_link(html: str) -> None:
    """An installed build registers ``adepthood://``; dropping it breaks native."""
    assert f"adepthood://reset-password?token={TOKEN}" in html


def test_states_the_expiry(html: str) -> None:
    """A link with no stated lifetime reads as broken when it lapses."""
    assert "30 minutes" in html


def test_is_a_complete_document(html: str) -> None:
    """Clients that inject a fragment into their own shell mangle bare markup."""
    assert html.lstrip().lower().startswith("<!doctype html")
    assert "</html>" in html.rstrip().lower()


def test_carries_no_script(html: str) -> None:
    """Every mail client strips script; shipping it only trips spam filters."""
    assert "<script" not in html.lower()
    assert "javascript:" not in html.lower()


def test_styles_are_inline_not_a_stylesheet(html: str) -> None:
    """Gmail strips ``<style>``; a design that lives there renders as nothing."""
    assert "<style" not in html.lower()
    assert 'style="' in html


def test_uses_the_candle_and_ink_palette(html: str) -> None:
    """The mail is the product's first impression and must look like it."""
    for token in ("canvas", "ink_primary", "accent_primary"):
        assert PALETTE[token] in html


def test_escapes_the_token_into_attributes() -> None:
    """A token is attacker-influenced only in theory, but it lands in an href."""
    hostile = 'a"><script>alert(1)</script>'
    rendered = reset_email_html(ORIGIN, hostile)
    assert "<script>alert(1)</script>" not in rendered
    assert "&lt;script&gt;" in rendered or "%3Cscript%3E" in rendered


def test_has_a_preheader_for_the_inbox_preview(html: str) -> None:
    """Without one, clients preview the first link's raw URL."""
    assert "preheader" in html.lower()


def test_every_anchor_has_a_discernible_name(html: str) -> None:
    """An anchor whose text is a bare URL is unreadable to a screen reader."""
    for anchor_text in re.findall(r"<a\b[^>]*>(.*?)</a>", html, flags=re.DOTALL):
        stripped = re.sub(r"<[^>]+>", "", anchor_text).strip()
        assert stripped, "anchor with no text content"
