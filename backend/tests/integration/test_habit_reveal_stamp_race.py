"""Two first habits reads racing the reveal pass, on a real PostgreSQL (#3071).

The SQLite suite cannot prove a reveal is stamped once: ``FOR UPDATE`` is a
no-op there, so two racing sessions both pass the locked re-read and both write.
Here the row lock is real. To make the race certain rather than likely, each
request's locked re-read is held until its twin has also reached it -- so both
requests have already judged the same invitation open without a lock -- and
every write the reveal pass makes is recorded, so the assertion counts stamps
instead of inferring them from a marker that a second write could overwrite.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import Counter
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import text

from services import habit_auto_reveal
from tests.helpers.feedback_triage import make_account

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from sqlalchemy.ext.asyncio import AsyncSession

    from models.habit import Habit
    from tests.integration.session_per_request import SessionPerRequest

pytestmark = pytest.mark.integration

# How long a locked re-read waits for its twin. Two unserialised requests always
# meet well inside this; the bound only stops a broken rendezvous from hanging.
_RENDEZVOUS_SECONDS = 2.0
_PARTIES = 2
# Beige's window, as a literal: a reshaped schedule should fail here.
_BEIGE_WINDOW_DAYS = 21
# The reveal pass's locked re-read and its writer, named once so the wrappers and
# their install agree. Both are resolved on the module at call time.
_LOCKED = "_locked_candidates"
_PERSIST = "_persist_reveals"
_LADDER = (("Beige ring", "Beige", 1), ("Purple ring", "Purple", 2))


class _RaceProbe:
    """Holds each round's first two locked re-reads together; records every stamp."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Install the hold on ``_locked_candidates`` and the recorder on ``_persist_reveals``."""
        self.stamped: list[str] = []
        self.held = 0
        self._arrived = 0
        self._both_here = asyncio.Event()
        real_locked: Callable[..., Awaitable[list[Habit]]] = getattr(habit_auto_reveal, _LOCKED)
        real_persist: Callable[..., Awaitable[int]] = getattr(habit_auto_reveal, _PERSIST)

        async def _held_locked(*args: object, **kwargs: object) -> list[Habit]:
            self._arrived += 1
            if self._arrived <= _PARTIES:
                if self._arrived == _PARTIES:
                    self._both_here.set()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._both_here.wait(), timeout=_RENDEZVOUS_SECONDS)
                self.held += 1
            return await real_locked(*args, **kwargs)

        async def _recorded_persist(
            session: AsyncSession, habits: list[Habit], moment: datetime
        ) -> int:
            self.stamped.extend(habit.name for habit in habits)
            return await real_persist(session, habits, moment)

        monkeypatch.setattr(habit_auto_reveal, _LOCKED, _held_locked)
        monkeypatch.setattr(habit_auto_reveal, _PERSIST, _recorded_persist)

    def next_round(self) -> None:
        """Re-arm the rendezvous and clear the record for another gathered pair."""
        self.stamped.clear()
        self.held = 0
        self._arrived = 0
        self._both_here = asyncio.Event()


async def _gathered_reads(pair: SessionPerRequest, headers: dict[str, str]) -> None:
    """Fire two habits reads at once and require both to succeed."""
    first, second = await asyncio.gather(
        pair.client.get("/habits/", headers=headers),
        pair.client.get("/habits/", headers=headers),
    )
    assert (first.status_code, second.status_code) == (HTTPStatus.OK, HTTPStatus.OK)


@pytest.mark.asyncio
async def test_racing_first_reads_provision_one_anchor_and_stamp_each_invitation_once(
    pair: SessionPerRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each invitation is written by exactly one of two racing reads, at both boundaries."""
    async with pair.factory() as session:
        account = await make_account(session, "habit_reveal_race@example.com")
    today = datetime.now(UTC).date().isoformat()
    for name, stage, slot in _LADDER:
        created = await pair.client.post(
            "/habits/",
            json={
                "name": name,
                "icon": "*",
                "start_date": today,
                "energy_cost": 1,
                "energy_return": 1,
                "stage": stage,
                "sort_order": slot,
                "revealed": False,
            },
            headers=account.headers,
        )
        assert created.status_code == HTTPStatus.OK
    probe = _RaceProbe(monkeypatch)

    # Day 0: no anchor yet, so both reads also race the provisioning SAVEPOINT.
    await _gathered_reads(pair, account.headers)

    assert probe.held == _PARTIES, "both reads must reach the locked re-read together"
    assert Counter(probe.stamped) == Counter({"Beige ring": 1})
    async with pair.factory() as session:
        rows = await session.scalar(
            text("SELECT count(*) FROM stageprogress WHERE user_id = :uid"),
            {"uid": account.user_id},
        )
        assert rows == 1
        await session.execute(
            text("UPDATE stageprogress SET program_started_at = :at WHERE user_id = :uid"),
            {
                "at": datetime.now(UTC) - timedelta(days=_BEIGE_WINDOW_DAYS),
                "uid": account.user_id,
            },
        )
        await session.commit()

    # Day 21: the Purple ring opens, and both reads judge it open without a lock.
    probe.next_round()
    await _gathered_reads(pair, account.headers)

    assert probe.held == _PARTIES, "both reads must reach the locked re-read together"
    assert Counter(probe.stamped) == Counter({"Purple ring": 1})
