"""Which occasions drive the vault's ontologization ladder, and how far.

Split out of :mod:`services.creek_vault_pipeline` (#3773) so the vocabulary the
scheduler reasons over -- the ladder itself, the occasions that climb it, how
deep each occasion is and which rungs it may pay for -- reads in one place, and
the scheduler module keeps to scheduling. Everything here is a pure value or a
pure function over one; nothing reads a database or dials a vault.
"""

from __future__ import annotations

import enum
from collections.abc import Mapping
from datetime import datetime, timedelta

from sqlalchemy import case, or_
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import col

from domain.creek_vault import VaultPipelineStage
from models.vault_pipeline_run import VaultPipelineRun

#: The ladder, in the order Creek documents it. Classification first because the
#: thread stage reads the labels it writes; then the linker stages cheapest
#: first, so a truncated pass leaves the corpus navigable rather than leaving it
#: exactly as it found it.
LADDER: tuple[VaultPipelineStage, ...] = (
    VaultPipelineStage.CLASSIFY,
    VaultPipelineStage.TEMPORAL,
    VaultPipelineStage.EMBEDDINGS,
    VaultPipelineStage.EDDIES,
    VaultPipelineStage.THREADS,
)


class VaultPipelineTrigger(enum.StrEnum):
    """What occasioned a pass, and therefore how much of the ladder it may climb.

    Two triggers because there are two honest answers to "how long may this
    request take". A journal save is the most frequent write in the app and the
    one a person is waiting on with something they just wrote; a document import
    is deliberate, rare, and already a file upload, so a caller has different
    patience for each. The depth is a property of the occasion rather than of the
    caller, which is why it is an enum here and not a parameter.

    Attributes:
        JOURNAL_WRITE: After an entry replicated to the vault. The cheap half
            only — classification and temporal linking — under the adapter's
            standing deadline.
        DOCUMENT_IMPORT: After a document was stored in the vault. The whole
            ladder, under a wall clock.
        BULK_IMPORT: Once, after a bulk upload drained (#3773). The whole ladder,
            every stage due whatever its window, handed straight to the durable
            background continuation rather than climbed inside any request.
    """

    JOURNAL_WRITE = "journal_write"
    DOCUMENT_IMPORT = "document_import"
    BULK_IMPORT = "bulk_import"


#: How deep each scope is, shallowest first. A joined or merged scope is the
#: deepest one any party asked for, so a bulk pass joined to a journal save's
#: classification keeps its whole, window-free ladder.
TRIGGER_DEPTH: tuple[VaultPipelineTrigger, ...] = (
    VaultPipelineTrigger.JOURNAL_WRITE,
    VaultPipelineTrigger.DOCUMENT_IMPORT,
    VaultPipelineTrigger.BULK_IMPORT,
)


def deeper_than(trigger: VaultPipelineTrigger) -> tuple[VaultPipelineTrigger, ...]:
    """The scopes deeper than ``trigger``, deepest first."""
    return tuple(reversed(TRIGGER_DEPTH[TRIGGER_DEPTH.index(trigger) + 1 :]))


def strongest_trigger(*values: str | None) -> VaultPipelineTrigger:
    """Return the deepest valid scope represented by ``values``."""
    for trigger in reversed(TRIGGER_DEPTH):
        if trigger.value in values:
            return trigger
    return VaultPipelineTrigger.JOURNAL_WRITE


#: Which rungs each trigger is willing to pay for. The journal path's exclusion
#: of the two clustering stages is the single most load-bearing line in this
#: module: those stages run a local sentence-transformer pass over every uncached
#: fragment on a cold vault, which is minutes, and a journal save that could take
#: minutes is a broken journal however well it is bounded.
STAGES_BY_TRIGGER: Mapping[VaultPipelineTrigger, frozenset[VaultPipelineStage]] = {
    VaultPipelineTrigger.JOURNAL_WRITE: frozenset(
        {VaultPipelineStage.CLASSIFY, VaultPipelineStage.TEMPORAL}
    ),
    VaultPipelineTrigger.DOCUMENT_IMPORT: frozenset(LADDER),
    VaultPipelineTrigger.BULK_IMPORT: frozenset(LADDER),
}

#: The scopes no stage window stands down. A bulk upload's pass is pressed once
#: per drained upload run, rate-limited per account, and exists precisely so a
#: morning's import is clustered that morning rather than six hours after its
#: first document closed the window (#3773).
WINDOW_FREE_TRIGGERS: frozenset[VaultPipelineTrigger] = frozenset(
    {VaultPipelineTrigger.BULK_IMPORT}
)


# How long a stage stands down for after an attempt, successful or not.
#
# The cheap window is minutes because classification is what makes new writing
# visible to everything downstream, and because the pass short-circuits on the
# fragments it already stamped — so a repeat costs the vault a walk over its own
# frontmatter rather than a reclassification. Fifteen is a compromise between
# "the entry I wrote this morning is in my wheel" and "forty entries in an hour
# is forty passes".
#
# The expensive window is hours because the two clustering stages are the ones
# that actually cost a vault something, and because what they produce — topic
# clusters and narrative currents over a whole corpus — does not meaningfully
# change between one document and the next. Six is chosen so a person importing
# a morning's worth of files pays for one clustering pass rather than one per
# file, while a corpus that grows over a week is re-clustered several times
# across it.
_CHEAP_STAGE_INTERVAL = timedelta(minutes=15)
_CLUSTERING_STAGE_INTERVAL = timedelta(hours=6)

#: How long each rung stands down for after an attempt. A table for the reason
#: :data:`LINK_STAGE_BY_PIPELINE_STAGE` is one: a stage added without an interval
#: should fail to be schedulable rather than inherit somebody else's by falling
#: through an ``else``.
_STAGE_INTERVAL: Mapping[VaultPipelineStage, timedelta] = {
    VaultPipelineStage.CLASSIFY: _CHEAP_STAGE_INTERVAL,
    VaultPipelineStage.TEMPORAL: _CHEAP_STAGE_INTERVAL,
    VaultPipelineStage.EMBEDDINGS: _CLUSTERING_STAGE_INTERVAL,
    VaultPipelineStage.EDDIES: _CLUSTERING_STAGE_INTERVAL,
    VaultPipelineStage.THREADS: _CLUSTERING_STAGE_INTERVAL,
}


def _due(stage: VaultPipelineStage, stamps: Mapping[str, datetime], now: datetime) -> bool:
    """Whether this stage's own window has reopened."""
    last = stamps.get(stage.value)
    return last is None or now - last >= _STAGE_INTERVAL[stage]


def due_stages(
    trigger: VaultPipelineTrigger, stamps: Mapping[str, datetime], now: datetime
) -> tuple[VaultPipelineStage, ...]:
    """The rungs this trigger may pay for whose own windows have reopened.

    Walks :data:`LADDER` rather than the permitted set, so the answer comes back
    in the order Creek documents the passes in rather than in whatever order a
    set happens to iterate. A window-free scope (:data:`WINDOW_FREE_TRIGGERS`)
    finds every permitted rung due.
    """
    permitted = STAGES_BY_TRIGGER[trigger]
    window_free = trigger in WINDOW_FREE_TRIGGERS
    return tuple(
        stage
        for stage in LADDER
        if stage in permitted and (window_free or _due(stage, stamps, now))
    )


def stages_to_run(
    trigger: VaultPipelineTrigger,
    stamps: Mapping[str, datetime],
    now: datetime,
    *,
    classification_landed: bool,
) -> tuple[VaultPipelineStage, ...]:
    """Which rungs this pass may climb, in ladder order.

    Three filters, and the third is what makes the ordering safe to rely on: the
    trigger's depth, each stage's own window, and the requirement that a
    classification pass has landed at some point -- in this run or an earlier
    one. Without the third, a vault whose classification window is still closed
    would have its clustering stages run over labels that were never written.
    """
    due = due_stages(trigger, stamps, now)
    if classification_landed or VaultPipelineStage.CLASSIFY in due:
        return due
    return ()


def stronger_scope_expression(
    trigger: VaultPipelineTrigger,
) -> str | ColumnElement[str]:
    """Build the SQL expression merging requested, original, and joined scope.

    Deepest first: a row already carrying a deeper scope than ``trigger`` --
    as its own trigger or as a joined follow-up -- keeps that scope, and
    otherwise the requested one is written.
    """
    requested = trigger.value
    deeper = deeper_than(trigger)
    if not deeper:
        return requested
    return case(
        *(
            (
                or_(
                    col(VaultPipelineRun.trigger) == scope.value,
                    col(VaultPipelineRun.follow_up_trigger) == scope.value,
                ),
                scope.value,
            )
            for scope in deeper
        ),
        else_=requested,
    )


def kept_or_deeper(
    stored: ColumnElement[str], trigger: VaultPipelineTrigger
) -> str | ColumnElement[str]:
    """Merge ``trigger`` into a stored scope column: keep a deeper one, else write this one.

    The follow-up intent row's upsert: a journal save arriving after a
    document import's intent must not shallow it, and a bulk import's intent
    outranks both.
    """
    deeper = [scope.value for scope in deeper_than(trigger)]
    if not deeper:
        return trigger.value
    return case((stored.in_(deeper), stored), else_=trigger.value)
