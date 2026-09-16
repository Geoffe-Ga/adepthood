"""Tests for :mod:`domain.detection_facts` — the drop-on-doubt fact rules.

Every rule here decides whether a *model-stated* amount or day may be
believed. The governing invariant across the file: a field that cannot be
believed becomes ``None``; it never raises, and it never costs the hit.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pytest

from domain.dates import MAX_BACKFILL_DAYS
from domain.detection_facts import (
    DetectionClock,
    facts_from_model,
    normalise_unit,
    resolve_when,
)

_ENTRY_DAY = date(2026, 9, 12)  # a Saturday
_TODAY = date(2026, 9, 15)  # the following Tuesday
_CLOCK = DetectionClock(entry_day=_ENTRY_DAY, today=_TODAY, max_backfill_days=MAX_BACKFILL_DAYS)


@dataclass(frozen=True)
class _Draft:
    """Stand-in for ``domain.detection._HitDraft``'s three raw fact fields."""

    amount: object = None
    unit: object = None
    when: object = None


class TestNormaliseUnit:
    """Allowlist on both sides; ``None`` means "these do not denominate the same thing"."""

    @pytest.mark.parametrize(
        ("written", "tracked", "canon"),
        [
            ("unit", "units", "count"),
            ("times", "unit", "count"),
            ("x", "times", "count"),
            ("Ounces", "oz", "oz"),
            ("  OZ  ", "ounce", "oz"),
            ("minutes", "min", "min"),
            ("mins", "minute", "min"),
            ("miles", "mi", "mi"),
            ("mile", "miles", "mi"),
            ("kilometres", "km", "km"),
            ("kilometer", "kilometres", "km"),
            ("reps", "rep", "rep"),
            ("sessions", "session", "session"),
            ("glasses", "glass", "glass"),
            ("cups", "cup", "cup"),
            ("pages", "page", "page"),
        ],
    )
    def test_every_alias_maps_to_its_canon(self, written: str, tracked: str, canon: str) -> None:
        assert normalise_unit(written, tracked) == canon

    def test_units_and_times_match_through_the_count_group(self) -> None:
        """The load-bearing pair: what POST /habits/ seeds vs what a writer types."""
        assert normalise_unit("times", "units") == "count"

    @pytest.mark.parametrize(
        ("written", "tracked"),
        [
            ("glasses", "oz"),  # both known, different things
            ("furlongs", "mi"),  # writer's token unknown
            ("oz", "smidgens"),  # goal's token unknown
            ("furlongs", "smidgens"),  # both unknown -- must NOT match by accident
        ],
    )
    def test_a_mismatched_or_unknown_unit_is_none(self, written: str, tracked: str) -> None:
        assert normalise_unit(written, tracked) is None

    def test_a_target_unit_of_none_is_none(self) -> None:
        """What makes practices structurally fact-free: they track no unit."""
        assert normalise_unit("minutes", None) is None


class TestResolveWhen:
    """Relative phrases anchor to the ENTRY's day, then clamp to the window."""

    def test_yesterday_is_the_day_before_the_entry_not_the_day_before_today(self) -> None:
        """A backdated entry's "yesterday" anchors to the entry's own day."""
        assert resolve_when("yesterday", clock=_CLOCK) == date(2026, 9, 11)

    @pytest.mark.parametrize(
        ("phrase", "expected"),
        [
            ("today", _ENTRY_DAY),
            ("this morning", _ENTRY_DAY),
            ("this afternoon", _ENTRY_DAY),
            ("this evening", _ENTRY_DAY),
            ("tonight", _ENTRY_DAY),
            ("earlier", _ENTRY_DAY),
            ("yesterday", date(2026, 9, 11)),
            ("last night", date(2026, 9, 11)),
            ("  YESTERDAY  ", date(2026, 9, 11)),
        ],
    )
    def test_fixed_relative_phrases(self, phrase: str, expected: date) -> None:
        assert resolve_when(phrase, clock=_CLOCK) == expected

    @pytest.mark.parametrize(
        ("phrase", "expected"),
        [
            ("saturday", _ENTRY_DAY),  # the entry's own weekday: same day allowed
            ("on saturday", _ENTRY_DAY),  # a leading "on " is stripped
            ("friday", date(2026, 9, 11)),
            ("sunday", date(2026, 9, 6)),  # most recent Sunday BEFORE Saturday
            ("last saturday", date(2026, 9, 5)),  # "last" on the same weekday goes back 7
            ("last friday", date(2026, 9, 11)),  # "last Friday" is still that Friday
        ],
    )
    def test_weekday_resolution(self, phrase: str, expected: date) -> None:
        assert resolve_when(phrase, clock=_CLOCK) == expected

    def test_weekday_resolution_crosses_a_month_boundary(self) -> None:
        """Wednesday, seen from a Tuesday, is the previous week -- and the previous month."""
        clock = DetectionClock(
            entry_day=date(2026, 10, 6),  # a Tuesday
            today=date(2026, 10, 6),
            max_backfill_days=MAX_BACKFILL_DAYS,
        )
        assert resolve_when("wednesday", clock=clock) == date(2026, 9, 30)

    @pytest.mark.parametrize("phrase", ["", "at some point", "last week", "the other day", "soon"])
    def test_an_unparseable_phrase_is_none(self, phrase: str) -> None:
        assert resolve_when(phrase, clock=_CLOCK) is None

    def test_a_day_after_today_is_clamped_away(self) -> None:
        """An entry dated ahead of today cannot back-date a completion into the future."""
        ahead = DetectionClock(
            entry_day=date(2026, 9, 20), today=_TODAY, max_backfill_days=MAX_BACKFILL_DAYS
        )
        assert resolve_when("today", clock=ahead) is None

    def test_a_day_before_the_backfill_window_is_clamped_away(self) -> None:
        """The N2 case: ``entry_date`` is caller-supplied and unbounded below.

        Without the clamp this returns 2014-12-31, which is then persisted,
        served in the suggestion, and rendered on the card -- while the accept
        silently logs today instead.
        """
        ancient = DetectionClock(
            entry_day=date(2015, 1, 1), today=_TODAY, max_backfill_days=MAX_BACKFILL_DAYS
        )
        assert resolve_when("yesterday", clock=ancient) is None

    def test_the_oldest_day_inside_the_window_survives(self) -> None:
        """The clamp is a window, not a ban on backdating."""
        oldest = _TODAY.toordinal() - MAX_BACKFILL_DAYS
        clock = DetectionClock(
            entry_day=date.fromordinal(oldest), today=_TODAY, max_backfill_days=MAX_BACKFILL_DAYS
        )
        assert resolve_when("today", clock=clock) == date.fromordinal(oldest)


class TestFactsFromModel:
    """Each field drops independently; a malformed extra never discards the hit."""

    def test_a_believable_pair_survives_whole(self) -> None:
        assert facts_from_model(
            _Draft(amount=64, unit="oz", when="yesterday"), target_unit="ounces", clock=_CLOCK
        ) == (64.0, date(2026, 9, 11))

    @pytest.mark.parametrize(
        "amount",
        [True, False, float("nan"), float("inf"), float("-inf"), -1.0, 0.0, "3", None, [3]],
    )
    def test_the_factory_never_returns_a_non_positive_amount(self, amount: object) -> None:
        """The DB CHECK is a backstop that must never fire.

        If it ever does it fires inside ``_persist_settle_commit`` on the
        combined resonance path, converting a best-effort feature into a 500
        that also loses the wallet settlement.
        """
        units, _ = facts_from_model(
            _Draft(amount=amount, unit="oz", when="yesterday"), target_unit="oz", clock=_CLOCK
        )
        assert units is None or units > 0
        assert units is None

    def test_a_mismatched_unit_drops_the_amount_and_keeps_the_day(self) -> None:
        units, day = facts_from_model(
            _Draft(amount=2, unit="glasses", when="yesterday"), target_unit="oz", clock=_CLOCK
        )
        assert units is None
        assert day == date(2026, 9, 11)

    def test_an_unparseable_when_drops_the_day_and_keeps_the_amount(self) -> None:
        units, day = facts_from_model(
            _Draft(amount=64, unit="oz", when="at some point"), target_unit="oz", clock=_CLOCK
        )
        assert units == 64.0
        assert day is None

    @pytest.mark.parametrize("when", [5, None, {"day": "yesterday"}])
    def test_a_non_string_when_drops_the_day_without_raising(self, when: object) -> None:
        units, day = facts_from_model(
            _Draft(amount=64, unit="oz", when=when), target_unit="oz", clock=_CLOCK
        )
        assert units == 64.0
        assert day is None

    @pytest.mark.parametrize("unit", [5, None, ["oz"]])
    def test_a_non_string_unit_drops_the_amount_without_raising(self, unit: object) -> None:
        units, day = facts_from_model(
            _Draft(amount=64, unit=unit, when="yesterday"), target_unit="oz", clock=_CLOCK
        )
        assert units is None
        assert day == date(2026, 9, 11)

    def test_an_empty_draft_yields_an_empty_pair(self) -> None:
        assert facts_from_model(_Draft(), target_unit="oz", clock=_CLOCK) == (None, None)

    def test_a_practice_candidate_can_never_carry_an_amount(self) -> None:
        """``target_unit=None`` is what makes the habit-only CHECK unreachable."""
        units, _ = facts_from_model(
            _Draft(amount=20, unit="minutes", when="yesterday"), target_unit=None, clock=_CLOCK
        )
        assert units is None
