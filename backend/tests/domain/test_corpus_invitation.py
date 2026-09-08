"""When the corpus invitation may be offered at the Resonance moment (#2407).

The owner ruling of 2026-09-05 fixes the shape: offer after the first
completed Resonance pass on an account that has never decided; on a plain
"Not now", offer again only once *both* a cooldown of days and a count of
further completed passes have elapsed; never again once consent is decided or
"Do not ask again" is chosen. Every rule below is asserted against the named
constants rather than against literals, so a change to the cooldown is a
change to a constant and not a hunt through the tests.

Pure: no session, no I/O, no clock. ``now`` is injected.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from domain.corpus_invitation import (
    FIRST_OFFER_AFTER_PASSES,
    REOFFER_MIN_DAYS,
    REOFFER_MIN_PASSES,
    InvitationFacts,
    should_offer,
)

_NOW = datetime(2026, 9, 7, 12, 0, tzinfo=UTC)


def _facts(
    *,
    consent_decided: bool = False,
    completed_passes: int = FIRST_OFFER_AFTER_PASSES,
    dismissed_at: datetime | None = None,
    passes_at_dismissal: int = 0,
    do_not_ask_again: bool = False,
) -> InvitationFacts:
    """An undecided account with one completed pass and no dismissal, varied by keyword."""
    return InvitationFacts(
        consent_decided=consent_decided,
        completed_passes=completed_passes,
        dismissed_at=dismissed_at,
        passes_at_dismissal=passes_at_dismissal,
        do_not_ask_again=do_not_ask_again,
    )


def test_nothing_is_offered_before_the_first_completed_pass() -> None:
    """An account that has asked for nothing has not reached the moment."""
    assert should_offer(_facts(completed_passes=0), now=_NOW) is False


def test_the_first_completed_pass_on_an_undecided_account_is_the_moment() -> None:
    """The ruling's trigger, exactly."""
    assert should_offer(_facts(), now=_NOW) is True


def test_a_decided_account_is_never_asked_whatever_it_decided() -> None:
    """A dated refusal is a decision on the record, not an open question."""
    assert should_offer(_facts(consent_decided=True), now=_NOW) is False


def test_do_not_ask_again_is_final() -> None:
    """Chosen once, and no count of passes or days reopens it."""
    facts = _facts(
        do_not_ask_again=True,
        dismissed_at=_NOW - timedelta(days=REOFFER_MIN_DAYS * 10),
        completed_passes=REOFFER_MIN_PASSES * 10,
    )
    assert should_offer(facts, now=_NOW) is False


@pytest.mark.parametrize(
    ("days_since", "passes_since", "expected"),
    [
        (REOFFER_MIN_DAYS, REOFFER_MIN_PASSES - 1, False),
        (REOFFER_MIN_DAYS - 1, REOFFER_MIN_PASSES, False),
        (REOFFER_MIN_DAYS, REOFFER_MIN_PASSES, True),
        (REOFFER_MIN_DAYS * 2, REOFFER_MIN_PASSES * 2, True),
        (0, 0, False),
    ],
)
def test_a_not_now_reopens_only_when_both_halves_of_the_cooldown_have_passed(
    days_since: int, passes_since: int, *, expected: bool
) -> None:
    """Days alone are not enough; passes alone are not enough."""
    passes_at_dismissal = FIRST_OFFER_AFTER_PASSES
    facts = _facts(
        dismissed_at=_NOW - timedelta(days=days_since),
        passes_at_dismissal=passes_at_dismissal,
        completed_passes=passes_at_dismissal + passes_since,
    )
    assert should_offer(facts, now=_NOW) is expected


def test_a_naive_dismissal_instant_is_read_as_utc() -> None:
    """SQLite hands back naive datetimes; the rule must not raise on one."""
    naive = (_NOW - timedelta(days=REOFFER_MIN_DAYS)).replace(tzinfo=None)
    facts = _facts(
        dismissed_at=naive,
        passes_at_dismissal=FIRST_OFFER_AFTER_PASSES,
        completed_passes=FIRST_OFFER_AFTER_PASSES + REOFFER_MIN_PASSES,
    )
    assert should_offer(facts, now=_NOW) is True


def test_the_constants_are_the_ruling() -> None:
    """Seven days and three passes, as the owner ruled; one pass to be asked at all."""
    assert FIRST_OFFER_AFTER_PASSES == 1
    assert REOFFER_MIN_DAYS == 7
    assert REOFFER_MIN_PASSES == 3
