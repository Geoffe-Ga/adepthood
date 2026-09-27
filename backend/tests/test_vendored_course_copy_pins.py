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

The one column that **is** compared against the dataset is the free-will
archetype -- the third item in each heading's parenthetical.  Unlike the
subtitles, it diverges only where the course's owner ratified a supersession,
and those are recorded machine-readably in the dataset's own
``provenance.supersessions`` list rather than in an exception table here.  So
the comparison needs no hand-maintained duplicate: a divergence either follows
the course or becomes a one-line provenance entry (#2915).
"""

from __future__ import annotations

import itertools
import json
import re
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

import curriculum

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_RESOURCES_DIR = _BACKEND_DIR / "content" / "markdown" / "resources"
_DATASET_PATH = _BACKEND_DIR / "src" / "curriculum" / "archetypal_wavelength.json"

_STAGES_FILE = "aptitude-stages.md"
_ABOUT_FILE = "about.md"

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

#: The dataset column the heading archetype is compared against.
_FREE_WILL_FIELD = "relationship_to_free_will"

#: The per-Stage identifying attributes a ratified supersession may override
#: (``docs/curriculum.md``, ``stage_attributes_source``).
_SUPERSEDABLE_FIELDS = frozenset(
    {
        "category",
        "aspect",
        "spiral_dynamics_color",
        "growing_up_stage",
        "divine_gender_polarity",
        _FREE_WILL_FIELD,
        "free_will_description",
    },
)

#: Exactly the keys one ``provenance.supersessions`` entry carries.
_SUPERSESSION_KEYS = frozenset({"stage_number", "field", "value"})

#: The ratified supersessions recorded today: stage 4's aspect and stage 8's
#: color, aspect and free-will archetype (December 2025).
_EXPECTED_SUPERSESSIONS = frozenset(
    {
        (4, "aspect"),
        (8, "spiral_dynamics_color"),
        (8, "aspect"),
        (8, _FREE_WILL_FIELD),
    },
)

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
    "#### Wisdom: True Self (Teal, Nonduality, The Adept)",
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


def _dataset_value(stage_number: int, field: str) -> str:
    """Return ``field`` of ``stage_number`` as the curriculum dataset ships it."""
    value: str = getattr(curriculum.stage_curriculum(stage_number), field)
    return value


def _validate_supersession(entry: Mapping[str, object]) -> tuple[int, str]:
    """Return ``entry``'s ``(stage_number, field)`` or raise on a malformed entry.

    A wrongly typed item raises :class:`TypeError` and any other defect
    :class:`ValueError`, each with its own message so a test can tell exactly
    which check fired.
    """
    keys = frozenset(entry)
    if keys != _SUPERSESSION_KEYS:
        msg = f"supersession keys must be exactly {sorted(_SUPERSESSION_KEYS)}, got {sorted(keys)}"
        raise ValueError(msg)
    stage_number = entry["stage_number"]
    if not isinstance(stage_number, int) or isinstance(stage_number, bool):
        msg = f"supersession stage_number must be an int, got {stage_number!r}"
        raise TypeError(msg)
    if not 1 <= stage_number <= _STAGE_COUNT:
        msg = f"supersession stage_number out of range 1..{_STAGE_COUNT}: {stage_number}"
        raise ValueError(msg)
    field = entry["field"]
    if not isinstance(field, str):
        msg = f"supersession field must be a str, got {field!r}"
        raise TypeError(msg)
    if field not in _SUPERSEDABLE_FIELDS:
        msg = f"supersession field is not a stage attribute: {field!r}"
        raise ValueError(msg)
    if entry["value"] != _dataset_value(stage_number, field):
        msg = f"supersession value does not match the dataset for stage {stage_number} {field}"
        raise ValueError(msg)
    return stage_number, field


def _supersessions() -> frozenset[tuple[int, str]]:
    """Return every ``(stage_number, field)`` the dataset's provenance supersedes."""
    payload = json.loads(_DATASET_PATH.read_text(encoding="utf-8"))
    entries = payload["provenance"]["supersessions"]
    return frozenset(_validate_supersession(entry) for entry in entries)


def test_free_will_archetypes_match_vendored_course_headings_except_recorded_supersessions() -> (
    None
):
    """Each stage's archetype is the course heading's, unless provenance supersedes it."""
    archetypes = _heading_archetypes()
    assert len(archetypes) == _STAGE_COUNT, (
        f"expected {_STAGE_COUNT} archetypes from {_STAGES_FILE}, parsed {len(archetypes)}"
    )
    superseded = _supersessions()
    exempt = {stage_number for stage_number, field in superseded if field == _FREE_WILL_FIELD}
    compared: list[int] = []
    for stage_number, course_archetype in archetypes.items():
        if (stage_number, _FREE_WILL_FIELD) in superseded:
            continue
        assert _dataset_value(stage_number, _FREE_WILL_FIELD) == course_archetype, (
            f"stage {stage_number}: the dataset's {_FREE_WILL_FIELD} diverges from the vendored "
            f"course heading {course_archetype!r}; follow the course or record a supersession "
            "in provenance.supersessions"
        )
        compared.append(stage_number)
    # Every stage not exempted was actually compared, so a loop that skipped
    # them all cannot pass by asserting nothing.
    assert compared == sorted(set(archetypes) - exempt)


def test_provenance_supersessions_are_well_formed() -> None:
    """The provenance list records exactly the ratified supersessions, each valid."""
    assert _supersessions() == _EXPECTED_SUPERSESSIONS


_VALID_ENTRY: dict[str, object] = {
    "stage_number": 8,
    "field": _FREE_WILL_FIELD,
    "value": "True Self Embodier",
}


@pytest.mark.parametrize(
    ("override", "error", "fragment"),
    [
        pytest.param({"extra": "x"}, ValueError, "keys must be exactly", id="extra_key"),
        pytest.param({"stage_number": "8"}, TypeError, "must be an int", id="stage_is_str"),
        pytest.param({"stage_number": True}, TypeError, "must be an int", id="stage_is_bool"),
        pytest.param({"stage_number": 0}, ValueError, "out of range", id="stage_zero"),
        pytest.param(
            {"stage_number": _STAGE_COUNT + 1},
            ValueError,
            "out of range",
            id="stage_past_last",
        ),
        pytest.param(
            {"field": "subtitle"},
            ValueError,
            "not a stage attribute",
            id="unknown_field",
        ),
        pytest.param({"field": 8}, TypeError, "field must be a str", id="field_not_str"),
        pytest.param(
            {"value": "Adept"},
            ValueError,
            "does not match the dataset",
            id="value_mismatch",
        ),
    ],
)
def test_malformed_supersession_is_rejected(
    override: dict[str, object],
    error: type[Exception],
    fragment: str,
) -> None:
    """Every malformed-entry check fires on its own case with its own message."""
    with pytest.raises(error, match=fragment):
        _validate_supersession({**_VALID_ENTRY, **override})


def test_supersession_missing_a_key_is_rejected() -> None:
    """An entry without its ``value`` key is refused by the key-set check."""
    entry = {key: value for key, value in _VALID_ENTRY.items() if key != "value"}
    with pytest.raises(ValueError, match="keys must be exactly"):
        _validate_supersession(entry)


def test_the_boundary_stages_are_valid_supersession_targets() -> None:
    """Stages 1 and ten sit inside the range, so the bounds are not off by one."""
    for stage_number in (1, _STAGE_COUNT):
        entry = {
            "stage_number": stage_number,
            "field": _FREE_WILL_FIELD,
            "value": _dataset_value(stage_number, _FREE_WILL_FIELD),
        }
        assert _validate_supersession(entry) == (stage_number, _FREE_WILL_FIELD)


def test_a_non_matching_stage_heading_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    """A ``#### `` line outside the heading pattern raises rather than being skipped."""
    monkeypatch.setattr(
        sys.modules[__name__],
        "_read_resource",
        lambda _name: "#### Yes-and-Ness: Agency without a parenthetical\n",
    )
    with pytest.raises(ValueError, match="does not match the archetype pattern"):
        _heading_archetypes()
