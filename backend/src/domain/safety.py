"""Acute-distress screening over a user's free text.

A pure, deterministic *screen* — not a diagnosis, not treatment, not advice. It
reads text and returns a typed :class:`DistressSignal` saying whether the writing
contains an **acute** distress signal (explicit suicidal intent, self-harm
intent, medication cessation, or intent to harm another) and, if so, which
category matched. Nothing here gives medical, medication, or treatment guidance;
it only classifies. Later sub-issues wire the signal into a care surface — this
module is wired into nothing.

Design — deliberately conservative
----------------------------------
Adepthood honors ordinary darkness — grief, sadness, emptiness, the "dark night
of the soul", existential struggle — as real developmental territory, and must
never pathologize it (NORTH-STAR §10). So matching is intentionally narrow: each
category fires only on phrasing that expresses *acute intent or action*, anchored
on word boundaries and matched case-insensitively over whitespace-normalized
text. When phrasing is ambiguous between ordinary darkness and acute distress we
prefer **not** to flag — a false negative here is a missed prompt to surface
human support (added later), while a false positive would shame someone in their
darkness. The phrase lists below are explicit and auditable rather than clever;
add to them only with a corresponding negative test guarding ordinary darkness.

Purity: no FastAPI, SQLModel, or network/LLM imports — only the standard library.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Literal

DistressLevel = Literal["none", "elevated"]


class DistressCategory(Enum):
    """Which acute-distress category matched, or ``NONE`` when nothing did."""

    NONE = "none"
    SUICIDAL_INTENT = "suicidal_intent"
    SELF_HARM = "self_harm"
    MEDICATION_CESSATION = "medication_cessation"
    INTENT_TO_HARM = "intent_to_harm"


@dataclass(frozen=True)
class DistressSignal:
    """The result of a screen: a level and the matched category.

    ``level`` is ``"elevated"`` only when ``category`` is non-``NONE``; a ``"none"``
    level always carries :attr:`DistressCategory.NONE`. This is a screen, never a
    diagnosis.
    """

    level: DistressLevel
    category: DistressCategory


_NONE = DistressSignal(level="none", category=DistressCategory.NONE)

# Acute-distress phrases per category. Each is matched case-insensitively, on
# word boundaries, over whitespace-normalized text. They target explicit intent
# or action — never ordinary sadness, grief, emptiness, or "dark night"
# reflection, which must pass through as ``none``. Ordering matters only for
# which category is reported first; categories are checked in list order below.
_PATTERNS: tuple[tuple[DistressCategory, tuple[str, ...]], ...] = (
    (
        DistressCategory.SUICIDAL_INTENT,
        (
            r"kill myself",
            r"end my life",
            r"take my (?:own )?life",
            r"want to die",
            r"going to die tonight",
            r"better off dead",
            r"suicidal",
            r"commit suicide",
            r"don'?t want to (?:be alive|live) anymore",
        ),
    ),
    (
        DistressCategory.SELF_HARM,
        (
            r"hurt myself",
            r"harm myself",
            r"cut myself",
            r"cutting myself",
            r"self[ -]harm",
        ),
    ),
    (
        DistressCategory.INTENT_TO_HARM,
        (
            r"kill (?:him|her|them|someone|everyone)",
            r"hurt (?:him|her|them|someone)",
            r"going to hurt (?:him|her|them|someone)",
            r"want to (?:kill|hurt) (?:him|her|them|someone)",
        ),
    ),
    (
        DistressCategory.MEDICATION_CESSATION,
        (
            r"stop(?:ping|ped)? (?:taking )?(?:my )?(?:meds|medication|pills|antidepressants)",
            r"quit(?:ting)? (?:my )?(?:meds|medication|antidepressants)",
            r"off my (?:meds|medication|antidepressants)",
            r"flush(?:ed|ing)? my (?:meds|medication|pills)",
        ),
    ),
)

_COMPILED: tuple[tuple[DistressCategory, re.Pattern[str]], ...] = tuple(
    (category, re.compile(rf"\b(?:{'|'.join(phrases)})\b", re.IGNORECASE))
    for category, phrases in _PATTERNS
)


def assess_distress(text: str) -> DistressSignal:
    """Screen ``text`` for an acute-distress signal; return a typed result.

    Returns :attr:`DistressLevel` ``"elevated"`` with the matched
    :class:`DistressCategory` when the text contains explicit acute-distress
    phrasing (suicidal intent, self-harm intent, intent to harm another, or
    medication cessation), and ``"none"`` otherwise. Empty or whitespace-only
    text returns ``none``.

    Matching is conservative by design (see the module docstring): it fires only
    on explicit intent/action phrasing and lets ordinary sadness, grief,
    emptiness, and "dark night" reflection pass through unflagged, so the app does
    not pathologize ordinary darkness. This is a screen, not a diagnosis, and
    introduces no medication, treatment, or medical advice.
    """
    normalized = re.sub(r"\s+", " ", text).strip().lower()
    if not normalized:
        return _NONE
    for category, pattern in _COMPILED:
        if pattern.search(normalized):
            return DistressSignal(level="elevated", category=category)
    return _NONE
