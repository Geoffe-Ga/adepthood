"""``POST /corpus/sweep``: sort the next bounded share of an account's backlog.

``GET /corpus/sweep`` (#3497) says how much of an account's writing is still
unsorted. This is the verb that acts on it: one bounded pass, the same pass a
consent grant runs, resumable by asking again until the remainder is zero.

It states no rules of its own, and the properties pinned here are the ones it
inherits from :func:`services.corpus_backfill.backfill_after_consent` rather
than re-implements:

*No consent, no sweep.* The pass runs under the decision already standing, so
an account that never said yes -- or said yes and then withdrew it -- reaches
no provider and writes nothing, and is told plainly how much is still waiting.

*Each pass leaves its own receipt, and only a pass that moved a number does.*
The row is filed under the standing consent event, which is how the reach of a
resumed sweep survives as something an export can carry rather than as a log
line.

*Intimate writing never moves.* It is never loaded, so it is never classified
and never leaves the deployment -- on this route as on the grant.

*The pass is free.* Nothing on the response names a price, because sorting has
none.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from http import HTTPStatus
from types import SimpleNamespace

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.frequencies import Frequency
from models.corpus_consent import CorpusConsentEvent
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.corpus_sweep import CorpusSweep
from models.journal_entry import JournalClassification, JournalEntry
from routers import corpus as corpus_router
from services import corpus_backfill as cb
from services import frequency_classification as fc
from services.corpus_backfill import BackfillOutcome
from services.corpus_consent import ConsentChange
from services.reflection_boundary import ReflectionBoundary

_SWEEP_PATH = "/corpus/sweep"
_CONSENT_PATH = f"/corpus/consent/{CorpusSource.JOURNAL.value}"

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

# A reply the classifier's parser accepts, naming one position on the ontology.
_CLASSIFIED_REPLY = json.dumps({"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9})

# A reply that places the entry nowhere: it is considered and stays pending.
_UNCLASSIFIED_REPLY = json.dumps({"weights": {}, "overall_confidence": 0.0})

# A string that exists nowhere in the response vocabulary, so finding it in a
# body or a provider prompt can only mean an entry's words were carried there.
_SENTINEL = "quartzlight-sentinel-phrase"

# A backlog larger than one, so a count a wrong implementation stumbled onto
# could not pass by coincidence.
_BACKLOG = 3

# A pass ceiling small enough to make a backlog of five take three passes, so
# resumption is exercised without writing forty-one entries.
_SMALL_CEILING = 2
_RESUMABLE_BACKLOG = 5


@pytest.fixture
def _classifier(monkeypatch: pytest.MonkeyPatch) -> None:
    """Route the classifier's provider call to a fake that always places the entry."""

    async def fake(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(text=_CLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", fake)


@pytest.fixture
def _no_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any provider dial a test failure rather than a silent success."""

    async def forbidden(**_kwargs: object) -> SimpleNamespace:
        msg = "this sweep must not dial a provider"
        raise AssertionError(msg)

    monkeypatch.setattr(fc, "generate_response", forbidden)


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh account and return its auth header and id."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _decide(client: AsyncClient, headers: dict[str, str], *, granted: bool) -> None:
    """Record a consent decision through the real route.

    Called before any writing exists, so the grant's own sweep reaches nothing
    and everything written afterwards is left for ``POST /corpus/sweep``.
    """
    resp = await client.put(_CONSENT_PATH, json={"granted": granted}, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text


async def _entries(
    session: AsyncSession,
    *,
    user_id: int,
    count: int,
    tier: JournalClassification = JournalClassification.PERSONAL,
    body: str = "a morning",
) -> None:
    """Put ``count`` un-ontologized journal rows in ``user_id``'s history.

    Inserted directly rather than through ``POST /journal/`` so the live write
    path's own ingest does not sort them first: the backlog this route exists
    for is writing that predates the permission.
    """
    for index in range(count):
        session.add(
            JournalEntry(
                message=f"{body} {index}",
                sender="user",
                user_id=user_id,
                classification=tier.value,
                timestamp=datetime.now(UTC),
            )
        )
    await session.commit()


async def _sweep(client: AsyncClient, headers: dict[str, str]) -> dict[str, int]:
    """Run one pass and return its body."""
    resp = await client.post(_SWEEP_PATH, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    return dict(resp.json())


async def _sweep_rows(session: AsyncSession, user_id: int) -> list[CorpusSweep]:
    """Every sweep receipt filed for ``user_id``, oldest first."""
    result = await session.execute(
        select(CorpusSweep)
        .where(col(CorpusSweep.user_id) == user_id)
        .order_by(col(CorpusSweep.id))
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _standing_grant_id(session: AsyncSession, user_id: int) -> int:
    """The id of ``user_id``'s one consent event."""
    result = await session.execute(
        select(col(CorpusConsentEvent.id)).where(col(CorpusConsentEvent.user_id) == user_id)
    )
    event_id = result.scalar_one()
    assert event_id is not None
    return event_id


async def _fragment_count(session: AsyncSession, user_id: int) -> int:
    """How many fragments ``user_id``'s corpus holds."""
    result = await session.execute(
        select(CorpusFragment.id).where(col(CorpusFragment.user_id) == user_id)
    )
    return len(list(result.scalars().all()))


@pytest.mark.asyncio
async def test_refuses_a_request_carrying_no_token(async_client: AsyncClient) -> None:
    """There is no anonymous "sort *my* writing"."""
    resp = await async_client.post(_SWEEP_PATH)

    assert resp.status_code == HTTPStatus.UNAUTHORIZED, resp.text


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier")
async def test_a_granted_account_has_its_backlog_sorted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One pass inside the bound sorts everything and says nothing is left.

    The body is ``GET /corpus/sweep``'s shape plus the pass's own two numbers,
    and the read agrees with it afterwards.
    """
    headers, user_id = await _signup(async_client, "sweep-run-granted")
    await _decide(async_client, headers, granted=True)
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    body = await _sweep(async_client, headers)
    estimate = (await async_client.get(_SWEEP_PATH, headers=headers)).json()

    assert body == {"entries_pending": 0, "entries_sorted": _BACKLOG, "entries_remaining": 0}
    assert estimate == {"entries_pending": 0}
    assert await _fragment_count(db_session, user_id) == _BACKLOG


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier")
async def test_a_backlog_past_the_bound_is_finished_by_asking_again(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Resumable is the whole design: each pass takes the next share, down to zero.

    Each pass that moved a number files its own receipt under the one standing
    decision, so the reach of a resumed sweep is recorded rather than only
    logged.
    """
    monkeypatch.setattr(cb, "BACKFILL_ENTRY_CEILING", _SMALL_CEILING)
    headers, user_id = await _signup(async_client, "sweep-run-resume")
    await _decide(async_client, headers, granted=True)
    await _entries(db_session, user_id=user_id, count=_RESUMABLE_BACKLOG)

    passes = [await _sweep(async_client, headers) for _ in range(3)]

    assert [(p["entries_sorted"], p["entries_remaining"]) for p in passes] == [
        (2, 3),
        (2, 1),
        (1, 0),
    ]
    assert [p["entries_pending"] for p in passes] == [p["entries_remaining"] for p in passes]
    grant_id = await _standing_grant_id(db_session, user_id)
    rows = await _sweep_rows(db_session, user_id)
    assert [(r.fragments_added, r.entries_remaining) for r in rows] == [(2, 3), (2, 1), (1, 0)]
    assert {r.consent_event_id for r in rows} == {grant_id}


@pytest.mark.asyncio
async def test_a_pass_that_moved_no_number_files_no_receipt(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The log holds reaches, not requests.

    An entry the classifier places nowhere stays pending on purpose, so a
    second pass over it says exactly what the first did -- and appends nothing.
    """

    async def unplaced(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(text=_UNCLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", unplaced)
    headers, user_id = await _signup(async_client, "sweep-run-stuck")
    await _decide(async_client, headers, granted=True)
    await _entries(db_session, user_id=user_id, count=1)

    first = await _sweep(async_client, headers)
    second = await _sweep(async_client, headers)

    assert first == second == {"entries_pending": 1, "entries_sorted": 0, "entries_remaining": 1}
    assert len(await _sweep_rows(db_session, user_id)) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("_no_provider")
async def test_an_account_that_never_consented_sweeps_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No standing grant means the existing sweep's own "no sweep" answer.

    Not a second gate: the standing change is not a grant, so
    ``_authorising_event_id`` names no decision and the pass reaches nothing.
    The remainder is still reported truthfully -- it is waiting, not done.
    """
    headers, user_id = await _signup(async_client, "sweep-run-unconsented")
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    body = await _sweep(async_client, headers)

    assert body == {
        "entries_pending": _BACKLOG,
        "entries_sorted": 0,
        "entries_remaining": _BACKLOG,
    }
    assert await _fragment_count(db_session, user_id) == 0
    assert await _sweep_rows(db_session, user_id) == []


@pytest.mark.asyncio
async def test_a_withdrawn_grant_sweeps_nothing(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The decision in force is the newest one, so a revoked yes resumes nothing."""
    headers, user_id = await _signup(async_client, "sweep-run-revoked")
    await _decide(async_client, headers, granted=True)
    await _decide(async_client, headers, granted=False)
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    async def forbidden(**_kwargs: object) -> SimpleNamespace:
        msg = "a withdrawn grant must not dial a provider"
        raise AssertionError(msg)

    monkeypatch.setattr(fc, "generate_response", forbidden)

    body = await _sweep(async_client, headers)

    assert body["entries_sorted"] == 0
    assert body["entries_remaining"] == _BACKLOG
    assert await _fragment_count(db_session, user_id) == 0
    assert await _sweep_rows(db_session, user_id) == []


@pytest.mark.asyncio
async def test_intimate_writing_is_never_sent_anywhere(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Intimate entries are not loaded, so no provider ever sees their words.

    Asserted at the provider call, where it would hurt: the personal entry is
    classified and the intimate one is never part of any prompt, never stored
    as a fragment, and never counted as waiting.
    """
    prompts: list[str] = []

    async def recording(**kwargs: object) -> SimpleNamespace:
        prompts.append(repr(kwargs))
        return SimpleNamespace(text=_CLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", recording)
    headers, user_id = await _signup(async_client, "sweep-run-intimate")
    await _decide(async_client, headers, granted=True)
    await _entries(
        db_session,
        user_id=user_id,
        count=_BACKLOG,
        tier=JournalClassification.INTIMATE,
        body=_SENTINEL,
    )
    await _entries(db_session, user_id=user_id, count=1)

    body = await _sweep(async_client, headers)

    assert body == {"entries_pending": 0, "entries_sorted": 1, "entries_remaining": 0}
    assert prompts
    assert all(_SENTINEL not in prompt for prompt in prompts)
    assert await _fragment_count(db_session, user_id) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier")
async def test_the_response_never_quotes_the_writing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A pass is reported in counts. The words stay in the journal."""
    headers, user_id = await _signup(async_client, "sweep-run-privacy")
    await _decide(async_client, headers, granted=True)
    await _entries(db_session, user_id=user_id, count=_BACKLOG, body=_SENTINEL)

    resp = await async_client.post(_SWEEP_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert _SENTINEL not in resp.text
    assert set(resp.json()) == {"entries_pending", "entries_sorted", "entries_remaining"}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier")
async def test_the_pass_is_the_existing_sweep_run_under_the_standing_grant(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Delegation, not a copy: the route hands the standing decision to the sweep.

    The consent gate, the intimate-tier refusal, the per-entry clock and the
    deadline are the ones ``backfill_after_consent`` already carries, so the
    route is pinned to calling it with the account's own standing grant.
    """
    seen: list[int | None] = []
    original = corpus_router.backfill_after_consent

    async def spy(
        session: AsyncSession,
        *,
        user_id: int,
        change: ConsentChange,
        boundary: ReflectionBoundary,
    ) -> BackfillOutcome:
        seen.append(None if change.event is None else change.event.id)
        return await original(session, user_id=user_id, change=change, boundary=boundary)

    monkeypatch.setattr(corpus_router, "backfill_after_consent", spy)
    headers, user_id = await _signup(async_client, "sweep-run-delegates")
    await _decide(async_client, headers, granted=True)
    seen.clear()
    await _entries(db_session, user_id=user_id, count=1)

    await _sweep(async_client, headers)

    assert seen == [await _standing_grant_id(db_session, user_id)]
