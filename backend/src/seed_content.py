"""Seed StageContent rows from the vendored content manifest.

Chapters are reconciled from ``manifest.json`` for **every stage the
manifest ships**: title, content type, and release day come
from the manifest verbatim, and the ``url`` column carries a local
``content://<chapter-id>`` reference instead of a remote CMS URL.
Reconciliation is idempotent and never destructive: rows update in place
when their fields drift, and nothing is ever deleted — rows referenced
by ``ContentCompletion`` stay put.

Seeding is resilient, never all-or-nothing.  Every manifest stage that
has a matching ``CourseStage`` row is reconciled and committed.  A
manifest stage whose ``CourseStage`` row is absent (stages seeded out of
order, or a stage rollback that left content orphaned) is skipped and
surfaced as a ``content_seed_partial`` WARNING in the logs — never an
abort.  This guarantees an always-unlocked stage such as Stage 1 always
seeds even when higher stages have no row yet.

Editing happens in the content repo; see ``docs/content.md``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from content_config import ChapterRecord, all_chapter_records
from models.course_stage import CourseStage
from models.stage_content import StageContent
from seed_helpers import commit_or_yield_to_race_winner

logger = logging.getLogger(__name__)


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


@dataclass
class _ExistingRows:
    """Two-tier lookup over existing ``StageContent`` for reconciliation.

    A chapter's stable identity is its ``content://<id>`` reference (the
    ``url`` column), so a manifest title edit must still land on the same
    row.  ``by_url`` is therefore the primary index; ``by_title`` is a
    fallback that heals legacy rows whose ``url`` drifted from the manifest
    while their title held steady.  Rows are popped from both indexes when
    claimed so one DB row can never satisfy two manifest records.
    """

    by_url: dict[tuple[int, str], StageContent]
    by_title: dict[tuple[int, str], StageContent]

    def claim(self, course_stage_id: int, record: ChapterRecord) -> StageContent | None:
        """Find and remove the prior row for ``record``: url first, title fallback."""
        prior = self.by_url.get((course_stage_id, record.url))
        if prior is None:
            prior = self.by_title.get((course_stage_id, record.title))
        if prior is not None:
            self.by_url.pop((course_stage_id, prior.url), None)
            self.by_title.pop((course_stage_id, prior.title), None)
        return prior


async def _load_existing_keys(session: AsyncSession) -> _ExistingRows:
    """Index existing ``StageContent`` rows for id-keyed reconciliation.

    The ``content://<id>`` reference (``url``) is the stable identity, so
    rows are indexed primarily by ``(course_stage_id, url)`` — a title edit
    on that stable ref updates in place instead of duplicating.  A
    secondary ``(course_stage_id, title)`` index is a fallback that keeps
    healing legacy rows whose ``url`` drifted from the manifest.
    """
    result = await session.execute(select(StageContent))
    rows = list(result.scalars().all())
    return _ExistingRows(
        by_url={(sc.course_stage_id, sc.url): sc for sc in rows},
        by_title={(sc.course_stage_id, sc.title): sc for sc in rows},
    )


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
        existing.title == record.title
        and existing.content_type == record.content_type
        and existing.release_day == record.release_day
        and existing.url == record.url
    )


def _update_row(existing: StageContent, record: ChapterRecord) -> None:
    """Mutate ``existing`` in place to match ``record``."""
    existing.title = record.title
    existing.content_type = record.content_type
    existing.release_day = record.release_day
    existing.url = record.url


def _reconcile_one(
    session: AsyncSession,
    record: ChapterRecord,
    stage_map: dict[int, int],
    existing: _ExistingRows,
) -> tuple[bool, bool]:
    """Insert or update a single record.

    Returns ``(inserted, dirty)`` — both flags are independent so the
    caller can track new-row count separately from session-dirty state.
    """
    course_stage_id = stage_map.get(record.stage_number)
    if course_stage_id is None:
        return False, False
    prior = existing.claim(course_stage_id, record)
    if prior is None:
        session.add(_build_new_row(record, course_stage_id))
        return True, True
    if not _row_is_in_sync(prior, record):
        _update_row(prior, record)
        return False, True
    return False, False


def _warn_unmapped_manifest_stages(stage_map: dict[int, int]) -> None:
    """Emit a loud WARNING when a manifest stage has no ``CourseStage`` row.

    Called after the commit so mapped rows persist regardless; the skipped
    stages are surfaced (never raised) so an operator can spot the partial
    seed and add the missing ``CourseStage`` rows.
    """
    unmapped = _unmapped_manifest_stages(stage_map)
    if unmapped:
        logger.warning("content_seed_partial stages_without_course_stage_row=%s", unmapped)


def _reconcile_all(
    session: AsyncSession,
    stage_map: dict[int, int],
    existing: _ExistingRows,
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
    second time.  Manifest stages without a ``CourseStage`` row are skipped
    and warned about after the commit, never aborting the seed.
    """
    stage_map = await _load_stage_map(session)
    existing = await _load_existing_keys(session)

    inserted, dirty = _reconcile_all(session, stage_map, existing)

    if dirty:
        # Race-safe commit: a peer worker that seeded the same chapters
        # between our existence read and this commit trips the
        # ``ix_stagecontent_stage_content_ref_unique`` index (migration
        # ``b4c5d6e7f8a1``); the loser rolls back and reports 0 inserts.
        inserted = await commit_or_yield_to_race_winner(session, inserted)
    _warn_unmapped_manifest_stages(stage_map)
    return inserted
