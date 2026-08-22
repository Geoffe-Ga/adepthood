"""Map a program week onto the journaling prompt the curriculum gives it.

The prompt text lives in ``backend/content`` and nowhere else; this module
only decides *which* prompt a week gets. It holds no prompt strings and no
stage names of its own — the ten positions come from
:mod:`domain.frequencies` and the week schedule from
:data:`domain.constants.WEEKS_PER_STAGE`.

Two things the old table got wrong, both worth naming so they do not return:

* **The bands are the ten APTITUDE positions, Beige through Clear Light.**
  They are reached by colour, never by name, because the Stage / Aspect /
  Mode labelings diverge at F5..F8 and a join on name mismatches exactly
  those four while looking correct.
* **Ten stages does not mean thirty weeks.** Eight stages run three weeks and
  two run six, so the program is thirty-six weeks long. That schedule is a
  cross-stack contract pinned on both sides; the week count is derived from
  it rather than asserted here.

A stage carries three to five prompts across three or six weeks, so weeks
inside a stage cycle through that stage's prompts in curriculum order. That
is an interim tiling of a one-prompt-per-week API onto a
several-prompts-per-stage curriculum; exposing the whole set per stage is
separate work.
"""

from __future__ import annotations

from domain.constants import TOTAL_PROGRAM_WEEKS, WEEKS_PER_STAGE
from domain.frequencies import FREQUENCY_COLORS
from domain.journal_prompt_parser import JournalPrompt, prompts_for_color

#: The ten stage colours in developmental order — the band labels a week's
#: default journal title is built from. Taken straight from the frequency
#: vocabulary so this module cannot drift from it.
PROMPT_BANDS: tuple[str, ...] = tuple(FREQUENCY_COLORS.values())

#: Total length of the program in weeks (36). Re-exported under the name the
#: prompts router and the program calendar already import.
TOTAL_WEEKS = TOTAL_PROGRAM_WEEKS

# ``WEEKS_PER_STAGE`` is re-exported deliberately: it is the companion of
# ``PROMPT_BANDS`` (weeks each band spans, same order) and callers reading one
# almost always need the other. There is no single weeks-per-band number —
# the last two bands are twice as long as the rest.
__all__ = [
    "PROMPT_BANDS",
    "TOTAL_WEEKS",
    "WEEKS_PER_STAGE",
    "get_prompt_for_week",
    "prompt_title_for_week",
]


def _resolve_week(week_number: int) -> tuple[str, int, JournalPrompt] | None:
    """The week's band, its place inside that band, and the prompt it draws.

    ``None`` for a week outside ``1..TOTAL_WEEKS``. The walk always lands on a
    band for an in-range week, since the spans sum to ``TOTAL_WEEKS``.
    """
    if not 1 <= week_number <= TOTAL_WEEKS:
        return None
    week_in_band = week_number
    band_index = 0
    while week_in_band > WEEKS_PER_STAGE[band_index]:
        week_in_band -= WEEKS_PER_STAGE[band_index]
        band_index += 1
    band = PROMPT_BANDS[band_index]
    prompts = prompts_for_color(band)
    return band, week_in_band, prompts[(week_in_band - 1) % len(prompts)]


def get_prompt_for_week(week_number: int) -> str | None:
    """Return the week's prompt as the curriculum writes it, or ``None``.

    ``None`` means the week is outside ``1..TOTAL_WEEKS``. A week that is in
    range but whose chapter cannot be parsed raises
    :class:`domain.journal_prompt_parser.JournalPromptParseError` rather than
    degrading to an empty prompt.
    """
    resolved = _resolve_week(week_number)
    return None if resolved is None else resolved[2].text


def prompt_title_for_week(week_number: int) -> str | None:
    """Return the default journal title for a week, or ``None`` if out of range.

    Mirrors :func:`get_prompt_for_week`'s range contract. The title is the
    week's band label, its position within that band, and which of the band's
    prompts the week draws — e.g. week 8 (the second Red week, drawing Red's
    second prompt) becomes ``"Red week 2 Prompt #2"``. This is the default a
    user sees in the compose title; they may override it.
    """
    resolved = _resolve_week(week_number)
    if resolved is None:
        return None
    band, week_in_band, prompt = resolved
    return f"{band} week {week_in_band} Prompt #{prompt.ordinal}"
