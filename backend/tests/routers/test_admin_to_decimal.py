"""Unit tests for :func:`routers.admin._to_decimal` — SUM-result coercion.

The helper exists to absorb the per-engine differences in what SQL
``SUM(NUMERIC)`` returns: Postgres yields a ``Decimal``, SQLite falls
back to a plain ``float`` (or ``int`` for integer columns), and an
empty-group ``COALESCE`` may produce ``None`` depending on the
``func.coalesce`` literal type.  Every branch must round-trip into a
``Decimal`` so the admin response shape is engine-agnostic.
"""

from __future__ import annotations

from decimal import Decimal

from routers.admin import _to_decimal


def test_to_decimal_passes_through_decimal() -> None:
    """A ``Decimal`` input is returned unchanged (Postgres SUM happy path)."""
    value = Decimal("1.234567")
    assert _to_decimal(value) is value


def test_to_decimal_coerces_none_to_zero() -> None:
    """``None`` (empty group on Postgres without ``COALESCE``) becomes zero."""
    assert _to_decimal(None) == Decimal(0)


def test_to_decimal_coerces_sqlite_float() -> None:
    """SQLite SUM returns a plain ``float``; coerce via ``str`` to keep precision."""
    # ``0.1 + 0.2`` is the canonical float-precision drift example.
    # Coercing via ``Decimal(str(...))`` preserves the displayed value
    # rather than the underlying binary noise.
    result = _to_decimal(0.1 + 0.2)
    # The float ``0.30000000000000004`` becomes the same string when
    # passed to ``str``, so the helper preserves whatever the caller
    # would have seen — but it's a ``Decimal`` now and amenable to
    # exact arithmetic downstream.
    assert isinstance(result, Decimal)
    assert str(result) == str(0.1 + 0.2)


def test_to_decimal_coerces_int() -> None:
    """SQLite SUM of an empty NUMERIC group can return ``int(0)``; coerce."""
    result = _to_decimal(0)
    assert result == Decimal(0)
    assert isinstance(result, Decimal)
