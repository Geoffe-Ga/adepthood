"""The archive's two renderings, tested where they are pure.

JSON serialisation and Markdown layout have failure modes an end-to-end test
reaches only by accident — a column type nobody thought about, an entry with no
title, a reply the app wrote rather than the account. They are pure functions of
a row, so they are checked as pure functions of a row.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from services.data_export import _json_default, _render_entry

_WHEN = datetime(2026, 3, 14, 9, 30, tzinfo=UTC)
_BODY = "The willow bends and does not break."


def _entry(**overrides: Any) -> dict[str, Any]:  # noqa: ANN401 - row values are heterogeneous
    """One journal row's values, with the fields Markdown reads."""
    values: dict[str, Any] = {
        "timestamp": _WHEN,
        "title": "What the willow knows",
        "classification": "personal",
        "tag": "freeform",
        "sender": "user",
        "message": _BODY,
    }
    return values | overrides


def test_datetimes_are_rendered_as_iso_8601() -> None:
    """A timestamp a person can read and a machine can parse back."""
    assert _json_default(_WHEN) == "2026-03-14T09:30:00+00:00"


def test_decimals_keep_their_exact_value() -> None:
    """Rendered as a string rather than a float, so no cent is rounded away."""
    assert _json_default(Decimal("19.99")) == "19.99"


def test_an_unknown_type_refuses_rather_than_guessing() -> None:
    """A silent ``repr`` in an archive is a value the user cannot re-import."""
    with pytest.raises(TypeError, match="cannot serialise"):
        _json_default(object())


def test_a_titled_entry_leads_with_its_date_and_title() -> None:
    """The heading is what a reader scans; it carries both."""
    rendered = _render_entry(_entry())

    assert rendered.startswith("## 2026-03-14 — What the willow knows")
    assert _BODY in rendered
    assert "*personal · freeform*" in rendered


def test_an_untitled_entry_leads_with_its_date_alone() -> None:
    """No trailing em dash hanging off an entry that was never named."""
    rendered = _render_entry(_entry(title=None))

    assert rendered.startswith("## 2026-03-14\n")


def test_a_reply_the_account_did_not_write_says_so() -> None:
    """A resonance reply in the same stream is attributed, not passed off."""
    rendered = _render_entry(_entry(sender="bot"))

    assert "written by bot" in rendered
