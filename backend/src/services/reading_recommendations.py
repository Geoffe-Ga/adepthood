"""Ground an optional reading offer in current writing and an accessible chapter.

Only the configured vault model writes the explanation. Every returned identity
and quote is checked against a fresh snapshot under the account egress barrier.
The shared cache contains public course text only; personal result caching is
owned by the vault and isolated by its identity and complete context revision.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.constants import STAGE_DURATIONS_DAYS
from domain.course import compute_days_elapsed, unlocked_chapter_count
from domain.creek_vault import CreekVaultClient, CreekVaultError, tier_ceiling_for, wire_ceiling_for
from domain.depth_preferences import DepthRing, load_enabled_rings
from domain.privacy_tier import egress_eligible_clause
from domain.program_calendar import calendar_day_in_stage, resolve_program_anchor
from domain.reading_recommendations import (
    ReadingCandidate,
    ReadingRecommendation,
    ReadingRecommendationClient,
    ReadingRequest,
    ReadingSource,
)
from domain.safety import assess_distress
from domain.stage_progress import get_user_progress, is_stage_unlocked
from models.content_completion import ContentCompletion
from models.corpus_fragment import CorpusSource
from models.course_stage import CourseStage
from models.journal_entry import JournalEntry
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from schemas.invitations import ReadingInvitation
from services.account_egress_barrier import ensure_account_live, hold_account
from services.content_repository import ContentRepositoryError
from services.corpus_consent import load_consent
from services.journal_withdrawal_obligation import deletion_in_progress_clause
from services.privacy_lineage import LineageOperation, observe_lineage
from services.reading_catalog import shortlist

_SOURCE_CHARS = 1400


@dataclass(frozen=True)
class _ReadingContext:
    user_id: int
    timezone: str
    stages: tuple[int, ...]


async def available_readings(
    session: AsyncSession, user_id: int, stage_number: int, tz: str
) -> list[StageContent]:
    """Mirror course access without provisioning progress or recording a visit."""
    if not 1 <= stage_number <= len(STAGE_DURATIONS_DAYS):
        return []
    progress = await get_user_progress(session, user_id)
    if progress is not None:
        await session.refresh(progress)
    if not is_stage_unlocked(stage_number, progress, tz=tz):
        return []
    result = await session.execute(
        select(StageContent)
        .join(CourseStage, col(CourseStage.id) == col(StageContent.course_stage_id))
        .where(col(CourseStage.stage_number) == stage_number)
        .order_by(col(StageContent.release_day), col(StageContent.id))
    )
    items = list(result.scalars().all())
    duration = STAGE_DURATIONS_DAYS[stage_number - 1]
    day = _day_in_stage(progress, stage_number, tz)
    count = unlocked_chapter_count(total=len(items), duration_days=duration, day_in_stage=day)
    read = await session.execute(
        select(ContentCompletion.content_id).where(col(ContentCompletion.user_id) == user_id)
    )
    completed = set(read.scalars().all())
    return _unread(items[:count], completed)


def _unread(items: list[StageContent], completed: set[int]) -> list[StageContent]:
    return [item for item in items if item.id not in completed]


def _day_in_stage(progress: StageProgress | None, stage: int, tz: str) -> int:
    """Use the same calendar/record union as an explicit course visit."""
    if progress is None:
        return 1
    if progress.current_stage > stage:
        return STAGE_DURATIONS_DAYS[stage - 1]
    day = calendar_day_in_stage(resolve_program_anchor(progress), stage, tz=tz)
    return (
        max(day, compute_days_elapsed(progress.stage_started_at) + 1)
        if progress.current_stage == stage
        else day
    )


def _source(entry: JournalEntry) -> ReadingSource:
    """Translate the app's public tier through the canonical wire mapping."""
    return ReadingSource(
        cast("int", entry.id),
        entry.title,
        entry.message[:_SOURCE_CHARS],
        wire_ceiling_for(tier_ceiling_for(entry.classification)).value,
    )


def _has_text(entry: JournalEntry) -> bool:
    return entry.id is not None and bool(entry.message.strip())


async def _sources(session: AsyncSession, user_id: int) -> tuple[ReadingSource, ...]:
    result = await session.execute(
        select(JournalEntry)
        .where(
            col(JournalEntry.user_id) == user_id,
            col(JournalEntry.sender) == "user",
            col(JournalEntry.deleted_at).is_(None),
            col(JournalEntry.status) == "finished",
            egress_eligible_clause(col(JournalEntry.classification)),
            ~deletion_in_progress_clause(col(JournalEntry.id)),
        )
        .order_by(col(JournalEntry.timestamp).desc(), col(JournalEntry.id).desc())
        .limit(2)
        .execution_options(populate_existing=True)
    )
    entries = list(result.scalars().all())
    if any(assess_distress(item.message).level == "elevated" for item in entries):
        return ()
    return tuple(_source(item) for item in entries if _has_text(item))


async def _consented(session: AsyncSession, user_id: int) -> bool:
    if DepthRing.COURSE not in await load_enabled_rings(session, user_id):
        return False
    return (await load_consent(session, user_id=user_id, source=CorpusSource.JOURNAL)).granted


async def _snapshot(
    session: AsyncSession, user_id: int, stages: tuple[int, ...], tz: str
) -> ReadingRequest | None:
    if not await _consented(session, user_id):
        return None
    sources = await _sources(session, user_id)
    if not sources:
        return None
    available = {stage: await available_readings(session, user_id, stage, tz) for stage in stages}
    revision, readings = shortlist(available, sources)
    return ReadingRequest(revision, readings, sources) if readings else None


async def _safe_snapshot(
    session: AsyncSession, user_id: int, stages: tuple[int, ...], tz: str
) -> ReadingRequest | None:
    try:
        return await _snapshot(session, user_id, stages, tz)
    except ContentRepositoryError:
        return None


async def reading_invitation(
    session: AsyncSession,
    user_id: int,
    stage: int | tuple[int, ...],
    tz: str,
    vault: CreekVaultClient,
) -> ReadingInvitation | None:
    """Hold erasure ordering from source collection through validation and projection."""
    if not isinstance(vault, ReadingRecommendationClient) or not vault.is_available():
        return None
    async with hold_account(session, user_id):
        await ensure_account_live(session, user_id)
        stages = (stage,) if isinstance(stage, int) else stage
        snapshot = await _safe_snapshot(session, user_id, stages, tz)
        if snapshot is None:
            return None
        return await _generate(session, _ReadingContext(user_id, tz, stages), vault, snapshot)


async def _recommend(
    vault: ReadingRecommendationClient, snapshot: ReadingRequest
) -> ReadingRecommendation | None:
    try:
        return await vault.recommend_reading(snapshot)
    except CreekVaultError:
        return None


async def _generate(
    session: AsyncSession,
    context: _ReadingContext,
    vault: ReadingRecommendationClient,
    snapshot: ReadingRequest,
) -> ReadingInvitation | None:
    await observe_lineage(
        session,
        LineageOperation.READING_RECOMMENDATION,
        user_id=context.user_id,
        subject_entry_id=snapshot.sources[0].entry_id,
        entry_ids=[source.entry_id for source in snapshot.sources],
    )
    await session.commit()
    result = await _recommend(vault, snapshot)
    if result is None:
        return None
    current = await _safe_snapshot(session, context.user_id, context.stages, context.timezone)
    if current != snapshot:
        return None
    return _project(snapshot, result)


def _reading(snapshot: ReadingRequest, content_id: int) -> ReadingCandidate | None:
    return next((item for item in snapshot.readings if item.content_id == content_id), None)


def _quoted_source(snapshot: ReadingRequest, result: ReadingRecommendation) -> ReadingSource | None:
    source = next((item for item in snapshot.sources if item.entry_id == result.entry_id), None)
    return source if source is not None and result.quote in source.content else None


def _project(snapshot: ReadingRequest, result: ReadingRecommendation) -> ReadingInvitation | None:
    """Navigation coordinates and source labels come from the app's own snapshot."""
    reading = _reading(snapshot, result.content_id)
    source = _quoted_source(snapshot, result)
    if reading is None or source is None:
        return None
    return ReadingInvitation(
        content_id=reading.content_id,
        stage_number=reading.stage_number,
        title=reading.title,
        entry_id=source.entry_id,
        entry_title=source.title,
        quote=result.quote,
        reason=result.reason,
        benefit=result.benefit,
    )
