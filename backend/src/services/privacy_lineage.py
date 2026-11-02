"""Folded-quote lineage: count it, content-free, at every egress -- observation only (#3059).

A promoted quote snapshots a passage of one entry; folding it into a review
splices that passage's plaintext into the review's body, and the review keeps
its own tier. A passage written Intimate can therefore leave in a Personal
body, past every per-entry guard. The server knows the lineage through
``PromotedQuote.included_in_entry_id`` joined to the source entry's *current*
tier, so it can be computed at egress time with no epoch: reclassifying the
source changes the answer on the next read.

Owner decision R5-2 settled one point of D01: Intimate text is excluded from
folded quotes. That exclusion is enforced in :mod:`services.folded_quote_privacy`,
which masks the passage itself wherever it would egress. Whether the review as
a whole inherits its source's restriction is the rest of D01 and still open,
so this module stays the issue's Rollout step 1: :func:`observe_lineage` logs
one :data:`LINEAGE_SHADOW_EVENT` record -- ids, counts, a closed operation name
and :data:`POLICY_VERSION`, never text -- when an egress operation runs on an
entry with restricted lineage. It blocks nothing and changes no answer.

What it counts, and what it cannot
==================================

* ``restricted``: folded quotes whose live source is not egress-eligible
  (:func:`domain.privacy_tier.egress_denied_clause` -- Intimate, or any tier
  outside the allowlist).
* ``withdrawn``: folded quotes whose source has since been deleted. A deleted
  source is a withdrawn one; it is reported separately rather than conflated.

A letter quote's "source" here is the entry its letter answered, which is the
tier it inherits; a Course quote is published text and is counted as neither
(#3657, :data:`POLICY_VERSION` 2).

Both are **lower bounds**. The client splices a quote into the body first and
PATCHes ``included_in_entry_id`` second, so a fold that was never PATCHed is
invisible here (#3059 AC13), and prose retyped by hand is out of scope.

Errors are not swallowed. On PostgreSQL a failed read aborts the transaction,
so a swallowed failure would only resurface on the request's next statement,
detached from its cause; an observation that cannot be made fails like any
other read on the request.
"""

from __future__ import annotations

import logging
from collections.abc import Collection
from enum import StrEnum
from typing import Final, NamedTuple

from sqlalchemy import ColumnElement, and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlmodel import col

from domain.privacy_tier import admits_egress, egress_denied_clause
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia
from models.promoted_quote import PromotedQuote, PromotedQuoteSourceKind

logger = logging.getLogger(__name__)

#: Bumped whenever what counts as restricted lineage changes, so a shadow
#: series can be split at the change rather than read as one population.
#:
#: * ``1`` -- folds of entry quotes, by their source entry.
#: * ``2`` -- also folds of letter quotes, by the entry the letter answered
#:   (#3657). Course quotes are published text and are never counted.
POLICY_VERSION: Final = 2

#: The one message every shadow record carries; its fields are in ``extra``.
LINEAGE_SHADOW_EVENT: Final = "privacy_lineage_shadow"


class LineageOperation(StrEnum):
    """Every egress operation that reports lineage -- a closed vocabulary safe to log.

    A test requires each member to be referenced from ``backend/src``, so a
    member cannot be added without a call site, nor a call site dropped
    without the test noticing.
    """

    RESONANCE = "resonance"
    ESSAY = "essay"
    DETECT = "detect"
    CORPUS_INGEST = "corpus_ingest"
    VAULT_WRITE = "vault_write"
    VOICE_DRAFT_MIRROR = "voice_draft_mirror"
    PRIOR_CONTEXT = "prior_context"
    READING_RECOMMENDATION = "reading_recommendation"


class LineageCounts(NamedTuple):
    """How many folded quotes in one entry come from a restricted, or a withdrawn, source."""

    restricted: int
    withdrawn: int


def _lineage_case(
    entry_arm: ColumnElement[bool], letter_arm: ColumnElement[bool]
) -> ColumnElement[int]:
    """``1`` for a fold whose kind's arm holds, else ``0`` -- never ``1`` for a Course fold."""
    kind = col(PromotedQuote.source_kind)
    return case(
        (and_(kind == PromotedQuoteSourceKind.ENTRY.value, entry_arm), 1),
        (and_(kind == PromotedQuoteSourceKind.LETTER.value, letter_arm), 1),
        else_=0,
    )


async def restricted_lineage_counts(
    session: AsyncSession, *, user_id: int, entry_ids: Collection[int]
) -> dict[int, LineageCounts]:
    """Count each entry's folded quotes by their source's current state, in one statement.

    Each kind is read through its own OUTER join (#3657), so no fold row drops
    out of the count: an entry quote by its source entry, a letter quote by the
    entry its margin note sits on (note and entry scoped to ``user_id``, so a
    missing or foreign one reads as restricted, never as clean). A Course quote
    is published text and is never counted.

    Only entries with at least one folded quote appear in the result. Scoped to
    ``user_id``'s own quotes. Projects ids and counts only -- the quote's
    ``anchor_text`` is never selected. An empty ``entry_ids`` returns ``{}``
    without a query.
    """
    if not entry_ids:
        return {}
    source = aliased(JournalEntry)
    note = aliased(Marginalia)
    answered = aliased(JournalEntry)
    restricted = func.sum(
        _lineage_case(
            and_(
                col(source.deleted_at).is_(None),
                egress_denied_clause(col(source.classification)),
            ),
            and_(
                col(answered.deleted_at).is_(None),
                egress_denied_clause(col(answered.classification)),
            ),
        )
    )
    withdrawn = func.sum(
        _lineage_case(col(source.deleted_at).is_not(None), col(answered.deleted_at).is_not(None))
    )
    folded_into = col(PromotedQuote.included_in_entry_id)
    result = await session.execute(
        select(folded_into, restricted, withdrawn)
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
        .where(col(PromotedQuote.user_id) == user_id, folded_into.in_(sorted(entry_ids)))
        .group_by(folded_into)
    )
    return {
        int(entry_id): LineageCounts(restricted=int(r or 0), withdrawn=int(w or 0))
        for entry_id, r, w in result.all()
    }


async def observe_lineage(
    session: AsyncSession,
    operation: LineageOperation,
    *,
    user_id: int,
    subject_entry_id: int,
    entry_ids: Collection[int],
) -> None:
    """Log one shadow record if any of ``entry_ids`` carries restricted or withdrawn lineage.

    ``subject_entry_id`` is the entry the operation is *for*; ``entry_ids`` is
    whatever of the writer's text the operation sends -- the subject itself, or
    the entries in its prior-context window. The record carries the summed
    counts, never which entry or passage contributed them.
    """
    found = await restricted_lineage_counts(session, user_id=user_id, entry_ids=entry_ids)
    restricted = sum(counts.restricted for counts in found.values())
    withdrawn = sum(counts.withdrawn for counts in found.values())
    if restricted + withdrawn == 0:
        return
    logger.info(
        LINEAGE_SHADOW_EVENT,
        extra={
            "operation": operation.value,
            "user_id": user_id,
            "entry_id": subject_entry_id,
            "count": restricted,
            "withdrawn_count": withdrawn,
            "policy_version": POLICY_VERSION,
        },
    )


async def observe_entry_lineage(
    session: AsyncSession, operation: LineageOperation, entry: JournalEntry
) -> None:
    """:func:`observe_lineage` for one entry's own text, if that entry would egress at all.

    An unsaved, deleted or non-eligible entry sends nothing, so an operation on
    it is not a shadow of anything and no query is made.
    """
    if entry.id is None or entry.deleted_at is not None or not admits_egress(entry.classification):
        return
    await observe_lineage(
        session,
        operation,
        user_id=entry.user_id,
        subject_entry_id=entry.id,
        entry_ids=(entry.id,),
    )
