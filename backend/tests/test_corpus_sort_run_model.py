"""``corpussortrun``: the database, not the code path, keeps a sort single-flight.

A second press of "Sort" must join the run already going rather than start a
second one, and two server workers can each receive one of those presses. An
in-process lock cannot see across workers, so the guarantee is a partial unique
index: at most one ``running`` row per account. Everything else here pins the
row's own vocabulary, so a writer that bypasses the service still cannot store
a state, lane or reason nobody defined.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from models.corpus_sort_run import CorpusSortRun, SortLane, SortRunState, SortStopReason
from models.user import User

_FINISHED = datetime(2026, 11, 3, tzinfo=UTC)


async def _user(session: AsyncSession, email: str) -> int:
    """Insert a bare account and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    assert user.id is not None
    return user.id


def _run(user_id: int, **overrides: object) -> CorpusSortRun:
    """A valid running row, with any field overridden."""
    fields: dict[str, object] = {
        "user_id": user_id,
        "lane": SortLane.APP_PROVIDER.value,
        "state": SortRunState.RUNNING.value,
        "entries_total": 3,
    }
    fields.update(overrides)
    return CorpusSortRun(**fields)


async def _rejects(session: AsyncSession, row: CorpusSortRun) -> None:
    """Assert the database refuses ``row``, and leave the session usable."""
    session.add(row)
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()


@pytest.mark.asyncio
async def test_one_account_holds_at_most_one_running_sort(db_session: AsyncSession) -> None:
    """The single-flight guarantee: a second running row for one account is refused."""
    user_id = await _user(db_session, "sort-run-single@example.com")
    db_session.add(_run(user_id))
    await db_session.commit()

    await _rejects(db_session, _run(user_id))


@pytest.mark.asyncio
async def test_finished_runs_do_not_block_a_new_one(db_session: AsyncSession) -> None:
    """The index covers only running rows, so history accumulates freely."""
    user_id = await _user(db_session, "sort-run-history@example.com")
    db_session.add(_run(user_id, state=SortRunState.COMPLETED.value, finished_at=_FINISHED))
    db_session.add(
        _run(
            user_id,
            state=SortRunState.STOPPED.value,
            stop_reason=SortStopReason.NO_CONSENT.value,
            finished_at=_FINISHED,
        )
    )
    db_session.add(_run(user_id))
    await db_session.commit()


@pytest.mark.asyncio
async def test_two_accounts_may_each_run_one(db_session: AsyncSession) -> None:
    """Single-flight is per account, never global."""
    first = await _user(db_session, "sort-run-a@example.com")
    second = await _user(db_session, "sort-run-b@example.com")
    db_session.add_all([_run(first), _run(second)])
    await db_session.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [
        {"state": "paused"},
        {"lane": "somewhere_else"},
        {"entries_total": -1},
        {"entries_offered": -1},
        {"entries_sorted": 2, "entries_offered": 1},
        # A reason belongs to a stopped run, and a stopped run must carry one.
        {"stop_reason": SortStopReason.NO_CONSENT.value},
        {"state": SortRunState.STOPPED.value, "finished_at": _FINISHED},
        {
            "state": SortRunState.STOPPED.value,
            "stop_reason": "felt_like_it",
            "finished_at": _FINISHED,
        },
        # A running row has not finished; a finished one says when.
        {"finished_at": _FINISHED},
        {"state": SortRunState.COMPLETED.value},
        # A lease is an owner and a clock, never one without the other.
        {"owner_id": "a" * 32},
    ],
)
async def test_the_row_vocabulary_is_closed(
    db_session: AsyncSession, overrides: dict[str, object]
) -> None:
    """Every CHECK refuses a value outside what the service can write."""
    user_id = await _user(db_session, f"sort-run-check-{len(str(overrides))}@example.com")

    await _rejects(db_session, _run(user_id, **overrides))
