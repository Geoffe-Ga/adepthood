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
inside a stage cycle through that stage's prompts in curriculum order. Weeks
and prompts are therefore not 1:1, and two accessors exist for the two
questions callers actually ask: :func:`resolve_week_prompt` for "what does
this week serve", and :func:`stage_prompts` for "what does this stage carry",
which is the only one that can express a stage whose four prompts run to four
different rhythms.

A caller may also name a specific prompt by its 1-based ``ordinal``. An
ordinal the stage does not carry resolves to ``None`` rather than wrapping
around: Beige ships three prompts, so its fourth does not exist.
"""

from __future__ import annotations

from dataclasses import dataclass

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
    "StagePrompts",
    "WeekPrompt",
    "get_prompt_for_week",
    "prompt_title_for_week",
    "resolve_week_prompt",
    "stage_prompts",
]


@dataclass(frozen=True)
class StagePrompts:
    """One stage's whole prompt set, with the week the stage opens in."""

    stage: int
    band: str
    first_week: int
    prompts: tuple[JournalPrompt, ...]


@dataclass(frozen=True)
class WeekPrompt:
    """The prompt one program week serves, and the default title for it."""

    week_number: int
    band: str
    week_in_band: int
    prompt: JournalPrompt

    @property
    def question(self) -> str:
        """The prompt as the curriculum writes it — headline, then explanation."""
        return self.prompt.text

    @property
    def default_title(self) -> str:
        """The compose default: band, place in the band, and which prompt.

        Week 8 — the second Red week, drawing Red's second prompt — becomes
        ``"Red week 2 Prompt #2"``. A user may override it.
        """
        return f"{self.band} week {self.week_in_band} Prompt #{self.prompt.ordinal}"


def stage_prompts(stage_number: int) -> StagePrompts | None:
    """Every prompt the 1-based ``stage_number`` carries, or ``None`` out of range.

    ``first_week`` is summed from :data:`WEEKS_PER_STAGE` rather than assuming
    a uniform three weeks per stage, because the last two stages run six. The
    range is the fixed ten positions: an eleventh stage would be a change to
    the shared ontology, not a lookup that returns something.
    """
    if not 1 <= stage_number <= len(PROMPT_BANDS):
        return None
    index = stage_number - 1
    band = PROMPT_BANDS[index]
    return StagePrompts(
        stage=stage_number,
        band=band,
        first_week=sum(WEEKS_PER_STAGE[:index]) + 1,
        prompts=prompts_for_color(band),
    )


def _band_of_week(week_number: int) -> tuple[str, int]:
    """The band an in-range week falls in, and its 1-based place inside it.

    The walk always lands on a band, since the spans sum to ``TOTAL_WEEKS``.
    """
    week_in_band = week_number
    band_index = 0
    while week_in_band > WEEKS_PER_STAGE[band_index]:
        week_in_band -= WEEKS_PER_STAGE[band_index]
        band_index += 1
    return PROMPT_BANDS[band_index], week_in_band


def _select_prompt(
    prompts: tuple[JournalPrompt, ...], week_in_band: int, ordinal: int | None
) -> JournalPrompt | None:
    """The prompt ``ordinal`` names, or the one the week draws when none is named."""
    if ordinal is None:
        return prompts[(week_in_band - 1) % len(prompts)]
    return prompts[ordinal - 1] if 1 <= ordinal <= len(prompts) else None


def resolve_week_prompt(week_number: int, ordinal: int | None = None) -> WeekPrompt | None:
    """The prompt ``week_number`` serves, or its stage's ``ordinal``-th prompt.

    ``None`` for a week outside ``1..TOTAL_WEEKS`` and for an ordinal the
    week's stage does not carry. A week that is in range but whose chapter
    cannot be parsed raises
    :class:`domain.journal_prompt_parser.JournalPromptParseError` rather than
    degrading to an empty prompt.
    """
    if not 1 <= week_number <= TOTAL_WEEKS:
        return None
    band, week_in_band = _band_of_week(week_number)
    prompt = _select_prompt(prompts_for_color(band), week_in_band, ordinal)
    if prompt is None:
        return None
    return WeekPrompt(week_number=week_number, band=band, week_in_band=week_in_band, prompt=prompt)


def get_prompt_for_week(week_number: int, ordinal: int | None = None) -> str | None:
    """Return a week's prompt as the curriculum writes it, or ``None``.

    Mirrors :func:`resolve_week_prompt`'s range contract; ``ordinal`` names a
    specific prompt of the week's stage instead of the one the week draws.
    """
    resolved = resolve_week_prompt(week_number, ordinal)
    return None if resolved is None else resolved.question


def prompt_title_for_week(week_number: int, ordinal: int | None = None) -> str | None:
    """Return the default journal title for a week, or ``None`` if unresolvable.

    Mirrors :func:`get_prompt_for_week`'s contract, including ``ordinal``, so
    a response that answers a stage's third prompt is titled for that prompt.
    """
    resolved = resolve_week_prompt(week_number, ordinal)
    return None if resolved is None else resolved.default_title
