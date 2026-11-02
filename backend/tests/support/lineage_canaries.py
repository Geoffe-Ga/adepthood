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

A quote need not come from an entry (#3656): :func:`seed_letter_quote` lifts one
from a Resonance Letter on a margin note (:func:`seed_letter_note`), and
:func:`seed_course_quote` from a published Course chapter. Both are seeded
straight into the table, since no route creates either kind yet (#3658).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import cast

from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import EntryStatus, JournalClassification, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.promoted_quote import PromotedQuote, PromotedQuoteSourceKind

#: A synthetic canary that must never appear in any log, nor -- since owner
#: decision R5-2 excluded Intimate text from folded quotes (#3059) -- in
#: anything a review that folds it sends.
LINEAGE_SENTINEL = "b03-lineage-canary-7f3a"

#: The review's own words, quoted by the canned resonance reply so a pass anchors.
REVIEW_PROSE = "Some personal thoughts about the week, gathered into one review."

#: The attribution the client writes under a folded quote.
_ATTRIBUTION = "An earlier page"

#: A line of a Resonance Letter, quoted out of it and folded into a review.
LETTER_LINE = "what the letter saw in that page"

#: The title a Course quote snapshots from its chapter.
CHAPTER_TITLE = "A published chapter"


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


async def seed_letter_note(
    session: AsyncSession, *, user_id: int, entry: JournalEntry, owner_id: int | None = None
) -> Marginalia:
    """A margin note on ``entry`` carrying a Resonance Letter that contains :data:`LETTER_LINE`.

    ``owner_id`` stamps the note with another account, for the ownership cases.
    """
    note = Marginalia(
        journal_entry_id=cast("int", entry.id),
        user_id=user_id if owner_id is None else owner_id,
        kind=MarginaliaKind.THEME,
        anchor_start=0,
        anchor_end=min(len(entry.message), 4),
        anchor_text=entry.message[:4],
        note="A note in the margin.",
        essay=f"Dear writer, {LETTER_LINE}.",
        essay_generated_at=datetime.now(UTC),
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    return note


async def _seed_quote(
    session: AsyncSession, text: str, links: dict[str, object], overrides: dict[str, object]
) -> PromotedQuote:
    """Persist a quote of ``text`` with the source ``links`` of its kind, then ``overrides``."""
    fields: dict[str, object] = {
        "anchor_start": 0,
        "anchor_end": len(text),
        "anchor_text": text,
        "created_at": datetime.now(UTC),
        **links,
        **overrides,
    }
    quote = PromotedQuote(**fields)
    session.add(quote)
    await session.commit()
    await session.refresh(quote)
    return quote


async def seed_letter_quote(
    session: AsyncSession,
    *,
    user_id: int,
    note: Marginalia,
    text: str = LETTER_LINE,
    **overrides: object,
) -> PromotedQuote:
    """A pending quote of ``note``'s letter; ``included_in_entry_id=`` folds it, as any field.

    Every other keyword overrides the row, ``created_at`` included.
    """
    links: dict[str, object] = {
        "user_id": user_id,
        "source_kind": PromotedQuoteSourceKind.LETTER,
        "source_marginalia_id": note.id,
    }
    return await _seed_quote(session, text, links, overrides)


async def seed_course_quote(
    session: AsyncSession, *, user_id: int, text: str = LETTER_LINE, **overrides: object
) -> PromotedQuote:
    """A pending quote of a Course chapter carrying its snapshotted :data:`CHAPTER_TITLE`.

    With no ``source_content_id=`` override it is a quote of a chapter since
    pruned, which is all a test needs when nothing reads the chapter row.
    Every other keyword overrides the row as well.
    """
    links: dict[str, object] = {
        "user_id": user_id,
        "source_kind": PromotedQuoteSourceKind.COURSE,
        "source_title": CHAPTER_TITLE,
    }
    return await _seed_quote(session, text, links, overrides)
