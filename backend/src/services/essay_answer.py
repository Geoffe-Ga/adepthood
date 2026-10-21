"""The essay route's answer: one note, the wallet it left behind, and care when owed.

Split out of :mod:`routers.journal` so the router stays within its
maintainability budget. A read only: nothing here charges, dials or commits.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from domain.care import build_care_payload
from models.marginalia import Marginalia
from schemas.marginalia import EssayResponse
from services import demo_visibility
from services.creek_vault_letters import LetterEscalation
from services.resonance_care import care_surface
from services.usage import get_monthly_cap
from services.wallet import require_user_fresh, reset_monthly_usage_if_due

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True, slots=True)
class LetterToMirror:
    """An app-provider letter just cached on ``cached``, still owed its one mirror."""

    cached: Marginalia
    essay: str


def letter_to_mirror(cached: Marginalia) -> Marginalia | LetterToMirror:
    """The app-provider letter ``cached`` now holds, as owed its mirror, or the bare note.

    A completion refused as not a letter leaves ``essay`` unset, and a stored
    demo letter a refused regeneration left in the row must never reach the
    vault (#3096): either way there is nothing to mirror.
    """
    essay = demo_visibility.served_letter(cached)
    return cached if essay is None else LetterToMirror(cached, essay)


async def essay_response(
    session: AsyncSession, answered: Marginalia | LetterEscalation
) -> EssayResponse:
    """Wrap the answered note with the owner's balances, computed as ``/user/usage`` does.

    The monthly rollover is applied inside the session so a stale counter is
    never reported, but it is not committed here -- the same discipline as
    ``GET /user/usage`` (BUG-BM-015).

    ``care`` is set only for a :class:`LetterEscalation`: the vault's care guard
    answered instead of a letter, so the writer gets adepthood's own reviewed
    care surface -- the one a resonance escalation returns, never the vault's
    prose (#3380).
    """
    note: Marginalia = answered if isinstance(answered, Marginalia) else answered.note
    care = None
    if isinstance(answered, LetterEscalation):
        care = care_surface(build_care_payload())
    await reset_monthly_usage_if_due(session, note.user_id, datetime.now(UTC))
    user = await require_user_fresh(session, note.user_id)
    return EssayResponse(
        **demo_visibility.served_note(note).model_dump(),
        remaining_messages=max(get_monthly_cap() - user.monthly_messages_used, 0),
        remaining_balance=user.offering_balance,
        monthly_reset_date=user.monthly_reset_date,
        care=care,
    )
