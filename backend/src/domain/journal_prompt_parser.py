"""Extract the journaling prompts of each stage from the vendored content.

The curriculum is the only copy of the prompt text. This module reads the
per-stage "The Journaling Prompts of <Colour>" chapter through
:class:`services.content_repository.ContentRepository` and turns its Markdown
into an ordered list of :class:`JournalPrompt` records. Nothing here re-types
a prompt, a cadence or a stage name into Python.

The parsing contract
--------------------
Stated explicitly because later work in this epic inherits it rather than
re-deriving it.

**Which chapter.** A stage is reached by its **colour**, never by its name:
:func:`domain.frequencies.frequency_for_color` is the single door, because the
Stage / Aspect / Mode labelings agree on six of the ten positions and diverge
on F5..F8, so a join on name mismatches exactly those four while looking
correct. Within that stage the prompt chapter is the one whose manifest slug
starts with ``the-journaling-prompts-of`` — which deliberately excludes Teal's
separate "Journaling Prompt Expansion" chapter.

**Which text.** Three body shapes exist in the snapshot and are tried in this
order; the first that yields at least :data:`_MINIMUM_PROMPT_COUNT` prompts
wins.

1. *Bold headers* — ``**Prompt N: Title (cadence)**``, and equivalently
   ``**Prompt N: Title** *(cadence)*``. Used by Blue, Orange, Green, Yellow,
   Teal, Ultraviolet and Clear Light. The prompt's body is everything between
   its header and the next one.
2. *Ordered list* — used by Beige and Red. The **last** run of ``1.`` ``2.``
   ``3.`` items in the chapter is the prompt list. Taking the last run rather
   than the first is what keeps Beige's opening list of general journaling
   *rules* out of the prompts; it is a structural rule, so it does not depend
   on the wording of the sentence that introduces the real list. An item runs
   until the next item's marker, so a continuation paragraph counts whether
   the author indented it under the marker or dedented it to column zero.
3. *Quoted paragraphs* — used by Purple, whose prompts are neither headers nor
   list items but paragraphs opening with a quotation mark.

**Titles and cadences.** ``title`` is the prompt's headline with any trailing
parenthetical removed; ``cadence`` is that parenthetical, or ``None`` where the
chapter states none. Cadence text is opaque prose written by the course author
and is never interpreted here — only located. Locating it by position rather
than by wording has one known false positive in the current snapshot, recorded
in the pull request: Clear Light's fourth prompt ends in a parenthetical that
qualifies its title rather than naming a cadence. That is a content-side
divergence to fix upstream, not a special case to encode here.

**Ordinals** are 1-based and run in curriculum order. Bold headers state their
own number and it is taken as written; the other two shapes state none, so
position is the only source. A test asserts the two agree for every stage, so a
chapter that misnumbers its headers fails rather than silently renumbering.

**Trailing prose.** A chapter's closing note (the Digital Sangha invitations,
Purple's coda) falls inside the last prompt's body, because no structural
marker separates it from that prompt. Prompt *titles* are unaffected.

**Failure is loud.** A chapter whose prompts cannot be located raises
:class:`JournalPromptParseError` rather than yielding an empty list, so a
content sync that changes shape fails the suite instead of silently emptying
the journal.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import cache

from domain.frequencies import Frequency, frequency_for_color
from services.content_repository import ChapterMeta, get_content_repository

# A run of ordered-list items or bold headers shorter than this is a false
# positive (a stray "1." in prose), not a prompt list. Beige, the shortest
# real chapter, carries three.
_MINIMUM_PROMPT_COUNT = 2

# Manifest slug prefix of the per-stage prompt chapter. Teal also ships a
# "journaling-prompt-expansion-..." chapter, which this prefix excludes.
_PROMPT_CHAPTER_SLUG_PREFIX = "the-journaling-prompts-of"

# ``**Prompt 3: Some Title (At least 4x per week)**`` and the variant that
# carries the cadence as an italic suffix outside the bold span.
_BOLD_HEADER = re.compile(
    r"^\*\*Prompt\s+(?P<ordinal>\d+)\s*:\s*(?P<label>.+?)\*\*"
    r"(?:\s*\*\((?P<italic>[^)]*)\)\*)?\s*$",
    re.MULTILINE,
)

# The trailing parenthetical of a headline, when the author put the cadence
# inside the bold span instead of after it.
_TRAILING_PARENTHETICAL = re.compile(r"^(?P<title>.*\S)\s*\((?P<cadence>[^()]*)\)$")

# A top-level ordered-list marker: ``2.`` at column zero, then the item text.
_LIST_ITEM = re.compile(r"^(?P<number>\d+)\.[ \t]+(?P<first>\S.*)$")

# A run of one or more blank lines — the only paragraph break left once every
# line has been stripped of its indentation.
_BLANK_LINE = re.compile(r"\n\s*\n")

# Openers Purple's prompt paragraphs use; the curly form is what the content
# actually ships, the straight one guards against a future sync normalising it.
_QUOTE_OPENERS = ('"', "“")

# The ten positions in canonical order, so a colour's stage number comes from
# the frequency vocabulary rather than from a second table written here.
_FREQUENCY_ORDER: tuple[Frequency, ...] = tuple(Frequency)


class JournalPromptParseError(Exception):
    """A stage's journaling prompts could not be located in its chapter."""


@dataclass(frozen=True)
class JournalPrompt:
    """One journaling prompt as the curriculum states it."""

    ordinal: int
    title: str
    body: str
    cadence: str | None = None

    @property
    def text(self) -> str:
        """The whole prompt — headline first, then its explanation."""
        return f"{self.title}\n\n{self.body}" if self.body else self.title


def _normalize(text: str) -> str:
    """Collapse a wrapped headline onto one line."""
    return " ".join(text.split())


def _paragraphs(text: str) -> list[str]:
    """Blank-line-separated paragraphs, each line stripped of indentation.

    Dedenting first is what lets a numbered item keep a continuation paragraph
    the author indented under its marker: after the strip, the run of blank
    lines is the only paragraph boundary left.
    """
    dedented = "\n".join(line.strip() for line in text.splitlines())
    return [block.strip() for block in _BLANK_LINE.split(dedented) if block.strip()]


def _segment_bounds(starts: list[int], limit: int) -> list[tuple[int, int]]:
    """Half-open spans running from each start marker to the next (or ``limit``)."""
    if not starts:
        return []
    return list(zip(starts, [*starts[1:], limit], strict=True))


def _split_title_and_body(segment: str) -> tuple[str, str]:
    """First paragraph as the headline, the rest as the body."""
    blocks = _paragraphs(segment)
    if not blocks:
        return "", ""
    return _normalize(blocks[0]), "\n\n".join(blocks[1:])


def _split_cadence(label: str, italic: str | None) -> tuple[str, str | None]:
    """Separate a headline from the cadence parenthetical it carries."""
    stripped = _normalize(label)
    if italic is not None:
        return stripped, italic.strip()
    trailing = _TRAILING_PARENTHETICAL.match(stripped)
    if trailing is None:
        return stripped, None
    return trailing["title"], trailing["cadence"].strip()


def _parse_bold_headers(body: str) -> list[JournalPrompt]:
    """Prompts introduced by ``**Prompt N: ...**`` headers."""
    matches = list(_BOLD_HEADER.finditer(body))
    prompts: list[JournalPrompt] = []
    for position, match in enumerate(matches):
        end = matches[position + 1].start() if position + 1 < len(matches) else len(body)
        title, cadence = _split_cadence(match["label"], match["italic"])
        prompts.append(
            JournalPrompt(
                ordinal=int(match["ordinal"]),
                title=title,
                body="\n\n".join(_paragraphs(body[match.end() : end])),
                cadence=cadence,
            )
        )
    return prompts


def _list_item_starts(lines: list[str]) -> list[tuple[int, int]]:
    """Line index and stated number of every top-level ordered-list marker."""
    candidates = ((index, _LIST_ITEM.match(line)) for index, line in enumerate(lines))
    return [(index, int(match["number"])) for index, match in candidates if match is not None]


def _last_list_run(items: list[tuple[int, int]]) -> list[int]:
    """Line indices of the final run of consecutively numbered items.

    A number that does not continue the previous one starts a fresh run, so
    the rules list that opens some chapters is discarded when the prompt list
    restarts at ``1.`` below it.
    """
    run: list[int] = []
    previous = 0
    for index, number in items:
        if number != previous + 1:
            run = []
        run.append(index)
        previous = number
    return run


def _strip_marker(line: str) -> str:
    """The text of an ordered-list item, without its ``N.`` marker."""
    match = _LIST_ITEM.match(line)
    return line if match is None else match["first"]


def _parse_ordered_list(body: str) -> list[JournalPrompt]:
    """Prompts written as the chapter's last top-level ordered list."""
    lines = body.splitlines()
    run = _last_list_run(_list_item_starts(lines))
    prompts: list[JournalPrompt] = []
    for ordinal, (start, end) in enumerate(_segment_bounds(run, len(lines)), start=1):
        chunk = [_strip_marker(lines[start]), *lines[start + 1 : end]]
        title, item_body = _split_title_and_body("\n".join(chunk))
        prompts.append(JournalPrompt(ordinal=ordinal, title=title, body=item_body))
    return prompts


def _parse_quoted_paragraphs(body: str) -> list[JournalPrompt]:
    """Prompts written as paragraphs that open with a quotation mark."""
    blocks = _paragraphs(body)
    starts = [index for index, block in enumerate(blocks) if block.startswith(_QUOTE_OPENERS)]
    prompts: list[JournalPrompt] = []
    for ordinal, (start, end) in enumerate(_segment_bounds(starts, len(blocks)), start=1):
        prompts.append(
            JournalPrompt(
                ordinal=ordinal,
                title=_normalize(blocks[start]),
                body="\n\n".join(blocks[start + 1 : end]),
            )
        )
    return prompts


def parse_prompts(body: str) -> tuple[JournalPrompt, ...]:
    """Every prompt in one chapter body, in curriculum order.

    Tries the three documented body shapes in order and returns the first that
    yields a plausible list. Raises :class:`JournalPromptParseError` when none
    does, so an unreadable chapter never degrades into an empty journal.
    """
    for strategy in (_parse_bold_headers, _parse_ordered_list, _parse_quoted_paragraphs):
        prompts = strategy(body)
        if len(prompts) >= _MINIMUM_PROMPT_COUNT:
            return tuple(prompts)
    msg = "no journaling prompts found in chapter body"
    raise JournalPromptParseError(msg)


def stage_number_for_color(colour: str) -> int:
    """The 1-based stage number at ``colour``.

    Goes through :func:`domain.frequencies.frequency_for_color` so this module
    holds no second copy of the colour-to-position rule.
    """
    code = frequency_for_color(colour)
    if code is None:
        msg = f"{colour!r} names no APTITUDE stage; the ten positions are fixed"
        raise JournalPromptParseError(msg)
    return _FREQUENCY_ORDER.index(code) + 1


def _prompt_chapter(stage: int) -> ChapterMeta:
    """The manifest entry for ``stage``'s journaling-prompt chapter."""
    for chapter in get_content_repository().list_chapters():
        if chapter.stage == stage and chapter.slug.startswith(_PROMPT_CHAPTER_SLUG_PREFIX):
            return chapter
    msg = f"the content manifest has no journaling-prompt chapter for stage {stage}"
    raise JournalPromptParseError(msg)


@cache
def prompts_for_color(colour: str) -> tuple[JournalPrompt, ...]:
    """Every journaling prompt of the stage at ``colour``, in order.

    Cached: the vendored content is immutable per deploy, so the Markdown is
    read and parsed once per process rather than per request. Tests that swap
    the content repository must call :func:`reset_prompt_cache_for_tests`.
    """
    chapter = _prompt_chapter(stage_number_for_color(colour))
    try:
        return parse_prompts(get_content_repository().read_body(chapter.id).body)
    except JournalPromptParseError as exc:
        msg = f"chapter {chapter.id!r} ({colour}) yielded no prompts: {exc}"
        raise JournalPromptParseError(msg) from exc


def reset_prompt_cache_for_tests() -> None:
    """Drop the parsed-prompt cache so the next read re-parses the content."""
    prompts_for_color.cache_clear()
