"""Which habits a timer feeds, and the units such a habit may count in (#3150).

A habit linked to the journal's writing timer, or to a practice (#3151), is
logged by the timer itself: the amount
posted is the elapsed minutes, or one session. Its goals must therefore count
in a unit the timer can measure, and be scored over a period the timer's
sessions can fill. This module is the one place that rule lives:

* :func:`linked_habit_ids` answers "which of this user's habits does a timer
  feed?". Each link source -- the writing timer's single link and every
  practice's own -- contributes one query to the union, so every guard below
  covers both.
* :func:`assert_linked_unit_allowed` / :func:`assert_linked_frequency_unit_allowed`
  refuse anything else with the repo's 422.
* :func:`assert_habit_goals_linkable` checks a habit's *stored* goals, for the
  writes that create a link (``PATCH /ui-flags``,
  ``PATCH /user-practices/{id}/habit``).
* :func:`assert_units_allowed_if_linked` guards the writes that change a
  habit's units (``PUT /habits/{id}/goals/units``, ``PUT /goals/{id}``).
"""

from __future__ import annotations

from sqlalchemy import union
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select, update

from dependencies.ownership import resolve_owned_habit
from errors import unprocessable
from models.goal import Goal
from models.user_practice import UserPractice
from models.user_ui_flags import UserUiFlags

#: The only units a timer can measure: elapsed minutes, or one whole session.
LINKED_HABIT_UNITS: frozenset[str] = frozenset({"minutes", "sessions"})

#: The cadences a timer-fed habit may be scored over.
LINKED_HABIT_FREQUENCY_UNITS: frozenset[str] = frozenset({"per_day", "per_week"})


async def linked_habit_ids(session: AsyncSession, user_id: int) -> set[int]:
    """Return the ids of ``user_id``'s habits that a timer logs to.

    The union of the writing timer's single link
    (``UserUiFlags.writing_session_habit_id``) and every practice's own
    (``UserPractice.habit_id``, open or closed -- a closed selection can still
    log a session). A user with no links has none.

    An unset link is dropped once, in Python: the ``UNION`` already folds every
    unset row into a single ``NULL``, and the comprehension is what narrows the
    column's ``int | None`` to the ``int`` the set holds (#3172).
    """
    writing_link = select(col(UserUiFlags.writing_session_habit_id)).where(
        col(UserUiFlags.user_id) == user_id
    )
    practice_links = select(col(UserPractice.habit_id)).where(col(UserPractice.user_id) == user_id)
    result = await session.execute(union(writing_link, practice_links))
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


async def link_practice_habit(
    session: AsyncSession, user_practice: UserPractice, habit_id: int | None
) -> None:
    """Point ``user_practice`` at ``habit_id``, or unlink it on ``None``.

    ``user_practice`` is already the caller's own (resolved from the path). A
    habit id is authorised unconditionally -- 404 when it does not exist, an
    audited 403 when it is another user's -- *before* the unit rule, so a
    stranger's goals are never described by a 422. Only then must its stored
    goals count in a unit a timer can measure. A refusal writes nothing.
    Clearing the link names no other row and needs no check. The caller commits.
    """
    if habit_id is not None:
        await resolve_owned_habit(session, habit_id, user_practice.user_id)
        await assert_habit_goals_linkable(session, habit_id)
    user_practice.habit_id = habit_id
    session.add(user_practice)


async def clear_practice_habit_links(session: AsyncSession, habit_id: int) -> None:
    """Unlink every practice pointing at ``habit_id``, ahead of deleting it.

    The column's ``ON DELETE SET NULL`` is the backstop; this makes the rule hold
    wherever foreign keys are not enforced (SQLite without the pragma) and keeps
    it visible at the one place a habit is deleted. Mirrors
    :func:`domain.ui_flags.clear_writing_habit_links`. The caller commits.
    """
    await session.execute(
        update(UserPractice).where(col(UserPractice.habit_id) == habit_id).values(habit_id=None)
    )
