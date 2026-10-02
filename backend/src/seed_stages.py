"""Seed and reconcile the 10 APTITUDE ``CourseStage`` rows.

``CourseStage`` is the canonical stage-correspondence table (#2665). Its seven
correspondence fields and its provenance come from the generated
stage-correspondence artifact (:mod:`curriculum.stage_correspondence`), which
is built from the Complete Map CSV vendored at the ``CONTENT_VERSION`` pin.
Titles and subtitles, which the artifact does not carry, still come from the
Archetypal Wavelength dataset (:mod:`curriculum`); ``overview_url`` is
seeder-owned.

Seeding is insert-plus-reconcile, keyed by the stable ``stage_key``, and
non-destructive:

* a Stage whose key is missing is inserted;
* a row whose key is present has its artifact-sourced fields and provenance
  refreshed in place when they have drifted, keeping its id (so every foreign
  key into the table still resolves) and its ``overview_url``;
* a row whose key and ``stage_number`` disagree with the artifact is an
  integrity fault and raises :class:`StageCorrespondenceError` before
  anything is written, rather than being misread as a lost boot race;
* a row whose key the artifact does not name is logged as an orphan and left
  in place. Rows are never deleted.

The artifact is loaded on the first call, never at import, so a malformed one
fails the startup seeder (``seed_failed seeder=stages``) instead of crashing
``import main``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from curriculum import stage_curriculum
from curriculum.stage_correspondence import (
    CORRESPONDENCE_FIELDS,
    StageCorrespondenceArtifact,
    StageCorrespondenceError,
    StageCorrespondenceRecord,
    stage_correspondence,
)
from models.course_stage import CourseStage
from seed_helpers import commit_or_yield_to_race_winner

logger = logging.getLogger(__name__)

#: The artifact does not carry per-Stage overview URLs; they are a seeder
#: concern and default to empty until populated elsewhere.
DEFAULT_OVERVIEW_URL: Final[str] = ""

#: One seed row for :class:`CourseStage`, as column name -> value.
StageDefinition = dict[str, str | int]

#: Columns reconciled in place on re-seed. ``stage_key`` is the identity the
#: reconcile is keyed by and ``stage_number`` is checked against it, so
#: neither is ever rewritten; ``overview_url`` is seeder-owned. All three are
#: deliberately excluded.
_RECONCILED_FIELDS: Final[tuple[str, ...]] = (
    "title",
    "subtitle",
    *CORRESPONDENCE_FIELDS,
    "source_repo",
    "source_sha",
    "source_path",
    "source_sha256",
    "artifact_schema_version",
)


def _to_definition(
    record: StageCorrespondenceRecord, artifact: StageCorrespondenceArtifact
) -> StageDefinition:
    """Map one artifact Stage, plus its curriculum title, to a seed row."""
    curriculum_stage = stage_curriculum(record.stage_number)
    return {
        "stage_key": record.stage_key,
        "stage_number": record.stage_number,
        "title": curriculum_stage.title,
        "subtitle": curriculum_stage.subtitle,
        "overview_url": DEFAULT_OVERVIEW_URL,
        **{field: getattr(record, field) for field in CORRESPONDENCE_FIELDS},
        "source_repo": artifact.source.repo,
        "source_sha": artifact.source.sha,
        "source_path": artifact.source.csv_path,
        "source_sha256": artifact.source.sha256,
        "artifact_schema_version": artifact.schema_version,
    }


def _build_definitions(artifact: StageCorrespondenceArtifact) -> list[StageDefinition]:
    """Every Stage's seed row, in program order."""
    return [_to_definition(record, artifact) for record in artifact.stages]


def stage_definitions() -> list[StageDefinition]:
    """The seed rows the committed artifact yields (a fresh list per call).

    Parsing is cached by :func:`curriculum.stage_correspondence.stage_correspondence`,
    so this is cheap; returning new dicts keeps callers from mutating a
    shared copy.
    """
    return _build_definitions(stage_correspondence())


def _apply_definition(stage: CourseStage, definition: StageDefinition) -> bool:
    """Refresh ``stage``'s reconciled fields from ``definition``.

    Assigns each reconciled field only when it differs, so an unchanged row
    produces no UPDATE. Returns ``True`` when any field was changed.
    """
    changed = False
    for field in _RECONCILED_FIELDS:
        if getattr(stage, field) != definition[field]:
            setattr(stage, field, definition[field])
            changed = True
    return changed


def _insert_or_reconcile(
    session: AsyncSession,
    existing: dict[str, CourseStage],
    definition: StageDefinition,
    now: datetime,
) -> tuple[int, bool]:
    """Insert ``definition`` if its key is missing, else reconcile that row.

    Returns ``(inserted, changed)`` — the insert count for this definition
    (0 or 1) and whether the session now holds a pending change for it.
    ``reconciled_at`` moves only when something actually changed.
    """
    stage = existing.get(str(definition["stage_key"]))
    if stage is None:
        session.add(CourseStage(**definition, reconciled_at=now))
        return 1, True
    if stage.stage_number != definition["stage_number"]:
        msg = (
            f"stage_key {stage.stage_key!r} is stage_number {stage.stage_number} in the "
            f"database but {definition['stage_number']} in the artifact"
        )
        raise StageCorrespondenceError(msg)
    if not _apply_definition(stage, definition):
        return 0, False
    stage.reconciled_at = now
    return 0, True


def _warn_about_orphans(existing: dict[str, CourseStage], planned: set[str]) -> None:
    """Log every row the artifact does not name; never delete it."""
    for stage_key, stage in existing.items():
        if stage_key not in planned:
            logger.warning(
                "stage_orphaned stage_key=%s stage_number=%d", stage_key, stage.stage_number
            )


async def _load_existing_stages(session: AsyncSession) -> dict[str, CourseStage]:
    """Return the CourseStage rows already present, keyed by ``stage_key``.

    The read is factored out so a concurrent-boot race can be simulated: a
    peer worker's rows may be committed while this worker's existence read
    still returns nothing.
    """
    result = await session.execute(select(CourseStage))
    return {str(stage.stage_key): stage for stage in result.scalars()}


async def _reconcile(session: AsyncSession, definitions: list[StageDefinition]) -> int:
    """Insert or reconcile every definition, then commit only when dirty."""
    existing = await _load_existing_stages(session)
    now = datetime.now(UTC)
    inserted = 0
    dirty = False
    for definition in definitions:
        added, changed = _insert_or_reconcile(session, existing, definition, now)
        inserted += added
        dirty = dirty or changed
    _warn_about_orphans(existing, {str(d["stage_key"]) for d in definitions})
    if dirty:
        return await commit_or_yield_to_race_winner(session, inserted)
    return inserted


async def seed_stages(
    session: AsyncSession,
    *,
    load: Callable[[], StageCorrespondenceArtifact] | None = None,
) -> int:
    """Insert missing Stages and reconcile existing ones by ``stage_key``.

    ``load`` supplies the artifact (default: the committed one, parsed once
    and cached); it runs before the table is read, so a bad artifact raises
    :class:`StageCorrespondenceError` with nothing written. Returns the number
    of Stages inserted (in-place updates are not counted). The session is
    committed only when something was inserted or changed, so a re-run of
    identical data is a true no-op.

    The commit is race-safe: two workers booting concurrently (uvicorn
    ``--workers N``) can both pass the existence check on a fresh database, so
    the loser's insert hits the ``stage_key`` / ``stage_number`` unique
    indexes and yields as a no-op instead of duplicating every Stage. Any
    other failure rolls the session back and propagates, leaving no partial
    update.
    """
    definitions = _build_definitions((load or stage_correspondence)())
    try:
        return await _reconcile(session, definitions)
    except Exception:
        await session.rollback()
        raise
