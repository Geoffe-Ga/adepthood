"""Folded-quote lineage: count it, content-free, at every egress -- observation only (#3059).

A promoted quote snapshots a passage of one entry; folding it into a review
splices that passage's plaintext into the review's body, and the review keeps
its own tier. A passage written Intimate can therefore leave in a Personal
body, past every per-entry guard. The server knows the lineage through
``PromotedQuote.included_in_entry_id`` joined to the source entry's *current*
tier, so it can be computed at egress time with no epoch: reclassifying the
source changes the answer on the next read.

Whether a folded passage inherits its source's restriction is owner decision
D01, which #3059 forbids assuming. This module is therefore the issue's
Rollout step 1 and nothing more: :func:`observe_lineage` logs one
:data:`LINEAGE_SHADOW_EVENT` record -- ids, counts, a closed operation name and
:data:`POLICY_VERSION`, never text -- when an egress operation runs on an entry
with restricted lineage. It blocks nothing and changes no answer.

What it counts, and what it cannot
==================================

* ``restricted``: folded quotes whose live source is not egress-eligible
  (:func:`domain.privacy_tier.egress_denied_clause` -- Intimate, or any tier
  outside the allowlist).
* ``withdrawn``: folded quotes whose source has since been deleted. A deleted
  source is a withdrawn one; it is reported separately rather than conflated.

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

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlmodel import col

from domain.privacy_tier import admits_egress, egress_denied_clause
from models.journal_entry import JournalEntry
from models.promoted_quote import PromotedQuote

logger = logging.getLogger(__name__)

#: Bumped whenever what counts as restricted lineage changes, so a shadow
#: series can be split at the change rather than read as one population.
POLICY_VERSION: Final = 1

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


class LineageCounts(NamedTuple):
    """How many folded quotes in one entry come from a restricted, or a withdrawn, source."""

    restricted: int
    withdrawn: int


async def restricted_lineage_counts(
    session: AsyncSession, *, user_id: int, entry_ids: Collection[int]
) -> dict[int, LineageCounts]:
    """Count each entry's folded quotes by their source's current state, in one statement.

    Only entries with at least one folded quote appear in the result. Scoped to
    ``user_id``'s own quotes. Projects ids and counts only -- the quote's
    ``anchor_text`` is never selected. An empty ``entry_ids`` returns ``{}``
    without a query.
    """
    if not entry_ids:
        return {}
    source = aliased(JournalEntry)
    live = col(source.deleted_at).is_(None)
    restricted = func.sum(
        case((and_(live, egress_denied_clause(col(source.classification))), 1), else_=0)
    )
    withdrawn = func.sum(case((col(source.deleted_at).is_not(None), 1), else_=0))
    folded_into = col(PromotedQuote.included_in_entry_id)
    result = await session.execute(
        select(folded_into, restricted, withdrawn)
        .join(source, col(source.id) == col(PromotedQuote.source_entry_id))
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
