"""Characterization pins on the vendored course's own curriculum wording.

The literals below are the *course's* words at the vendored content pin
recorded in ``backend/content/CONTENT_VERSION`` -- **not** the curriculum
dataset's.  They deliberately do **not** assert that the course wording equals
``archetypal_wavelength.json``'s subtitles: those two genuinely differ for
stages 1, 2, 4, 9 and 10 today, so an equality test would be permanently red
and would have to grow a hand-maintained exception table -- the very duplicate
this pin exists to retire.

What the pin buys instead: ``make sync-content`` can never change curriculum
copy silently again.  **A failure here is a decision, not a typo.** It means a
re-pin moved the vendored tree and the course changed its own wording.  Go read
the upstream diff and decide whether the dataset follows, then update these
literals deliberately.  Never "fix" a literal just to make the suite green, and
never hand-edit ``backend/content/**`` to make it match.

The one column that **is** compared is the free-will archetype -- the third
item in each heading's parenthetical -- against the generated
``stage_correspondence.json`` that the ``CourseStage`` rows are seeded from
(the curriculum dataset no longer carries a copy of it, #2666).  All ten
headings equal the artifact's ``relationship_to_free_will``, so the comparison
has no exemptions.  The supersession list that once excused stage 8 lived in
the retired dataset copy; the artifact's own departures from the Complete Map
CSV are recorded in ``stage_correspondence_supersessions.json`` and pinned by
``tests/test_stage_correspondence.py::TestIssue1637Rulings`` and
``tests/scripts/test_build_stage_correspondence.py``.
"""

from __future__ import annotations

import itertools
import re
import sys
from collections.abc import Sequence
from pathlib import Path

import pytest

from curriculum.stage_correspondence import stage_correspondence

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_RESOURCES_DIR = _BACKEND_DIR / "content" / "markdown" / "resources"

#: Site resources are named ``NN-slug.md`` since aptitude-course#76.
_STAGES_FILE = "04-aptitude-stages.md"
_ABOUT_FILE = "02-about.md"

#: The APTITUDE curriculum has exactly ten stages.  Asserted for both parses so
#: a parser that quietly matched nothing fails loudly instead of vacuously
#: comparing two empty tuples.
_STAGE_COUNT = 10

_HEADING_PREFIX = "#### "

#: A stage heading: ``#### <Category>: <Aspect> (<Color>, <Stage>, <Archetype>)``.
#: The prefix is ``[^(]+`` so stage 6's ``Understanding;`` semicolon still
#: matches; the third parenthesised item is the free-will archetype.
_ARCHETYPE_HEADING = re.compile(r"^#### [^(]+\(([^,]+), ([^,]+), ([^)]+)\)$")

#: The regex group holding the free-will archetype.
_ARCHETYPE_GROUP = 3

#: Headings name most archetypes with an article ("The Dominator"); the dataset
#: does not ("Dominator"), so one leading article is dropped before comparing.
_LEADING_ARTICLE = "The "

#: The artifact column the heading archetype is compared against.
_FREE_WILL_FIELD = "relationship_to_free_will"

#: ``1.``/``10.`` etc. open a numbered item in about.md's stage list.
_ITEM_START = re.compile(r"^\s*\d{1,2}\.\s")

#: Every ``#### `` stage heading in ``aptitude-stages.md``, verbatim.  Stage 6
#: really does use a semicolon ("Understanding; Embodied") where the other nine
#: use a colon -- that is the course's own typo and is pinned as-is, not
#: normalised, so a future re-pin that fixes it registers as a real change.
_EXPECTED_HEADINGS: tuple[str, ...] = (
    "#### Yes-and-Ness: Agency (Beige, Survival, The Biological Machine)",
    "#### Yes-and-Ness: Receptivity (Purple, Mythic, The Pleasure Seeker)",
    "#### Love: Self (Red, Power, The Dominator)",
    "#### Love: Community (Blue, Conformity, The Victim)",
    "#### Understanding: Intellectual (Orange, Rationality, The Status Seeker)",
    "#### Understanding; Embodied (Green, Plurality, The Shadow Glorifier)",
    "#### Wisdom: Systems (Yellow, Integrative, The Despairing Analyst)",
    "#### Wisdom: True Self (Teal, True Self Connection, The True Self Embodier)",
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
    (
        "8.  True Self Wisdom: Tap into deep intuition and the small clear "
        "voice beneath the conditioned personality."
    ),
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


def _heading_archetypes() -> dict[int, str]:
    """Return each stage's free-will archetype as ``aptitude-stages.md`` names it.

    Stages are numbered by heading order.  Any ``#### `` line the heading
    pattern does not match fails loudly rather than being skipped, so a changed
    heading shape cannot shrink the comparison silently.
    """
    archetypes: dict[int, str] = {}
    for stage_number, heading in enumerate(_stage_headings(_read_resource(_STAGES_FILE)), 1):
        match = _ARCHETYPE_HEADING.match(heading)
        if match is None:
            msg = f"stage heading does not match the archetype pattern: {heading!r}"
            raise ValueError(msg)
        archetypes[stage_number] = match.group(_ARCHETYPE_GROUP).removeprefix(_LEADING_ARTICLE)
    return archetypes


def _artifact_value(stage_number: int, field: str) -> str:
    """Return ``field`` of ``stage_number`` as the stage-correspondence artifact ships it."""
    record = next(r for r in stage_correspondence().stages if r.stage_number == stage_number)
    value: str = getattr(record, field)
    return value


def test_free_will_archetypes_match_vendored_course_headings() -> None:
    """Each stage's archetype is the course heading's, for all ten stages."""
    archetypes = _heading_archetypes()
    assert len(archetypes) == _STAGE_COUNT, (
        f"expected {_STAGE_COUNT} archetypes from {_STAGES_FILE}, parsed {len(archetypes)}"
    )
    mismatches = {
        stage_number: (course_archetype, _artifact_value(stage_number, _FREE_WILL_FIELD))
        for stage_number, course_archetype in archetypes.items()
        if _artifact_value(stage_number, _FREE_WILL_FIELD) != course_archetype
    }
    assert mismatches == {}, (
        f"the artifact's {_FREE_WILL_FIELD} diverges from the vendored course headings "
        "(stage: (course, artifact)); follow the course or record a chapter-cited "
        "supersession in stage_correspondence_supersessions.json"
    )


def test_a_diverging_archetype_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """Non-vacuity: a heading the artifact disagrees with is caught, not skipped."""
    real = _heading_archetypes()
    monkeypatch.setattr(
        sys.modules[__name__], "_heading_archetypes", lambda: {**real, 8: "Intentional Actor"}
    )
    with pytest.raises(AssertionError, match="True Self Embodier"):
        test_free_will_archetypes_match_vendored_course_headings()


def test_a_non_matching_stage_heading_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    """A ``#### `` line outside the heading pattern raises rather than being skipped."""
    monkeypatch.setattr(
        sys.modules[__name__],
        "_read_resource",
        lambda _name: "#### Yes-and-Ness: Agency without a parenthetical\n",
    )
    with pytest.raises(ValueError, match="does not match the archetype pattern"):
        _heading_archetypes()
