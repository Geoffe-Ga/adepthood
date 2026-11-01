"""Intimate text never rides a folded quote out of the journal (#3059, owner decision R5-2).

R5-2 (``prompts/claude-comms/2026-10-27-release-decisions.md``): "#3059 D01:
exclude Intimate text from folded quotes." It decides that one point. Whether
a review that holds a folded quote inherits its source's tier -- lineage taint
-- is the rest of D01 and is still open, so nothing here changes a review's
tier or withholds a review whole: only the folded passage is excluded.

Three doors, each closed at the narrowest point that sees it:

* **Creation.** :func:`refuse_unquotable_span` refuses to promote a span of a
  source that may not egress (Intimate, or any tier outside the allowlist of
  :func:`domain.privacy_tier.admits_egress` -- an unknown tier fails closed),
  and a span that overlaps a restricted passage the source itself carries from
  an earlier fold. :func:`refuse_unfoldable_quote` refuses to fold a quote
  whose source has *since* become restricted. Both answer 409
  :data:`QUOTE_SOURCE_RESTRICTED` and log ids and the code only.
* **Offer.** The reflection composer is offered no quote that carries
  restricted text (``routers.reflections`` filters with
  :func:`quote_is_foldable`), so it never splices one into a review.
* **Egress.** A review can already hold the passage: the client splices the
  quote into the body *before* it PATCHes the fold, and a source can be made
  Intimate after its quote was folded. :func:`restricted_folded_passages`
  resolves, against each source's *current* tier, the folded text an entry must
  not send, and every sink that sends an entry's body -- the reflection and
  completion-detection prompts, letters, the recency window and corpus
  grounding, corpus ingest, the vault write and reading recommendations --
  sends :func:`domain.folded_passages.withhold_passages` of it instead. Nothing
  is rewritten in the database: the writer's own page still reads as written,
  and making the source Personal again lets the passage go where the review
  goes.

A quote's restriction **follows it through re-quoting**: a quote lifted from a
review counts as restricted when its text carries a passage that review holds
from a restricted source, so a week review folded into a stage review does not
launder it.

Nothing here logs or returns text. Errors are not swallowed: a passage that
cannot be decrypted fails the request rather than sending the body unredacted.
"""

from __future__ import annotations

import logging
from collections.abc import Collection, Mapping
from typing import Final, NamedTuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlmodel import col

from domain.folded_passages import carries_passage, span_overlaps_passage, withhold_passages
from domain.privacy_tier import admits_egress
from errors import conflict
from models.journal_entry import JournalEntry
from models.promoted_quote import PromotedQuote
from services.privacy_lineage import LineageOperation, observe_entry_lineage

logger = logging.getLogger(__name__)

#: The 409 ``detail`` for a promotion or fold that would carry restricted text.
QUOTE_SOURCE_RESTRICTED: Final = "quote_source_restricted"

#: The content-free event logged when one is refused.
QUOTE_REFUSED_EVENT: Final = "quote_refused_restricted_source"

#: How many fold levels the resolver walks before it stops trusting the chain.
#: The reflection hierarchy nests week, stage, section and course, so a real
#: chain is at most a handful deep; a deeper one is treated as restricted.
MAX_FOLD_LEVELS: Final = 16


class _Fold(NamedTuple):
    """One folded quote: where it went, where it came from, and its text."""

    target_id: int
    source_id: int
    source_admits_egress: bool
    text: str


async def _folds_into(
    session: AsyncSession, user_id: int, entry_ids: Collection[int]
) -> list[_Fold]:
    """Every quote of ``user_id``'s folded into one of ``entry_ids``, with its source's tier."""
    source = aliased(JournalEntry)
    result = await session.execute(
        select(
            col(PromotedQuote.included_in_entry_id),
            col(PromotedQuote.source_entry_id),
            col(source.classification),
            col(PromotedQuote.anchor_text),
        )
        .join(source, col(source.id) == col(PromotedQuote.source_entry_id))
        .where(
            col(PromotedQuote.user_id) == user_id,
            col(PromotedQuote.included_in_entry_id).in_(sorted(entry_ids)),
        )
    )
    return [
        _Fold(int(target), int(source_id), admits_egress(tier), str(text))
        for target, source_id, tier, text in result.all()
    ]


async def _fold_closure(
    session: AsyncSession, user_id: int, entry_ids: Collection[int]
) -> tuple[list[_Fold], bool]:
    """Every fold reachable upstream of ``entry_ids``, and whether the walk ran out of levels."""
    folds: list[_Fold] = []
    seen: set[int] = set()
    frontier = set(entry_ids)
    for _ in range(MAX_FOLD_LEVELS):
        if not frontier:
            return folds, False
        found = await _folds_into(session, user_id, frontier)
        folds.extend(found)
        seen |= frontier
        frontier = {fold.source_id for fold in found if fold.source_admits_egress} - seen
    return folds, bool(frontier)


async def restricted_folded_passages(
    session: AsyncSession, *, user_id: int, entry_ids: Collection[int]
) -> dict[int, tuple[str, ...]]:
    """The folded text each of ``entry_ids`` must not send, keyed by entry; absent means none.

    A fold is restricted when its source may not egress -- Intimate, unknown
    or ``NULL``, live or deleted -- or when its text carries a restricted
    passage of its own source (a quote of a quote). Scoped to ``user_id``'s
    own quotes. An empty ``entry_ids`` issues no query; an entry with no folds
    costs one. A chain deeper than :data:`MAX_FOLD_LEVELS` fails closed: every
    fold in it is treated as restricted.
    """
    if not entry_ids:
        return {}
    folds, exhausted = await _fold_closure(session, user_id, entry_ids)
    restricted = _restricted_texts(folds, exhausted=exhausted)
    return {
        entry_id: tuple(sorted(restricted[entry_id]))
        for entry_id in set(entry_ids)
        if restricted.get(entry_id)
    }


def _fold_is_restricted(
    fold: _Fold, restricted: Mapping[int, set[str]], *, exhausted: bool
) -> bool:
    """Whether ``fold`` carries restricted text, given what is known restricted so far."""
    if exhausted or not fold.source_admits_egress:
        return True
    return carries_passage(fold.text, restricted.get(fold.source_id, ()))


def _restricted_texts(folds: list[_Fold], *, exhausted: bool) -> dict[int, set[str]]:
    """Each target's restricted fold texts, propagated to a fixed point.

    Sets only grow and are bounded by the folds' own texts, so the loop ends.
    A cycle (a review quoting itself) is no restriction unless something in it
    already is.
    """
    restricted: dict[int, set[str]] = {}
    changed = True
    while changed:
        changed = False
        for fold in folds:
            held = restricted.setdefault(fold.target_id, set())
            if fold.text not in held and _fold_is_restricted(fold, restricted, exhausted=exhausted):
                held.add(fold.text)
                changed = True
    return restricted


async def egress_bodies(
    session: AsyncSession, *, user_id: int, bodies: Mapping[int, str]
) -> dict[int, str]:
    """Each of ``bodies`` (keyed by entry id) with its restricted folded passages withheld."""
    passages = await restricted_folded_passages(session, user_id=user_id, entry_ids=bodies.keys())
    return {
        entry_id: withhold_passages(body, passages.get(entry_id, ()))
        for entry_id, body in bodies.items()
    }


async def egress_body(session: AsyncSession, entry: JournalEntry, body: str) -> str:
    """``body`` -- what a sink is about to send for ``entry`` -- with its restricted folds masked.

    ``body`` is passed rather than read off ``entry`` because sinks send a
    sanitized or truncated form of it. An unsaved entry has no folds and its
    body is returned as is, with no query.
    """
    if entry.id is None:
        return body
    bodies = await egress_bodies(session, user_id=entry.user_id, bodies={entry.id: body})
    return bodies[entry.id]


async def letter_body(session: AsyncSession, entry: JournalEntry, anchor_text: str) -> str | None:
    """The body a letter on ``entry``'s note may be written from, or ``None`` if none may.

    Read under the letter's account hold. A deleted row, or one that may not
    egress, sends nothing. A letter's prompt carries the note's anchored
    passage as well as the body, so a note anchored inside a passage this
    entry holds from a restricted fold (anchored before its source became
    Intimate) would carry that passage however the body is masked: no letter is
    written for it. Otherwise the shadow lineage is observed and the body comes
    back with its restricted folds masked.
    """
    if entry.id is None or entry.deleted_at is not None or not admits_egress(entry.classification):
        return None
    passages = await restricted_folded_passages(
        session, user_id=entry.user_id, entry_ids=(entry.id,)
    )
    held = passages.get(entry.id, ())
    if carries_passage(anchor_text, held):
        return None
    # Shadow only (#3059). The letter commits before it dials, so this read is
    # released with its own before anything leaves the process.
    await observe_entry_lineage(session, LineageOperation.ESSAY, entry)
    return withhold_passages(entry.message, held)


def quote_is_foldable(source: JournalEntry, text: str, source_passages: tuple[str, ...]) -> bool:
    """Whether a quote of ``source`` with ``text`` may be folded into a review.

    ``source_passages`` is what :func:`restricted_folded_passages` resolved for
    the source itself.
    """
    return admits_egress(source.classification) and not carries_passage(text, source_passages)


def _refused(user_id: int, entry_id: int | None, quote_id: int | None) -> Exception:
    logger.info(
        QUOTE_REFUSED_EVENT,
        extra={
            "user_id": user_id,
            "entry_id": entry_id,
            "quote_id": quote_id,
            "reason": QUOTE_SOURCE_RESTRICTED,
        },
    )
    return conflict(QUOTE_SOURCE_RESTRICTED)


async def refuse_unquotable_span(
    session: AsyncSession, entry: JournalEntry, start: int, end: int
) -> None:
    """Raise 409 unless ``[start, end)`` of ``entry`` may become a quote.

    Refused when the entry may not egress, or when the span touches a passage
    the entry holds from a restricted fold.
    """
    if not admits_egress(entry.classification):
        raise _refused(entry.user_id, entry.id, None)
    if entry.id is None:
        return
    passages = await restricted_folded_passages(
        session, user_id=entry.user_id, entry_ids=(entry.id,)
    )
    if span_overlaps_passage(entry.message, start, end, passages.get(entry.id, ())):
        raise _refused(entry.user_id, entry.id, None)


async def refuse_unfoldable_quote(session: AsyncSession, quote: PromotedQuote) -> None:
    """Raise 409 unless ``quote`` may still be folded into a review.

    It may when its source is egress-eligible and its text carries no passage
    that source holds from a restricted fold. A source that is missing reads as
    restricted: nothing vouches for its tier.
    """
    source = await session.get(JournalEntry, quote.source_entry_id)
    if source is None or source.user_id != quote.user_id:
        raise _refused(quote.user_id, None, quote.id)
    passages = await restricted_folded_passages(
        session, user_id=quote.user_id, entry_ids=(quote.source_entry_id,)
    )
    if not quote_is_foldable(source, quote.anchor_text, passages.get(quote.source_entry_id, ())):
        raise _refused(quote.user_id, quote.source_entry_id, quote.id)
