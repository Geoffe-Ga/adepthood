"""Seed StageContent rows from the vendored content manifest.

Chapters are reconciled from ``manifest.json`` for **every stage the
manifest ships**: title, content type, and release day come
from the manifest verbatim, and the ``url`` column carries a local
``content://<chapter-id>`` reference instead of a remote CMS URL.
Reconciliation is idempotent: a manifest-claimed row survives and updates
in place when its fields drift.  A ``StageContent`` row in a *reconciled*
stage that the current manifest no longer claims is pruned; stages the
manifest does not ship, and stages skipped for a missing ``CourseStage``
row, are never touched.  When a pruned row carried ``ContentCompletion``
read-marks, each mark is repointed to a surviving row of the same
``(stage, title)`` or dropped when no such survivor exists (and dropped,
rather than repointed, when repointing would collide with a mark the user
already holds on the survivor).

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
from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.stage_content import StageContent
from seed_helpers import try_commit_yielding_to_race_winner

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
) -> tuple[bool, bool, StageContent | None]:
    """Insert or update a single record.

    Returns ``(inserted, dirty, row)`` — the flags are independent so the
    caller can track new-row count separately from session-dirty state,
    and ``row`` is the reconciled ``StageContent`` (the claimed/updated
    prior row, or the freshly built insert).  ``row`` is ``None`` only
    when the record's stage has no ``CourseStage`` row and is skipped.
    """
    course_stage_id = stage_map.get(record.stage_number)
    if course_stage_id is None:
        return False, False, None
    prior = existing.claim(course_stage_id, record)
    if prior is None:
        new_row = _build_new_row(record, course_stage_id)
        session.add(new_row)
        return True, True, new_row
    if not _row_is_in_sync(prior, record):
        _update_row(prior, record)
        return False, True, prior
    return False, False, prior


def _warn_unmapped_manifest_stages(stage_map: dict[int, int]) -> None:
    """Emit a loud WARNING when a manifest stage has no ``CourseStage`` row.

    Called after the commit so mapped rows persist regardless; the skipped
    stages are surfaced (never raised) so an operator can spot the partial
    seed and add the missing ``CourseStage`` rows.
    """
    unmapped = _unmapped_manifest_stages(stage_map)
    if unmapped:
        logger.warning("content_seed_partial stages_without_course_stage_row=%s", unmapped)


@dataclass(frozen=True)
class _ReconcileResult:
    """Outcome of reconciling every desired record against the DB.

    ``survivors`` maps ``(course_stage_id, title)`` to the reconciled row
    that now owns that slot, so the prune step can repoint a stale row's
    read-marks onto the same-``(stage, title)`` survivor.
    """

    inserted: int
    dirty: bool
    survivors: dict[tuple[int, str], StageContent]


def _reconcile_all(
    session: AsyncSession,
    stage_map: dict[int, int],
    existing: _ExistingRows,
) -> _ReconcileResult:
    """Reconcile every desired record; report inserts, dirt, and survivors."""
    inserted = 0
    dirty = False
    survivors: dict[tuple[int, str], StageContent] = {}
    for record in desired_content_records():
        was_inserted, was_dirty, row = _reconcile_one(session, record, stage_map, existing)
        inserted += int(was_inserted)
        dirty = dirty or was_dirty
        if row is not None:
            survivors[(row.course_stage_id, row.title)] = row
    return _ReconcileResult(inserted=inserted, dirty=dirty, survivors=survivors)


def _reconciled_stage_ids(stage_map: dict[int, int]) -> set[int]:
    """The ``CourseStage.id`` set the current manifest reconciles this run.

    This is the prune scope guard: only rows whose ``course_stage_id`` is
    in this set are ever eligible for deletion, so stages the manifest
    does not ship and stages skipped for a missing ``CourseStage`` row
    stay untouched.
    """
    shipped = {r.stage_number for r in desired_content_records()}
    return {stage_map[stage] for stage in shipped if stage in stage_map}


def _stale_rows(existing: _ExistingRows, reconciled_ids: set[int]) -> list[StageContent]:
    """Unclaimed rows in reconciled stages — the deletion candidates.

    After reconciliation ``existing.by_url`` holds exactly the rows no
    manifest record claimed; narrowing to ``reconciled_ids`` keeps the
    prune from ever reaching a stage this run did not reconcile.
    """
    return [row for row in existing.by_url.values() if row.course_stage_id in reconciled_ids]


@dataclass(frozen=True)
class _PruneCounts:
    """Tally of a prune pass: rows removed and read-marks moved or dropped."""

    rows: int
    repointed: int
    dropped: int


async def _user_ids_with_completion(session: AsyncSession, content_id: int) -> set[int]:
    """User ids that already hold a read-mark on ``content_id``."""
    result = await session.execute(
        select(ContentCompletion.user_id).where(ContentCompletion.content_id == content_id)
    )
    return set(result.scalars().all())


async def _repoint_completions(
    session: AsyncSession,
    completions: list[ContentCompletion],
    survivor_id: int,
) -> tuple[int, int]:
    """Repoint marks onto ``survivor_id``; return ``(repointed, dropped)``.

    A user who already holds a mark on the survivor would trip
    ``uq_contentcompletion_user_content`` on repoint, so that stale mark is
    dropped instead of moved.
    """
    already_marked = await _user_ids_with_completion(session, survivor_id)
    repointed = 0
    dropped = 0
    for completion in completions:
        if completion.user_id in already_marked:
            await session.delete(completion)
            dropped += 1
        else:
            completion.content_id = survivor_id
            repointed += 1
    return repointed, dropped


async def _drop_or_repoint_completions(
    session: AsyncSession,
    stale: StageContent,
    survivor: StageContent | None,
) -> tuple[int, int]:
    """Rehome a stale row's read-marks; return ``(repointed, dropped)``.

    With no survivor every mark is deleted; with a survivor the marks are
    repointed onto it (or dropped on a duplicate) by
    :func:`_repoint_completions`.
    """
    result = await session.execute(
        select(ContentCompletion).where(ContentCompletion.content_id == stale.id)
    )
    completions = list(result.scalars().all())
    survivor_id = survivor.id if survivor is not None else None
    if survivor_id is None:
        for completion in completions:
            await session.delete(completion)
        return 0, len(completions)
    return await _repoint_completions(session, completions, survivor_id)


async def _prune_stale_rows(
    session: AsyncSession,
    existing: _ExistingRows,
    survivors: dict[tuple[int, str], StageContent],
    reconciled_ids: set[int],
) -> _PruneCounts:
    """Delete unclaimed rows in reconciled stages, rehoming their read-marks.

    Flushes first so freshly inserted survivors carry ids before any
    read-mark is repointed onto them, and again once every mark is rehomed
    so no surviving completion still references a stale row when the row is
    deleted (the ``content_id`` FK is enforced and not deferrable).
    Deletion stays inside the caller's transaction; the shared commit point
    is the sole writer.
    """
    stale = _stale_rows(existing, reconciled_ids)
    if not stale:
        return _PruneCounts(rows=0, repointed=0, dropped=0)
    await session.flush()
    repointed = 0
    dropped = 0
    for row in stale:
        survivor = survivors.get((row.course_stage_id, row.title))
        row_repointed, row_dropped = await _drop_or_repoint_completions(session, row, survivor)
        repointed += row_repointed
        dropped += row_dropped
    await session.flush()
    for row in stale:
        await session.delete(row)
    return _PruneCounts(rows=len(stale), repointed=repointed, dropped=dropped)


def _warn_pruned(counts: _PruneCounts) -> None:
    """Emit one WARNING summarising a prune pass, only when rows were removed."""
    if counts.rows > 0:
        logger.warning(
            "content_seed_pruned rows=%d completions_repointed=%d completions_deleted=%d",
            counts.rows,
            counts.repointed,
            counts.dropped,
        )


async def seed_content(session: AsyncSession) -> int:
    """Reconcile ``StageContent`` rows with the declarative config.

    Returns the number of newly-inserted rows.  Existing rows whose fields
    have drifted from the config are updated in place; the function is
    idempotent — running it twice with the same config inserts nothing the
    second time.  Rows in reconciled stages that the manifest no longer
    claims are pruned, and their read-marks repointed or dropped.  Manifest
    stages without a ``CourseStage`` row are skipped and warned about after
    the commit, never aborting the seed.
    """
    stage_map = await _load_stage_map(session)
    existing = await _load_existing_keys(session)

    result = _reconcile_all(session, stage_map, existing)
    counts = await _prune_stale_rows(
        session, existing, result.survivors, _reconciled_stage_ids(stage_map)
    )

    if result.dirty or counts.rows > 0:
        # Race-safe commit: a peer worker that seeded the same chapters
        # between our existence read and this commit trips the
        # ``ix_stagecontent_stage_content_ref_unique`` index (migration
        # ``e8f9a0b1c2d3``); the loser rolls back and reports 0 inserts.
        won = await try_commit_yielding_to_race_winner(session)
        inserted = result.inserted if won else 0
    else:
        # Nothing to commit, so nothing this process could lose or roll back.
        won = True
        inserted = result.inserted
    _warn_unmapped_manifest_stages(stage_map)
    if won:
        # A prune the losing worker rolled back never persisted from here;
        # only the winner reports its tally.
        _warn_pruned(counts)
    return inserted
