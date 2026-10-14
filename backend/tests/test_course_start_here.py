"""Start Here read tracking for the site resources (issue #3148).

Covers:
* ``GET /course/site-resources`` — served in manifest ``order`` with the
  caller's own ``is_read`` flag
* ``POST /course/site-resources/{slug}/mark-read`` — idempotent, 404 on an
  unknown slug, one row under concurrency
* ``GET /course/start-here/progress`` — ``CourseProgressResponse``-shaped
  read arithmetic over the slugs the current pin ships

Resources are not database rows, so a read mark is keyed by slug; the
manifest is the only gate on which slugs exist.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Iterator
from http import HTTPStatus
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

from models.resource_completion import ResourceCompletion
from routers import course as course_router
from services.content_repository import (
    ContentRepository,
    reset_content_repository_for_tests,
    set_content_repository_for_tests,
)

_PASSWORD = "securepassword123"  # pragma: allowlist secret

# Listed out of reading order on purpose: list position carries no meaning, and
# only ``order`` says what a reader meets first.
_MANIFEST: dict[str, Any] = {
    "schema_version": "1.3.0",
    "chapters": [],
    "site_resources": [
        {
            "slug": "about",
            "title": "APTITUDE Intro",
            "description": "What this is.",
            "path": "markdown/resources/02-about.md",
            "order": 2,
        },
        {
            "slug": "energy-scaffolding",
            "title": "Energy Scaffolding",
            "description": "",
            "path": "markdown/resources/03-energy-scaffolding.md",
            "order": 3,
        },
        {
            "slug": "liminal-creep",
            "title": "Who Benefits?",
            "description": "Who this is for.",
            "path": "markdown/resources/01-liminal-creep.md",
            "order": 1,
        },
    ],
}

_READING_ORDER = ["liminal-creep", "about", "energy-scaffolding"]
_TOTAL = len(_READING_ORDER)
_ONE_THIRD_PERCENT = 33.33
_COMPLETE_PERCENT = 100.0
_CONCURRENT_FANOUT = 5
#: One past the slug column's bound (``RESOURCE_SLUG_MAX_LENGTH``).
_OVERLONG_SLUG = "s" * 101


def _write_content(root: Path, manifest: dict[str, Any]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(json.dumps(manifest))
    for resource in manifest["site_resources"]:
        md = root / resource["path"]
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(f"# {resource['title']}\n")
    return root


@pytest.fixture
def content_dir(tmp_path: Path) -> Iterator[Path]:
    """A three-resource Start Here pin wired into the repository singleton."""
    root = _write_content(tmp_path / "content", _MANIFEST)
    set_content_repository_for_tests(ContentRepository(root))
    yield root
    reset_content_repository_for_tests()


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _mark(client: AsyncClient, headers: dict[str, str], slug: str) -> Response:
    return await client.post(f"/course/site-resources/{slug}/mark-read", headers=headers)


async def _progress(client: AsyncClient, headers: dict[str, str]) -> dict[str, Any]:
    resp = await client.get("/course/start-here/progress", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body: dict[str, Any] = resp.json()
    return body


# --------------------------------------------------------------------------- #
# Listing the Start Here resources                                            #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_site_resources_are_served_in_order_and_unread(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "orderer")
    resp = await async_client.get("/course/site-resources", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    assert [r["slug"] for r in payload] == _READING_ORDER
    assert [r["order"] for r in payload] == [1, 2, 3]
    assert [r["is_read"] for r in payload] == [False, False, False]
    assert payload[0]["title"] == "Who Benefits?"


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_site_resources_flag_only_what_the_caller_read(async_client: AsyncClient) -> None:
    reader = await _signup(async_client, "reader")
    other = await _signup(async_client, "other")
    assert (await _mark(async_client, reader, "about")).status_code == HTTPStatus.OK

    mine = (await async_client.get("/course/site-resources", headers=reader)).json()
    theirs = (await async_client.get("/course/site-resources", headers=other)).json()
    assert {r["slug"]: r["is_read"] for r in mine} == {
        "liminal-creep": False,
        "about": True,
        "energy-scaffolding": False,
    }
    assert not any(r["is_read"] for r in theirs)


# --------------------------------------------------------------------------- #
# Marking a Start Here resource read                                          #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_mark_read_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.post("/course/site-resources/about/mark-read")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_mark_read_records_the_slug(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await _signup(async_client, "marker")
    resp = await _mark(async_client, headers, "liminal-creep")
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["slug"] == "liminal-creep"
    assert body["completed_at"]
    assert "user_id" not in body

    rows = (await db_session.execute(select(ResourceCompletion))).scalars().all()
    assert [(row.slug, row.id) for row in rows] == [("liminal-creep", body["id"])]


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_mark_read_is_idempotent(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await _signup(async_client, "repeater")
    first = await _mark(async_client, headers, "about")
    second = await _mark(async_client, headers, "about")
    assert first.status_code == second.status_code == HTTPStatus.OK
    assert first.json() == second.json()

    rows = (await db_session.execute(select(ResourceCompletion))).scalars().all()
    assert len(rows) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_mark_read_unknown_slug_is_404_and_persists_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await _signup(async_client, "stranger")
    resp = await _mark(async_client, headers, "not-a-resource")
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "content_not_found"
    assert (await db_session.execute(select(ResourceCompletion))).scalars().all() == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_mark_read_rejects_an_overlong_slug(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "overlong")
    resp = await _mark(async_client, headers, _OVERLONG_SLUG)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_mark_read_without_a_manifest_is_404(
    async_client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The bootstrap state ships no resources, so no slug can be marked."""
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("CONTENT_DIR", str(empty))
    reset_content_repository_for_tests()
    try:
        headers = await _signup(async_client, "bootstrapmark")
        assert (await _mark(async_client, headers, "about")).status_code == HTTPStatus.NOT_FOUND
        assert await _progress(async_client, headers) == {
            "total_items": 0,
            "read_items": 0,
            "progress_percent": 0.0,
            "next_unlock_day": None,
        }
    finally:
        reset_content_repository_for_tests()


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit", "content_dir")
async def test_concurrent_mark_read_collapses_to_one_row(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Simultaneous mark-reads persist one row and all answer with it.

    The pre-check can pass for every caller before any commits; the
    ``uq_resourcecompletion_user_slug`` constraint then rejects the losers
    inside a savepoint and each is answered with the winner's row.
    """
    headers = await _signup(concurrent_async_client, "racer")
    responses = await asyncio.gather(
        *[_mark(concurrent_async_client, headers, "about") for _ in range(_CONCURRENT_FANOUT)]
    )
    assert all(r.status_code == HTTPStatus.OK for r in responses)
    assert len({r.json()["id"] for r in responses}) == 1

    async with concurrent_session_factory() as session:
        rows = (await session.execute(select(ResourceCompletion))).scalars().all()
    assert len(rows) == 1


def _blind_first_precheck(monkeypatch: pytest.MonkeyPatch, *, winner_vanishes: bool) -> None:
    """Make the route's pre-check miss, as it does for a request that loses the race.

    The first lookup (the pre-check) reports no row, so the route goes on to
    insert and hits the unique constraint. Later lookups (resolving the
    winner) are real, or also miss when ``winner_vanishes``.
    """
    calls = 0

    async def lookup(session: AsyncSession, user_id: int, slug: str) -> ResourceCompletion | None:
        nonlocal calls
        calls += 1
        if calls == 1 or winner_vanishes:
            return None
        result = await session.execute(
            select(ResourceCompletion).where(
                ResourceCompletion.user_id == user_id, ResourceCompletion.slug == slug
            )
        )
        return result.scalars().first()

    monkeypatch.setattr(course_router, "_existing_resource_completion", lookup)


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_a_lost_race_answers_with_the_winners_row(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = await _signup(async_client, "loser")
    winner = (await _mark(async_client, headers, "about")).json()

    _blind_first_precheck(monkeypatch, winner_vanishes=False)
    loser = await _mark(async_client, headers, "about")
    assert loser.status_code == HTTPStatus.OK
    assert loser.json() == winner
    assert len((await db_session.execute(select(ResourceCompletion))).scalars().all()) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_a_lost_race_with_no_winner_is_a_loud_failure(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A constraint hit with no winning row means a broken invariant, never a silent re-insert."""
    headers = await _signup(async_client, "orphaned")
    assert (await _mark(async_client, headers, "about")).status_code == HTTPStatus.OK

    _blind_first_precheck(monkeypatch, winner_vanishes=True)
    with caplog.at_level(logging.ERROR):
        resp = await _mark(async_client, headers, "about")
    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    assert "ResourceCompletion lost the race" in caplog.text


# --------------------------------------------------------------------------- #
# Start Here progress                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_progress_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/course/start-here/progress")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_progress_arithmetic(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "progressor")
    assert await _progress(async_client, headers) == {
        "total_items": _TOTAL,
        "read_items": 0,
        "progress_percent": 0.0,
        "next_unlock_day": None,
    }

    await _mark(async_client, headers, "about")
    one = await _progress(async_client, headers)
    assert (one["read_items"], one["progress_percent"]) == (1, _ONE_THIRD_PERCENT)

    for slug in _READING_ORDER:
        await _mark(async_client, headers, slug)
    done = await _progress(async_client, headers)
    assert (done["read_items"], done["progress_percent"]) == (_TOTAL, _COMPLETE_PERCENT)
    assert done["next_unlock_day"] is None


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_progress_is_per_user(async_client: AsyncClient) -> None:
    reader = await _signup(async_client, "progreader")
    other = await _signup(async_client, "progother")
    await _mark(async_client, reader, "liminal-creep")
    assert (await _progress(async_client, reader))["read_items"] == 1
    assert (await _progress(async_client, other))["read_items"] == 0


@pytest.mark.asyncio
async def test_progress_ignores_a_resource_the_pin_no_longer_ships(
    async_client: AsyncClient, tmp_path: Path
) -> None:
    """A read mark on a slug that left the manifest stops counting.

    Read marks outlive re-pins (nothing deletes them), so progress must count
    only the slugs the current pin ships or it could exceed ``total_items``.
    """
    set_content_repository_for_tests(ContentRepository(_write_content(tmp_path / "v1", _MANIFEST)))
    try:
        headers = await _signup(async_client, "repinned")
        await _mark(async_client, headers, "energy-scaffolding")
        await _mark(async_client, headers, "about")

        trimmed = json.loads(json.dumps(_MANIFEST))
        trimmed["site_resources"] = [
            r for r in trimmed["site_resources"] if r["slug"] != "energy-scaffolding"
        ]
        set_content_repository_for_tests(
            ContentRepository(_write_content(tmp_path / "v2", trimmed))
        )
        progress = await _progress(async_client, headers)
        assert (progress["total_items"], progress["read_items"]) == (2, 1)
        listed = (await async_client.get("/course/site-resources", headers=headers)).json()
        assert [(r["slug"], r["is_read"]) for r in listed] == [
            ("liminal-creep", False),
            ("about", True),
        ]
    finally:
        reset_content_repository_for_tests()
