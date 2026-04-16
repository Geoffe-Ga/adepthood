"""Tests for the shared pagination envelope and ``PaginationParams``.

BUG-INFRA-012..018: every list endpoint in the audit should switch between
the bare-list shape (default) and the :class:`Page` envelope when the client
sends ``?paginate=true``.  These tests exercise one representative endpoint
(``/practices/``) to prove the toggle works; per-endpoint tests live
alongside each feature's API tests.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from schemas import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, Page, PaginationParams, build_page

_SEED_COUNT_SMALL = 3
_SEED_COUNT_LARGE = 5
_SLICE_LIMIT = 2
_SLICE_OFFSET = 1
_ROUND_TRIP_COUNT = 2


async def _signup(client: AsyncClient) -> dict[str, str]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": "pager@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _seed(db_session: AsyncSession, count: int) -> None:
    for i in range(count):
        db_session.add(
            Practice(
                stage_number=1,
                name=f"Practice {i:02d}",
                description="",
                instructions="",
                default_duration_minutes=10,
                approved=True,
            )
        )
    await db_session.commit()


@pytest.mark.asyncio
async def test_bare_list_is_the_default(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Without ``?paginate=true`` the response is a plain JSON array."""
    headers = await _signup(async_client)
    await _seed(db_session, count=_SEED_COUNT_SMALL)

    resp = await async_client.get("/practices/", params={"stage_number": 1}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) == _SEED_COUNT_SMALL


@pytest.mark.asyncio
async def test_envelope_returned_when_paginate_true(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``?paginate=true`` switches the response to the :class:`Page` envelope."""
    headers = await _signup(async_client)
    await _seed(db_session, count=_SEED_COUNT_SMALL)

    resp = await async_client.get(
        "/practices/",
        params={"stage_number": 1, "paginate": "true"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["total"] == _SEED_COUNT_SMALL
    assert body["limit"] == DEFAULT_PAGE_SIZE
    assert body["offset"] == 0
    assert body["has_more"] is False
    assert len(body["items"]) == _SEED_COUNT_SMALL


@pytest.mark.asyncio
async def test_envelope_respects_limit_and_offset(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``limit`` / ``offset`` produce the expected slice of a larger result."""
    headers = await _signup(async_client)
    await _seed(db_session, count=_SEED_COUNT_LARGE)

    resp = await async_client.get(
        "/practices/",
        params={
            "stage_number": 1,
            "paginate": "true",
            "limit": _SLICE_LIMIT,
            "offset": _SLICE_OFFSET,
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["total"] == _SEED_COUNT_LARGE
    assert body["limit"] == _SLICE_LIMIT
    assert body["offset"] == _SLICE_OFFSET
    assert body["has_more"] is True
    assert len(body["items"]) == _SLICE_LIMIT


@pytest.mark.asyncio
async def test_envelope_rejects_out_of_range_limit(async_client: AsyncClient) -> None:
    """``limit`` above :data:`MAX_PAGE_SIZE` is a 422 validation error."""
    headers = await _signup(async_client)
    resp = await async_client.get(
        "/practices/",
        params={"stage_number": 1, "paginate": "true", "limit": MAX_PAGE_SIZE + 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


def test_build_page_has_more_boundary() -> None:
    """``has_more`` flips exactly at ``offset + limit == total``."""
    params = PaginationParams(limit=10, offset=0, paginate=True)
    page = build_page(items=[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], total=10, params=params)
    assert page.has_more is False

    params = PaginationParams(limit=10, offset=0, paginate=True)
    page = build_page(items=[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], total=11, params=params)
    assert page.has_more is True


def test_page_schema_round_trip() -> None:
    """:class:`Page` round-trips through JSON with parametrised item type."""
    page: Page[dict[str, int]] = Page(
        items=[{"a": 1}, {"a": 2}],
        total=2,
        limit=50,
        offset=0,
        has_more=False,
    )
    restored = Page[dict[str, int]].model_validate_json(page.model_dump_json())
    assert restored.items == page.items
    assert restored.total == _ROUND_TRIP_COUNT
