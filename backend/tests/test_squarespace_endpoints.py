"""Integration tests for the Squarespace-backed course endpoints.

Covers:
* ``GET /course/content/{content_id}/body`` — drip-feed gating + CMS fetch
* ``GET /course/site-resources`` — declarative list, authenticated only
* ``GET /course/site-resources/{slug}/body`` — fetch a configured resource

Squarespace is replaced with a stub :class:`SquarespaceClient` so no
network access happens.  The stub is wired in by overriding
``services.squarespace.get_squarespace_client`` for the duration of each
test, then resetting it.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from content_config import SITE_RESOURCES
from models.course_stage import CourseStage
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from services import squarespace as squarespace_module
from services.squarespace import (
    FetchedContent,
    SquarespaceAuthError,
    SquarespaceFetchError,
)

# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #


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


async def _seed_stage_with_content(
    db_session: AsyncSession,
    stage_number: int = 1,
) -> tuple[CourseStage, StageContent]:
    stage = CourseStage(**_stage_data(stage_number=stage_number))
    db_session.add(stage)
    await db_session.flush()
    item = StageContent(
        course_stage_id=stage.id,
        title="Chapter 1",
        content_type="chapter",
        release_day=0,
        url="https://aptitude.guru/course/beige-1",
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


class _StubSquarespaceClient:
    """Drop-in for :class:`SquarespaceClient` that returns fixed HTML."""

    def __init__(
        self,
        body_html: str = "<article><h1>Hi</h1><p>body</p></article>",
        title: str = "Hi",
        raise_exc: Exception | None = None,
    ) -> None:
        self._body_html = body_html
        self._title = title
        self._raise = raise_exc
        self.calls: list[str] = []

    async def fetch(self, url: str) -> FetchedContent:
        self.calls.append(url)
        if self._raise is not None:
            raise self._raise
        return FetchedContent(url=url, title=self._title, body_html=self._body_html)


@contextlib.contextmanager
def _patch_client(stub: _StubSquarespaceClient) -> Iterator[None]:
    """Swap the module-level singleton for the test's duration."""
    original = squarespace_module._singleton  # noqa: SLF001
    squarespace_module._singleton = stub  # type: ignore[assignment]  # noqa: SLF001
    try:
        yield
    finally:
        squarespace_module._singleton = original  # noqa: SLF001


def _signup_user_id(resp_json: dict[str, object]) -> int:
    raw = resp_json["user_id"]
    assert isinstance(raw, int)
    return raw


# --------------------------------------------------------------------------- #
# /course/content/{id}/body                                                    #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_content_body_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/course/content/1/body")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_content_body_returns_cleaned_html(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Happy path: an unlocked, released chapter returns cleaned HTML."""
    resp = await async_client.post(
        "/auth/signup",
        json={
            "email": "happy@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },  # pragma: allowlist secret
    )
    headers = {"Authorization": f"Bearer {resp.json()['token']}"}
    user_id = _signup_user_id(resp.json())

    _, item = await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)

    stub = _StubSquarespaceClient(body_html="<article>chapter 1</article>", title="Beige One")
    with _patch_client(stub):
        body_resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)

    assert body_resp.status_code == HTTPStatus.OK
    payload = body_resp.json()
    assert payload["body_html"] == "<article>chapter 1</article>"
    assert payload["title"] == "Beige One"
    assert payload["url"] == "https://aptitude.guru/course/beige-1"
    assert stub.calls == ["https://aptitude.guru/course/beige-1"]


@pytest.mark.asyncio
async def test_content_body_404_for_locked_stage(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A user not yet at this stage gets 404 — never the real HTML."""
    headers = await _signup(async_client, "locked")
    _, item = await _seed_stage_with_content(db_session, stage_number=2)
    # No StageProgress => stage is locked.

    stub = _StubSquarespaceClient()
    with _patch_client(stub):
        resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert stub.calls == []


@pytest.mark.asyncio
async def test_content_body_404_for_unreleased_day(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An item whose release_day is in the future returns 404, no fetch."""
    resp = await async_client.post(
        "/auth/signup",
        json={
            "email": "early@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },  # pragma: allowlist secret
    )
    headers = {"Authorization": f"Bearer {resp.json()['token']}"}
    user_id = _signup_user_id(resp.json())

    stage = CourseStage(**_stage_data(stage_number=1))
    db_session.add(stage)
    await db_session.flush()
    item = StageContent(
        course_stage_id=stage.id,
        title="Chapter 10",
        content_type="chapter",
        release_day=9,
        url="https://aptitude.guru/course/beige-10",
    )
    db_session.add(item)
    await db_session.commit()
    await db_session.refresh(item)

    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=2)

    stub = _StubSquarespaceClient()
    with _patch_client(stub):
        body_resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)
    assert body_resp.status_code == HTTPStatus.NOT_FOUND
    assert stub.calls == []


@pytest.mark.asyncio
async def test_content_body_502_when_cms_unreachable(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A network failure surfaces as 502 with the ``cms_unavailable`` detail."""
    resp = await async_client.post(
        "/auth/signup",
        json={
            "email": "downstream@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },  # pragma: allowlist secret
    )
    headers = {"Authorization": f"Bearer {resp.json()['token']}"}
    user_id = _signup_user_id(resp.json())

    _, item = await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)

    stub = _StubSquarespaceClient(raise_exc=SquarespaceFetchError("boom"))
    with _patch_client(stub):
        body_resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)
    assert body_resp.status_code == HTTPStatus.BAD_GATEWAY
    assert body_resp.json()["detail"] == "cms_unavailable"


@pytest.mark.asyncio
async def test_content_body_503_when_cms_auth_misconfigured(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Missing site password surfaces as 503 ``cms_auth_failed``."""
    resp = await async_client.post(
        "/auth/signup",
        json={
            "email": "noauth@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },  # pragma: allowlist secret
    )
    headers = {"Authorization": f"Bearer {resp.json()['token']}"}
    user_id = _signup_user_id(resp.json())

    _, item = await _seed_stage_with_content(db_session, stage_number=1)
    await _set_user_stage(db_session, user_id, stage_number=1, days_ago=1)

    stub = _StubSquarespaceClient(raise_exc=SquarespaceAuthError("no creds"))
    with _patch_client(stub):
        body_resp = await async_client.get(f"/course/content/{item.id}/body", headers=headers)
    assert body_resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert body_resp.json()["detail"] == "cms_auth_failed"


# --------------------------------------------------------------------------- #
# /course/site-resources                                                       #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_site_resources_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/course/site-resources")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_site_resources_lists_configured_entries(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "lister")
    resp = await async_client.get("/course/site-resources", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    assert len(payload) == len(SITE_RESOURCES)
    by_slug = {r["slug"]: r for r in payload}
    for configured in SITE_RESOURCES:
        assert configured.slug in by_slug
        entry = by_slug[configured.slug]
        assert entry["title"] == configured.title
        assert entry["url"] == configured.url


@pytest.mark.asyncio
async def test_site_resource_body_happy_path(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "bodyread")
    stub = _StubSquarespaceClient(body_html="<article>About</article>", title="About Adepthood")
    with _patch_client(stub):
        resp = await async_client.get("/course/site-resources/about/body", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["body_html"] == "<article>About</article>"
    assert resp.json()["title"] == "About Adepthood"
    assert stub.calls == ["https://aptitude.guru/about"]


@pytest.mark.asyncio
async def test_site_resource_body_unknown_slug_returns_404(
    async_client: AsyncClient,
) -> None:
    headers = await _signup(async_client, "unknown")
    stub = _StubSquarespaceClient()
    with _patch_client(stub):
        resp = await async_client.get(
            "/course/site-resources/this-does-not-exist/body", headers=headers
        )
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert stub.calls == []
