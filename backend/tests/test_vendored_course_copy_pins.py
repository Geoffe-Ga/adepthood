"""Characterization pins on the vendored course's own curriculum wording.

The literals below are the *course's* words at the vendored content pin
recorded in ``backend/content/CONTENT_VERSION`` -- **not** the curriculum
dataset's.  They deliberately do **not** assert that the course wording equals
``archetypal_wavelength.json``'s subtitles: those two genuinely differ for
stages 1, 2, 4, 8, 9 and 10 today, so an equality test would be permanently red
and would have to grow a hand-maintained exception table -- the very duplicate
this pin exists to retire.

What the pin buys instead: ``make sync-content`` can never change curriculum
copy silently again.  **A failure here is a decision, not a typo.** It means a
re-pin moved the vendored tree and the course changed its own wording.  Go read
the upstream diff and decide whether the dataset follows, then update these
literals deliberately.  Never "fix" a literal just to make the suite green, and
never hand-edit ``backend/content/**`` to make it match.

Known divergence, tracked by issue #2706: the dataset says "True Self Wisdom"
for stage 8 (following ``aptitude-course`` commit ``3bf0df5``, 2026-07-31)
while the pin below still carries the course's older "Transcendent Wisdom",
because adepthood's vendored pin predates that commit.  The app's label
deliberately leads the vendored course until the re-pin lands -- at which point
this test goes red on stage 8, which is exactly what it is for.
"""

from __future__ import annotations

import itertools
import re
from collections.abc import Sequence
from pathlib import Path

from curriculum import stage_curriculum

_RESOURCES_DIR = Path(__file__).resolve().parents[1] / "content" / "markdown" / "resources"

_STAGES_FILE = "aptitude-stages.md"
_ABOUT_FILE = "about.md"

#: The APTITUDE curriculum has exactly ten stages.  Asserted for both parses so
#: a parser that quietly matched nothing fails loudly instead of vacuously
#: comparing two empty tuples.
_STAGE_COUNT = 10

#: Teal.  The one stage where the dataset and the pinned course copy disagree.
_TEAL_STAGE_NUMBER = 8

#: The dataset's Teal subtitle, corrected in #2577 ahead of the vendored pin.
_DATASET_TEAL_SUBTITLE = "True Self Wisdom"

#: The pinned course's Teal subtitle, superseded upstream by ``3bf0df5`` but
#: still what ``backend/content/`` ships.  Retired by issue #2706.
_COURSE_TEAL_SUBTITLE = "Transcendent Wisdom"

_HEADING_PREFIX = "#### "

#: ``1.``/``10.`` etc. open a numbered item in about.md's stage list.
_ITEM_START = re.compile(r"^\s*\d{1,2}\.\s")

#: Every ``#### `` stage heading in ``aptitude-stages.md``, verbatim.  Stage 6
#: really does use a semicolon ("Understanding; Embodied") where the other nine
#: use a colon -- that is the course's own typo and is pinned as-is, not
#: normalised, so a future re-pin that fixes it registers as a real change.
_EXPECTED_HEADINGS: tuple[str, ...] = (
    "#### Yes-and-Ness: Agency (Beige, Survival, The Biological Machine)",
    "#### Yes-and-Ness: Receptivity (Purple, Mythic, The Archetype Embodier)",
    "#### Love: Self (Red, Power, The Dominator)",
    "#### Love: Community (Blue, Conformity, The Victim)",
    "#### Understanding: Intellectual (Orange, Rationality, The Status Seeker)",
    "#### Understanding; Embodied (Green, Plurality, The Shadow Glorifier)",
    "#### Wisdom: Systems (Yellow, Integrative, The Despairing Analyst)",
    "#### Wisdom: Transcendent (Teal, Nonduality, The Adept)",
    "#### Being: Unity (Ultraviolet, Effortless Being, The Blissy Adept)",
    "#### Awareness: Emptiness (Clear Light, Pure Awareness, Whole Adept)",
)

#: ``about.md``'s ten numbered stage items with their wrapped continuation lines
#: folded back together on a single space.  Items 2, 5 and 6 wrap *mid-name*
#: ("Yes-And-Ness,\n    Receptivity"), so the fold has to happen before any
#: comparison or the pin would only ever be comparing halves.
_EXPECTED_ITEMS: tuple[str, ...] = (
    "1.  Yes-And-Ness, Agency: Build a life intentionally when in a higher energy mode.",
    "2.  Yes-And-Ness, Receptivity: Receive abundance when in a lower energy mode.",
    "3.  Self-Love: Break free from shame and insecurity to exhibit authentic confidence.",
    "4.  Community Love: Move from digital isolation to embodied belonging.",
    "5.  Intellectual Understanding: Harness rationality and the drive to achieve.",
    "6.  Embodied Understanding: Know yourself as good by centering repressed edges",
    "7.  Systems Wisdom: Amalgamate insights of previous stages into one unique system",
    "8.  Transcendent Wisdom: Tap into flow states and higher intuition to unlock free will.",
    "9.  Unity: Yoke yourself to the greater currents of Source.",
    (
        "10. Emptiness: Explore how vibration \u201cdoesn\u2019t satisfy, "
        "doesn\u2019t last, and ain\u2019t you.\u201d"
    ),
)


def _read_resource(name: str) -> str:
    """Return the text of a vendored course resource markdown file."""
    return (_RESOURCES_DIR / name).read_text(encoding="utf-8")


def _stage_headings(text: str) -> tuple[str, ...]:
    """Return every ``#### `` heading line in ``text``, verbatim."""
    return tuple(line for line in text.splitlines() if line.startswith(_HEADING_PREFIX))


def _is_continuation(line: str) -> bool:
    """Say whether ``line`` is an indented wrap of the numbered item above it."""
    return bool(line.strip()) and line[:1].isspace() and not _ITEM_START.match(line)


def _join_item(lines: Sequence[str], start: int) -> str:
    """Return the numbered item at ``start`` with its wrapped lines folded in."""
    wrapped = itertools.takewhile(_is_continuation, lines[start + 1 :])
    return " ".join(part.strip() for part in [lines[start], *wrapped])


def _about_items(text: str) -> tuple[str, ...]:
    """Return ``about.md``'s numbered items, each folded onto one line."""
    lines = text.splitlines()
    starts = [index for index, line in enumerate(lines) if _ITEM_START.match(line)]
    return tuple(_join_item(lines, start) for start in starts)


def test_aptitude_stages_headings_match_the_pinned_course_copy() -> None:
    """The ten stage headings in ``aptitude-stages.md`` are the pinned strings."""
    headings = _stage_headings(_read_resource(_STAGES_FILE))
    assert len(headings) == _STAGE_COUNT, (
        f"expected {_STAGE_COUNT} '{_HEADING_PREFIX}' stage headings in {_STAGES_FILE}, "
        f"parsed {len(headings)} -- the heading shape changed, so nothing below was checked"
    )
    assert headings == _EXPECTED_HEADINGS


def test_about_stage_items_match_the_pinned_course_copy() -> None:
    """``about.md``'s ten numbered stage items, unwrapped, are the pinned strings."""
    items = _about_items(_read_resource(_ABOUT_FILE))
    assert len(items) == _STAGE_COUNT, (
        f"expected {_STAGE_COUNT} numbered stage items in {_ABOUT_FILE}, "
        f"parsed {len(items)} -- the list shape changed, so nothing below was checked"
    )
    assert items == _EXPECTED_ITEMS


def test_teal_dataset_subtitle_leads_the_pinned_course_copy() -> None:
    """Stage 8's dataset subtitle deliberately runs ahead of the vendored course.

    #2577 corrected the dataset to "True Self Wisdom" following upstream commit
    ``3bf0df5``; the vendored pin predates it, so the in-app About page still
    reads "Transcendent Wisdom".  This asserts the split rather than leaving it
    to a comment, and goes red when issue #2706 re-pins the course -- the cue to
    update the stage-8 literals above and delete this test.
    """
    teal_index = _TEAL_STAGE_NUMBER - 1
    assert stage_curriculum(_TEAL_STAGE_NUMBER).subtitle == _DATASET_TEAL_SUBTITLE
    assert _COURSE_TEAL_SUBTITLE.split(maxsplit=1)[0] in _EXPECTED_HEADINGS[teal_index]
    assert f"{_TEAL_STAGE_NUMBER}.  {_COURSE_TEAL_SUBTITLE}:" in _EXPECTED_ITEMS[teal_index]
