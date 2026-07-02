"""Unit tests for the shared page_has_more helper."""

from __future__ import annotations

from schemas.pagination import page_has_more


def test_offset_plus_limit_equals_total_is_not_more() -> None:
    assert page_has_more(offset=0, limit=10, total=10) is False


def test_offset_plus_limit_less_than_total_has_more() -> None:
    assert page_has_more(offset=0, limit=10, total=11) is True


def test_offset_plus_limit_greater_than_total_is_not_more() -> None:
    assert page_has_more(offset=8, limit=10, total=10) is False


def test_zero_total_is_never_more() -> None:
    assert page_has_more(offset=0, limit=10, total=0) is False
