"""Schema-level tests for ``UserPracticeCustomize`` size cap.

The integration test in ``tests/test_user_practice_customization.py`` covers
the end-to-end PATCH path; this file pins the schema contract in isolation
so a regression in the size cap can be caught without spinning up the
full async client + DB stack.
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from schemas.practice import (
    MODE_CONFIG_OVERRIDE_MAX_BYTES,
    UserPracticeCustomize,
)


def _padded(byte_count: int) -> dict[str, object]:
    """Construct an opaque dict whose JSON-encoded size is roughly ``byte_count``."""
    return {"mode": "meditation_timer", "duration_minutes": 10, "_pad": "x" * byte_count}


def test_override_under_cap_passes() -> None:
    """A small override is accepted by the size guard (schema layer)."""
    payload = _padded(100)
    assert len(json.dumps(payload).encode("utf-8")) < MODE_CONFIG_OVERRIDE_MAX_BYTES
    model = UserPracticeCustomize.model_validate({"mode_config_override": payload})
    assert model.mode_config_override == payload


def test_override_just_over_cap_fails_with_size_message() -> None:
    """A payload past the cap fires the size validator with an actionable message."""
    payload = _padded(MODE_CONFIG_OVERRIDE_MAX_BYTES + 100)
    assert len(json.dumps(payload).encode("utf-8")) > MODE_CONFIG_OVERRIDE_MAX_BYTES

    with pytest.raises(ValidationError) as exc:
        UserPracticeCustomize.model_validate({"mode_config_override": payload})
    assert "too large" in str(exc.value)


def test_none_override_skips_size_check() -> None:
    """``None`` clears the override; the size guard must accept it."""
    model = UserPracticeCustomize.model_validate({"mode_config_override": None})
    assert model.mode_config_override is None


def test_unicode_counted_by_utf8_byte_size_not_escaped_char_count() -> None:
    r"""Multibyte characters count by their wire size, not by their escaped length.

    Without ``ensure_ascii=False`` in the encoder, the JSON would escape every
    non-ASCII codepoint to ``\uXXXX`` (6 ASCII bytes per char). A 2 000-char
    Chinese payload would then measure 12 KB on the wire and trip the cap
    erroneously. With ``ensure_ascii=False`` it measures ~6 KB (3 bytes per
    codepoint in UTF-8) — well under the 8 KB cap, and accepted here.
    """
    chinese_padding = "字" * 2_000
    payload = {"mode": "meditation_timer", "duration_minutes": 10, "_pad": chinese_padding}
    # Verify the *wire* size is under cap so the test fails loudly if someone
    # later switches the encoder to ensure_ascii=True.
    assert (
        len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        < MODE_CONFIG_OVERRIDE_MAX_BYTES
    )

    model = UserPracticeCustomize.model_validate({"mode_config_override": payload})
    assert model.mode_config_override == payload
