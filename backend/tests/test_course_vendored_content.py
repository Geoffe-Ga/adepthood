"""Integration tests against the REAL vendored content manifest.

Stage 1 (Beige) went briefly blank in production because a pre-content
deploy image seeded zero StageContent rows for it. These tests seed from
the actual vendored ``backend/content`` tree via the real startup seeders
and assert the production symptom over HTTP so the empty-stage-1 failure
mode can never regress silently.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from http import HTTPStatus
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from content_config import CONTENT_REF_SCHEME
from models.course_stage import CourseStage
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from models.user import User
from seed_content import seed_content
from seed_stages import seed_stages, stage_definitions
from services.content_repository import (
    ContentRepository,
    reset_content_repository_for_tests,
    set_content_repository_for_tests,
)

_VENDORED_CONTENT_DIR = Path(__file__).resolve().parents[1] / "content"

#: Stage 1 (Beige) ships exactly 16 chapters in the vendored manifest; it
#: shipped 17 until "Energy Scaffolding" (beige-8) moved upstream to the site
#: resources (aptitude-course#76).
_STAGE_ONE_CHAPTER_COUNT = 16

#: Only the first three (unlocked) stages get a CourseStage row in the
#: partial-coverage fixture -- the manifest still ships stages 4-10.
_UNLOCKED_STAGE_COUNT = 3

#: The first Beige chapter drips on day 0 (immediately visible at signup).
_DAY_ZERO = 0

_BEIGE_ONE_TITLE = "What is Beige?"

#: Orange (stage 5) ships 26 chapters once orange-26..28 were removed
#: upstream (#3137, aptitude-course#74); it shipped 29 before.
_ORANGE_STAGE_NUMBER = 5
_ORANGE_CHAPTER_COUNT = 26


@pytest_asyncio.fixture
async def seeded_vendored_course(db_session: AsyncSession) -> AsyncIterator[None]:
    """Seed all 10 stages and their content from the real vendored manifest."""
    set_content_repository_for_tests(ContentRepository(_VENDORED_CONTENT_DIR))
    await seed_stages(db_session)
    await seed_content(db_session)
    yield
    reset_content_repository_for_tests()


async def _signup(async_client: AsyncClient, username: str) -> dict[str, str]:
    """Sign up a fresh user (no stage-progress pinning, so day 0 applies)."""
    resp = await async_client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


@pytest_asyncio.fixture
async def partially_seeded_vendored_course(db_session: AsyncSession) -> AsyncIterator[None]:
    """Seed only the unlocked stages' CourseStage rows, then the real content.

    Mirrors a production database whose CourseStage table does not cover
    every manifest stage: the seeder must still populate the mapped
    (unlocked) stages instead of aborting the whole seed and blanking
    Stage 1.
    """
    set_content_repository_for_tests(ContentRepository(_VENDORED_CONTENT_DIR))
    for definition in stage_definitions()[:_UNLOCKED_STAGE_COUNT]:
        db_session.add(CourseStage(**definition))
    await db_session.commit()
    await seed_content(db_session)
    yield
    reset_content_repository_for_tests()


@pytest.mark.asyncio
@pytest.mark.usefixtures("partially_seeded_vendored_course")
async def test_stage_one_serves_chapters_when_higher_stages_have_no_row(
    async_client: AsyncClient,
) -> None:
    """P0: unlocked Stage 1 still shows all 16 chapters when stages 4-10 are unmapped."""
    headers = await _signup(async_client, "partial-stage-adept")

    resp = await async_client.get("/course/stages/1/progress", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["total_items"] == _STAGE_ONE_CHAPTER_COUNT
    assert body["read_items"] == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("seeded_vendored_course")
async def test_orange_progress_counts_the_vendored_chapters(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """#3137: Orange's total drops to 26 with the three removed essays gone."""
    headers = await _signup(async_client, "orange-adept")
    user = (
        (await db_session.execute(select(User).where(User.email == "orange-adept@example.com")))
        .scalars()
        .one()
    )
    assert user.id is not None
    # Orange is locked at signup; place the reader on it, with 1-4 behind them.
    db_session.add(
        StageProgress(
            user_id=user.id,
            current_stage=_ORANGE_STAGE_NUMBER,
            completed_stages=list(range(1, _ORANGE_STAGE_NUMBER)),
        )
    )
    await db_session.commit()

    resp = await async_client.get(
        f"/course/stages/{_ORANGE_STAGE_NUMBER}/progress", headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["total_items"] == _ORANGE_CHAPTER_COUNT


@pytest.mark.asyncio
@pytest.mark.usefixtures("seeded_vendored_course")
async def test_stage_one_progress_reflects_vendored_manifest(async_client: AsyncClient) -> None:
    """Regression: a fresh signup sees all 16 vendored Beige chapters, none read."""
    headers = await _signup(async_client, "fresh-adept")

    resp = await async_client.get("/course/stages/1/progress", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["total_items"] == _STAGE_ONE_CHAPTER_COUNT
    assert body["read_items"] == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("seeded_vendored_course")
async def test_stage_one_day_zero_chapter_is_visible_at_signup(async_client: AsyncClient) -> None:
    """The day-0 Beige chapter is unlocked immediately, not hidden behind a drip."""
    headers = await _signup(async_client, "day-zero-reader")

    resp = await async_client.get("/course/stages/1/content", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    items = resp.json()
    assert items
    day_zero_items = [item for item in items if item["release_day"] == _DAY_ZERO]
    assert day_zero_items
    assert all(item["is_locked"] is False for item in day_zero_items)
    assert any(item["title"] == _BEIGE_ONE_TITLE for item in day_zero_items)


@pytest.mark.asyncio
@pytest.mark.usefixtures("seeded_vendored_course")
async def test_beige_one_body_has_frontmatter_stripped(async_client: AsyncClient) -> None:
    """The served body for beige-1 excludes its YAML frontmatter block."""
    headers = await _signup(async_client, "frontmatter-reader")
    listing = await async_client.get("/course/stages/1/content", headers=headers)
    assert listing.status_code == HTTPStatus.OK
    beige_one = next(item for item in listing.json() if item["title"] == _BEIGE_ONE_TITLE)

    resp = await async_client.get(f"/course/content/{beige_one['id']}/body", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    stripped = payload["body_markdown"].lstrip()
    assert not stripped.startswith("---")
    assert stripped != ""
    # The frontmatter carries an ``id:`` key; a stripped body must not leak it.
    assert "id: beige-1" not in payload["body_markdown"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("seeded_vendored_course")
async def test_stage_one_rows_carry_content_refs_not_urls(db_session: AsyncSession) -> None:
    """Every seeded Stage 1 row uses a local content:// reference, never a URL."""
    stage_one = (
        (await db_session.execute(select(CourseStage).where(CourseStage.stage_number == 1)))
        .scalars()
        .one()
    )
    rows = (
        (
            await db_session.execute(
                select(StageContent).where(StageContent.course_stage_id == stage_one.id)
            )
        )
        .scalars()
        .all()
    )

    assert len(rows) == _STAGE_ONE_CHAPTER_COUNT
    assert all(row.url.startswith(f"{CONTENT_REF_SCHEME}://") for row in rows)


#: The vendored Start Here reading order (aptitude-course#76): "Who Benefits?"
#: first, then the intro, then the Energy Scaffolding essay that left Beige.
_START_HERE_LEAD = ("liminal-creep", "about", "energy-scaffolding")


def test_vendored_start_here_is_served_in_order() -> None:
    """The real pin numbers its resources 1..N and the reader honours it (#3148).

    Pins the contract the Start Here list leans on: a gap or a duplicate in
    the upstream numbering, or a reshuffled lead, fails here on re-pin.
    """
    resources = ContentRepository(_VENDORED_CONTENT_DIR).list_resources()
    assert [r.order for r in resources] == list(range(1, len(resources) + 1))
    assert tuple(r.slug for r in resources[: len(_START_HERE_LEAD)]) == _START_HERE_LEAD
