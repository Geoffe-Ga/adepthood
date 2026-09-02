"""One rung of a vault's ontologization ladder, and how far it got.

A connected vault files what adepthood sends it as fragments, and a fragment
nobody classified carries no frequency, no phase and no links: the reflection
surface, the wheel and the invitation engine all read it as absence rather than
as writing. Creek's remedy is a batch pass — classify everything, then link it
three ways — and this table is adepthood's memory of having driven it.

**A rung is a row because "how long since" is a question, and a question needs
rows.** The pass is triggered from two request paths that run on ordinary user
activity, so the thing that keeps it from running on every journal save is a
per-stage interval, and an interval can only be measured against a stamp that
outlives the request that wrote it. A log line outlives nothing that can be
compared: it is retained for a window, it cannot be read back by the code that
has to decide, and no surface can query it.

**The row is content-free.** A stage name, an outcome, three counts and an
instant. Nothing from any fragment, nothing from any document, and nothing a
reader could reconstruct one from — which is not a discipline this table imposes
on itself so much as one it inherits: Creek's two pipeline responses publish
counts and *nothing else*, no id, no path, no title, no excerpt, not even an
error string, precisely so that a pass running over the whole vault can be
reported to a caller admitted to only part of it. The three counts here are the
widest thing those responses say, and they are still only numbers.

**Every attempt writes a row, including the failures.** That is the opposite of
the ``corpussweep`` rule one table over, and deliberately so: a sweep that
reached nothing writes nothing there, because that log answers "how much of my
writing was reached". This one answers "when was this stage last *attempted*",
and a failure that left no stamp would be retried on the very next request —
turning a vault that is refusing one stage into a request-rate loop against it.
Recording the attempt is what makes standing down possible.

It is also what keeps a persistently failing stage from starving the ones behind
it. The ladder is climbed in order, so a stage that fails every time would be
retried ahead of its successors forever; because its failure sets its own stamp,
its interval closes and the next attempt skips it and reaches the rung below.

**The instant is declared zoned.** Comparing these rows against a clock is the
entire use of them, and that comparison is made by different requests in
different processes, so an unzoned answer would leave the deciding code to guess
which zone the deployment was in. ``DateTime(timezone=True)``, the declaration
``corpussweep`` makes, so the two can be read against each other.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, SQLModel

from domain.creek_vault import VaultPipelineStage

# A stage reaches fragments or it reaches none; it cannot reach a negative
# number of them, and a negative count would read as a sentinel nobody defined.
_MIN_FRAGMENTS = 0

# Symbolic tokens from closed sets, never prose. The CHECKs below pin which, and
# the widths are the ``corpusconsentevent`` convention rather than a measurement
# of today's longest member: a column sized to the current vocabulary is one that
# has to be migrated the first time a member is renamed.
_STAGE_WIDTH = 20
_OUTCOME_WIDTH = 20


class VaultPipelineOutcome(enum.StrEnum):
    """How one attempted rung ended.

    Three members, and the middle one is the reason there are not two.
    ``INCOMPLETE`` is Creek's ``complete: false`` — a classification pass that
    skipped some fragments — and it is neither a success nor a failure: the pass
    is resumable, so it means the honest next step is to call again, while the
    labels it did write are real and the stages that read them may run. Folding
    it into ``COMPLETED`` would lose the reason to come back; folding it into
    ``FAILED`` would stand down a stage that in fact did most of its work.

    Values are stored, so they are a persisted vocabulary and must not be
    reworded without a migration.

    Attributes:
        ATTEMPTED: The row was written and committed *before* the vault was
            dialled, and no answer has replaced it yet. It is what makes the
            stamp visible to a concurrent request while the call is still in
            flight -- without it, every request arriving during one pass reads
            an empty log and dials the vault too. A row left in this state is a
            process that died mid-call, and it is read as "attempted, outcome
            unknown": it holds the interval closed, and it does not count as a
            classification having landed.
        COMPLETED: The vault ran the stage and reported it clean.
        INCOMPLETE: The vault ran the stage and reported that some fragments
            were skipped. Only a classification pass can report this; the linker
            has no per-fragment error accumulator to collapse.
        FAILED: The stage did not land — refused, unreachable, out of time, or
            answered in a shape adepthood would not read.
    """

    ATTEMPTED = "attempted"
    COMPLETED = "completed"
    INCOMPLETE = "incomplete"
    FAILED = "failed"


def _quoted(values: tuple[str, ...]) -> str:
    """Render enum values as the quoted SQL literal list a CHECK reads."""
    return ", ".join(f"'{value}'" for value in values)


def _stage_check() -> CheckConstraint:
    """CHECK that a row names a rung of the ladder and not some other word."""
    return CheckConstraint(
        f"stage IN ({_quoted(tuple(stage.value for stage in VaultPipelineStage))})",
        name="ck_vaultpipelinerun_stage_valid",
    )


def _outcome_check() -> CheckConstraint:
    """CHECK that a row names one of the three ways a rung can end."""
    return CheckConstraint(
        f"outcome IN ({_quoted(tuple(outcome.value for outcome in VaultPipelineOutcome))})",
        name="ck_vaultpipelinerun_outcome_valid",
    )


def _fragments_seen_check() -> CheckConstraint:
    """CHECK that the number of fragments a stage looked at is a count."""
    return CheckConstraint(
        f"fragments_seen >= {_MIN_FRAGMENTS}",
        name="ck_vaultpipelinerun_fragments_seen_range",
    )


def _fragments_touched_check() -> CheckConstraint:
    """CHECK that the number of fragments a stage acted on is a count."""
    return CheckConstraint(
        f"fragments_touched >= {_MIN_FRAGMENTS}",
        name="ck_vaultpipelinerun_fragments_touched_range",
    )


def _fragments_lost_check() -> CheckConstraint:
    """CHECK that the number of fragments a stage dropped is a count."""
    return CheckConstraint(
        f"fragments_lost >= {_MIN_FRAGMENTS}",
        name="ck_vaultpipelinerun_fragments_lost_range",
    )


class VaultPipelineRun(SQLModel, table=True):
    """One attempt at one stage of the vault ontologization ladder.

    The three counts are the two pipeline responses read through one vocabulary,
    because the scheduler that writes them does not care which route answered.
    For a classification pass they are fragments visited, fragments whose
    frontmatter was rewritten, and zero — that pass loses nothing. For a linker
    stage they are fragments loaded, links (or eddies, or threads) emitted, and
    fragments dropped to noise because their cluster stayed oversized after the
    split budget was spent.

    ``fragments_lost`` is the one worth reading twice. Creek publishes it rather
    than folding it away because a caller who cannot see it reads a lossy pass as
    a clean one, and it is kept here for the same reason: those fragments carry
    no link at all, and a corpus quietly missing some of its threads is exactly
    the failure this whole table exists to make visible.

    ``user_id`` and not a vault url, because the account is what the ladder is
    driven on behalf of and what the interval is measured per. It is also the
    only key that covers both kinds of vault this deployment can reach: an
    account with its own connection has a ``uservaultconfig`` row, and the owner
    of a deployment-wide vault has none, so a stamp hung off that table would
    silently exempt the second from every interval it defines.
    """

    __tablename__ = "vaultpipelinerun"

    # The read is always "this account's attempts at this stage, newest first",
    # so the index carries the filter, the discriminator and the ordering key and
    # answers it in one scan. ``user_id`` deliberately carries no index of its
    # own: the composite covers it as a prefix, and a second index over the same
    # column would be paid for on every insert to serve a query the first one
    # already serves. Declared here as well as in the migration so
    # ``alembic check`` sees no drift.
    __table_args__ = (
        Index("ix_vaultpipelinerun_user_id_stage_id", "user_id", "stage", "id"),
        _stage_check(),
        _outcome_check(),
        _fragments_seen_check(),
        _fragments_touched_check(),
        _fragments_lost_check(),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    stage: str = Field(max_length=_STAGE_WIDTH)
    outcome: str = Field(max_length=_OUTCOME_WIDTH)
    fragments_seen: int = Field(nullable=False)
    fragments_touched: int = Field(nullable=False)
    fragments_lost: int = Field(nullable=False)
    ran_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
