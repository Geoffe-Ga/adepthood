"""Journal persistence helpers shared by the BotMason chat endpoints.

Routers stay thin by delegating DB writes and query shape to this module.
The service assumes the caller owns the :class:`AsyncSession` lifecycle — it
stages rows on the session (``session.add`` / ``session.flush``) but leaves
commit/rollback to the route handler so wallet mutations and journal rows
land atomically together.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.journal_entry import JournalEntry
from models.llm_usage_log import LLMUsageLog
from services.botmason import CONVERSATION_HISTORY_LIMIT, LLMResponse
from services.llm_pricing import estimate_cost_usd


async def load_recent_conversation(
    session: AsyncSession,
    user_id: int,
) -> list[dict[str, str]]:
    """Return the last ``CONVERSATION_HISTORY_LIMIT`` messages chronologically.

    Centralising the query keeps the streaming and non-streaming endpoints in
    sync: if the context window grows later, both inherit the new behaviour
    without drift.  Each entry is returned as a plain dict so provider
    adapters do not need to know about ORM types.
    """
    history_query = (
        select(JournalEntry)
        .where(JournalEntry.user_id == user_id)
        .order_by(col(JournalEntry.id).desc())
        .limit(CONVERSATION_HISTORY_LIMIT)
    )
    result = await session.execute(history_query)
    entries = list(reversed(result.scalars().all()))
    return [{"sender": entry.sender, "message": entry.message} for entry in entries]


async def persist_user_message(
    session: AsyncSession,
    user_id: int,
    message: str,
) -> JournalEntry:
    """Stage and flush the user's chat message as a :class:`JournalEntry`.

    The flush assigns a primary key so subsequent operations (loading history,
    forming the bot's FK) can reference it without guessing.  The commit is
    still the caller's responsibility so a provider failure can roll back the
    whole interaction.
    """
    entry = JournalEntry(sender="user", user_id=user_id, message=message)
    session.add(entry)
    await session.flush()
    return entry


async def persist_bot_reply(
    session: AsyncSession,
    user_id: int,
    response: LLMResponse,
) -> JournalEntry:
    """Stage the bot's :class:`JournalEntry` and its :class:`LLMUsageLog` row.

    ``LLMUsageLog`` carries a foreign key to the bot's journal entry so each
    usage row can be traced back to the exact response it billed.  We flush
    after adding the entry to lock in the FK value, then add the usage log
    against the same session.  The caller owns the final ``commit()``; both
    rows land in the same transaction.
    """
    entry = JournalEntry(sender="bot", user_id=user_id, message=response.text)
    session.add(entry)
    await session.flush()

    if entry.id is None:  # pragma: no cover - defensive; flush assigns the PK
        msg = "journal_entry_id must be set before logging LLM usage"
        raise RuntimeError(msg)

    session.add(
        LLMUsageLog(
            user_id=user_id,
            provider=response.provider,
            model=response.model,
            prompt_tokens=response.prompt_tokens,
            completion_tokens=response.completion_tokens,
            total_tokens=response.total_tokens,
            estimated_cost_usd=estimate_cost_usd(
                response.model,
                response.prompt_tokens,
                response.completion_tokens,
            ),
            journal_entry_id=entry.id,
        )
    )
    return entry
