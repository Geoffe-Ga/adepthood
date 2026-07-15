"""Integration tests for the local-content course body endpoints (issue #393).

Covers:
* ``GET /course/content/{content_id}/body`` — drip-feed gating + local read
* ``GET /course/site-resources`` — declarative list, authenticated only
* ``GET /course/site-resources/{slug}/body`` — read a configured resource

Bodies come from the vendored content directory via
:class:`ContentRepository`, stubbed with a manifest-backed temp
directory.  **Gating parity is the point of this file**: the locked /
unreleased / missing 404-mask tests (BUG-COURSE-004) carry over from the
remote-CMS era unchanged in intent.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from content_config import content_ref
from models.course_stage import CourseStage
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from services.content_repository import (
    ContentRepository,
    reset_content_repository_for_tests,
    set_content_repository_for_tests,
)

# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

_MANIFEST: dict[str, Any] = {
    "schema_version": "1.1.0",
    "chapters": [
        {
            "id": "beige-1",
            "stage": 1,
            "chapter": 1,
            "slug": "survival",
            "title": "Survival",
            "content_type": "chapter",
            "release_day": 0,
            "order": 1,
            "path": "markdown/01-beige/01-survival.md",
        },
        {
            "id": "beige-10",
            "stage": 1,
            "chapter": 10,
            "slug": "late-chapter",
            "title": "Late Chapter",
            "content_type": "chapter",
            "release_day": 9,
            "order": 10,
            "path": "markdown/01-beige/10-late.md",
        },
    ],
    "site_resources": [
        {
            "slug": "about",
            "title": "About Adepthood",
            "description": "What this is.",
            "path": "markdown/site/about.md",
        },
        {
            "slug": "aptitude-stages",
            "title": "APTITUDE Stages",
            "description": "The stage map.",
            "path": "markdown/site/aptitude-stages.md",
        },
    ],
    "stage_intros": [
        {
            "stage": 1,
            "id": "beige-intro",
            "slug": "beige-introduction",
            "title": "Welcome to Beige",
            "path": "markdown/01-beige/00-introduction.md",
            "summary": "What Beige is about.",
        },
        {
            "stage": 2,
            "id": "purple-intro",
            "slug": "purple-introduction",
            "title": "Welcome to Purple",
            "path": "markdown/02-purple/00-introduction.md",
        },
    ],
}


@pytest.fixture
def content_dir(tmp_path: Path) -> Iterator[Path]:
    """Vendored-content stand-in wired into the repository singleton."""
    root = tmp_path / "content"
    root.mkdir()
    (root / "manifest.json").write_text(json.dumps(_MANIFEST))
    for chapter in _MANIFEST["chapters"]:
        md = root / chapter["path"]
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(f"# {chapter['title']}\n\nBody of {chapter['id']}.\n")
    for resource in _MANIFEST["site_resources"]:
        md = root / resource["path"]
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(f"# {resource['title']}\n")
    for intro in _MANIFEST["stage_intros"]:
        md = root / intro["path"]
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(f"# {intro['title']}\n\nIntro body for stage {intro['stage']}.\n")
    set_content_repository_for_tests(ContentRepository(root))
    yield root
    reset_content_repository_for_tests()


def _stage_data(stage_number: int = 1, **overrides: object) -> dict[str, object]:
    defaults: dict[str, object] = {
        "title": f"Stage {stage_number}",
        "subtitle": f"Subtitle {stage_number}",
        "stage_number": stage_number,
        "overview_url": f"https://example.com/stage-{stage_number}",
        "category": "test",
        "aspect": "test-aspect",
        "spiral_dynamics_color": "beige",
        "growing_up_stage": "archaic",
        "divine_gender_polarity": "masculine",
        "relationship_to_free_will": "active",
        "free_will_description": "Active Yes-And-Ness",
    }
    defaults.update(overrides)
    return defaults


async def _signup(client: AsyncClient, username: str = "cmsuser") -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _signup_with_id(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    user_id = payload["user_id"]
    assert isinstance(user_id, int)
    return {"Authorization": f"Bearer {payload['token']}"}, user_id


async def _seed_stage_with_content(
    db_session: AsyncSession,
    stage_number: int = 1,
    url: str = content_ref("beige-1"),
    release_day: int = 0,
    title: str = "Survival",
) -> tuple[CourseStage, StageContent]:
    stage = CourseStage(**_stage_data(stage_number=stage_number))
    db_session.add(stage)
    await db_session.flush()
    item = StageContent(
        course_stage_id=stage.id,
        title=title,
        content_type="chapter",
        release_day=release_day,
        url=url,
    )
    db_session.add(item)
    await db_session.commit()
    await db_session.refresh(item)
    return stage, item


async def _set_user_stage(
    db_session: AsyncSession,
    user_id: int,
    stage_number: int,
    days_ago: int = 1,
) -> StageProgress:
    progress = StageProgress(
        user_id=user_id,
        current_stage=stage_number,
        completed_stages=list(range(1, stage_number)),
        stage_started_at=datetime.now(UTC) - timedelta(days=days_ago),
    )
    db_session.add(progress)
    await db_session.commit()
    return progress


# --------------------------------------------------------------------------- #
# /course/content/{id}/body                                                    #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_content_body_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/course/content/1/body")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_content_body_returns_markdown(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Happy path: an unlocked, released chapter returns raw Markdown."""
    headers, user_id = await _signup_with_id(async_client, "happy")
    _, item = await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)

    body_resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)

    assert body_resp.status_code == HTTPStatus.OK
    payload = body_resp.json()
    assert payload["body_markdown"] == "# Survival\n\nBody of beige-1.\n"
    assert payload["title"] == "Survival"
    assert payload["content_type"] == "chapter"
    assert "body_html" not in payload


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_content_body_404_for_locked_stage(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A user not yet at this stage gets 404 — never the body (BUG-COURSE-004)."""
    headers = await _signup(async_client, "locked")
    _, item = await _seed_stage_with_content(db_session, stage_number=2)
    # No StageProgress => stage is locked.

    resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_content_body_404_for_drip_locked_chapter(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A chapter still behind the proportional drip returns 404 (BUG-COURSE-004).

    On day 2 of a 21-day stage only the first chapters have dripped, so a
    high-ordinal chapter (filled behind several earlier ones) is locked and
    its body must not leak — masked as ``content_not_found``.
    """
    headers, user_id = await _signup_with_id(async_client, "early")
    stage, _first = await _seed_stage_with_content(
        db_session, stage_number=1, release_day=0, title="Opening"
    )
    # Fill earlier ordinals so "Late Chapter" sits near the end of the stage.
    # Each filler gets its own content ref — one ``content://`` reference per
    # stage is a DB-enforced invariant (``ix_stagecontent_stage_content_ref_
    # unique``, migration b4c5d6e7f8a1), and the helper already seeded beige-1.
    for day in (1, 2, 3):
        db_session.add(
            StageContent(
                course_stage_id=stage.id,
                title=f"Chapter {day}",
                content_type="chapter",
                release_day=day,
                url=content_ref(f"beige-fill-{day}"),
            )
        )
    late = StageContent(
        course_stage_id=stage.id,
        title="Late Chapter",
        content_type="chapter",
        release_day=9,
        url=content_ref("beige-10"),
    )
    db_session.add(late)
    await db_session.commit()
    await db_session.refresh(late)
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=2)

    body_resp = await async_client.get(f"/course/content/{late.id}/body", headers=headers)
    assert body_resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_content_body_404_for_unknown_id(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "ghost")
    resp = await async_client.get("/course/content/999999/body", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_content_body_404_for_non_local_reference(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Placeholder/legacy rows (http urls) have no local body — same 404 mask."""
    headers, user_id = await _signup_with_id(async_client, "legacy")
    _, item = await _seed_stage_with_content(
        db_session,
        stage_number=1,
        url="https://cms.adepthood.com/stage-2/intro",
        title="Introduction to Magick",
    )
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)

    resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_content_body_404_for_ref_missing_from_manifest(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stale row pointing at a chapter the manifest dropped keeps the mask."""
    headers, user_id = await _signup_with_id(async_client, "stale")
    _, item = await _seed_stage_with_content(
        db_session, stage_number=1, url=content_ref("gone-1"), title="Gone"
    )
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)

    resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_content_body_502_when_markdown_file_missing(
    async_client: AsyncClient, db_session: AsyncSession, content_dir: Path
) -> None:
    """A manifest-listed chapter whose file is gone is a server bug — 502."""
    headers, user_id = await _signup_with_id(async_client, "torn")
    _, item = await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)
    (content_dir / "markdown/01-beige/01-survival.md").unlink()

    body_resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)
    assert body_resp.status_code == HTTPStatus.BAD_GATEWAY
    assert body_resp.json()["detail"] == "content_unavailable"


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_content_body_serves_today_chapter_on_release_day_boundary(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``release_day == days_elapsed`` is the "today" chapter — must serve, not 404."""
    headers, user_id = await _signup_with_id(async_client, "boundary")
    _, item = await _seed_stage_with_content(db_session, stage_number=1)
    # Just enrolled today — days_elapsed == 0, release_day == 0.
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=0)

    body_resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)
    assert body_resp.status_code == HTTPStatus.OK
    assert body_resp.json()["body_markdown"].startswith("# Survival")


# --------------------------------------------------------------------------- #
# /course/site-resources                                                       #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_site_resources_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/course/site-resources")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_site_resources_lists_manifest_entries(async_client: AsyncClient) -> None:
    """The list comes from the manifest, in manifest order, auth required."""
    headers = await _signup(async_client, "lister")
    resp = await async_client.get("/course/site-resources", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    assert [r["slug"] for r in payload] == ["about", "aptitude-stages"]
    assert payload[0]["title"] == "About Adepthood"
    assert payload[0]["description"] == "What this is."
    # ``url`` is kept for surface stability; it now carries the local ref.
    assert payload[0]["url"] == content_ref("about")


@pytest.mark.asyncio
async def test_site_resources_empty_without_manifest(
    async_client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bootstrap state — no vendored manifest — degrades to an empty list."""
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("CONTENT_DIR", str(empty))
    reset_content_repository_for_tests()
    try:
        headers = await _signup(async_client, "bootstrap")
        resp = await async_client.get("/course/site-resources", headers=headers)
        assert resp.status_code == HTTPStatus.OK
        assert resp.json() == []
    finally:
        reset_content_repository_for_tests()


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_site_resource_body_happy_path(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "bodyread")
    resp = await async_client.get("/course/site-resources/about/body", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["body_markdown"] == "# About Adepthood\n"
    assert resp.json()["title"] == "About Adepthood"
    assert resp.json()["content_type"] == "resource"


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_site_resource_body_unknown_slug_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "unknown")
    resp = await async_client.get(
        "/course/site-resources/this-does-not-exist/body", headers=headers
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_site_resource_body_502_when_markdown_file_missing(
    async_client: AsyncClient, content_dir: Path
) -> None:
    """A manifest-listed resource whose file is gone is a server bug — 502."""
    headers = await _signup(async_client, "rsbad")
    (content_dir / "markdown/site/aptitude-stages.md").unlink()
    resp = await async_client.get("/course/site-resources/aptitude-stages/body", headers=headers)
    assert resp.status_code == HTTPStatus.BAD_GATEWAY
    assert resp.json()["detail"] == "content_unavailable"


# --------------------------------------------------------------------------- #
# /course/stages/{n}/intro (+ /body) — stage introductions                     #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_stage_intro_metadata_and_body_for_unlocked_stage(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An unlocked stage serves its intro metadata and Markdown body."""
    headers, user_id = await _signup_with_id(async_client, "introreader")
    await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)

    meta = await async_client.get("/course/stages/1/intro", headers=headers)
    assert meta.status_code == HTTPStatus.OK
    assert meta.json() == {
        "stage": 1,
        "id": "beige-intro",
        "slug": "beige-introduction",
        "title": "Welcome to Beige",
        "summary": "What Beige is about.",
    }

    body = await async_client.get("/course/stages/1/intro/body", headers=headers)
    assert body.status_code == HTTPStatus.OK
    payload = body.json()
    assert payload["body_markdown"].startswith("# Welcome to Beige")
    assert payload["title"] == "Welcome to Beige"
    assert payload["content_type"] == "introduction"


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_stage_intro_locked_stage_is_masked_as_not_found(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A locked stage's intro (which exists) is indistinguishable from absent."""
    headers, user_id = await _signup_with_id(async_client, "introlocked")
    await _seed_stage_with_content(db_session, stage_number=1)
    await _seed_stage_with_content(db_session, stage_number=2, title="Tribal Rhythm")
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)

    for path in ("/course/stages/2/intro", "/course/stages/2/intro/body"):
        resp = await async_client.get(path, headers=headers)
        assert resp.status_code == HTTPStatus.NOT_FOUND
        assert resp.json()["detail"] == "content_not_found"


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_stage_intro_unlocked_stage_without_intro_is_not_found(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An unlocked stage with no manifest intro returns content_not_found."""
    headers, user_id = await _signup_with_id(async_client, "introless")
    await _seed_stage_with_content(db_session, stage_number=3)
    await _set_user_stage(db_session, user_id, stage_number=3, days_ago=1)

    resp = await async_client.get("/course/stages/3/intro", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "content_not_found"


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_stage_intro_unknown_stage_is_not_found(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stage with no CourseStage row is a plain stage 404."""
    headers, user_id = await _signup_with_id(async_client, "introghost")
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)

    resp = await async_client.get("/course/stages/999/intro", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "stage_not_found"


@pytest.mark.asyncio
async def test_stage_intro_requires_auth(async_client: AsyncClient) -> None:
    """Both intro endpoints require authentication."""
    for path in ("/course/stages/1/intro", "/course/stages/1/intro/body"):
        resp = await async_client.get(path)
        assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_stage_intro_body_502_when_markdown_file_missing(
    async_client: AsyncClient, db_session: AsyncSession, content_dir: Path
) -> None:
    """A manifest-listed intro whose file is gone is a server bug — 502."""
    headers, user_id = await _signup_with_id(async_client, "introtorn")
    await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)
    (content_dir / "markdown/01-beige/00-introduction.md").unlink()

    resp = await async_client.get("/course/stages/1/intro/body", headers=headers)
    assert resp.status_code == HTTPStatus.BAD_GATEWAY
    assert resp.json()["detail"] == "content_unavailable"
