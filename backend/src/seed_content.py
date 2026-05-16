"""Seed StageContent rows from the declarative content config.

Stage 1 (Beige) is fully driven by ``content_config.STAGE_PLANS`` — its
chapters reflect the live Squarespace site.  Stages 2 and 3 retain their
historic placeholder rows so the rest of the app keeps something to render
until those courses ship; once a stage is added to ``STAGE_PLANS`` the
placeholders are reconciled against the plan (see :func:`seed_content`).

Editing rules live in ``backend/src/content_config.py`` and the editor
guide in ``docs/content.md``.  Do not hand-edit URLs in this file — go
update the config instead.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from content_config import STAGE_PLANS, ChapterRecord, all_chapter_records
from models.course_stage import CourseStage
from models.stage_content import StageContent

# Placeholder rows for stages that don't yet have a Squarespace plan.
# Once a stage is added to ``STAGE_PLANS`` (see content_config.py) its
# entry here should be removed in the same commit.
_PLACEHOLDER_DEFINITIONS: list[dict[str, str | int]] = [
    # Stage 2 — Magick
    {
        "stage_number": 2,
        "title": "Introduction to Magick",
        "content_type": "essay",
        "release_day": 0,
        "url": "https://cms.adepthood.com/stage-2/intro",
    },
    {
        "stage_number": 2,
        "title": "Tribal Connection Exercise",
        "content_type": "video",
        "release_day": 3,
        "url": "https://cms.adepthood.com/stage-2/tribal-connection",
    },
    {
        "stage_number": 2,
        "title": "Magick Reflection Prompt",
        "content_type": "prompt",
        "release_day": 7,
        "url": "https://cms.adepthood.com/stage-2/reflection",
    },
    # Stage 3 — Power
    {
        "stage_number": 3,
        "title": "Introduction to Power",
        "content_type": "essay",
        "release_day": 0,
        "url": "https://cms.adepthood.com/stage-3/intro",
    },
    {
        "stage_number": 3,
        "title": "Self-Assertion Practice",
        "content_type": "video",
        "release_day": 3,
        "url": "https://cms.adepthood.com/stage-3/self-assertion",
    },
    {
        "stage_number": 3,
        "title": "Power Reflection Prompt",
        "content_type": "prompt",
        "release_day": 7,
        "url": "https://cms.adepthood.com/stage-3/reflection",
    },
]

#: Stage numbers that have a real Squarespace plan and should NOT receive
#: placeholder rows even if some are listed historically.
_PLANNED_STAGES: frozenset[int] = frozenset(plan.stage_number for plan in STAGE_PLANS)

# BUG-SEED-001 (preserved): a duplicate (stage_number, release_day) on a
# placeholder row would scramble drip-feed ordering.  Configured chapters
# may legitimately share a release_day with a placeholder of a different
# stage, so we only assert uniqueness within the placeholder set.
_placeholder_pairs = [(d["stage_number"], d["release_day"]) for d in _PLACEHOLDER_DEFINITIONS]
if len(set(_placeholder_pairs)) != len(_placeholder_pairs):
    _dupes = sorted(p for p in _placeholder_pairs if _placeholder_pairs.count(p) > 1)
    _err = f"Duplicate (stage_number, release_day) in placeholders: {_dupes}"
    raise ValueError(_err)


def _placeholder_records() -> list[ChapterRecord]:
    """Convert placeholder dicts into ``ChapterRecord``.

    Lets the seeder iterate a single uniform list regardless of whether the
    record came from the declarative config or the legacy placeholder block.
    """
    return [
        ChapterRecord(
            stage_number=int(d["stage_number"]),
            title=str(d["title"]),
            content_type=str(d["content_type"]),
            release_day=int(d["release_day"]),
            url=str(d["url"]),
        )
        for d in _PLACEHOLDER_DEFINITIONS
        if int(d["stage_number"]) not in _PLANNED_STAGES
    ]


def desired_content_records() -> list[ChapterRecord]:
    """Return the full set of records that should exist after seeding.

    Order is (configured chapters first, then placeholders) — callers that
    need a stable ordering can ``sorted(...)`` on the fields they care
    about.
    """
    return [*all_chapter_records(), *_placeholder_records()]


async def _load_stage_map(session: AsyncSession) -> dict[int, int]:
    """Build a map of ``stage_number -> CourseStage.id`` from the DB."""
    result = await session.execute(select(CourseStage))
    return {s.stage_number: s.id for s in result.scalars().all() if s.id is not None}


async def _load_existing_keys(
    session: AsyncSession,
) -> dict[tuple[int, str], StageContent]:
    """Index existing ``StageContent`` rows by ``(course_stage_id, title)``.

    Title is the natural key today (no slug column).  Using a dict — not a
    set — lets us update fields on a row whose URL has drifted from the
    config (e.g. when chapter URLs are renamed on Squarespace) without
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


async def seed_content(session: AsyncSession) -> int:
    """Reconcile ``StageContent`` rows with the declarative config.

    Returns the number of newly-inserted rows.  Existing rows whose fields
    have drifted from the config are updated in place; the function is
    idempotent — running it twice with the same config inserts nothing the
    second time.
    """
    stage_map = await _load_stage_map(session)
    existing = await _load_existing_keys(session)

    inserted = 0
    dirty = False
    for record in desired_content_records():
        was_inserted, was_dirty = _reconcile_one(session, record, stage_map, existing)
        if was_inserted:
            inserted += 1
        dirty = dirty or was_dirty

    if dirty:
        await session.commit()
    return inserted
