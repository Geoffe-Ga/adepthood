"""The Goal model declares the tier CHECK constraint its migration creates.

Migration ``c3d4e5f6a7b8`` added ``ck_goal_tier_valid`` to bound ``goal.tier`` to
the :class:`GoalTier` members, but the model never declared it. That divergence
was invisible for as long as it existed: Alembic 1.18.x did not compare CHECK
constraints during autogenerate, so ``alembic check`` saw a clean tree. Alembic
1.19 does compare them, and immediately reported the constraint as *removed* --
the model, being metadata's only account of the table, appeared to have dropped
something the database has.

These tests pin the model side of that agreement so the drift cannot come back,
and pin the constraint's *effect* so it is more than a shape that satisfies a
gate: the ORM must actually refuse a tier outside the enum.
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import CheckConstraint
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from models.goal import Goal, GoalTier
from models.habit import Habit

# The name migration c3d4e5f6a7b8 creates the constraint under. The model must
# use the same one -- a differently-named constraint with identical semantics
# still reads to Alembic as one dropped and one added.
_CONSTRAINT_NAME = "ck_goal_tier_valid"


# Reached through the shared metadata rather than ``Goal.__table__``: SQLModel
# does not type the latter, so mypy rejects it, and the registry is the same
# Table object Alembic's autogenerate compares against anyway.
_GOAL_TABLE_NAME = "goal"


def _tier_check_constraints() -> list[CheckConstraint]:
    """Return every CHECK constraint the Goal table declares under the pinned name."""
    table = SQLModel.metadata.tables[_GOAL_TABLE_NAME]
    return [
        constraint
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint) and constraint.name == _CONSTRAINT_NAME
    ]


def _habit(name: str) -> Habit:
    """Build a minimally valid Habit to hang a Goal off.

    Every NOT NULL column is supplied: this fixture exists only to satisfy the
    goal's foreign key, so nothing here is under test and the values are the
    least interesting ones that are legal.
    """
    return Habit(
        user_id=1,
        name=name,
        icon="circle",
        start_date=date(2026, 1, 1),
        energy_cost=1,
        energy_return=1,
    )


class TestGoalTierConstraintIsDeclared:
    """The model's metadata carries the constraint the migration created."""

    def test_the_constraint_is_declared_exactly_once(self) -> None:
        """Present, and not duplicated by a second declaration under the same name."""
        assert len(_tier_check_constraints()) == 1

    @pytest.mark.parametrize("tier", list(GoalTier))
    def test_every_enum_member_appears_in_the_predicate(self, tier: GoalTier) -> None:
        """A member missing from the predicate would be rejected despite being valid."""
        sqltext = str(_tier_check_constraints()[0].sqltext)
        assert f"'{tier.value}'" in sqltext

    def test_the_predicate_constrains_the_tier_column(self) -> None:
        """A predicate over some other column would bound the wrong thing entirely."""
        assert "tier" in str(_tier_check_constraints()[0].sqltext)


class TestGoalTierConstraintIsEnforced:
    """The constraint does its job, rather than merely existing to satisfy a gate."""

    @pytest.mark.asyncio
    async def test_a_tier_outside_the_enum_is_rejected(self, db_session: AsyncSession) -> None:
        """The whole point of the constraint: an unlisted tier cannot be stored."""
        habit = _habit("Morning sit")
        db_session.add(habit)
        await db_session.commit()
        await db_session.refresh(habit)

        db_session.add(
            Goal(
                habit_id=habit.id,
                title="A goal with an invented tier",
                tier="platinum",
                target=1.0,
                target_unit="minutes",
                frequency=1.0,
                frequency_unit="per_day",
            )
        )
        with pytest.raises(IntegrityError):
            await db_session.commit()
        await db_session.rollback()

    @pytest.mark.parametrize("tier", list(GoalTier))
    @pytest.mark.asyncio
    async def test_every_enum_member_is_accepted(
        self, db_session: AsyncSession, tier: GoalTier
    ) -> None:
        """A constraint that rejected a legitimate tier would be worse than none."""
        habit = _habit(f"Habit for {tier.value}")
        db_session.add(habit)
        await db_session.commit()
        await db_session.refresh(habit)

        goal = Goal(
            habit_id=habit.id,
            title=f"A {tier.value} goal",
            tier=tier.value,
            target=1.0,
            target_unit="minutes",
            frequency=1.0,
            frequency_unit="per_day",
        )
        db_session.add(goal)
        await db_session.commit()
        await db_session.refresh(goal)

        assert goal.tier == tier.value
