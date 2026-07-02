"""Seed StageContent rows from the vendored content manifest.

Chapters are reconciled from ``manifest.json`` for **every stage the
manifest ships**: title, content type, and release day come
from the manifest verbatim, and the ``url`` column carries a local
``content://<chapter-id>`` reference instead of a remote CMS URL.
Reconciliation is idempotent and never destructive: rows update in place
when their fields drift, and nothing is ever deleted — rows referenced
by ``ContentCompletion`` stay put.

Seeding fails loudly when the manifest ships a stage that has no matching
``CourseStage`` row: that mismatch means stages and content were seeded
out of order (or a stage rollback left content orphaned), so we raise
``SeedContentStageMissingError`` before touching the DB rather than
silently dropping the stage's chapters.  ``_seed_startup_data`` catches
it per seeder and surfaces it as ``seed_failed seeder=content`` in the
boot logs.

Editing happens in the content repo; see ``docs/content.md``.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from content_config import ChapterRecord, all_chapter_records
from models.course_stage import CourseStage
from models.stage_content import StageContent


class SeedContentStageMissingError(ValueError):
    """Raised when a manifest stage has no matching ``CourseStage`` row."""


def desired_content_records() -> list[ChapterRecord]:
    """The full set of records that should exist after seeding -- one per manifest chapter."""
    return all_chapter_records()


def _unmapped_manifest_stages(stage_map: dict[int, int]) -> list[int]:
    """Return sorted manifest stage numbers with no ``CourseStage`` row."""
    return sorted(
        {r.stage_number for r in all_chapter_records() if r.stage_number not in stage_map}
    )


async def _load_stage_map(session: AsyncSession) -> dict[int, int]:
    """Build a map of ``stage_number -> CourseStage.id`` from the DB."""
    result = await session.execute(select(CourseStage))
    return {s.stage_number: s.id for s in result.scalars().all() if s.id is not None}


async def _load_existing_keys(
    session: AsyncSession,
) -> dict[tuple[int, str], StageContent]:
    """Index existing ``StageContent`` rows by ``(course_stage_id, title)``.

    Title is the natural key today (no slug column).  Using a dict — not a
    set — lets us update fields on a row whose reference has drifted from
    the manifest (e.g. a chapter id renamed upstream) without
    re-inserting.
    """
    result = await session.execute(select(StageContent))
    return {(sc.course_stage_id, sc.title): sc for sc in result.scalars().all()}


def _build_new_row(record: ChapterRecord, course_stage_id: int) -> StageContent:
    """Construct a fresh ``StageContent`` from a ``ChapterRecord``."""
    return StageContent(
        course_stage_id=course_stage_id,
        title=record.title,
        content_type=record.content_type,
        release_day=record.release_day,
        url=record.url,
    )


def _row_is_in_sync(existing: StageContent, record: ChapterRecord) -> bool:
    """Whether the DB row already matches the config for this chapter."""
    return (
        existing.content_type == record.content_type
        and existing.release_day == record.release_day
        and existing.url == record.url
    )


def _update_row(existing: StageContent, record: ChapterRecord) -> None:
    """Mutate ``existing`` in place to match ``record``."""
    existing.content_type = record.content_type
    existing.release_day = record.release_day
    existing.url = record.url


def _reconcile_one(
    session: AsyncSession,
    record: ChapterRecord,
    stage_map: dict[int, int],
    existing: dict[tuple[int, str], StageContent],
) -> tuple[bool, bool]:
    """Insert or update a single record.

    Returns ``(inserted, dirty)`` — both flags are independent so the
    caller can track new-row count separately from session-dirty state.
    """
    course_stage_id = stage_map.get(record.stage_number)
    if course_stage_id is None:
        return False, False
    prior = existing.get((course_stage_id, record.title))
    if prior is None:
        session.add(_build_new_row(record, course_stage_id))
        return True, True
    if not _row_is_in_sync(prior, record):
        _update_row(prior, record)
        return False, True
    return False, False


def _guard_manifest_stages_mapped(stage_map: dict[int, int]) -> None:
    """Raise loudly when a manifest stage has no ``CourseStage`` row."""
    unmapped = _unmapped_manifest_stages(stage_map)
    if unmapped:
        message = f"Manifest stages have no CourseStage row: {unmapped}"
        raise SeedContentStageMissingError(message)


def _reconcile_all(
    session: AsyncSession,
    stage_map: dict[int, int],
    existing: dict[tuple[int, str], StageContent],
) -> tuple[int, bool]:
    """Reconcile every desired record; return ``(inserted_count, dirty)``."""
    inserted = 0
    dirty = False
    for record in desired_content_records():
        was_inserted, was_dirty = _reconcile_one(session, record, stage_map, existing)
        inserted += int(was_inserted)
        dirty = dirty or was_dirty
    return inserted, dirty


async def seed_content(session: AsyncSession) -> int:
    """Reconcile ``StageContent`` rows with the declarative config.

    Returns the number of newly-inserted rows.  Existing rows whose fields
    have drifted from the config are updated in place; the function is
    idempotent — running it twice with the same config inserts nothing the
    second time.
    """
    stage_map = await _load_stage_map(session)
    _guard_manifest_stages_mapped(stage_map)
    existing = await _load_existing_keys(session)

    inserted, dirty = _reconcile_all(session, stage_map, existing)

    if dirty:
        await session.commit()
    return inserted
