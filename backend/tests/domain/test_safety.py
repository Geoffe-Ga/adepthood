"""Tests for the acute-distress screen in :mod:`domain.safety`.

The negative cases are load-bearing: they guard against pathologizing ordinary
darkness (grief, sadness, emptiness, the "dark night of the soul"), which the app
honors rather than flags (NORTH-STAR §10).
"""

import pytest

from domain.safety import DistressCategory, DistressSignal, assess_distress


@pytest.mark.parametrize(
    ("text", "category"),
    [
        ("I want to kill myself", DistressCategory.SUICIDAL_INTENT),
        ("Some nights I just want to die.", DistressCategory.SUICIDAL_INTENT),
        ("Everyone would be better off dead without me.", DistressCategory.SUICIDAL_INTENT),
        ("I keep thinking about how to end my life.", DistressCategory.SUICIDAL_INTENT),
        ("I've been feeling suicidal again.", DistressCategory.SUICIDAL_INTENT),
        ("I cut myself last night.", DistressCategory.SELF_HARM),
        ("I want to hurt myself when it gets bad.", DistressCategory.SELF_HARM),
        ("the self-harm urges came back", DistressCategory.SELF_HARM),
        ("I'm going to hurt him if he comes back.", DistressCategory.INTENT_TO_HARM),
        ("I want to kill them all.", DistressCategory.INTENT_TO_HARM),
        ("I stopped taking my meds two days ago.", DistressCategory.MEDICATION_CESSATION),
        ("I'm quitting my antidepressants.", DistressCategory.MEDICATION_CESSATION),
        ("I went off my medication last week.", DistressCategory.MEDICATION_CESSATION),
        ("I flushed my pills down the toilet.", DistressCategory.MEDICATION_CESSATION),
    ],
)
def test_acute_phrases_flag_elevated_with_category(text: str, category: DistressCategory) -> None:
    signal = assess_distress(text)
    assert signal == DistressSignal(level="elevated", category=category)


# Curated ordinary-darkness / grief / sadness / existential-struggle phrases.
# These MUST NOT flag — flagging them would pathologize developmental territory
# the app deliberately honors.
_ORDINARY_DARKNESS = [
    "I feel so empty today.",
    "the dark night of the soul",
    "I'm grieving my father.",
    "everything feels pointless lately",
    "I'm exhausted and sad.",
    "I've been so depressed this week.",
    "I feel like I'm dying inside, metaphorically.",
    "This grief is killing me, honestly.",
    "Nothing seems to matter anymore.",
    "I just want to disappear into the woods for a while.",
    "I'm tired of my medication's side effects.",
    "The loneliness has been crushing.",
    "I cried myself to sleep again.",
    "I feel hopeless about the future.",
    "My heart is broken after the breakup.",
]


@pytest.mark.parametrize("text", _ORDINARY_DARKNESS)
def test_ordinary_darkness_does_not_flag(text: str) -> None:
    signal = assess_distress(text)
    assert signal.level == "none"
    assert signal.category is DistressCategory.NONE


@pytest.mark.parametrize("text", ["", "   ", "\n\t  \n"])
def test_empty_or_whitespace_returns_none(text: str) -> None:
    assert assess_distress(text) == DistressSignal(level="none", category=DistressCategory.NONE)


def test_matching_is_case_insensitive() -> None:
    assert assess_distress("I WANT TO KILL MYSELF").category is (DistressCategory.SUICIDAL_INTENT)


def test_matching_normalizes_internal_whitespace() -> None:
    assert assess_distress("kill\n   myself").category is DistressCategory.SUICIDAL_INTENT


def test_no_substring_false_positive_on_word_boundary() -> None:
    # "skill" contains "kill" but must not match "kill myself".
    assert assess_distress("I want to upskill myself professionally.").level == "none"
