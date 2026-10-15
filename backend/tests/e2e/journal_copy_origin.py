"""Arrange a historical unrecorded journal destination in the throwaway e2e DB.

Only ``vault_destination`` is cleared, after a real vault ingest. Production
DELETE, edit refusal, withdrawal bookkeeping and local-only erase remain real.
``show`` reads the content-free obligation; it never reports a remote withdrawal.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import select

from database import normalize_database_url
from models import JournalEntry, User
from models.journal_withdrawal_obligation import JournalWithdrawalObligation


async def inspect_origin(
    session: AsyncSession, email: str, entry_id: int, *, mark: bool
) -> dict[str, object]:
    """Check ownership, optionally arrange the pre-binding row, and report it."""
    user = (await session.execute(select(User).where(User.email == email))).scalar_one()
    entry = await session.get(JournalEntry, entry_id)
    obligation = (
        await session.execute(
            select(JournalWithdrawalObligation).where(
                JournalWithdrawalObligation.user_id == user.id,
                JournalWithdrawalObligation.journal_entry_id == entry_id,
            )
        )
    ).scalar_one_or_none()
    verify_owner(user, entry)
    if mark:
        await mark_unrecorded(session, entry)
    return {
        "entry_id": entry_id,
        **entry_state(entry),
        "obligation": obligation.state if obligation is not None else None,
        "obligation_destination": obligation.destination if obligation is not None else None,
    }


def verify_owner(user: User, entry: JournalEntry | None) -> None:
    """Never arrange or report another account's extant journal row."""
    if entry is not None and entry.user_id != user.id:
        raise ValueError("The journal entry belongs to another account")


async def mark_unrecorded(session: AsyncSession, entry: JournalEntry | None) -> None:
    """Model a historical copy without rewriting its actual vault receipt."""
    if entry is None or not entry.vault_ref or not entry.vault_destination:
        raise ValueError("Arrange requires a newly ingested, destination-bound page")
    entry.vault_destination = None
    session.add(entry)
    await session.commit()


def entry_state(entry: JournalEntry | None) -> dict[str, object]:
    """Report local existence and destination without journal content."""
    if entry is None:
        return {"deleted_here": True, "destination": None}
    return {"deleted_here": entry.deleted_at is not None, "destination": entry.vault_destination}


async def run(command: str, email: str, entry_id: int) -> dict[str, object]:
    """Use only the explicit database URL passed by the isolated browser lane."""
    url = os.environ["DATABASE_URL"].strip()
    if not url:
        raise ValueError("The throwaway lane DATABASE_URL is required")
    engine = create_async_engine(normalize_database_url(url), poolclass=NullPool)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            return await inspect_origin(session, email, entry_id, mark=command == "mark-unrecorded")
    finally:
        await engine.dispose()


def main() -> None:
    """Arrange or inspect one synthetic owner's journal copy origin."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["mark-unrecorded", "show"])
    parser.add_argument("--email", required=True)
    parser.add_argument("--entry-id", required=True, type=int)
    args = parser.parse_args()
    result = asyncio.run(run(args.command, args.email.strip().lower(), args.entry_id))
    sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
