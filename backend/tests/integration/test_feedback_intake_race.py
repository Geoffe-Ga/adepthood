"""Two submissions of one report racing through intake, on a real PostgreSQL.

``tests/test_feedback_api.py`` proves a replayed ``Idempotency-Key`` returns the
stored reference, but on SQLite and without forcing the interleaving that
matters: the second request usually arrives after the first has committed and
takes the plain replay branch. The branch this module exists to prove is the
other one -- both requests miss the replay pre-check, both insert, the partial
UNIQUE on ``(user_id, idem_key)`` refuses the loser, and
``_insert_with_fresh_public_id`` recovers by re-reading the winner.

To make that interleaving certain rather than likely, each pre-check is held
until its twin has also reached it, and the results are recorded, so the test
can assert both pre-checks really did miss before it credits the recovery path.
"""

from __future__ import annotations

import asyncio
import contextlib
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import text

from routers import feedback as feedback_router
from tests.helpers.feedback_triage import make_account

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from models.feedback import FeedbackReport
    from tests.integration.session_per_request import SessionPerRequest

pytestmark = pytest.mark.integration

# How long a pre-check waits for its twin. Two unserialised requests always meet
# well inside this; the bound only stops a broken rendezvous from hanging.
_RENDEZVOUS_SECONDS = 2.0
_PARTIES = 2
_INTAKE_KEY = "intake-race-0001"  # pragma: allowlist secret
_ONE_ROW = 1
# The router's replay look-up, named once so the wrapper and its install agree.
_PRE_CHECK = "_recorded_report"

_PAYLOAD: dict[str, object] = {
    "category": "broken",
    "impact": "blocked",
    "summary": "The shelf went blank while I was saving.",
    "context": {
        "screen": "journal.shelf",
        "control": "shell.header.send_feedback",
        "platform": "web",
        "app_build": "1.4.2",
        "viewport_class": "compact",
    },
}


def _hold_pre_checks(monkeypatch: pytest.MonkeyPatch) -> list[FeedbackReport | None]:
    """Hold the first two replay look-ups until both have arrived; record every result.

    The router resolves ``_recorded_report`` on its module at call time, so the
    wrapper intercepts both the replay pre-check and the recovery re-read. Only
    the first ``_PARTIES`` calls wait; the recovery read that follows proceeds
    at once.
    """
    real: Callable[..., Awaitable[FeedbackReport | None]] = getattr(feedback_router, _PRE_CHECK)
    results: list[FeedbackReport | None] = []
    arrived = 0
    both_here = asyncio.Event()

    async def _held(*args: object, **kwargs: object) -> FeedbackReport | None:
        nonlocal arrived
        arrived += 1
        if arrived <= _PARTIES:
            if arrived == _PARTIES:
                both_here.set()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(both_here.wait(), timeout=_RENDEZVOUS_SECONDS)
        found = await real(*args, **kwargs)
        results.append(found)
        return found

    monkeypatch.setattr(feedback_router, _PRE_CHECK, _held)
    return results


@pytest.mark.asyncio
async def test_two_racing_submissions_with_one_key_store_one_report(
    pair: SessionPerRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both callers get 201 and the same reference; the table holds one row."""
    async with pair.factory() as session:
        reporter = await make_account(session, "intake_race_reporter@example.com")
    looked_up = _hold_pre_checks(monkeypatch)
    headers = {**reporter.headers, "Idempotency-Key": _INTAKE_KEY}

    first, second = await asyncio.gather(
        pair.client.post("/feedback/", json=_PAYLOAD, headers=headers),
        pair.client.post("/feedback/", json=_PAYLOAD, headers=headers),
    )

    assert (first.status_code, second.status_code) == (HTTPStatus.CREATED, HTTPStatus.CREATED)
    assert first.json()["public_id"] == second.json()["public_id"]
    # Both replay pre-checks missed, so the single row is the recovery path's doing.
    assert looked_up[:_PARTIES] == [None] * _PARTIES
    async with pair.factory() as session:
        stored = await session.scalar(
            text("SELECT count(*) FROM feedbackreport WHERE user_id = :uid"),
            {"uid": reporter.user_id},
        )
    assert stored == _ONE_ROW
