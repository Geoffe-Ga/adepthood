"""Order one account's outbound writes against its own erasure.

The per-entry serializer in :mod:`services.voice_draft_privacy` makes one
journal entry's Creek mutations agree on an order. It cannot help with the
account-shaped question, because the two racing requests are not about the same
entry: a journal write that is already inside ``ingest()`` and a
``DELETE /users/me`` share nothing but an account id. Without an ordering on
that id, the receipt that says "erased" can be followed by this account's
plaintext being handed to Creek -- measured, and the reason this module exists.

**What takes the barrier.** Every path that transmits content adepthood has
*stored for this account*: the journal write, update, delete, resonance and
essay-mirror routes, ``POST /corpus/import``, ``PUT /corpus/consent/{source}``
on the grant path, the teardown side of ``DELETE /users/me``, and -- the one no
request-scoped guard can reach -- the detached pipeline continuation in
:mod:`services.creek_vault_pipeline`, which opens its own session and dials
Creek after the request that scheduled it has returned.

**What deliberately does not.** Paths that only *read* from the vault
(``GET /stages/wheel``, ``GET /invitations``) and paths carrying only bytes
supplied in the same request (``POST /journal/transcribe-page``). Neither can
expose stored content after an erasure, and serializing the first two would cost
the app's two hottest authenticated reads for no confidentiality gain. The rule,
stated once so a future boundary is classified without re-litigation: *take the
barrier where a path transmits content adepthood has stored for this account;
exclude paths that only read from the vault or that carry only bytes supplied in
the same request.*

**The asymmetry.** When the cross-worker lock connection cannot be established
at all, an egress site refuses (``on_unavailable="refuse"``) and
``DELETE /users/me`` still erases (``on_unavailable="proceed"``). Erasure only
ever reduces exposure, so it must never be blocked by the ordering mechanism;
egress only ever increases it, so it must never proceed unordered.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import StrEnum
from typing import Final

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.user import User
from services.advisory_lock_namespaces import ACCOUNT_EGRESS_LOCK_NAMESPACE
from services.voice_draft_privacy import OnUnavailable, VoiceDraftPrivacySerializer

_LOGGER = logging.getLogger(__name__)

#: A **second instance**, never the ``voice_draft_privacy`` singleton. Sharing it
#: would give ``user_id 7`` and ``entry_id 7`` one ``asyncio.Lock`` and one
#: advisory key, which self-deadlocks the account-outer / entry-inner nesting
#: that every journal egress site uses.
account_egress_barrier = VoiceDraftPrivacySerializer(namespace=ACCOUNT_EGRESS_LOCK_NAMESPACE)

ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR: Final[str] = "ACCOUNT_EGRESS_BARRIER_CROSS_WORKER_ENABLED"

_TRUE_VALUES: Final[frozenset[str]] = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES: Final[frozenset[str]] = frozenset({"0", "false", "no", "off"})

_POSTGRESQL_DIALECT: Final[str] = "postgresql"

#: The one condition that makes an enabled barrier incomplete rather than ready:
#: the cross-worker half is PostgreSQL-only, so any other dialect leaves a
#: multi-worker deployment ordered *within* each worker and nowhere else.
NOT_POSTGRESQL_DEFECT: Final[str] = "database_is_not_postgresql"

#: The uniform 401 detail every ``get_current_user`` route answers with. Pinned
#: here rather than spelled at each raise so the barrier cannot drift away from
#: ``routers.auth.get_current_user``'s documented rule that *all* rejection
#: scenarios look identical (OWASP A07:2021, sec-04).
UNAUTHORIZED_DETAIL: Final[str] = "unauthorized"


class EgressBarrierState(StrEnum):
    """Operator-visible state of the barrier's cross-worker half."""

    DISABLED = "disabled"
    INCOMPLETE = "incomplete"
    READY = "ready"


@dataclass(frozen=True, slots=True)
class EgressBarrierRollout:
    """One immutable reading of the current deployment settings.

    ``DISABLED`` suppresses **only** the PostgreSQL advisory statements. The
    in-process lock is taken either way, so no setting available to an operator
    can remove the ordering property inside a worker -- the switch trades
    cross-worker ordering for the ability to run a mixed-version fleet, and
    nothing else.
    """

    state: EgressBarrierState
    defects: tuple[str, ...] = ()

    @property
    def orders_across_workers(self) -> bool:
        """Whether this reading actually serializes two workers, not just two tasks."""
        return self.state is EgressBarrierState.READY


def _parse_enabled() -> bool | None:
    """Read the switch: unset means on, and an unreadable value means neither."""
    raw = os.getenv(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR, "").strip().lower()
    if not raw or raw in _TRUE_VALUES:
        return True
    if raw in _FALSE_VALUES:
        return False
    return None


def load_egress_barrier_rollout(dialect_name: str) -> EgressBarrierRollout:
    """Interpret the current settings for one database dialect, secret-free.

    ``dialect_name`` is passed in rather than read from a global because the
    answer genuinely differs per deployment and the readiness probe already
    holds the session that knows it.
    """
    enabled = _parse_enabled()
    if enabled is None:
        return EgressBarrierRollout(
            EgressBarrierState.INCOMPLETE,
            defects=(ACCOUNT_EGRESS_BARRIER_ENABLED_ENV_VAR,),
        )
    if not enabled:
        return EgressBarrierRollout(EgressBarrierState.DISABLED)
    if dialect_name != _POSTGRESQL_DIALECT:
        return EgressBarrierRollout(
            EgressBarrierState.INCOMPLETE,
            defects=(NOT_POSTGRESQL_DEFECT,),
        )
    return EgressBarrierRollout(EgressBarrierState.READY)


def rollout_for(session: AsyncSession) -> EgressBarrierRollout:
    """Read the rollout against the dialect this session is actually bound to."""
    return load_egress_barrier_rollout(session.get_bind().dialect.name)


async def account_is_live(session: AsyncSession, user_id: int) -> bool:
    """Whether this account still exists, undeleted and enabled.

    The boolean half of the liveness read, for the caller that has no request to
    refuse: the detached pipeline continuation stands down on a false rather
    than raising a status code nobody will ever receive.

    The commit is what keeps a pooled connection out of the caller's outbound
    call, and it is unconditional for the reason
    :func:`routers.journal._record_corpus_fragment`'s is: the read autobegins a
    transaction either way, and an open transaction is a checked-out connection
    that would then be held for the length of a Creek round trip. Every caller
    takes this barrier with its own work already committed, so what this ends is
    only the transaction this read opened.
    """
    live = await session.execute(
        select(col(User.id)).where(
            col(User.id) == user_id,
            col(User.deleted_at).is_(None),
            col(User.is_active).is_(True),
        )
    )
    found = live.scalars().first() is not None
    await session.commit()
    return found


async def ensure_account_live(session: AsyncSession, user_id: int) -> None:
    """Refuse a request whose account stopped existing while it was in flight.

    Raises the same ``401 unauthorized`` that
    :func:`routers.auth.get_current_user` answers every rejection with, because
    this is that check arriving late rather than a different one: a request that
    *started* after the erasure is refused there, and this is the request that
    was already past it. The alternative observed at HEAD was a 500 from
    refreshing a swept row, or a 201 carrying an entry nobody owns.

    Called as the first statement inside the barrier, so the answer is read
    under the same ordering that stops the egress.
    """
    if not await account_is_live(session, user_id):
        _LOGGER.info("egress refused for an account that no longer exists")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=UNAUTHORIZED_DETAIL)


@asynccontextmanager
async def hold_account(
    session: AsyncSession,
    user_id: int,
    *,
    on_unavailable: OnUnavailable = "refuse",
) -> AsyncIterator[None]:
    """Order this account's egress against its own erasure, for one region.

    Held by the handler around the outbound call rather than for the whole
    request, so a user on a slow vault cannot make their own deletion wait out
    the vault's whole-request deadline. Where a journal site also takes the
    per-entry serializer, the account barrier is the **outer** of the two, and
    that ordering is fixed: account outermost, entry innermost, everywhere.
    """
    async with account_egress_barrier.hold(
        session,
        user_id,
        on_unavailable=on_unavailable,
        cross_worker=rollout_for(session).orders_across_workers,
    ):
        yield
