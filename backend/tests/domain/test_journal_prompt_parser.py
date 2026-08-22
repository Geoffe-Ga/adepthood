"""Pins the journal-prompt parsing contract against the vendored content.

These tests read the real ``backend/content`` snapshot rather than fixtures:
the whole point of the parser is that the curriculum is the only copy of the
prompt text, so a fixture would reintroduce the second copy it exists to
delete. Synthetic bodies appear only where a *format* has to be pinned that
the current snapshot does not yet contain.
"""

from __future__ import annotations

import pytest

from domain.frequencies import FREQUENCY_COLORS
from domain.journal_prompt_parser import (
    JournalPromptParseError,
    parse_prompts,
    prompts_for_color,
    reset_prompt_cache_for_tests,
)

_ALL_COLORS = tuple(FREQUENCY_COLORS.values())

# Every stage chapter in the snapshot carries at least three prompts; Beige is
# the floor with exactly three, which is why a fixed count of four is wrong.
_MINIMUM_PROMPTS_ANY_STAGE = 3


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    """Drop the parsed-prompt cache so each test re-reads the content."""
    reset_prompt_cache_for_tests()


def test_orange_prompts_parse_in_curriculum_order() -> None:
    """Orange uses bold ``**Prompt N: Title (cadence)**`` headers."""
    prompts = prompts_for_color("Orange")

    assert len(prompts) == 4
    assert [p.ordinal for p in prompts] == [1, 2, 3, 4]
    assert prompts[1].title == "Make a List of 25 Curiosities"
    assert prompts[1].cadence == "At least 4x per week"
    assert "polyvagal theory" in prompts[1].body


def test_beige_skips_the_rules_list() -> None:
    """Beige's chapter opens with journaling *rules*, not prompts."""
    prompts = prompts_for_color("Beige")

    assert len(prompts) == 3
    joined = "\n".join(p.text for p in prompts)
    assert "Try to write at least once a week" not in joined
    assert "Don't reread or cross anything out" not in joined
    assert prompts[0].title.startswith("List the systemic, social, and cultural influences")


def test_red_numbered_list_has_no_rules_preamble() -> None:
    """Red's rules are prose, so its only ordered list is the prompt list."""
    prompts = prompts_for_color("Red")

    assert len(prompts) == 4
    assert prompts[1].title.startswith("Make a list of 15 outside influences")
    # Red's second prompt dedents its continuation paragraph to column 0; the
    # item must still absorb it rather than stopping at the blank line.
    assert "tear up the page" in prompts[1].body


def test_purple_quoted_paragraph_prompts() -> None:
    """Purple carries neither bold headers nor an ordered list."""
    prompts = prompts_for_color("Purple")

    assert len(prompts) == 5
    assert "abundance" in prompts[0].title
    assert prompts[1].title.strip('“”"') == "What am I grateful for?"
    assert all(p.cadence is None for p in prompts)


@pytest.mark.parametrize("colour", _ALL_COLORS)
def test_every_stage_yields_well_formed_prompts(colour: str) -> None:
    """All ten stages parse; none yields an empty or mis-ordinalled prompt."""
    prompts = prompts_for_color(colour)

    assert len(prompts) >= _MINIMUM_PROMPTS_ANY_STAGE
    assert [p.ordinal for p in prompts] == list(range(1, len(prompts) + 1))
    assert all(p.title.strip() for p in prompts)
    assert all(p.text.strip() for p in prompts)


def test_green_final_prompt_has_no_cadence() -> None:
    """A bold header without a trailing parenthetical yields ``None``."""
    prompts = prompts_for_color("Green")

    assert prompts[3].title == "Share and Discuss Shadow Work With Your Digital Sangha"
    assert prompts[3].cadence is None


def test_italic_cadence_suffix_is_supported() -> None:
    """The ``**Prompt N: Title** *(cadence)*`` form parses too.

    That form is not in the current snapshot but is used elsewhere in the
    corpus and is the shape upstream is moving to, so the parser accepts it
    now rather than breaking on the next content sync.
    """
    body = (
        "## Header\n\n"
        "**Prompt 1: Sit With It** *(Twice a week)*\n\n"
        "Body of the first prompt.\n\n"
        "**Prompt 2: Then Write** *(Daily)*\n\n"
        "Body of the second prompt.\n"
    )

    prompts = parse_prompts(body)

    assert [(p.title, p.cadence) for p in prompts] == [
        ("Sit With It", "Twice a week"),
        ("Then Write", "Daily"),
    ]


def test_unparseable_body_raises_rather_than_returning_nothing() -> None:
    """A chapter with no recognisable prompt list must fail loudly."""
    with pytest.raises(JournalPromptParseError):
        parse_prompts("## Nothing here\n\nJust a paragraph of prose.\n")


def test_single_item_list_is_not_accepted_as_a_prompt_list() -> None:
    """One stray ordered item is a false positive, not a prompt list."""
    with pytest.raises(JournalPromptParseError):
        parse_prompts("## Header\n\n1.  A lone numbered line.\n")


def test_unknown_colour_raises() -> None:
    """An eleventh colour is an ontology change, not a lookup miss."""
    with pytest.raises(JournalPromptParseError, match="Turquoise"):
        prompts_for_color("Turquoise")


def test_prompts_for_color_is_cached() -> None:
    """Repeat reads reuse the parsed list rather than re-reading markdown."""
    assert prompts_for_color("Teal") is prompts_for_color("Teal")


def test_clear_lights_fourth_prompt_still_reads_its_qualifier_as_a_cadence() -> None:
    """Pin the one known false positive, so it cannot change unnoticed.

    Cadence is located by position -- the trailing parenthetical -- and never by
    wording, which is deliberate: cadence text is prose the course author writes
    and this module does not get to interpret it. Clear Light's fourth prompt
    ends in a parenthetical that qualifies the *title* instead of naming a
    cadence, so it is read as one.

    That is a content-side divergence to fix upstream, not a special case to
    encode here -- but "known and documented" is not the same as "guarded".
    Without this, a positional-parsing tweak could silently change the reading
    in either direction and nothing would notice: fixing it would look like an
    unrelated refactor, and breaking the other three would look like this.

    So this test pins the wrong answer on purpose. **When the content is
    corrected upstream, this test fails, and that failure is the signal to
    delete it** -- not to reintroduce the reading.
    """
    prompts = prompts_for_color("Clear Light")
    fourth = prompts[3]

    assert fourth.title == "Write as the Adept"
    assert fourth.cadence == "Aspirational Identity", (
        "Clear Light prompt 4's parenthetical is a title qualifier, not a "
        "cadence. If this now reads differently, the content was fixed "
        "upstream -- delete this test rather than restoring the old reading."
    )

    # The other three carry real cadences, which is what makes the fourth a
    # divergence in the content rather than a parser that cannot find cadences.
    assert [p.cadence for p in prompts[:3]] == [
        "Whenever they arise",
        "At least 4x per week",
        "Daily",
    ]
