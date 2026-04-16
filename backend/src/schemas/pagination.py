"""Shared pagination primitives for list endpoints.

Defines the ``Page[T]`` response envelope and the ``PaginationParams``
dependency so every paginated list endpoint serialises the same shape and
shares a single source of validation for ``limit`` / ``offset``.

The envelope is opt-in via ``?paginate=true`` so this can ship before the
frontend consumes it (BUG-INFRA-012-018).  When the frontend has migrated,
the bare-list code path is dropped and the envelope becomes the only shape.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select

T = TypeVar("T")

# Hard upper bounds on per-page results.  ``MAX_PAGE_SIZE`` matches the audit
# recommendation; ``DEFAULT_PAGE_SIZE`` is what callers get when they omit
# ``limit`` entirely.
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


class Page(BaseModel, Generic[T]):  # noqa: UP046
    """Generic pagination envelope returned when ``?paginate=true`` is set.

    Fields mirror what the frontend needs to render a paged list without a
    second round-trip: the items themselves, the absolute total for "page X
    of Y" displays, and the request parameters echoed back so retries can
    reproduce the page exactly.
    """

    items: list[T]
    total: int
    limit: int
    offset: int
    has_more: bool


@dataclass
class PaginationParams:
    """Standard ``limit`` / ``offset`` / ``paginate`` query parameters.

    ``paginate`` defaults to ``False`` so existing clients receive the bare
    list shape they were built against.  New clients (and the frontend, once
    migrated) opt in by sending ``?paginate=true``; the response then becomes
    a :class:`Page` envelope.
    """

    limit: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE)
    offset: int = Query(default=0, ge=0)
    paginate: bool = Query(
        default=False,
        description=(
            "When true, return a Page envelope ({items, total, limit, offset, "
            "has_more}) instead of a bare list.  Default is bare list for "
            "backwards compatibility; will become the default in a future "
            "release."
        ),
    )


def build_page(items: list[T], total: int, params: PaginationParams) -> Page[T]:  # noqa: UP047
    """Construct a :class:`Page` envelope from sliced items + count + params."""
    return Page[T](
        items=items,
        total=total,
        limit=params.limit,
        offset=params.offset,
        has_more=(params.offset + params.limit) < total,
    )


async def paginate_query(
    session: AsyncSession,
    query: Select[Any],
    params: PaginationParams,
) -> tuple[list[Any], int]:
    """Apply ``offset`` / ``limit`` to ``query`` and return ``(items, total)``.

    Performs two database round-trips: a ``SELECT COUNT(*)`` over the
    pre-pagination query (to populate ``Page.total`` for "page X of Y"
    displays) and the actual paged ``SELECT``.  Eager-loaded relationships
    declared on ``query`` via ``selectinload`` continue to work because they
    issue separate ``IN`` queries that aren't affected by the outer
    ``OFFSET`` / ``LIMIT``.
    """
    count_query = select(func.count()).select_from(query.order_by(None).subquery())
    total = (await session.execute(count_query)).scalar() or 0

    paged_query = query.offset(params.offset).limit(params.limit)
    result = await session.execute(paged_query)
    items = list(result.scalars().all())
    return items, int(total)
