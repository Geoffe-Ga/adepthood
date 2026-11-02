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
  an earlier fold (:func:`refuse_unquotable_letter_span` does the same for a
  span of a Resonance Letter, held to the tier of the entry its note sits on,
  #3658). :func:`refuse_unfoldable_quote` refuses to fold a quote
  whose source has *since* become restricted. Both answer 409
  :data:`QUOTE_SOURCE_RESTRICTED` and log ids and the code only.
* **Offer.** The reflection composer is offered no quote that carries
  restricted text (``routers.reflections`` filters entry quotes with
  :func:`quote_is_foldable`, and Course and letter quotes with
  :func:`reading_quote_is_foldable`), so it never splices one into a review.
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
from a restricted source -- a whole line of it, or a phrase from inside one
(:func:`domain.folded_passages.fold_carries_passage`) -- so a week review folded
into a stage review does not launder it.

**Each kind of quote answers to the tier it inherits** (#3657;
:func:`fold_source_admits_egress`). An entry quote reads its source entry's
tier. A Resonance Letter has no tier of its own: a quote of one reads the tier
of the entry its margin note sits on, so making that entry Intimate later
withholds the letter's words too. A Course quote is published text, judged by
:func:`domain.privacy_tier.admits_published_content_egress`. Every egress reader
reaches each kind's tier by its own OUTER join, so a fold of any kind is never
dropped from the read, and a kind -- or a join -- that resolves to nothing fails
closed rather than open.

Nothing here logs or returns text. Errors are not swallowed: a passage that
cannot be decrypted fails the request rather than sending the body unredacted.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Collection, Mapping
from typing import Final, NamedTuple

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlmodel import col

from domain.folded_passages import (
    carries_passage,
    fold_carries_passage,
    span_overlaps_passage,
    withhold_passages,
)
from domain.privacy_tier import admits_egress, admits_published_content_egress
from errors import conflict
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia
from models.promoted_quote import PromotedQuote, PromotedQuoteSourceKind
from services.privacy_lineage import LineageOperation, observe_entry_lineage

logger = logging.getLogger(__name__)

#: The 409 ``detail`` for a promotion or fold that would carry restricted text.
QUOTE_SOURCE_RESTRICTED: Final = "quote_source_restricted"

#: The content-free event logged when one is refused.
QUOTE_REFUSED_EVENT: Final = "quote_refused_restricted_source"

#: How many fold levels the resolver walks before it stops trusting the chain.
#: The reflection hierarchy nests week, stage, section and course, so a real
#: chain is at most a handful deep; a deeper one is treated as restricted --
#: that chain alone, not the rest of the batch it was resolved with (#3639).
MAX_FOLD_LEVELS: Final = 16


class _Fold(NamedTuple):
    """One folded quote: where it went, the entry it came from, its kind's tier, and its text.

    ``source_id`` is the upstream *journal entry*, set only for an entry quote:
    a Course chapter or a letter is never an inclusion target, so neither holds
    folds of its own to walk, and its id is not a journal id at all.
    """

    target_id: int
    source_id: int | None
    source_admits_egress: bool
    text: str


def fold_source_admits_egress(kind: object, entry_tier: object, letter_tier: object) -> bool:
    """Whether a fold of ``kind`` may egress, read off the tier that kind inherits (#3657).

    * ``entry`` -- its source entry's tier (``entry_tier``), as it always was.
    * ``letter`` -- a letter has no tier of its own: it inherits the tier of the
      entry its margin note sits on (``letter_tier``), live or soft-deleted. A
      missing note or entry joins as ``NULL``, and nothing vouches for ``NULL``.
    * ``course`` -- published text, through
      :func:`domain.privacy_tier.admits_published_content_egress`.
    * Anything else, or ``NULL``: a kind nobody placed fails closed.
    """
    if kind == PromotedQuoteSourceKind.ENTRY:
        return admits_egress(entry_tier)
    if kind == PromotedQuoteSourceKind.LETTER:
        return admits_egress(letter_tier)
    return kind == PromotedQuoteSourceKind.COURSE and admits_published_content_egress()


async def _folds_into(
    session: AsyncSession, user_id: int, entry_ids: Collection[int]
) -> list[_Fold]:
    """Every quote of ``user_id``'s folded into one of ``entry_ids``, with its kind's tier.

    Each kind reaches the tier it inherits through its own OUTER join, so no
    fold row is ever dropped: a kind whose join finds nothing reads ``NULL`` and
    is withheld, never skipped. The letter joins are scoped to ``user_id`` in the
    join itself, so a note or entry of another account vouches for nothing.
    """
    source = aliased(JournalEntry)
    note = aliased(Marginalia)
    answered = aliased(JournalEntry)
    result = await session.execute(
        select(
            col(PromotedQuote.included_in_entry_id),
            col(PromotedQuote.source_kind),
            col(PromotedQuote.source_entry_id),
            col(source.classification),
            col(answered.classification),
            col(PromotedQuote.anchor_text),
        )
        .outerjoin(source, col(source.id) == col(PromotedQuote.source_entry_id))
        .outerjoin(
            note,
            and_(
                col(note.id) == col(PromotedQuote.source_marginalia_id),
                col(note.user_id) == user_id,
            ),
        )
        .outerjoin(
            answered,
            and_(
                col(answered.id) == col(note.journal_entry_id),
                col(answered.user_id) == user_id,
            ),
        )
        .where(
            col(PromotedQuote.user_id) == user_id,
            col(PromotedQuote.included_in_entry_id).in_(sorted(entry_ids)),
        )
    )
    return [
        _Fold(
            int(target),
            _upstream_entry(kind, source_id),
            fold_source_admits_egress(kind, entry_tier, letter_tier),
            str(text),
        )
        for target, kind, source_id, entry_tier, letter_tier, text in result.all()
    ]


def _upstream_entry(kind: object, source_id: int | None) -> int | None:
    """The journal entry a fold of ``kind`` was lifted from, if it was lifted from one."""
    if kind != PromotedQuoteSourceKind.ENTRY or source_id is None:
        return None
    return int(source_id)


async def _fold_closure(
    session: AsyncSession, user_id: int, entry_ids: Collection[int]
) -> tuple[list[_Fold], set[int]]:
    """Every fold reachable upstream of ``entry_ids``, and the sources the walk never resolved.

    One statement per level, however many entries the batch holds. Only an
    entry source is walked: a Course or letter source is never an inclusion
    target, so it holds no folds and never enters the frontier. A source in
    the second set holds folds no statement read, so nothing is known about
    what it carries; it is empty unless a chain ran past :data:`MAX_FOLD_LEVELS`.
    """
    folds: list[_Fold] = []
    seen: set[int] = set()
    frontier = set(entry_ids)
    for _ in range(MAX_FOLD_LEVELS):
        if not frontier:
            break
        found = await _folds_into(session, user_id, frontier)
        folds.extend(found)
        seen |= frontier
        frontier = _next_frontier(found) - seen
    return folds, frontier


def _next_frontier(found: list[_Fold]) -> set[int]:
    """The upstream entries of ``found`` the walk reads next: eligible entry sources only.

    A restricted source needs no walk -- everything it carries is withheld
    already -- and a fold with no upstream entry has nothing upstream to read.
    """
    return {
        fold.source_id for fold in found if fold.source_id is not None and fold.source_admits_egress
    }


def _targets_by_source(folds: list[_Fold]) -> dict[int, list[int]]:
    """Each upstream entry, mapped to the entries its folds went into.

    A Course or letter fold has no upstream entry, so it carries no other
    entry's text onward and links nothing here.
    """
    targets: dict[int, list[int]] = {}
    for fold in folds:
        if fold.source_id is not None:
            targets.setdefault(fold.source_id, []).append(fold.target_id)
    return targets


def _downstream_of(folds: list[_Fold], unresolved: set[int]) -> set[int]:
    """``unresolved`` and every entry a chain of ``folds`` carries their text into.

    These are the entries whose restricted passages cannot be known: each holds,
    at some remove, a fold from a source the walk never read. An entry that
    reaches none of them was resolved in full, however deep another chain in
    the same batch ran.
    """
    targets = _targets_by_source(folds)
    reached = set(unresolved)
    pending = list(unresolved)
    while pending:
        for target in targets.get(pending.pop(), ()):
            if target not in reached:
                reached.add(target)
                pending.append(target)
    return reached


async def restricted_folded_passages(
    session: AsyncSession, *, user_id: int, entry_ids: Collection[int]
) -> dict[int, tuple[str, ...]]:
    """The folded text each of ``entry_ids`` must not send, keyed by entry; absent means none.

    A fold is restricted when its source may not egress -- Intimate, unknown
    or ``NULL``, live or deleted, read per kind by
    :func:`fold_source_admits_egress` -- or when its text carries a restricted
    passage of its own source entry (a quote of a quote). Scoped to ``user_id``'s
    own quotes. An empty ``entry_ids`` issues no query; an entry with no folds
    costs one. A chain deeper than :data:`MAX_FOLD_LEVELS` fails closed: every
    fold into an entry that chain reaches is treated as restricted. The rest of
    the batch is resolved on its own folds (#3639).
    """
    if not entry_ids:
        return {}
    folds, unresolved = await _fold_closure(session, user_id, entry_ids)
    restricted = _restricted_texts(folds, unknown=_downstream_of(folds, unresolved))
    return {
        entry_id: tuple(sorted(restricted[entry_id]))
        for entry_id in set(entry_ids)
        if restricted.get(entry_id)
    }


def _fold_is_restricted(
    fold: _Fold, restricted: Mapping[int, set[str]], *, unknown: Collection[int]
) -> bool:
    """Whether ``fold`` carries restricted text, given what is known restricted so far.

    A fold into an entry in ``unknown`` is restricted outright: what that entry
    carries cannot be resolved, and an ambiguity withholds. A fold with no
    upstream entry (Course or letter) is judged on its kind's tier alone.
    """
    if fold.target_id in unknown or not fold.source_admits_egress:
        return True
    if fold.source_id is None:
        return False
    return fold_carries_passage(fold.text, restricted.get(fold.source_id, ()))


def _restricted_texts(folds: list[_Fold], *, unknown: Collection[int]) -> dict[int, set[str]]:
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
            if fold.text not in held and _fold_is_restricted(fold, restricted, unknown=unknown):
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


async def refuse_unquotable_letter_span(
    session: AsyncSession, entry: JournalEntry, text: str
) -> None:
    """Raise 409 unless ``text``, a span of a letter on a note of ``entry``'s, may become a quote.

    A letter has no tier of its own: it answers to the entry its note sits on,
    so it is refused when that entry may not egress -- the letter may predate
    the entry becoming Intimate -- exactly as :func:`refuse_unquotable_span`
    refuses a span of the entry itself. It is also refused when ``text`` carries
    a passage the entry holds from a restricted fold: a letter is written from
    the masked body, but one written before that fold's source became Intimate
    may repeat it. Nothing is stored either way.
    """
    if not admits_egress(entry.classification):
        raise _refused(entry.user_id, entry.id, None)
    if entry.id is None:
        return
    passages = await restricted_folded_passages(
        session, user_id=entry.user_id, entry_ids=(entry.id,)
    )
    if carries_passage(text, passages.get(entry.id, ())):
        raise _refused(entry.user_id, entry.id, None)


def quote_is_foldable(source: JournalEntry, text: str, source_passages: tuple[str, ...]) -> bool:
    """Whether a quote of ``source`` with ``text`` may be folded into a review.

    ``source_passages`` is what :func:`restricted_folded_passages` resolved for
    the source itself.
    """
    return admits_egress(source.classification) and not carries_passage(text, source_passages)


def _is_published(quote: PromotedQuote) -> bool:
    """Whether ``quote`` is of published Course text, which every reader may carry onward."""
    return quote.source_kind == PromotedQuoteSourceKind.COURSE and admits_published_content_egress()


def reading_quote_is_foldable(
    quote: PromotedQuote, answered: JournalEntry | None, answered_passages: tuple[str, ...]
) -> bool:
    """Whether a Course or letter quote may be offered for folding into a review (#3657).

    ``answered`` is the entry a letter quote's note sits on -- already resolved
    by the caller as live and the quote owner's own, ``None`` when nothing
    vouches -- and ``answered_passages`` what :func:`restricted_folded_passages`
    resolved for it. A Course quote is published text; a letter quote answers
    to that entry exactly as :func:`refuse_unfoldable_quote` holds it; any other
    kind is never offered here.
    """
    if _is_published(quote):
        return True
    if quote.source_kind != PromotedQuoteSourceKind.LETTER or answered is None:
        return False
    return quote_is_foldable(answered, quote.anchor_text, answered_passages)


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


async def _vouched_entry_source(session: AsyncSession, quote: PromotedQuote) -> JournalEntry | None:
    """An entry quote's source entry if it is the quote owner's own, else ``None``."""
    if quote.source_entry_id is None:
        return None
    source = await session.get(JournalEntry, quote.source_entry_id)
    return source if source is not None and source.user_id == quote.user_id else None


async def _owned_note(session: AsyncSession, quote: PromotedQuote) -> Marginalia | None:
    """The margin note a letter quote was lifted from, if it is the quote owner's own."""
    if quote.source_marginalia_id is None:
        return None
    note = await session.get(Marginalia, quote.source_marginalia_id)
    return note if note is not None and note.user_id == quote.user_id else None


async def _vouched_letter_entry(session: AsyncSession, quote: PromotedQuote) -> JournalEntry | None:
    """The live entry a letter quote's note sits on, if note and entry are both the owner's.

    A letter has no tier of its own: it answers to this entry's. A deleted
    entry vouches for nothing a review is about to carry onward.
    """
    note = await _owned_note(session, quote)
    if note is None:
        return None
    entry = await session.get(JournalEntry, note.journal_entry_id)
    vouched = entry is not None and entry.deleted_at is None and entry.user_id == quote.user_id
    return entry if vouched else None


_Voucher = Callable[[AsyncSession, PromotedQuote], Awaitable[JournalEntry | None]]

#: How each kind finds the entry whose tier and restricted passages its fold
#: answers to. A Course quote answers to none (published text); a kind not
#: named here -- an unknown one included -- answers to none and is refused.
_VOUCHERS: Final[Mapping[str, _Voucher]] = {
    PromotedQuoteSourceKind.ENTRY: _vouched_entry_source,
    PromotedQuoteSourceKind.LETTER: _vouched_letter_entry,
}


async def _vouched_source(session: AsyncSession, quote: PromotedQuote) -> JournalEntry | None:
    """The entry a fold of ``quote`` answers to, per its kind, or ``None`` if nothing vouches."""
    voucher = _VOUCHERS.get(quote.source_kind)
    return None if voucher is None else await voucher(session, quote)


async def refuse_unfoldable_quote(session: AsyncSession, quote: PromotedQuote) -> None:
    """Raise 409 unless ``quote`` may still be folded into a review, per its kind (#3657).

    * ``course`` -- published text: allowed, through
      :func:`domain.privacy_tier.admits_published_content_egress`.
    * ``entry`` -- allowed when its source entry is the owner's own and
      egress-eligible, and its text carries no passage that entry holds from a
      restricted fold.
    * ``letter`` -- the same test against the entry its note sits on, which must
      also be live; the note must be the owner's own too. Letters are written
      from the masked body, so the passage check is defence in depth for a
      letter written before one of that entry's folds became restricted.
    * Anything else: refused.

    A source that is missing reads as restricted: nothing vouches for its tier.
    """
    if _is_published(quote):
        return
    source = await _vouched_source(session, quote)
    if source is None or source.id is None:
        raise _refused(quote.user_id, None, quote.id)
    passages = await restricted_folded_passages(
        session, user_id=quote.user_id, entry_ids=(source.id,)
    )
    if not quote_is_foldable(source, quote.anchor_text, passages.get(source.id, ())):
        raise _refused(quote.user_id, source.id, quote.id)
