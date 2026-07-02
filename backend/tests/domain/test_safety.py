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
        ("I no longer want to be alive anymore", DistressCategory.SUICIDAL_INTENT),
        ("I no longer want to be alive", DistressCategory.SUICIDAL_INTENT),
        ("I don't want to be alive", DistressCategory.SUICIDAL_INTENT),
        ("I no longer want to live anymore", DistressCategory.SUICIDAL_INTENT),
        ("I wish I wasn't here", DistressCategory.SUICIDAL_INTENT),
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
    "I no longer want to live in fear.",
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


# iOS smart punctuation emits this curly apostrophe; the screen must treat it like
# a straight one. Built via a named escape so it reads unambiguously in source.
_CURLY = "\N{RIGHT SINGLE QUOTATION MARK}"

# Explicit denials of acute-distress phrasing. A negated statement must not flag
# — matching only the negation-blind phrase would wrongly pathologize a denial.
_NEGATED_DENIALS = [
    "I would never kill myself",
    "I do not want to die",
    "I have no plans to kill myself",
    "I am not going to hurt myself",
    "I promised I would never cut myself again",
    "I don't feel suicidal at all anymore",
    "I won't hurt myself",
    "I would never cut myself",
    "I would never kill him",
    "I don't want to hurt them",
    "I'm not going to stop taking my meds",
    "I would never quit my antidepressants",
    "I no longer want to die",
    "I used to cut myself",
    f"I don{_CURLY}t want to die",
    "I would never say I no longer want to be alive",
    "I don't wish I wasn't here",
]


@pytest.mark.parametrize("text", _NEGATED_DENIALS)
def test_negated_denials_do_not_flag(text: str) -> None:
    assert assess_distress(text) == DistressSignal(level="none", category=DistressCategory.NONE)


@pytest.mark.parametrize(
    ("text", "category"),
    [
        ("I want to kill myself tonight", DistressCategory.SUICIDAL_INTENT),
        ("I can't say I don't want to die", DistressCategory.SUICIDAL_INTENT),
        (
            "I would never hurt myself, but I want to kill him",
            DistressCategory.INTENT_TO_HARM,
        ),
        (
            "I said never before, but tonight I want to kill myself",
            DistressCategory.SUICIDAL_INTENT,
        ),
        ("No. I want to kill myself tonight.", DistressCategory.SUICIDAL_INTENT),
        ("I don't want to be alive anymore", DistressCategory.SUICIDAL_INTENT),
        (f"I don{_CURLY}t want to be alive anymore", DistressCategory.SUICIDAL_INTENT),
        (f"I wish I wasn{_CURLY}t here", DistressCategory.SUICIDAL_INTENT),
        ("Now more than I used to I want to die", DistressCategory.SUICIDAL_INTENT),
        ("I am not okay and lonely and I want to die", DistressCategory.SUICIDAL_INTENT),
    ],
)
def test_negation_does_not_suppress_genuine_signals(text: str, category: DistressCategory) -> None:
    assert assess_distress(text) == DistressSignal(level="elevated", category=category)
