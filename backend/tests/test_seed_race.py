"""Regression tests for the concurrent-startup seeder race (course content).

Production boots uvicorn with ``--workers 2`` (backend/Dockerfile CMD), so
two workers run ``_seed_startup_data`` in parallel on every deploy.  Against
a fresh database both workers' existence SELECTs see an empty table, both
insert, and — with no unique index on ``coursestage.stage_number`` — every
stage row is duplicated.  ``seed_content`` then maps each stage_number onto
only ONE of the duplicate ids, leaving the other id with zero content; the
course endpoints resolve stages with an unordered ``.first()``, so users are
routed to the content-less duplicate and see "No Content Yet" with all-200
responses.  This is the same TOCTOU family migration ``d2e3f4a5b6c7`` closed
for practice presets.

The deterministic simulation of the race here: rows are already committed
(the peer worker won), but the seeder's existence read is stale (patched to
"empty").  The unique indexes must make the loser's commit fail, and
``commit_or_yield_to_race_winner`` must turn that failure into a no-op.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.course_stage import CourseStage
from models.stage_content import StageContent
from seed_content import _ExistingRows, _load_stage_map, seed_content
from seed_practice_recipes import seed_practice_recipes
from seed_stages import STAGE_DEFINITIONS, seed_stages


async def _count(session: AsyncSession, model: type[CourseStage] | type[StageContent]) -> int:
    result = await session.execute(select(model))
    return len(result.scalars().all())


@pytest.mark.asyncio
async def test_duplicate_stage_number_rejected_by_db(db_session: AsyncSession) -> None:
    """The DB itself must arbitrate stage uniqueness — the app pre-check is racy."""
    await seed_stages(db_session)

    dupe = CourseStage(**STAGE_DEFINITIONS[0])
    db_session.add(dupe)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_duplicate_content_ref_rejected_by_db(db_session: AsyncSession) -> None:
    """One ``content://`` reference per stage — the seeder's stable identity key."""
    await seed_stages(db_session)
    await seed_content(db_session)

    result = await db_session.execute(select(StageContent))
    existing = result.scalars().first()
    assert existing is not None, "vendored manifest must seed at least one chapter"

    dupe = StageContent(
        course_stage_id=existing.course_stage_id,
        title=existing.title,
        content_type=existing.content_type,
        release_day=existing.release_day,
        url=existing.url,
    )
    db_session.add(dupe)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_seed_stages_race_loser_yields_to_winner(db_session: AsyncSession) -> None:
    """A stale existence read must not duplicate stages — the loser rolls back.

    Simulates the two-worker boot race: the peer's rows are committed, but
    this worker's existence SELECT ran before that commit and saw nothing.
    """
    first = await seed_stages(db_session)
    assert first == len(STAGE_DEFINITIONS)

    async def _stale_read(*_args: object, **_kwargs: object) -> dict[int, CourseStage]:
        return {}

    with patch("seed_stages._load_existing_stages", new=_stale_read):
        second = await seed_stages(db_session)

    assert second == 0, "race loser must report 0 inserts, not raise"
    assert await _count(db_session, CourseStage) == len(STAGE_DEFINITIONS)


@pytest.mark.asyncio
async def test_seed_content_race_loser_yields_to_winner(db_session: AsyncSession) -> None:
    """A stale existing-rows read must not duplicate chapters — the loser rolls back."""
    await seed_stages(db_session)
    first = await seed_content(db_session)
    assert first > 0, "vendored manifest must seed chapters"
    baseline = await _count(db_session, StageContent)

    async def _stale_read(*_args: object, **_kwargs: object) -> _ExistingRows:
        return _ExistingRows(by_url={}, by_title={})

    with patch("seed_content._load_existing_keys", new=_stale_read):
        second = await seed_content(db_session)

    assert second == 0, "race loser must report 0 inserts, not raise"
    assert await _count(db_session, StageContent) == baseline


@pytest.mark.asyncio
async def test_seed_content_race_loser_yields_when_prune_flush_collides(
    db_session: AsyncSession,
) -> None:
    """The content seeder must survive losing the race at PRUNE-FLUSH time.

    ``_prune_stale_rows`` calls ``session.flush()`` before the guarded
    commit, and that flush pushes every pending ``_reconcile_all`` insert
    to the DB.  On the two-worker boot against a pre-manifest DB that still
    carries legacy fossil rows, the losing worker reaches the prune with
    real stale rows present *and* pending manifest inserts, so its flush
    fires the ``ix_stagecontent_stage_content_ref_unique`` collision before
    ``try_commit_yielding_to_race_winner`` could arbitrate — the exact
    escape ``seed_practice_recipes`` already guards at its own flush.

    Deterministic simulation: the peer's manifest rows are committed, a
    genuine fossil row sits in a reconciled stage, and this worker's
    existence read is stale (patched to see only the fossil), so reconcile
    re-stages every manifest chapter and the prune flush collides.
    """
    await seed_stages(db_session)
    first = await seed_content(db_session)
    assert first > 0, "vendored manifest must seed chapters"

    reconciled_stage_id = (await _load_stage_map(db_session))[1]
    fossil = StageContent(
        course_stage_id=reconciled_stage_id,
        title="Legacy Fossil No Manifest Claims",
        content_type="reading",
        release_day=1,
        url="legacy://orphaned-fossil",
    )
    db_session.add(fossil)
    await db_session.commit()
    baseline = await _count(db_session, StageContent)

    fossil_only = _ExistingRows(
        by_url={(reconciled_stage_id, fossil.url): [fossil]},
        by_title={(reconciled_stage_id, fossil.title): fossil},
    )

    async def _stale_read(*_args: object, **_kwargs: object) -> _ExistingRows:
        return fossil_only

    with patch("seed_content._load_existing_keys", new=_stale_read):
        second = await seed_content(db_session)

    assert second == 0, "race loser must report 0 inserts, not raise at prune flush"
    assert await _count(db_session, StageContent) == baseline


@pytest.mark.asyncio
async def test_seed_practice_recipes_race_loser_yields_to_winner(
    db_session: AsyncSession,
) -> None:
    """The recipes seeder must survive losing the race at FLUSH time.

    ``_insert_recipe_with_steps`` flushes to obtain the recipe PK, which
    executes the pending tag INSERTs early — so the loser's
    ``IntegrityError`` fires before ``commit_or_yield_to_race_winner``
    ever runs, escaping as a spurious ``seed_failed`` ERROR on every
    fresh-database multi-worker boot.
    """
    first = await seed_practice_recipes(db_session)
    assert first > 0

    async def _stale_read(*_args: object, **_kwargs: object) -> set[str]:
        return set()

    with patch("seed_practice_recipes.existing_system_keys", new=_stale_read):
        second = await seed_practice_recipes(db_session)

    assert second == 0, "race loser must report 0 inserts, not raise"
