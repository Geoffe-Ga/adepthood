"""Pure-domain tests for the per-week default prompt title (band label).

Pins ``domain.weekly_prompts.prompt_title_for_week(week_number) -> str | None``:
a 12-band table (Beige, Purple, Red, Blue, Orange, Green, Yellow, Turquoise,
Coral, Teal, Indigo, Ultraviolet), three weeks each, format
``"{band} week {week_in_band} Prompt #1"``. Out-of-range weeks return None.
"""

from __future__ import annotations

import pytest

from domain.weekly_prompts import prompt_title_for_week


@pytest.mark.parametrize(
    ("week_number", "expected_title"),
    [
        (1, "Beige week 1 Prompt #1"),
        (3, "Beige week 3 Prompt #1"),
        (4, "Purple week 1 Prompt #1"),
        (8, "Red week 2 Prompt #1"),
        (36, "Ultraviolet week 3 Prompt #1"),
    ],
)
def test_prompt_title_for_week_matches_band_label(week_number: int, expected_title: str) -> None:
    assert prompt_title_for_week(week_number) == expected_title


@pytest.mark.parametrize(
    ("week_number", "expected_title"),
    [
        (1, "Beige week 1 Prompt #1"),
        (4, "Purple week 1 Prompt #1"),
        (7, "Red week 1 Prompt #1"),
        (10, "Blue week 1 Prompt #1"),
        (13, "Orange week 1 Prompt #1"),
        (16, "Green week 1 Prompt #1"),
        (19, "Yellow week 1 Prompt #1"),
        (22, "Turquoise week 1 Prompt #1"),
        (25, "Coral week 1 Prompt #1"),
        (28, "Teal week 1 Prompt #1"),
        (31, "Indigo week 1 Prompt #1"),
        (34, "Ultraviolet week 1 Prompt #1"),
    ],
)
def test_prompt_title_for_week_band_order_is_pinned(week_number: int, expected_title: str) -> None:
    assert prompt_title_for_week(week_number) == expected_title


@pytest.mark.parametrize("week_number", [0, 37])
def test_prompt_title_for_week_out_of_range_is_none(week_number: int) -> None:
    assert prompt_title_for_week(week_number) is None
