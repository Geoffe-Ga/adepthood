"""Tests for the Metta "Return" arc lifecycle endpoints (/metta-return).

These tests FAIL on import/collection until the implementation-specialist
creates ``backend/src/routers/metta_return.py`` (and the supporting model /
schemas) and mounts the router in ``backend/src/main.py``. That is the
correct RED state for Gate 1.

The Return is a declinable five-week Metta arc, offered only after Blue
Stage has been passed (highest stage reached >= 5). Accepting it starts a
guided arc the user can pause/resume/leave at any time with no penalty, and
none of the lifecycle actions ever mutate StageProgress.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.metta_return_arc import MettaReturnArc
from models.metta_return_offer_dismissal import MettaReturnOfferDismissal
from models.stage_progress import StageProgress
from models.user import User
from routers import metta_return as metta_return_router

_BASE_URL = "/metta-return"
_START_URL = f"{_BASE_URL}/arc"
_PAUSE_URL = f"{_BASE_URL}/arc/pause"
_RESUME_URL = f"{_BASE_URL}/arc/resume"
_LEAVE_URL = f"{_BASE_URL}/arc/leave"
_DISMISS_URL = f"{_BASE_URL}/offer/dismiss"
_FORBIDDEN_KEY = "user_id"
_ELIGIBLE_STAGE = 5
_INELIGIBLE_STAGE = 3


# ---------------------------------------------------------------------------
# Auth + seeding helpers
# ---------------------------------------------------------------------------


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Create an account and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


async def _get_user(session: AsyncSession, email: str) -> User:
    """Look up a signed-up user row by email."""
    result = await session.execute(select(User).where(col(User.email) == email))
    return result.scalars().one()


async def _seed_progress(
    session: AsyncSession,
    user_id: int,
    *,
    current_stage: int,
    completed_stages: list[int] | None = None,
    cycle_number: int = 1,
) -> StageProgress:
    """Insert a StageProgress row for a user at the given stage."""
    progress = StageProgress(
        user_id=user_id,
        current_stage=current_stage,
        completed_stages=completed_stages or [],
        cycle_number=cycle_number,
    )
    session.add(progress)
    await session.commit()
    await session.refresh(progress)
    return progress


async def _seed_active_arc(
    session: AsyncSession,
    user_id: int,
    *,
    started_at: datetime,
    paused_at: datetime | None = None,
) -> MettaReturnArc:
    """Insert an active (not-left) MettaReturnArc row directly."""
    arc = MettaReturnArc(user_id=user_id, started_at=started_at, paused_at=paused_at)
    session.add(arc)
    await session.commit()
    await session.refresh(arc)
    return arc


# ---------------------------------------------------------------------------
# 1. Auth: 401 unauthenticated on all five routes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_state_requires_auth(async_client: AsyncClient) -> None:
    """GET /metta-return without a token returns 401."""
    resp = await async_client.get(_BASE_URL)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_start_arc_requires_auth(async_client: AsyncClient) -> None:
    """POST /metta-return/arc without a token returns 401."""
    resp = await async_client.post(_START_URL)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_pause_arc_requires_auth(async_client: AsyncClient) -> None:
    """POST /metta-return/arc/pause without a token returns 401."""
    resp = await async_client.post(_PAUSE_URL)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_resume_arc_requires_auth(async_client: AsyncClient) -> None:
    """POST /metta-return/arc/resume without a token returns 401."""
    resp = await async_client.post(_RESUME_URL)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_leave_arc_requires_auth(async_client: AsyncClient) -> None:
    """POST /metta-return/arc/leave without a token returns 401."""
    resp = await async_client.post(_LEAVE_URL)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ---------------------------------------------------------------------------
# 2. GET shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_state_shape_no_active_arc(async_client: AsyncClient) -> None:
    """GET returns eligible flag, the 5-week sequence in order, and a null arc."""
    headers = await _signup(async_client, "mr_shape1")

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert isinstance(body["eligible"], bool)
    assert len(body["weeks"]) == 5
    assert [w["week_number"] for w in body["weeks"]] == [1, 2, 3, 4, 5]
    assert body["arc"] is None


@pytest.mark.asyncio
async def test_get_state_never_exposes_user_id(async_client: AsyncClient) -> None:
    """No response payload (top level, weeks, or arc) leaks a user_id key."""
    headers = await _signup(async_client, "mr_noleak2")

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert _FORBIDDEN_KEY not in body
    for week in body["weeks"]:
        assert _FORBIDDEN_KEY not in week
    if body["arc"] is not None:
        assert _FORBIDDEN_KEY not in body["arc"]


@pytest.mark.asyncio
async def test_get_state_does_not_provision_stage_progress(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """GET is read-only: a brand-new user's StageProgress row must not be created."""
    headers = await _signup(async_client, "mr_noprovision3")
    user = await _get_user(db_session, "mr_noprovision3@example.com")
    assert user.id is not None
    user_id = user.id

    resp = await async_client.get(_BASE_URL, headers=headers)
    assert resp.status_code == HTTPStatus.OK

    db_session.expire_all()
    result = await db_session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    assert result.scalars().first() is None


@pytest.mark.asyncio
async def test_get_state_reads_active_arc_without_row_lock(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GET projects the active arc via the lock-free reader, never ``FOR UPDATE``.

    ``GET`` never writes, so it must use ``_active_arc`` (a plain ``select``) and
    never ``_active_arc_for_update`` (``SELECT ... FOR UPDATE``), which would
    serialize concurrent reads from one caller. Poison the write-lock reader so
    any accidental call from the read path fails loudly.
    """
    headers = await _signup(async_client, "mr_getnolock5")
    user = await _get_user(db_session, "mr_getnolock5@example.com")
    assert user.id is not None
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))

    def _forbidden(*_args: object, **_kwargs: object) -> None:
        message = "GET must not acquire a row lock"
        raise AssertionError(message)

    monkeypatch.setattr(metta_return_router, "_active_arc_for_update", _forbidden)

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["arc"] is not None


# ---------------------------------------------------------------------------
# 3. Start: eligibility gate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_arc_eligible_user_returns_week_one_self(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An eligible user (stage 5+) starting an arc lands on week 1, focus self."""
    headers = await _signup(async_client, "mr_start4")
    user = await _get_user(db_session, "mr_start4@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)

    resp = await async_client.post(_START_URL, headers=headers)

    assert resp.status_code == HTTPStatus.CREATED
    body = resp.json()
    assert body["week"] == 1
    assert body["focus"] == "self"
    assert body["paused"] is False
    assert _FORBIDDEN_KEY not in body


@pytest.mark.asyncio
async def test_start_arc_ineligible_user_returns_409(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A user below the Blue-passed threshold cannot start the arc; no row persists."""
    headers = await _signup(async_client, "mr_ineligible5")
    user = await _get_user(db_session, "mr_ineligible5@example.com")
    assert user.id is not None
    user_id = user.id
    await _seed_progress(db_session, user_id, current_stage=_INELIGIBLE_STAGE)

    resp = await async_client.post(_START_URL, headers=headers)

    assert resp.status_code == HTTPStatus.CONFLICT

    db_session.expire_all()
    result = await db_session.execute(
        select(MettaReturnArc).where(col(MettaReturnArc.user_id) == user_id)
    )
    assert result.scalars().first() is None


@pytest.mark.asyncio
async def test_start_arc_twice_while_active_returns_409(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A second start while an arc is already active is rejected, not duplicated."""
    headers = await _signup(async_client, "mr_double6")
    user = await _get_user(db_session, "mr_double6@example.com")
    assert user.id is not None
    user_id = user.id
    await _seed_progress(db_session, user_id, current_stage=_ELIGIBLE_STAGE)

    first = await async_client.post(_START_URL, headers=headers)
    assert first.status_code == HTTPStatus.CREATED

    second = await async_client.post(_START_URL, headers=headers)
    assert second.status_code == HTTPStatus.CONFLICT

    db_session.expire_all()
    result = await db_session.execute(
        select(MettaReturnArc).where(
            col(MettaReturnArc.user_id) == user_id,
            col(MettaReturnArc.left_at).is_(None),
        )
    )
    assert len(list(result.scalars().all())) == 1


@pytest.mark.asyncio
async def test_start_arc_losing_a_concurrent_race_returns_409(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When two starts race, the loser's insert hits the unique index and 409s.

    The pre-check cannot lock a not-yet-existing row, so a truly concurrent
    start can slip past it. Forcing the pre-check to see no active arc while one
    already exists exercises the partial-unique-index guard: the insert raises
    IntegrityError, which the handler collapses to the same 409, never a 500.
    """
    headers = await _signup(async_client, "mr_race16")
    user = await _get_user(db_session, "mr_race16@example.com")
    assert user.id is not None
    user_id = user.id
    await _seed_progress(db_session, user_id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user_id, started_at=datetime.now(UTC))

    async def _pretend_no_active_arc(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(metta_return_router, "_active_arc_for_update", _pretend_no_active_arc)

    resp = await async_client.post(_START_URL, headers=headers)

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "return_arc_already_active"


# ---------------------------------------------------------------------------
# 4. Pause / resume lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pause_freezes_week_and_resume_ticks_again(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Pausing an arc freezes the reported week; resuming lets it advance again."""
    headers = await _signup(async_client, "mr_pauseresume7")
    user = await _get_user(db_session, "mr_pauseresume7@example.com")
    assert user.id is not None
    user_id = user.id
    await _seed_progress(db_session, user_id, current_stage=_ELIGIBLE_STAGE)

    # Back-dated start: 10 days in, so unpaused week would be 2.
    started_at = datetime.now(UTC) - timedelta(days=10)
    await _seed_active_arc(db_session, user_id, started_at=started_at)

    pause_resp = await async_client.post(_PAUSE_URL, headers=headers)
    assert pause_resp.status_code == HTTPStatus.OK
    assert pause_resp.json()["paused"] is True
    frozen_week = pause_resp.json()["week"]

    get_resp = await async_client.get(_BASE_URL, headers=headers)
    assert get_resp.status_code == HTTPStatus.OK
    assert get_resp.json()["arc"]["week"] == frozen_week
    assert get_resp.json()["arc"]["paused"] is True

    resume_resp = await async_client.post(_RESUME_URL, headers=headers)
    assert resume_resp.status_code == HTTPStatus.OK
    assert resume_resp.json()["paused"] is False


@pytest.mark.asyncio
async def test_pause_when_already_paused_is_idempotent_no_op(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Pausing an already-paused arc returns 200 without changing its frozen week."""
    headers = await _signup(async_client, "mr_pauseidem8")
    user = await _get_user(db_session, "mr_pauseidem8@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)

    started_at = datetime.now(UTC) - timedelta(days=10)
    paused_at = datetime.now(UTC) - timedelta(days=3)
    await _seed_active_arc(db_session, user.id, started_at=started_at, paused_at=paused_at)

    first = await async_client.post(_PAUSE_URL, headers=headers)
    assert first.status_code == HTTPStatus.OK
    second = await async_client.post(_PAUSE_URL, headers=headers)
    assert second.status_code == HTTPStatus.OK
    assert second.json()["week"] == first.json()["week"]
    assert second.json()["paused"] is True


@pytest.mark.asyncio
async def test_resume_when_not_paused_is_idempotent_no_op(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Resuming an arc that is not paused returns 200 without altering its state."""
    headers = await _signup(async_client, "mr_resumeidem9")
    user = await _get_user(db_session, "mr_resumeidem9@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)

    started_at = datetime.now(UTC) - timedelta(days=2)
    await _seed_active_arc(db_session, user.id, started_at=started_at)

    resp = await async_client.post(_RESUME_URL, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["paused"] is False


@pytest.mark.asyncio
async def test_pause_without_active_arc_returns_404(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Pausing with no active arc returns 404."""
    headers = await _signup(async_client, "mr_pause404_10")
    user = await _get_user(db_session, "mr_pause404_10@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)

    resp = await async_client.post(_PAUSE_URL, headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_resume_without_active_arc_returns_404(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Resuming with no active arc returns 404."""
    headers = await _signup(async_client, "mr_resume404_11")
    user = await _get_user(db_session, "mr_resume404_11@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)

    resp = await async_client.post(_RESUME_URL, headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ---------------------------------------------------------------------------
# 5. Leave lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_leave_removes_arc_from_get_and_blocks_further_lifecycle(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """After leaving, GET shows no arc and pause/resume/leave all 404."""
    headers = await _signup(async_client, "mr_leave12")
    user = await _get_user(db_session, "mr_leave12@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))

    leave_resp = await async_client.post(_LEAVE_URL, headers=headers)
    assert leave_resp.status_code == HTTPStatus.OK

    get_resp = await async_client.get(_BASE_URL, headers=headers)
    assert get_resp.status_code == HTTPStatus.OK
    assert get_resp.json()["arc"] is None

    assert (await async_client.post(_PAUSE_URL, headers=headers)).status_code == (
        HTTPStatus.NOT_FOUND
    )
    assert (await async_client.post(_RESUME_URL, headers=headers)).status_code == (
        HTTPStatus.NOT_FOUND
    )
    assert (await async_client.post(_LEAVE_URL, headers=headers)).status_code == (
        HTTPStatus.NOT_FOUND
    )


@pytest.mark.asyncio
async def test_start_again_after_leave_succeeds(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Leaving frees the partial-unique slot: a fresh arc can be started afterward."""
    headers = await _signup(async_client, "mr_restart13")
    user = await _get_user(db_session, "mr_restart13@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))

    leave_resp = await async_client.post(_LEAVE_URL, headers=headers)
    assert leave_resp.status_code == HTTPStatus.OK

    restart_resp = await async_client.post(_START_URL, headers=headers)
    assert restart_resp.status_code == HTTPStatus.CREATED
    assert restart_resp.json()["week"] == 1


# ---------------------------------------------------------------------------
# 6. Cross-user isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cross_user_lifecycle_posts_return_404_never_mutate_other_arc(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """User B's pause/resume/leave never touches user A's active arc."""
    alice_headers = await _signup(async_client, "mr_alice14")
    bob_headers = await _signup(async_client, "mr_bob14")

    alice = await _get_user(db_session, "mr_alice14@example.com")
    bob = await _get_user(db_session, "mr_bob14@example.com")
    assert alice.id is not None
    assert bob.id is not None

    await _seed_progress(db_session, alice.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_progress(db_session, bob.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, alice.id, started_at=datetime.now(UTC))

    assert (await async_client.post(_PAUSE_URL, headers=bob_headers)).status_code == (
        HTTPStatus.NOT_FOUND
    )
    assert (await async_client.post(_RESUME_URL, headers=bob_headers)).status_code == (
        HTTPStatus.NOT_FOUND
    )
    assert (await async_client.post(_LEAVE_URL, headers=bob_headers)).status_code == (
        HTTPStatus.NOT_FOUND
    )

    # Bob's read path is isolated too: GET never surfaces Alice's active arc.
    bob_get = await async_client.get(_BASE_URL, headers=bob_headers)
    assert bob_get.status_code == HTTPStatus.OK
    assert bob_get.json()["arc"] is None

    # Alice's arc remains untouched: still active, unpaused.
    alice_get = await async_client.get(_BASE_URL, headers=alice_headers)
    assert alice_get.status_code == HTTPStatus.OK
    assert alice_get.json()["arc"] is not None
    assert alice_get.json()["arc"]["paused"] is False


# ---------------------------------------------------------------------------
# 7. No mutation of StageProgress
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_full_lifecycle_never_mutates_stage_progress(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Start -> pause -> leave never touches current_stage/completed_stages/cycle_number."""
    headers = await _signup(async_client, "mr_nomutate15")
    user = await _get_user(db_session, "mr_nomutate15@example.com")
    assert user.id is not None
    user_id = user.id
    progress = await _seed_progress(
        db_session,
        user_id,
        current_stage=_ELIGIBLE_STAGE,
        completed_stages=[1, 2, 3, 4],
        cycle_number=1,
    )
    before_stage = progress.current_stage
    before_completed = list(progress.completed_stages)
    before_cycle = progress.cycle_number

    start_resp = await async_client.post(_START_URL, headers=headers)
    assert start_resp.status_code == HTTPStatus.CREATED

    pause_resp = await async_client.post(_PAUSE_URL, headers=headers)
    assert pause_resp.status_code == HTTPStatus.OK

    leave_resp = await async_client.post(_LEAVE_URL, headers=headers)
    assert leave_resp.status_code == HTTPStatus.OK

    db_session.expire_all()
    result = await db_session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    refreshed = result.scalars().one()
    assert refreshed.current_stage == before_stage
    assert list(refreshed.completed_stages) == before_completed
    assert refreshed.cycle_number == before_cycle


# ---------------------------------------------------------------------------
# 8. Per-episode offer dismissal (GET offer_dismissed + POST offer/dismiss)
# ---------------------------------------------------------------------------


async def _dismissal_count(session: AsyncSession, user_id: int) -> int:
    """Count MettaReturnOfferDismissal rows for a user, after expiring the identity map."""
    session.expire_all()
    result = await session.execute(
        select(MettaReturnOfferDismissal).where(col(MettaReturnOfferDismissal.user_id) == user_id)
    )
    return len(list(result.scalars().all()))


@pytest.mark.asyncio
async def test_get_state_offer_dismissed_defaults_false_for_fresh_user(
    async_client: AsyncClient,
) -> None:
    """A fresh user with no StageProgress at all has never dismissed anything."""
    headers = await _signup(async_client, "mr_dismissdefault17")

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["offer_dismissed"] is False


@pytest.mark.asyncio
async def test_get_state_offer_dismissed_false_for_ineligible_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An ineligible user has no current episode, so offer_dismissed is always False."""
    headers = await _signup(async_client, "mr_dismissineligible18")
    user = await _get_user(db_session, "mr_dismissineligible18@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_INELIGIBLE_STAGE)

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["offer_dismissed"] is False


@pytest.mark.asyncio
async def test_dismiss_offer_requires_auth(async_client: AsyncClient) -> None:
    """POST /metta-return/offer/dismiss without a token returns 401."""
    resp = await async_client.post(_DISMISS_URL)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_dismiss_offer_eligible_user_returns_dismissed_state(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An eligible user's dismiss call succeeds and reports offer_dismissed True, no owner key."""
    headers = await _signup(async_client, "mr_dismisseligible19")
    user = await _get_user(db_session, "mr_dismisseligible19@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)

    resp = await async_client.post(_DISMISS_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["offer_dismissed"] is True
    assert _FORBIDDEN_KEY not in body


@pytest.mark.asyncio
async def test_dismiss_offer_persists_across_sessions(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A dismissal survives a fresh GET, proving it is stored in the database."""
    headers = await _signup(async_client, "mr_dismisspersist20")
    user = await _get_user(db_session, "mr_dismisspersist20@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)

    dismiss_resp = await async_client.post(_DISMISS_URL, headers=headers)
    assert dismiss_resp.status_code == HTTPStatus.OK

    get_resp = await async_client.get(_BASE_URL, headers=headers)
    assert get_resp.status_code == HTTPStatus.OK
    assert get_resp.json()["offer_dismissed"] is True


@pytest.mark.asyncio
async def test_dismiss_offer_twice_is_idempotent_single_row(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A repeat dismiss for the same episode is a 200 no-op backed by one row."""
    headers = await _signup(async_client, "mr_dismissidem21")
    user = await _get_user(db_session, "mr_dismissidem21@example.com")
    assert user.id is not None
    user_id = user.id
    await _seed_progress(db_session, user_id, current_stage=_ELIGIBLE_STAGE)

    first = await async_client.post(_DISMISS_URL, headers=headers)
    assert first.status_code == HTTPStatus.OK
    second = await async_client.post(_DISMISS_URL, headers=headers)
    assert second.status_code == HTTPStatus.OK
    assert second.json()["offer_dismissed"] is True

    assert await _dismissal_count(db_session, user_id) == 1


@pytest.mark.asyncio
async def test_dismiss_offer_concurrent_insert_race_returns_200_single_row(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A racing insert that trips the unique index rolls back yet still returns 200.

    Forcing the pre-check to miss an already-persisted row drives the
    ``except IntegrityError`` branch: the rollback expires ``progress``, so the
    endpoint must re-materialize it instead of 500-ing on an expired attribute.
    """
    headers = await _signup(async_client, "mr_dismissrace26")
    user = await _get_user(db_session, "mr_dismissrace26@example.com")
    assert user.id is not None
    user_id = user.id
    await _seed_progress(db_session, user_id, current_stage=_ELIGIBLE_STAGE)

    first = await async_client.post(_DISMISS_URL, headers=headers)
    assert first.status_code == HTTPStatus.OK

    async def _always_absent(*_args: object, **_kwargs: object) -> bool:
        return False

    monkeypatch.setattr(metta_return_router, "_offer_dismissed", _always_absent)

    racing = await async_client.post(_DISMISS_URL, headers=headers)

    assert racing.status_code == HTTPStatus.OK
    assert racing.json()["offer_dismissed"] is True
    assert await _dismissal_count(db_session, user_id) == 1


@pytest.mark.asyncio
async def test_dismiss_offer_ineligible_user_returns_409_and_persists_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An ineligible user cannot dismiss a non-existent offer; no row is written."""
    headers = await _signup(async_client, "mr_dismissineligible409_22")
    user = await _get_user(db_session, "mr_dismissineligible409_22@example.com")
    assert user.id is not None
    user_id = user.id
    await _seed_progress(db_session, user_id, current_stage=_INELIGIBLE_STAGE)

    resp = await async_client.post(_DISMISS_URL, headers=headers)

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "return_not_eligible"
    assert await _dismissal_count(db_session, user_id) == 0


@pytest.mark.asyncio
async def test_dismiss_offer_cross_user_isolation(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Alice's dismissal never suppresses Bob's offer, and Alice's stays dismissed."""
    alice_headers = await _signup(async_client, "mr_dismissalice23")
    bob_headers = await _signup(async_client, "mr_dismissbob23")

    alice = await _get_user(db_session, "mr_dismissalice23@example.com")
    bob = await _get_user(db_session, "mr_dismissbob23@example.com")
    assert alice.id is not None
    assert bob.id is not None

    await _seed_progress(db_session, alice.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_progress(db_session, bob.id, current_stage=_ELIGIBLE_STAGE)

    dismiss_resp = await async_client.post(_DISMISS_URL, headers=alice_headers)
    assert dismiss_resp.status_code == HTTPStatus.OK

    bob_get = await async_client.get(_BASE_URL, headers=bob_headers)
    assert bob_get.status_code == HTTPStatus.OK
    assert bob_get.json()["offer_dismissed"] is False

    alice_get = await async_client.get(_BASE_URL, headers=alice_headers)
    assert alice_get.status_code == HTTPStatus.OK
    assert alice_get.json()["offer_dismissed"] is True


@pytest.mark.asyncio
async def test_dismiss_offer_resets_when_episode_advances(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Advancing to a new stage opens a fresh episode: the old dismissal no longer applies."""
    headers = await _signup(async_client, "mr_dismissreset24")
    user = await _get_user(db_session, "mr_dismissreset24@example.com")
    assert user.id is not None
    progress = await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)

    dismiss_resp = await async_client.post(_DISMISS_URL, headers=headers)
    assert dismiss_resp.status_code == HTTPStatus.OK

    dismissed_get = await async_client.get(_BASE_URL, headers=headers)
    assert dismissed_get.json()["offer_dismissed"] is True

    progress.current_stage = _ELIGIBLE_STAGE + 1
    db_session.add(progress)
    await db_session.commit()

    reset_get = await async_client.get(_BASE_URL, headers=headers)
    assert reset_get.status_code == HTTPStatus.OK
    assert reset_get.json()["offer_dismissed"] is False


@pytest.mark.asyncio
async def test_dismiss_offer_does_not_mutate_stage_progress_or_create_arc(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Dismissing the offer never touches StageProgress and never opens a Return arc."""
    headers = await _signup(async_client, "mr_dismissnomutate25")
    user = await _get_user(db_session, "mr_dismissnomutate25@example.com")
    assert user.id is not None
    user_id = user.id
    progress = await _seed_progress(
        db_session,
        user_id,
        current_stage=_ELIGIBLE_STAGE,
        completed_stages=[1, 2, 3, 4],
        cycle_number=1,
    )
    before_stage = progress.current_stage
    before_completed = list(progress.completed_stages)
    before_cycle = progress.cycle_number

    dismiss_resp = await async_client.post(_DISMISS_URL, headers=headers)
    assert dismiss_resp.status_code == HTTPStatus.OK

    db_session.expire_all()
    result = await db_session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    refreshed = result.scalars().one()
    assert refreshed.current_stage == before_stage
    assert list(refreshed.completed_stages) == before_completed
    assert refreshed.cycle_number == before_cycle

    arc_result = await db_session.execute(
        select(MettaReturnArc).where(col(MettaReturnArc.user_id) == user_id)
    )
    assert arc_result.scalars().first() is None


# ---------------------------------------------------------------------------
# 8. Completion: a finished arc reports a warm complete state.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_arc_fresh_returns_complete_false(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A freshly started arc is nowhere near finished: complete is False."""
    headers = await _signup(async_client, "mr_freshcomplete17")
    user = await _get_user(db_session, "mr_freshcomplete17@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)

    resp = await async_client.post(_START_URL, headers=headers)

    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["complete"] is False


@pytest.mark.asyncio
async def test_get_state_thirty_five_day_arc_is_complete_at_week_five(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An arc backdated the full RETURN_TOTAL_DAYS reports week 5 and complete True."""
    headers = await _signup(async_client, "mr_complete18")
    user = await _get_user(db_session, "mr_complete18@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    started_at = datetime.now(UTC) - timedelta(days=35)
    await _seed_active_arc(db_session, user.id, started_at=started_at)

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    arc = resp.json()["arc"]
    assert arc["week"] == 5
    assert arc["complete"] is True


@pytest.mark.asyncio
async def test_get_state_thirty_day_arc_is_week_five_but_not_complete(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An arc backdated 30 days sits in week 5 but has not finished living it."""
    headers = await _signup(async_client, "mr_notcomplete19")
    user = await _get_user(db_session, "mr_notcomplete19@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    started_at = datetime.now(UTC) - timedelta(days=30)
    await _seed_active_arc(db_session, user.id, started_at=started_at)

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    arc = resp.json()["arc"]
    assert arc["week"] == 5
    assert arc["complete"] is False


@pytest.mark.asyncio
async def test_get_state_arc_payload_carries_complete_key_and_no_user_id(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The arc payload carries a complete key and still leaks no user_id."""
    headers = await _signup(async_client, "mr_completekey20")
    user = await _get_user(db_session, "mr_completekey20@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    await _seed_active_arc(db_session, user.id, started_at=datetime.now(UTC))

    resp = await async_client.get(_BASE_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    arc = resp.json()["arc"]
    assert "complete" in arc
    assert _FORBIDDEN_KEY not in arc


@pytest.mark.asyncio
async def test_completion_never_mutates_stage_progress(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Reading a complete arc never touches current_stage/completed_stages/cycle_number."""
    headers = await _signup(async_client, "mr_completenomutate21")
    user = await _get_user(db_session, "mr_completenomutate21@example.com")
    assert user.id is not None
    user_id = user.id
    progress = await _seed_progress(
        db_session,
        user_id,
        current_stage=_ELIGIBLE_STAGE,
        completed_stages=[1, 2, 3, 4],
        cycle_number=1,
    )
    before_stage = progress.current_stage
    before_completed = list(progress.completed_stages)
    before_cycle = progress.cycle_number
    started_at = datetime.now(UTC) - timedelta(days=35)
    await _seed_active_arc(db_session, user_id, started_at=started_at)

    resp = await async_client.get(_BASE_URL, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["arc"]["complete"] is True

    db_session.expire_all()
    result = await db_session.execute(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    refreshed = result.scalars().one()
    assert refreshed.current_stage == before_stage
    assert list(refreshed.completed_stages) == before_completed
    assert refreshed.cycle_number == before_cycle


@pytest.mark.asyncio
async def test_leave_complete_arc_then_restart_lands_on_week_one_incomplete(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Setting down a finished arc frees the slot; the next arc starts fresh."""
    headers = await _signup(async_client, "mr_leavecomplete22")
    user = await _get_user(db_session, "mr_leavecomplete22@example.com")
    assert user.id is not None
    await _seed_progress(db_session, user.id, current_stage=_ELIGIBLE_STAGE)
    started_at = datetime.now(UTC) - timedelta(days=35)
    await _seed_active_arc(db_session, user.id, started_at=started_at)

    leave_resp = await async_client.post(_LEAVE_URL, headers=headers)
    assert leave_resp.status_code == HTTPStatus.OK

    restart_resp = await async_client.post(_START_URL, headers=headers)
    assert restart_resp.status_code == HTTPStatus.CREATED
    assert restart_resp.json()["week"] == 1
    assert restart_resp.json()["complete"] is False
