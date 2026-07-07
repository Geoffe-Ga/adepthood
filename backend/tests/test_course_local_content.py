"""End-to-end tests for the local-content course flow (issue #398).

The committed fixture tree at ``tests/fixtures/content/`` drives the
whole journey the user actually takes: manifest → seeder → gated chapter
list → released body → read-tracking → progress math — deterministic,
offline, against real files instead of mocks of a third party.

Fixture shape: stage 1 ships four chapters (ordinals 0-3), stage 2 ships
one chapter (locked until the user reaches the stage), plus one site
resource.  Every test pins the user at **day 2 of stage 1**.  Gating is
now the proportional drip: four chapters spread over the 21-day stage
means by day-in-stage 3 only ceil(4 * 3 / 21) = 1 chapter has opened, so
the first ordinal unlocks and the rest stay locked.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.course_stage import CourseStage
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from seed_content import seed_content
from services.content_repository import (
    ContentRepository,
    reset_content_repository_for_tests,
    set_content_repository_for_tests,
)

_FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "content"

#: Day the test user is pinned to within stage 1.
_DAYS_ELAPSED = 2


@pytest_asyncio.fixture
async def seeded_course(db_session: AsyncSession) -> AsyncIterator[None]:
    """Install the fixture content tree and seed the database from it."""
    set_content_repository_for_tests(ContentRepository(_FIXTURE_DIR))
    for number in (1, 2):
        db_session.add(
            CourseStage(
                title=f"Stage {number}",
                subtitle=f"Subtitle {number}",
                stage_number=number,
                overview_url=f"https://example.com/stage-{number}",
                category="test",
                aspect="test-aspect",
                spiral_dynamics_color="beige",
                growing_up_stage="archaic",
                divine_gender_polarity="masculine",
                relationship_to_free_will="active",
                free_will_description="Active Yes-And-Ness",
            )
        )
    await db_session.commit()
    await seed_content(db_session)
    yield
    reset_content_repository_for_tests()


async def _signup_at_day_two(
    async_client: AsyncClient, db_session: AsyncSession, username: str
) -> dict[str, str]:
    """Sign up a user and pin them at day 2 of stage 1."""
    resp = await async_client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    user_id = resp.json()["user_id"]
    db_session.add(
        StageProgress(
            user_id=user_id,
            current_stage=1,
            completed_stages=[],
            stage_started_at=datetime.now(UTC) - timedelta(days=_DAYS_ELAPSED),
        )
    )
    await db_session.commit()
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _stage_one_items(
    async_client: AsyncClient, headers: dict[str, str]
) -> dict[str, dict[str, object]]:
    resp = await async_client.get("/course/stages/1/content", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    return {item["title"]: item for item in resp.json()}


@pytest.mark.asyncio
@pytest.mark.usefixtures("seeded_course")
async def test_list_reflects_drip_feed_boundaries(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Proportional drip: on day-in-stage 3 only the first ordinal is open."""
    headers = await _signup_at_day_two(async_client, db_session, "journey")
    items = await _stage_one_items(async_client, headers)

    # ceil(4 chapters * day 3 / 21 days) = 1 → only ordinal 0 has dripped.
    assert items["Survival"]["is_locked"] is False  # ordinal 0 — open
    assert items["Breath as Anchor"]["is_locked"] is True  # ordinal 1 — not yet
    assert items["Tomorrow Prompt"]["is_locked"] is True  # ordinal 2 — not yet
    assert items["Late Chapter"]["is_locked"] is True  # ordinal 3 — not yet


@pytest.mark.asyncio
@pytest.mark.usefixtures("seeded_course")
async def test_released_body_serves_fixture_markdown(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The body endpoint returns the literal fixture file for a released id."""
    headers = await _signup_at_day_two(async_client, db_session, "reader")
    items = await _stage_one_items(async_client, headers)

    resp = await async_client.get(
        f"/course/content/{items['Survival']['id']}/body", headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    expected = (_FIXTURE_DIR / "markdown/01-beige/01-survival.md").read_text()
    assert payload["body_markdown"] == expected
    assert payload["title"] == "Survival"
    assert payload["content_type"] == "chapter"


@pytest.mark.asyncio
@pytest.mark.usefixtures("seeded_course")
async def test_gating_mask_for_unreleased_locked_and_unknown(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Unreleased, locked-stage, and nonexistent ids are indistinguishable."""
    headers = await _signup_at_day_two(async_client, db_session, "masked")
    items = await _stage_one_items(async_client, headers)

    # Still behind the drip (ordinal 2, only 1 chapter open on day 3).
    resp = await async_client.get(
        f"/course/content/{items['Tomorrow Prompt']['id']}/body", headers=headers
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "content_not_found"

    # Stage 2 is locked for a stage-1 user; fetch its seeded row id from
    # the DB directly (the list endpoint rightly refuses locked stages).
    result = await db_session.execute(
        select(StageContent).where(StageContent.title == "Tribal Rhythm")
    )
    purple = result.scalars().one()
    resp = await async_client.get(f"/course/content/{purple.id}/body", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "content_not_found"

    # Nonexistent id.
    resp = await async_client.get("/course/content/999999/body", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "content_not_found"


@pytest.mark.asyncio
@pytest.mark.usefixtures("seeded_course")
async def test_site_resource_journey(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """List the manifest resource, then read its body from the fixture file."""
    headers = await _signup_at_day_two(async_client, db_session, "resourceful")

    resp = await async_client.get("/course/site-resources", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    listing = resp.json()
    assert [r["slug"] for r in listing] == ["getting-started"]
    assert listing[0]["description"] == "Orientation for new adepts."

    body_resp = await async_client.get(
        "/course/site-resources/getting-started/body", headers=headers
    )
    assert body_resp.status_code == HTTPStatus.OK
    expected = (_FIXTURE_DIR / "markdown/site/getting-started.md").read_text()
    assert body_resp.json()["body_markdown"] == expected


@pytest.mark.asyncio
@pytest.mark.usefixtures("seeded_course")
async def test_progress_math_and_read_tracking(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Progress counts released items only; mark-read moves the needle."""
    headers = await _signup_at_day_two(async_client, db_session, "progressing")
    items = await _stage_one_items(async_client, headers)

    resp = await async_client.get("/course/stages/1/progress", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    before = resp.json()
    assert before["read_items"] == 0
    # 4 chapters over 21 days: with one open on day-in-stage 3, the second
    # drips on day 6 (floor(1 * 21 / 4) + 1).
    assert before["next_unlock_day"] == 6

    mark = await async_client.post(
        f"/course/content/{items['Survival']['id']}/mark-read", headers=headers
    )
    assert mark.status_code == HTTPStatus.OK

    after = (await async_client.get("/course/stages/1/progress", headers=headers)).json()
    assert after["read_items"] == before["read_items"] + 1
    assert after["progress_percent"] > before["progress_percent"]

    relisted = await _stage_one_items(async_client, headers)
    assert relisted["Survival"]["is_read"] is True
