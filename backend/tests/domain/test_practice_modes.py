"""Tests for the practice mode StrEnum."""

from __future__ import annotations

from domain.practice_modes import ALL_MODES, PracticeMode

_EXPECTED_MEMBERS: tuple[str, ...] = (
    "meditation_timer",
    "count_up",
    "metronome",
    "interval_bell",
    "rep_counter",
    "sense_grounding",
    "tarot",
    "tallied_grounding",
    "mindful_anchor",
    "card_meditation",
    "random_interval_bell",
)


def test_practice_mode_is_str_subclass() -> None:
    """Members behave like strings so JSON serialisation is a no-op.

    The widening to ``str`` matters because mypy narrows ``StrEnum``
    members to their ``Literal`` value; the comparison below would
    otherwise be flagged as non-overlapping even though it is valid at
    runtime. Pinning the type once exercises the contract the wire
    format relies on.
    """
    assert isinstance(PracticeMode.MEDITATION_TIMER, str)
    member: str = PracticeMode.MEDITATION_TIMER
    assert member == "meditation_timer"


def test_every_documented_mode_is_present() -> None:
    """Every mode listed in ritual-01 ships in the enum."""
    actual = {m.value for m in PracticeMode}
    assert actual == set(_EXPECTED_MEMBERS)


def test_all_modes_constant_matches_enum() -> None:
    """``ALL_MODES`` is the public, ordered export consumed by callers."""
    assert tuple(ALL_MODES) == _EXPECTED_MEMBERS


def test_round_trip_through_value() -> None:
    """Constructing from the wire string returns the original member."""
    for value in _EXPECTED_MEMBERS:
        assert PracticeMode(value).value == value
