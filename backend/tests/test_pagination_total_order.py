"""``paginate_query`` must page over a *total* order, never a partial one.

``OFFSET``/``LIMIT`` is only well-defined over a total order. Where the
caller's ``ORDER BY`` ties -- or is absent entirely -- the database is free to
return a different row order for each page request, so one row can surface on
two consecutive pages while another surfaces on none (issue #2718).

Every assertion below is on the SQL the helper actually emitted, compiled to
the PRODUCTION dialect, not on the row order that came back. That is
deliberate: the lane is in-memory SQLite, whose planner happily returns a
stable order for a handful of fixture rows whether or not the tiebreak is
present, so a row-order assertion out of this fixture passes with the defect
fully in place. The one behavioural test at the bottom is kept as
documentation of the user-visible contract, and is labelled with what it
cannot see.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import event, func, update
from sqlalchemy.engine import Connection
from sqlalchemy.engine.interfaces import Dialect
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql import ClauseElement, Select
from sqlmodel import col, select

from conftest import test_engine
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_progress import StageProgress
from models.user import User
from schemas import DEFAULT_PAGE_SIZE, PaginationParams
from schemas import pagination as pag_mod

# The dialect production actually runs, resolved through the same registry a
# real ``postgresql+asyncpg://`` URL goes through.  Rendering captured clauses
# with it keeps the assertions honest about what PostgreSQL will be asked to
# do, rather than about what SQLite happens to do.
_PRODUCTION_DIALECT: Dialect = make_url("postgresql+asyncpg://").get_dialect()()

_TIED_ROW_COUNT = 6
_PAGE_SIZE = 2


def _params(*, limit: int = DEFAULT_PAGE_SIZE, offset: int = 0) -> PaginationParams:
    """Build ``PaginationParams`` with real ints.

    The dataclass's declared defaults are FastAPI ``Query`` markers, resolved
    per-request by the dependency injector; constructing it directly has to
    supply the values the injector would have.
    """
    return PaginationParams(limit=limit, offset=offset, paginate=False)


@contextmanager
def _record_paged_order_by() -> Iterator[list[str]]:
    """Collect the ``ORDER BY`` of every ``LIMIT``+``OFFSET`` SELECT executed.

    ``LIMIT`` alone is not the discriminator: ``.first()`` compiles to a bare
    ``LIMIT 1`` and several request paths use it.  ``paginate_query`` always
    applies ``.offset()`` -- even at offset 0 -- so requiring both keys
    isolates exactly the statements this helper produced.  An empty string is
    recorded for a paged SELECT carrying no ``ORDER BY`` at all, so the
    unordered case fails the assertion instead of vanishing from the list.
    """
    clauses: list[str] = []

    def _before_execute(
        _conn: Connection,
        clause: ClauseElement,
        _multiparams: object,
        _params: object,
        _execution_options: object,
    ) -> None:
        if not isinstance(clause, Select):
            return
        compiled = str(clause.compile(dialect=_PRODUCTION_DIALECT))
        if "LIMIT" not in compiled or "OFFSET" not in compiled:
            return
        if "ORDER BY" not in compiled:
            clauses.append("")
            return
        clauses.append(compiled.split("ORDER BY", 1)[1].split("LIMIT", 1)[0].strip())

    sync_engine = test_engine.sync_engine
    event.listen(sync_engine, "before_execute", _before_execute)
    try:
        yield clauses
    finally:
        event.remove(sync_engine, "before_execute", _before_execute)


async def _signup(client: AsyncClient, username: str = "pager") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _promote_to_admin(db_session: AsyncSession, email: str) -> None:
    """Flip ``is_admin`` on a signed-up user so the admin routes answer."""
    await db_session.execute(update(User).where(col(User.email) == email).values(is_admin=True))
    await db_session.commit()


# ---------------------------------------------------------------------------
# The helper itself.  Every call site inherits whatever this proves, because
# none of them can opt out of it.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unordered_query_is_ordered_by_the_entity_primary_key(
    db_session: AsyncSession,
) -> None:
    """A caller that supplies no ``ORDER BY`` still pages over a total order."""
    with _record_paged_order_by() as clauses:
        await pag_mod.paginate_query(db_session, select(Practice), _params())
    assert clauses == ["practice.id ASC"], clauses


@pytest.mark.asyncio
async def test_primary_key_is_appended_after_a_tie_prone_caller_key(
    db_session: AsyncSession,
) -> None:
    """The caller's ordering is preserved; the primary key only breaks its ties."""
    query = select(PracticeSession).order_by(col(PracticeSession.timestamp).desc())
    with _record_paged_order_by() as clauses:
        await pag_mod.paginate_query(db_session, query, _params())
    assert clauses == ["practicesession.timestamp DESC, practicesession.id ASC"], clauses


@pytest.mark.asyncio
async def test_tiebreak_binds_to_the_selected_alias_not_the_base_table(
    db_session: AsyncSession,
) -> None:
    """An aliased entity is tiebroken on *its* primary key, not the base table's.

    Reading the key straight off ``mapper.primary_key`` would emit
    ``practice.id`` while the FROM clause names ``practice_1`` -- valid SQL
    that silently sorts by a table the page never selected from.
    """
    alias = aliased(Practice)
    with _record_paged_order_by() as clauses:
        await pag_mod.paginate_query(db_session, select(alias), _params())
    assert clauses == ["practice_1.id ASC"], clauses


@pytest.mark.asyncio
async def test_query_without_a_mapped_entity_fails_loudly(db_session: AsyncSession) -> None:
    """A query whose primary key cannot be derived raises instead of paging blind."""
    with pytest.raises(ValueError, match="single mapped entity"):
        await pag_mod.paginate_query(db_session, select(func.count()), _params())


@pytest.mark.asyncio
async def test_envelope_count_pays_for_no_sort(db_session: AsyncSession) -> None:
    """The count that fills ``Page.total`` still runs with no ``ORDER BY`` at all.

    ``count_query_total`` strips the caller's ordering before wrapping the
    query in a subquery, and the primary-key tiebreak must not smuggle a sort
    back into it: the count reads no row order, so sorting for it is pure cost.
    Asserted over the whole ``?paginate=true`` path -- the paged SELECT gets
    the tiebreak, the count SELECT gets no ordering whatsoever.
    """
    statements: list[str] = []

    def _before_execute(
        _conn: Connection,
        clause: ClauseElement,
        _multiparams: object,
        _params: object,
        _execution_options: object,
    ) -> None:
        if isinstance(clause, Select):
            statements.append(str(clause.compile(dialect=_PRODUCTION_DIALECT)))

    sync_engine = test_engine.sync_engine
    event.listen(sync_engine, "before_execute", _before_execute)
    try:
        await pag_mod.paginate_query(
            db_session,
            select(Practice).order_by(col(Practice.name)),
            PaginationParams(limit=DEFAULT_PAGE_SIZE, offset=0, paginate=True),
        )
    finally:
        event.remove(sync_engine, "before_execute", _before_execute)

    counts = [sql for sql in statements if "count(" in sql]
    paged = [sql for sql in statements if "OFFSET" in sql]
    assert counts, statements
    assert all("ORDER BY" not in sql for sql in counts), counts
    assert paged, statements
    assert all("practice.name, practice.id ASC" in sql for sql in paged), paged


# ---------------------------------------------------------------------------
# Every ``paginate_query`` call site, driven through its real endpoint.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "expected_order_by"),
    [
        # Sites that carried no ordering at all before #2718.
        ("/goal-groups/", "goalgroup.id ASC"),
        ("/practices/?stage_number=1", "practice.id ASC"),
        ("/user-practices/", "userpractice.id ASC"),
        # Sites whose ordering existed but could tie.
        (
            "/practice-recipes/",
            "practicerecipe.owner_user_id NULLS FIRST, practicerecipe.name, practicerecipe.id ASC",
        ),
        (
            "/practice-tags/",
            "practicetag.owner_user_id NULLS FIRST, practicetag.label, practicetag.id ASC",
        ),
        # Already total before #2718; the tiebreak must be a harmless no-op.
        ("/stages", "coursestage.stage_number ASC, coursestage.id ASC"),
    ],
)
@pytest.mark.asyncio
async def test_list_endpoints_page_over_a_total_order(
    async_client: AsyncClient, path: str, expected_order_by: str
) -> None:
    """Each paginated list endpoint emits an ORDER BY ending in its primary key."""
    headers = await _signup(async_client, username="lister")
    with _record_paged_order_by() as clauses:
        resp = await async_client.get(path, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert clauses == [expected_order_by], clauses


async def _create_user_practice(
    async_client: AsyncClient, db_session: AsyncSession, headers: dict[str, str]
) -> int:
    """Seed a catalog practice, select it, and return the user-practice id."""
    practice = Practice(
        stage_number=1,
        name="Meditation",
        description="Sit quietly",
        instructions="Close your eyes and breathe",
        default_duration_minutes=10,
        approved=True,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    created_id: int = resp.json()["id"]
    return created_id


@pytest.mark.asyncio
async def test_session_list_pages_over_a_total_order(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``GET /practice-sessions/`` breaks equal timestamps on the session id."""
    headers = await _signup(async_client, username="sessionlister")
    user_practice_id = await _create_user_practice(async_client, db_session, headers)
    with _record_paged_order_by() as clauses:
        resp = await async_client.get(
            f"/practice-sessions/?user_practice_id={user_practice_id}", headers=headers
        )
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert clauses == ["practicesession.timestamp DESC, practicesession.id ASC"], clauses


@pytest.mark.asyncio
async def test_embedded_session_history_pages_over_a_total_order(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The ``sessions[]`` embed on a user-practice detail is paged the same way."""
    headers = await _signup(async_client, username="embedlister")
    user_practice_id = await _create_user_practice(async_client, db_session, headers)
    with _record_paged_order_by() as clauses:
        resp = await async_client.get(f"/user-practices/{user_practice_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert clauses == ["practicesession.timestamp DESC, practicesession.id ASC"], clauses


@pytest.mark.asyncio
async def test_admin_stage_progress_scan_pages_over_a_total_order(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``user_id`` groups many rows per user, so the id tiebreak is load-bearing."""
    headers = await _signup(async_client, username="progressadmin")
    await _promote_to_admin(db_session, "progressadmin@example.com")
    with _record_paged_order_by() as clauses:
        resp = await async_client.get("/admin/stage-progress/gaps?paginate=true", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert clauses == ["stageprogress.user_id, stageprogress.id ASC"], clauses


# ---------------------------------------------------------------------------
# Behavioural backstop.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_paging_a_tie_group_yields_every_row_exactly_once(
    db_session: AsyncSession,
) -> None:
    """Walking the pages of an all-ties collection loses and repeats nothing.

    This is the user-visible contract from issue #2718, stated directly.  It
    is *not* the gate: SQLite returns rowid order for this fixture with or
    without the tiebreak, so it stays green on the defect.  The emitted-SQL
    assertions above are what actually fail when the tiebreak is removed.
    """
    for index in range(_TIED_ROW_COUNT):
        db_session.add(StageProgress(user_id=index + 1, current_stage=1, completed_stages=[]))
    await db_session.commit()

    # Every row ties on ``current_stage``: without a tiebreak the page
    # boundaries are the database's to choose, request by request.
    query = select(StageProgress).order_by(col(StageProgress.current_stage))
    seen: list[int] = []
    for offset in range(0, _TIED_ROW_COUNT, _PAGE_SIZE):
        items, _total = await pag_mod.paginate_query(
            db_session, query, _params(limit=_PAGE_SIZE, offset=offset)
        )
        seen.extend(row.id for row in items if row.id is not None)

    assert len(seen) == _TIED_ROW_COUNT
    assert len(set(seen)) == _TIED_ROW_COUNT


# ---------------------------------------------------------------------------
# Paginators that do not run through ``paginate_query`` and so inherit nothing
# from it.  Both were outside issue #2718's table, which enumerated callers of
# the helper rather than sites of the defect.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prompt_history_pages_over_a_total_order(async_client: AsyncClient) -> None:
    """``GET /prompts/history`` ordered on ``week_number`` alone, which ties hard.

    A user answers many prompts in a week, so the tie groups here are the whole
    week.  This endpoint pages by hand (its no-count path fetches ``limit + 1``
    to peek), so the shared helper's tiebreak never reaches it.
    """
    headers = await _signup(async_client, username="prompthistory")
    with _record_paged_order_by() as clauses:
        resp = await async_client.get("/prompts/history", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert clauses == ["promptresponse.week_number DESC, promptresponse.id DESC"], clauses


@pytest.mark.asyncio
async def test_admin_usage_breakdown_pages_over_a_total_order(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The per-user spend page ordered on a summed cost, which two users can share.

    ``GROUP BY user_id`` makes ``user_id`` unique per output row, so it is the
    total key.  The query is grouped and multi-column, so it cannot go through
    ``paginate_query``.
    """
    headers = await _signup(async_client, username="usageadmin")
    await _promote_to_admin(db_session, "usageadmin@example.com")
    with _record_paged_order_by() as clauses:
        resp = await async_client.get("/admin/usage-stats?paginate=true", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert len(clauses) == 1, clauses
    assert clauses[0].endswith("DESC, llmusagelog.user_id"), clauses
