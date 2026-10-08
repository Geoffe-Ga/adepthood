"""Folded-quote lineage fixtures: a restricted source, a review that quotes it, and a canary.

The transitive leak #3059 names is a promoted quote folded into a review. The
client splices the quote's plaintext into the review body as a Markdown
blockquote (``frontend/src/features/Journal/reflectionCopy.ts``
``formatBlockquote``: every line prefixed ``> ``, then ``> — <attribution>``),
and the review keeps its own tier, so a passage written Intimate rides out in a
Personal body. The server learns the lineage only from
``PromotedQuote.included_in_entry_id``, set by a separate PATCH.

These helpers build exactly that state, rows only, so a test can drive any sink
over it. The privacy regression suite (B15) reuses them; keep them free of
assertions.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import cast

from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import EntryStatus, JournalClassification, JournalEntry
from models.promoted_quote import PromotedQuote

#: A synthetic canary that should never appear in any log, and -- once lineage
#: enforcement lands (#3059 AC9, pending D01) -- in any model prompt.
LINEAGE_SENTINEL = "b03-lineage-canary-7f3a"

#: The review's own words, quoted by the canned resonance reply so a pass anchors.
REVIEW_PROSE = "Some personal thoughts about the week, gathered into one review."

#: The attribution the client writes under a folded quote.
_ATTRIBUTION = "An earlier page"


def folded_blockquote(anchor_text: str, attribution: str = _ATTRIBUTION) -> str:
    """The block the client splices into a review, mirroring ``formatBlockquote``."""
    quoted = "\n".join(f"> {line}" for line in anchor_text.split("\n"))
    return f"{quoted}\n> — {attribution}"


@dataclass(frozen=True, slots=True)
class FoldedLineage:
    """The ids of one source → quote → review chain."""

    source_id: int
    review_id: int
    quote_id: int


async def _entry(
    session: AsyncSession,
    *,
    user_id: int,
    message: str,
    classification: JournalClassification,
) -> JournalEntry:
    entry = JournalEntry(
        user_id=user_id,
        message=message,
        sender="user",
        status=EntryStatus.FINISHED,
        classification=classification,
        timestamp=datetime.now(UTC),
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return entry


async def seed_folded_lineage(
    session: AsyncSession,
    *,
    user_id: int,
    source_classification: JournalClassification = JournalClassification.INTIMATE,
    review_classification: JournalClassification = JournalClassification.PERSONAL,
    fold_text_into_review: bool = True,
) -> FoldedLineage:
    """Seed a canary source, a promoted quote of it, and a review the quote is folded into.

    ``fold_text_into_review=False`` keeps the ``included_in_entry_id`` link but
    leaves the blockquote out of the review body -- the control for proving a
    leak assertion is not vacuous.
    """
    source_body = f"A passage I keep to myself: {LINEAGE_SENTINEL}."
    source = await _entry(
        session, user_id=user_id, message=source_body, classification=source_classification
    )
    review_body = REVIEW_PROSE
    if fold_text_into_review:
        review_body = f"{REVIEW_PROSE}\n\n{folded_blockquote(LINEAGE_SENTINEL)}"
    review = await _entry(
        session, user_id=user_id, message=review_body, classification=review_classification
    )
    source_id, review_id = cast("int", source.id), cast("int", review.id)
    start = source_body.index(LINEAGE_SENTINEL)
    quote = PromotedQuote(
        user_id=user_id,
        source_entry_id=source_id,
        anchor_start=start,
        anchor_end=start + len(LINEAGE_SENTINEL),
        anchor_text=LINEAGE_SENTINEL,
        included_in_entry_id=review_id,
    )
    session.add(quote)
    await session.commit()
    await session.refresh(quote)
    return FoldedLineage(source_id=source_id, review_id=review_id, quote_id=cast("int", quote.id))
