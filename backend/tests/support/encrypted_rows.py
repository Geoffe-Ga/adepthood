"""Minimal valid rows for every table that holds an encrypted column.

The raw at-rest canary and the operator-tool tests both need "one row per
encrypted table, with chosen text in every encrypted column". Each factory here
builds the smallest valid instance of its table -- creating whatever parent rows
its foreign keys demand -- and hands it back unsaved. :func:`insert_row` then
sets *every* encrypted column of that table, as the schema-derived inventory
lists them, so a column added to an existing table is written by these tests
the day it lands without anybody editing a factory.

A table with no factory fails ``test_every_encrypted_table_has_a_row_factory``
by name, which is the point at which a new encrypted table must add one.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, date, datetime
from typing import Protocol
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from models.completion_suggestion import CompletionSuggestion, CompletionTargetType
from models.corpus_fragment import RETRIEVABLE_TIERS, CorpusFragment, CorpusSource
from models.feedback import FeedbackReport
from models.feedback_triage import FeedbackNote
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.practice import Practice
from models.practice_session import PracticeSession
from models.promoted_quote import PromotedQuote
from models.prompt_response import PromptResponse
from models.user import User
from models.user_practice import UserPractice
from models.user_vault_config import UserVaultConfig
from services.encryption_inventory import encrypted_columns

# Placeholder text for required encrypted fields; insert_row overwrites it.
_FILL = "placeholder"
_ANCHOR_START = 0
_ANCHOR_END = 5
_DURATION_MINUTES = 20.0
_STAGE = 1
_WEEK = 1


class _Row(Protocol):
    """What every encrypted table's row has: an integer ``id`` once flushed."""

    id: int | None


RowFactory = Callable[[AsyncSession], Awaitable[_Row]]


async def _flush(session: AsyncSession, *rows: SQLModel) -> None:
    session.add_all(rows)
    await session.flush()


async def _user_id(session: AsyncSession) -> int:
    user = User(
        email=f"enc-{uuid4().hex}@example.com", password_hash="x"
    )  # pragma: allowlist secret
    await _flush(session, user)
    assert user.id is not None
    return user.id


async def _entry(session: AsyncSession) -> JournalEntry:
    return JournalEntry(sender="user", user_id=await _user_id(session), message=_FILL)


async def _parent_entry(session: AsyncSession) -> JournalEntry:
    entry = await _entry(session)
    await _flush(session, entry)
    return entry


async def _marginalia(session: AsyncSession) -> Marginalia:
    entry = await _parent_entry(session)
    return Marginalia(
        journal_entry_id=entry.id,
        user_id=entry.user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=_ANCHOR_START,
        anchor_end=_ANCHOR_END,
        anchor_text=_FILL,
        note=_FILL,
        # essay and its timestamp are set together or the paired CHECK fires.
        essay=_FILL,
        essay_generated_at=datetime.now(UTC),
    )


async def _completion_suggestion(session: AsyncSession) -> CompletionSuggestion:
    entry = await _parent_entry(session)
    habit = Habit(
        name=f"Walk {uuid4().hex}",
        icon="-",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=1,
        user_id=entry.user_id,
    )
    await _flush(session, habit)
    goal = Goal(
        habit_id=habit.id,
        title="Daily walk",
        tier="clear",
        target=1.0,
        target_unit="walk",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    await _flush(session, goal)
    return CompletionSuggestion(
        journal_entry_id=entry.id,
        user_id=entry.user_id,
        target_type=CompletionTargetType.HABIT,
        goal_id=goal.id,
        label=_FILL,
        anchor_start=_ANCHOR_START,
        anchor_end=_ANCHOR_END,
        anchor_text=_FILL,
    )


async def _promoted_quote(session: AsyncSession) -> PromotedQuote:
    entry = await _parent_entry(session)
    return PromotedQuote(
        user_id=entry.user_id,
        source_entry_id=entry.id,
        anchor_start=_ANCHOR_START,
        anchor_end=_ANCHOR_END,
        anchor_text=_FILL,
    )


async def _prompt_response(session: AsyncSession) -> PromptResponse:
    return PromptResponse(
        week_number=_WEEK, question="q", response=_FILL, user_id=await _user_id(session)
    )


async def _corpus_fragment(session: AsyncSession) -> CorpusFragment:
    return CorpusFragment(
        user_id=await _user_id(session),
        source=CorpusSource.JOURNAL.value,
        tier=RETRIEVABLE_TIERS[0].value,
        content=_FILL,
    )


async def _practice_session(session: AsyncSession) -> PracticeSession:
    user_id = await _user_id(session)
    practice = Practice(
        stage_number=_STAGE,
        name=f"Sitting {uuid4().hex}",
        description="d",
        instructions="i",
        default_duration_minutes=_DURATION_MINUTES,
    )
    await _flush(session, practice)
    selection = UserPractice(
        user_id=user_id,
        practice_id=practice.id,
        stage_number=_STAGE,
        start_date=date(2025, 1, 1),
    )
    await _flush(session, selection)
    return PracticeSession(
        user_id=user_id, user_practice_id=selection.id, duration_minutes=_DURATION_MINUTES
    )


def _report(user_id: int) -> FeedbackReport:
    return FeedbackReport(
        user_id=user_id,
        public_id=f"FB-{uuid4().hex[:8].upper()}",
        category="broken",
        impact="blocked",
        platform="ios",
        viewport_class="compact",
        summary=_FILL,
        screen="habits.shelf",
        app_build="1.0.0",
    )


async def _feedback_report(session: AsyncSession) -> FeedbackReport:
    return _report(await _user_id(session))


async def _feedback_note(session: AsyncSession) -> FeedbackNote:
    report = _report(await _user_id(session))
    await _flush(session, report)
    assert report.id is not None
    return FeedbackNote(report_id=report.id, body=_FILL)


async def _user_vault_config(session: AsyncSession) -> UserVaultConfig:
    return UserVaultConfig(
        user_id=await _user_id(session), vault_url="https://vault.example.com", api_key=_FILL
    )


ROW_FACTORIES: Mapping[str, RowFactory] = {
    "completionsuggestion": _completion_suggestion,
    "corpusfragment": _corpus_fragment,
    "feedbacknote": _feedback_note,
    "feedbackreport": _feedback_report,
    "journalentry": _entry,
    "marginalia": _marginalia,
    "practicesession": _practice_session,
    "promotedquote": _promoted_quote,
    "promptresponse": _prompt_response,
    "uservaultconfig": _user_vault_config,
}


async def insert_row(session: AsyncSession, table: str, text_for: Callable[[str], str]) -> int:
    """Insert one ``table`` row via the ORM with ``text_for(column)`` in each encrypted column.

    Returns:
        The new row's id.
    """
    row = await ROW_FACTORIES[table](session)
    for target in encrypted_columns():
        if target.table == table:
            setattr(row, target.column, text_for(target.column))
    session.add(row)
    await session.flush()
    assert row.id is not None
    return row.id
