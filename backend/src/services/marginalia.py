"""Marginalia maintenance hooks.

The re-anchoring seam is intentionally a no-op here: editing a journal entry's
body can shift or invalidate the character spans that marginalia anchor to, but
the actual re-anchor / mark-stale logic lands in a later issue. This module
exists so the PATCH endpoint can call a stable, documented seam now.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import JournalEntry


async def reanchor_entry_marginalia(
    entry: JournalEntry,
    old_message: str,
    new_message: str,
    session: AsyncSession,
) -> None:
    """Re-anchor (or mark stale) the entry's marginalia after a body edit.

    No-op for now — the diff-based re-anchoring is implemented in a follow-up.
    Kept as a call seam so the edit endpoint's contract is stable: callers invoke
    it whenever ``message`` changes, passing the old and new bodies.
    """
    # Arguments are accepted now to fix the seam's signature; the follow-up that
    # implements re-anchoring will consume them.
    del entry, old_message, new_message, session
