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

Negation is handled deterministically, not with a parser. Before matching, the
Unicode curly apostrophe (U+2019) is folded to ASCII ``'`` so iOS smart
punctuation matches the phrase lists. A candidate phrase match is suppressed only
when a negator (e.g. "never", "not", "no plans to", "don't") appears in the
window of :data:`_NEGATION_WINDOW_WORDS` whitespace tokens strictly *before* the
match, within the same clause (the window is clipped at the last ``.``, ``!``,
``?``, ``;``, or ``,``, so a negator in an earlier clause cannot suppress genuine
intent in a later one). Logical negators ("never", "not", "don't", …) are counted
by parity: an odd count negates, an even count (including zero) does not, so
double negation ("I can't say I don't want to die") still flags. Temporal
negators ("used to", "no longer") negate only when they directly abut the match,
so a present-tense signal is never suppressed by a distant one ("more than I used
to I want to die" still flags). Because the window is strictly before the match, a
negator that is itself part of a positive phrase (the "don't" in "don't want to
be alive anymore") can never suppress that phrase.

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

# Unicode curly apostrophe (iOS smart punctuation) folded to ASCII before matching.
_CURLY_APOSTROPHE = "\N{RIGHT SINGLE QUOTATION MARK}"

# Number of whitespace tokens before a match inspected for a negator.
_NEGATION_WINDOW_WORDS = 5

# Logical negators that invert intent wherever they sit in the preceding window;
# counted by parity. Multi-word alternatives come first so they win over their
# single-word prefixes. Bare "no" is excluded: it would negate "No. I want to
# kill myself".
_LOGICAL_NEGATORS = re.compile(
    r"\b(?:no plans? to|no intention|no desire|never|not|cannot"
    r"|don'?t|won'?t|wouldn'?t|couldn'?t|can'?t|didn'?t|doesn'?t|haven'?t"
    r"|isn'?t|ain'?t)\b",
    re.IGNORECASE,
)

# Temporal negators only negate when they directly abut the matched phrase
# ("I used to cut myself"). A distant one must not suppress a present-tense signal
# ("more than I used to I want to die" still flags), so they are matched only at
# the very end of the window rather than counted anywhere in it.
_TEMPORAL_NEGATOR = re.compile(r"\b(?:no longer|used to)\s*$", re.IGNORECASE)

# Clause boundaries clip the preceding window. Commas count: a negator in an
# earlier clause must not suppress genuine intent in a later one, so a mixed
# statement ("I would never hurt myself, but I want to kill him") still flags.
_CLAUSE_BOUNDARY = re.compile(r"[.!?;,]")


def _tail_window(prefix: str) -> str:
    """Return the last :data:`_NEGATION_WINDOW_WORDS` tokens of ``prefix``.

    ``prefix`` is first clipped to the current clause — only the text after the
    last clause-boundary character (``.``, ``!``, ``?``, ``;``, ``,``) is kept.
    """
    boundaries = list(_CLAUSE_BOUNDARY.finditer(prefix))
    if boundaries:
        prefix = prefix[boundaries[-1].end() :]
    return " ".join(prefix.split()[-_NEGATION_WINDOW_WORDS:])


def _is_negated(normalized: str, match_start: int) -> bool:
    """Return whether the match at ``match_start`` is negated by preceding text.

    Only text strictly before the match is inspected, so a negator that is part of
    a positive phrase cannot self-suppress. An odd number of logical negators in
    the window negates; an even number (including zero) does not, so double
    negation still flags. A temporal negator negates only when it directly abuts
    the match.
    """
    window = _tail_window(normalized[:match_start])
    if _TEMPORAL_NEGATOR.search(window):
        return True
    return len(_LOGICAL_NEGATORS.findall(window)) % 2 == 1


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
    not pathologize ordinary darkness. Explicit denials ("I would never kill
    myself") are suppressed by preceding-window negation handling. This is a
    screen, not a diagnosis, and introduces no medication, treatment, or medical
    advice.
    """
    folded = text.replace(_CURLY_APOSTROPHE, "'")
    normalized = re.sub(r"\s+", " ", folded).strip().lower()
    if not normalized:
        return _NONE
    for category, pattern in _COMPILED:
        for match in pattern.finditer(normalized):
            if not _is_negated(normalized, match.start()):
                return DistressSignal(level="elevated", category=category)
    return _NONE
