"""Which habits a timer feeds, and the units such a habit may count in (#3150).

A habit linked to the journal's writing timer -- or, once the practice link
lands (#3151), to a practice -- is logged by the timer itself: the amount
posted is the elapsed minutes, or one session. Its goals must therefore count
in a unit the timer can measure, and be scored over a period the timer's
sessions can fill. This module is the one place that rule lives:

* :func:`linked_habit_ids` answers "which of this user's habits does a timer
  feed?". Each link source contributes one query to the union; the practice
  link adds ``UserPractice.habit_id`` here and every guard below picks it up.
* :func:`assert_linked_unit_allowed` / :func:`assert_linked_frequency_unit_allowed`
  refuse anything else with the repo's 422.
* :func:`assert_habit_goals_linkable` checks a habit's *stored* goals, for the
  write that creates a link (``PATCH /ui-flags`` today).
* :func:`assert_units_allowed_if_linked` guards the writes that change a
  habit's units (``PUT /habits/{id}/goals/units``, ``PUT /goals/{id}``).
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from errors import unprocessable
from models.goal import Goal
from models.user_ui_flags import UserUiFlags

#: The only units a timer can measure: elapsed minutes, or one whole session.
LINKED_HABIT_UNITS: frozenset[str] = frozenset({"minutes", "sessions"})

#: The cadences a timer-fed habit may be scored over.
LINKED_HABIT_FREQUENCY_UNITS: frozenset[str] = frozenset({"per_day", "per_week"})


async def linked_habit_ids(session: AsyncSession, user_id: int) -> set[int]:
    """Return the ids of ``user_id``'s habits that a timer logs to.

    Today that is the writing timer's single link
    (``UserUiFlags.writing_session_habit_id``). A user with no flags row, or
    with the link cleared, has none.
    """
    result = await session.execute(
        select(UserUiFlags.writing_session_habit_id).where(
            col(UserUiFlags.user_id) == user_id,
            col(UserUiFlags.writing_session_habit_id).is_not(None),
        )
    )
    return {habit_id for habit_id in result.scalars().all() if habit_id is not None}


def assert_linked_unit_allowed(target_unit: str) -> None:
    """Raise 422 ``linked_habit_unit_not_allowed`` unless a timer can count ``target_unit``."""
    if target_unit not in LINKED_HABIT_UNITS:
        raise unprocessable("linked_habit_unit_not_allowed")


def assert_linked_frequency_unit_allowed(frequency_unit: str) -> None:
    """Raise 422 ``linked_habit_frequency_unit_not_allowed`` unless per day or per week."""
    if frequency_unit not in LINKED_HABIT_FREQUENCY_UNITS:
        raise unprocessable("linked_habit_frequency_unit_not_allowed")


def assert_linked_units_allowed(target_unit: str, frequency_unit: str) -> None:
    """Apply both linked-habit unit rules, the target unit first."""
    assert_linked_unit_allowed(target_unit)
    assert_linked_frequency_unit_allowed(frequency_unit)


async def assert_units_allowed_if_linked(
    session: AsyncSession,
    *,
    user_id: int,
    habit_id: int,
    target_unit: str,
    frequency_unit: str,
) -> None:
    """Refuse a unit change that would put a timer-fed habit off minutes or sessions.

    A habit no timer feeds is unaffected: any unit stays available to it.
    """
    if habit_id in await linked_habit_ids(session, user_id):
        assert_linked_units_allowed(target_unit, frequency_unit)


async def assert_habit_goals_linkable(session: AsyncSession, habit_id: int) -> None:
    """Refuse to link a timer to a habit whose stored goals use any other unit.

    Called after ownership is settled, so ``habit_id`` is the caller's own.
    Every tier is checked: units are shared across tiers by the units editor,
    but ``PUT /goals/{id}`` writes one tier at a time.
    """
    result = await session.execute(
        select(Goal.target_unit, Goal.frequency_unit).where(col(Goal.habit_id) == habit_id)
    )
    for target_unit, frequency_unit in result.all():
        assert_linked_units_allowed(target_unit, frequency_unit)
