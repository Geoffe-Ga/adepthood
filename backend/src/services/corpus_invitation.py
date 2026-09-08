"""Whether to offer the corpus decision now, and the record of having asked.

:mod:`domain.corpus_invitation` owns the rule; this module owns the reads and
writes the rule needs and nothing else. Three operations, with three different
relationships to the transaction:

**Recording a completed pass commits nothing.** It is called from inside the
resonance settlement -- the post-dial transaction in
:mod:`routers.journal` -- and stages one atomic ``UPDATE ... SET n = n + 1``
there, so the count lands with the notes and the usage row or not at all. A
pass that fails after the dials is refunded and rolled back, and the count goes
with it: a person is never counted as having completed a reflection they never
received. The increment is an UPDATE against the column rather than a
read-modify-write in Python, so two passes settling at once cannot lose one.

**Asking whether to offer writes nothing.** An account that has completed no
pass has no row, and ``GET`` must not provision one -- a read that writes is a
read that needs a commit, and the route that serves it has none.

**Declining provisions if it must, then updates in place.** Provisioning is
one ``INSERT ... ON CONFLICT (user_id) DO NOTHING`` against the unique owner
index rather than the SAVEPOINT-and-``IntegrityError`` shape
:func:`domain.ui_flags.ensure_ui_flags` uses. Two reasons, both about the
transaction this runs inside. A conflict answered by the database is not an
error, so a lost race cannot poison the settlement's open transaction the way
a caught ``IntegrityError`` does on PostgreSQL without a SAVEPOINT. And a
SAVEPOINT is exactly what this must not lean on: the SQLite driver the test
suite runs under releases an outermost SAVEPOINT as a *commit*, so a count
provisioned that way would survive the rollback that a refunded pass performs
-- the one outcome the first paragraph promises cannot happen. The statement is
spelled per dialect because SQLAlchemy exposes the clause per dialect; the
semantics are identical.

Consent is read through :func:`services.corpus_consent.load_consent` rather
than by consulting the event table here, for the reason
:func:`services.voice_readiness.load_voice_readiness` gives: that function owns
what an unanswered account has agreed to, and the predicate here needs only
whether the account has *decided*, which is ``decided_at``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.base import Executable
from sqlmodel import col, select, update

from domain.corpus_invitation import InvitationFacts, should_offer
from domain.dates import ensure_aware
from models.corpus_fragment import CorpusSource
from models.corpus_invitation_state import CorpusInvitationState
from services.corpus_consent import load_consent

#: The source the invitation is about. The Resonance moment is about the
#: journal, and the journal is the only source the pass could have drawn on.
INVITATION_SOURCE = CorpusSource.JOURNAL


@dataclass(frozen=True)
class InvitationOffer:
    """What the client is told: whether to show the note, and what it last chose.

    No count crosses this boundary. ``completed_passes`` is a fact the cooldown
    is computed from, and a number on an invitation turns it into a meter.
    """

    offer: bool
    dismissed_at: datetime | None
    do_not_ask_again: bool


async def _load_state(session: AsyncSession, user_id: int) -> CorpusInvitationState | None:
    """The account's row, read fresh from the database, or ``None``.

    ``populate_existing`` because the writers below use core UPDATEs, and an
    object already in the identity map would otherwise answer with the values
    it had before them.
    """
    result = await session.execute(
        select(CorpusInvitationState)
        .where(col(CorpusInvitationState.user_id) == user_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().first()


#: The columns the provisioning insert may conflict on: the unique owner index.
_OWNER_INDEX_ELEMENTS = ("user_id",)

#: The one dialect whose ``INSERT ... ON CONFLICT`` SQLAlchemy spells separately
#: from PostgreSQL's. Every other bind gets the PostgreSQL construct.
_SQLITE = "sqlite"


def _provisioning_insert(dialect_name: str, user_id: int) -> Executable:
    """``INSERT ... ON CONFLICT (user_id) DO NOTHING`` for the bound dialect.

    A quiet row -- every other column takes its server default -- that is a
    no-op when the account already has one. The database answers the race, so
    two first passes settling at once produce one row and no error.
    """
    if dialect_name == _SQLITE:
        return (
            sqlite_insert(CorpusInvitationState)
            .values(user_id=user_id)
            .on_conflict_do_nothing(index_elements=_OWNER_INDEX_ELEMENTS)
        )
    return (
        pg_insert(CorpusInvitationState)
        .values(user_id=user_id)
        .on_conflict_do_nothing(index_elements=_OWNER_INDEX_ELEMENTS)
    )


async def _provision_state(session: AsyncSession, user_id: int) -> None:
    """Make sure ``user_id`` has a row, without committing and without a SAVEPOINT."""
    dialect_name = session.get_bind().dialect.name
    await session.execute(_provisioning_insert(dialect_name, user_id))


async def record_completed_pass(session: AsyncSession, *, user_id: int) -> None:
    """Count one completed, non-intimate Resonance pass for ``user_id``.

    Staged in the caller's transaction and never committed here. The caller is
    the resonance settlement, whose commit is the one that makes the pass real.
    """
    await _provision_state(session, user_id)
    await session.execute(
        update(CorpusInvitationState)
        .where(col(CorpusInvitationState.user_id) == user_id)
        .values(completed_passes=col(CorpusInvitationState.completed_passes) + 1)
        .execution_options(synchronize_session=False)
    )


def _facts_of(state: CorpusInvitationState | None, *, consent_decided: bool) -> InvitationFacts:
    """Project a row, or its absence, onto what the rule reads."""
    if state is None:
        return InvitationFacts(
            consent_decided=consent_decided,
            completed_passes=0,
            dismissed_at=None,
            passes_at_dismissal=0,
            do_not_ask_again=False,
        )
    return InvitationFacts(
        consent_decided=consent_decided,
        completed_passes=state.completed_passes,
        dismissed_at=state.dismissed_at,
        passes_at_dismissal=state.passes_at_dismissal,
        do_not_ask_again=state.do_not_ask_again,
    )


async def load_invitation(
    session: AsyncSession, *, user_id: int, now: datetime | None = None
) -> InvitationOffer:
    """Whether to offer ``user_id`` the corpus decision right now.

    Two reads and no write: the account's row, if it has one, and the journal
    source's consent state. ``now`` is injectable so the cooldown is testable
    without a clock; a caller that passes nothing gets the present.
    """
    state = await _load_state(session, user_id)
    consent = await load_consent(session, user_id=user_id, source=INVITATION_SOURCE)
    facts = _facts_of(state, consent_decided=consent.decided_at is not None)
    dismissed_at = None if facts.dismissed_at is None else ensure_aware(facts.dismissed_at)
    return InvitationOffer(
        offer=should_offer(facts, now=now or datetime.now(UTC)),
        dismissed_at=dismissed_at,
        do_not_ask_again=facts.do_not_ask_again,
    )


async def dismiss_invitation(
    session: AsyncSession,
    *,
    user_id: int,
    do_not_ask_again: bool,
    now: datetime | None = None,
) -> InvitationOffer:
    """Record that ``user_id`` set the invitation aside, and report the result.

    Stamps the instant and the pass count in the same UPDATE, so the cooldown's
    two floors are measured from one moment. ``do_not_ask_again`` is only ever
    set, never cleared: a later "Not now" from a person who already asked not
    to be asked is answered with silence, not with a reopened question. The
    caller owns the commit.
    """
    await _provision_state(session, user_id)
    moment = now or datetime.now(UTC)
    values: dict[str, object] = {
        "dismissed_at": moment,
        "passes_at_dismissal": col(CorpusInvitationState.completed_passes),
    }
    if do_not_ask_again:
        values["do_not_ask_again"] = True
    await session.execute(
        update(CorpusInvitationState)
        .where(col(CorpusInvitationState.user_id) == user_id)
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    return await load_invitation(session, user_id=user_id, now=moment)
