"""An integer past its column's range is a bad request, not a broken server.

``10878892956`` fits comfortably in JSON and in Python, and passes every
validation the application currently declares.  It then reaches a PostgreSQL
``integer`` column, asyncpg raises ``OverflowError('value out of int32 range')``
inside the handler, and the unhandled-exception middleware answers 500.  The
caller sent something the API never promised to accept and was told the server
had failed.

The test database is SQLite, whose INTEGER is 64-bit, so that overflow is not
reproducible here and a test asserting only ``status_code == 422`` would pass for
the wrong reason -- any domain rejection, any database error, any renamed route
that 422s for an unrelated cause would satisfy it.  So every assertion below pins
the *shape* of the rejection instead:

``type == "less_than_equal"`` is Pydantic's own bound-violation code and can be
produced by nothing but the declared annotation.  ``loc[0] == "path"`` (or
``"query"`` / ``"body"``) places the rejection inside FastAPI's parameter solving
-- before the endpoint body runs, therefore before any database use.  No domain
422 and no driver error can produce that pair.  Those three keys are exactly what
``errors._sanitized_validation_entry`` preserves, so these assertions and the
redaction interlock rather than compete.

Every out-of-range case is paired with an in-range companion at the exact
boundary integer.  The companion proves the route is genuinely reachable, so a
422 cannot be a routing artifact, and pins the bound at the precise value rather
than somewhere in its neighbourhood.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from bounds import INT32_MAX, MAX_PAGE_OFFSET
from domain.constants import TOTAL_PROGRAM_WEEKS, TOTAL_STAGES
from models.user import User
from services.energy import ENERGY_PLAN_RETENTION_DAYS
from tests.routers.test_metta_return import _seed_active_arc, _seed_progress
from tests.test_course_api import _seed_stage_with_content

# The value from the field report: a plausible client-side identifier that is
# past int32 and nowhere near the 64-bit ceiling, so nothing but a declared
# bound stops it.
_PAST_INT32 = 10_878_892_956

# Pydantic's code for a violated ``le``.  Asserting on it rather than on the
# status is what distinguishes a bound rejection from every other 422.
_BOUND_VIOLATION = "less_than_equal"

# ``timedelta`` tops out at 999_999_999 days, well below int32's own ceiling, so
# a retention window declared merely "an int32" still overflows before it reaches
# any database.  The ceiling on that parameter has to sit below this.
_TIMEDELTA_MAX_DAYS = 999_999_999

_ELIGIBLE_ARC_STAGE = 5


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create an account and return its auth headers and user id."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _promote_to_admin(session: AsyncSession, email: str) -> None:
    """Flip an existing account's admin flag directly."""
    await session.execute(update(User).where(col(User.email) == email).values(is_admin=True))
    await session.commit()


def _first_entry(resp: Response) -> dict[str, object]:
    """Return ``detail[0]``, asserting the response really is a schema rejection.

    Guards every assertion in this file against the silent-pass failure mode
    where a renamed route answers 422 for some unrelated reason and the shape
    checks below never run at all.
    """
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, (
        f"expected a schema rejection, got {resp.status_code}: {resp.text}"
    )
    detail = resp.json()["detail"]
    assert isinstance(detail, list), f"422 body has no 'detail' list: {resp.text}"
    assert detail, f"422 body carries an empty 'detail' list: {resp.text}"
    entry = detail[0]
    assert isinstance(entry, dict), f"'detail' entry was not an object: {entry!r}"
    return entry


def _assert_bound_rejection(resp: Response, expected_loc: list[object]) -> None:
    """Assert the response is a bound violation at exactly ``expected_loc``.

    The two assertions carry different weight.  ``type`` proves an annotation
    rejected the value; ``loc`` proves where, and its first element proves the
    rejection happened during parameter solving rather than in the handler.
    """
    entry = _first_entry(resp)
    assert entry["type"] == _BOUND_VIOLATION, (
        f"rejected with {entry['type']!r}, not a declared-bound violation. A 422 "
        f"from some other cause does not prove the bound exists: {entry!r}"
    )
    assert entry["loc"] == expected_loc, (
        f"rejected at {entry['loc']!r}, not {expected_loc!r}: {entry!r}"
    )


def _assert_not_a_bound_rejection(resp: Response, label: str) -> None:
    """Assert an in-range companion reached past parameter solving.

    Anything but a 422 proves the route accepted the value; a 5xx would mean the
    bound was set somewhere the application still cannot survive.
    """
    assert resp.status_code != HTTPStatus.UNPROCESSABLE_ENTITY, (
        f"{label} was rejected as out of range, so the ceiling is set below it: {resp.text}"
    )
    assert resp.status_code < HTTPStatus.INTERNAL_SERVER_ERROR, (
        f"{label} is inside the declared range and still broke the server: {resp.text}"
    )


@pytest.mark.asyncio
async def test_habit_path_id_past_int32_is_rejected_before_the_database(
    async_client: AsyncClient,
) -> None:
    """A habit id past int32 must be refused while solving the path parameter."""
    headers, _ = await _signup(async_client, "habit-path")
    resp = await async_client.get(f"/habits/{_PAST_INT32}", headers=headers)
    _assert_bound_rejection(resp, ["path", "habit_id"])


@pytest.mark.asyncio
async def test_habit_path_id_at_int32_max_still_reaches_the_lookup(
    async_client: AsyncClient,
) -> None:
    """The largest storable id is a lookup that misses, not a rejection.

    The companion that makes the test above mean something: without it a 422
    could equally come from a route that stopped existing.
    """
    headers, _ = await _signup(async_client, "habit-path-max")
    resp = await async_client.get(f"/habits/{INT32_MAX}", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND, resp.text
    assert resp.json()["detail"] == "habit_not_found"


@pytest.mark.asyncio
async def test_pagination_offset_past_the_ceiling_is_rejected(
    async_client: AsyncClient,
) -> None:
    """One past the largest page offset is a query-parameter rejection."""
    headers, _ = await _signup(async_client, "offset-over")
    resp = await async_client.get(
        "/habits/", params={"offset": MAX_PAGE_OFFSET + 1}, headers=headers
    )
    _assert_bound_rejection(resp, ["query", "offset"])


@pytest.mark.asyncio
async def test_pagination_offset_at_the_ceiling_is_accepted(
    async_client: AsyncClient,
) -> None:
    """The largest page offset itself must still be served.

    Pins the boundary at the exact integer: an off-by-one in either direction
    fails this or its sibling above, not both and not neither.
    """
    headers, _ = await _signup(async_client, "offset-at")
    resp = await async_client.get("/habits/", params={"offset": MAX_PAGE_OFFSET}, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json() == []


@pytest.mark.asyncio
async def test_energy_plan_habit_element_id_past_int32_is_rejected(
    async_client: AsyncClient,
) -> None:
    """An oversized id inside the habit list is rejected at that element.

    The ``loc`` ending in ``[0, "id"]`` is what proves the bound sits on the
    element's own field rather than on the list, which already has a length cap
    that would produce a different rejection entirely.
    """
    headers, _ = await _signup(async_client, "energy-over")
    resp = await async_client.post(
        "/v1/energy/plan",
        json={
            "habits": [{"id": _PAST_INT32, "name": "Sit"}],
            "start_date": "2026-01-01",
        },
        headers=headers,
    )
    _assert_bound_rejection(resp, ["body", "habits", 0, "id"])


@pytest.mark.asyncio
async def test_energy_plan_habit_element_id_at_int32_max_reaches_ownership(
    async_client: AsyncClient,
) -> None:
    """The largest storable id passes validation and is resolved as a real habit."""
    headers, _ = await _signup(async_client, "energy-at")
    resp = await async_client.post(
        "/v1/energy/plan",
        json={
            "habits": [{"id": INT32_MAX, "name": "Sit"}],
            "start_date": "2026-01-01",
        },
        headers=headers,
    )
    _assert_not_a_bound_rejection(resp, "an energy-plan habit id at int32 max")


@pytest.mark.asyncio
async def test_release_habit_ids_element_past_int32_is_rejected(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An oversized element of ``habit_ids`` is rejected at its index.

    ``loc`` ending in the index rather than in the field name is what separates
    the element's own bound from the list's existing length bound: a rejection
    at ``["body", "habit_ids"]`` would be the latter.
    """
    headers, user_id = await _signup(async_client, "release-over")
    await _seed_progress(db_session, user_id, current_stage=_ELIGIBLE_ARC_STAGE)
    await _seed_active_arc(db_session, user_id, started_at=datetime.now(UTC) - timedelta(days=1))
    resp = await async_client.post(
        "/metta-return/arc/release", json={"habit_ids": [_PAST_INT32]}, headers=headers
    )
    _assert_bound_rejection(resp, ["body", "habit_ids", 0])


@pytest.mark.asyncio
async def test_release_habit_ids_element_at_int32_max_is_accepted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The largest storable id is an unknown habit, which the route skips silently."""
    headers, user_id = await _signup(async_client, "release-at")
    await _seed_progress(db_session, user_id, current_stage=_ELIGIBLE_ARC_STAGE)
    await _seed_active_arc(db_session, user_id, started_at=datetime.now(UTC) - timedelta(days=1))
    resp = await async_client.post(
        "/metta-return/arc/release", json={"habit_ids": [INT32_MAX]}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json() == []


@pytest.mark.asyncio
async def test_energy_cleanup_older_than_days_past_int32_is_rejected(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An absurd retention window is a query-parameter rejection, not a 500."""
    headers, _ = await _signup(async_client, "cleanup-over")
    await _promote_to_admin(db_session, "cleanup-over@example.com")
    resp = await async_client.post(
        "/admin/maintenance/energy-plans",
        params={"older_than_days": _PAST_INT32},
        headers=headers,
    )
    _assert_bound_rejection(resp, ["query", "older_than_days"])


@pytest.mark.asyncio
async def test_energy_cleanup_accepts_its_documented_retention_window(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The default retention window must still sweep, so the ceiling is not the floor."""
    headers, _ = await _signup(async_client, "cleanup-at")
    await _promote_to_admin(db_session, "cleanup-at@example.com")
    resp = await async_client.post(
        "/admin/maintenance/energy-plans",
        params={"older_than_days": ENERGY_PLAN_RETENTION_DAYS},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["older_than_days"] == ENERGY_PLAN_RETENTION_DAYS


@pytest.mark.asyncio
async def test_energy_cleanup_ceiling_sits_below_the_timedelta_limit(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A retention window ``timedelta`` cannot express must be refused, not crashed.

    ``older_than_days`` is subtracted from the current time, so its usable range
    ends far below int32: at ``timedelta``'s own 999_999_999-day ceiling the
    subtraction overflows before any query is built.  Bounding this parameter by
    int32 alone would move the 500 rather than remove it, so this pins the
    outcome without pinning the constant the bound is written with.
    """
    headers, _ = await _signup(async_client, "cleanup-timedelta")
    await _promote_to_admin(db_session, "cleanup-timedelta@example.com")
    resp = await async_client.post(
        "/admin/maintenance/energy-plans",
        params={"older_than_days": _TIMEDELTA_MAX_DAYS},
        headers=headers,
    )
    assert resp.status_code < HTTPStatus.INTERNAL_SERVER_ERROR, (
        f"a retention window of {_TIMEDELTA_MAX_DAYS} days broke the server "
        f"instead of being refused: {resp.text}"
    )


@pytest.mark.asyncio
async def test_stage_number_past_the_curriculum_is_rejected(async_client: AsyncClient) -> None:
    """A stage beyond the ten the program has is a rejection, not a lookup miss.

    ``stage_number`` is bounded by the curriculum rather than by int32: the
    program has exactly ten stages, and every value past that is meaningless
    regardless of what the column could hold.
    """
    headers, _ = await _signup(async_client, "stage-over")
    resp = await async_client.get(f"/course/stages/{TOTAL_STAGES + 1}/content", headers=headers)
    _assert_bound_rejection(resp, ["path", "stage_number"])


@pytest.mark.asyncio
async def test_final_stage_number_still_reaches_its_content(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The last real stage must still be served, so the bound is inclusive."""
    headers, _ = await _signup(async_client, "stage-at")
    await _seed_stage_with_content(db_session, stage_number=TOTAL_STAGES)
    resp = await async_client.get(f"/course/stages/{TOTAL_STAGES}/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text


@pytest.mark.asyncio
async def test_week_number_past_the_program_is_rejected(async_client: AsyncClient) -> None:
    """A week beyond the thirty-six the program runs is a rejection.

    Bounded by ``TOTAL_PROGRAM_WEEKS`` rather than by int32, for the same reason
    as ``stage_number``: the curriculum is the constraint, not the column.
    """
    headers, _ = await _signup(async_client, "week-over")
    resp = await async_client.get(f"/prompts/{TOTAL_PROGRAM_WEEKS + 1}", headers=headers)
    _assert_bound_rejection(resp, ["path", "week_number"])


@pytest.mark.asyncio
async def test_final_week_number_reaches_the_pacing_gate(async_client: AsyncClient) -> None:
    """The last real week must reach the pacing check rather than be refused outright.

    A fresh account cannot read week thirty-six yet, so the honest outcome is the
    403 the pacing gate raises -- which is only reachable once the path parameter
    has been accepted.
    """
    headers, _ = await _signup(async_client, "week-at")
    resp = await async_client.get(f"/prompts/{TOTAL_PROGRAM_WEEKS}", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN, resp.text
