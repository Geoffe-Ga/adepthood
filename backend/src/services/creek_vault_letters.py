"""Vault-written letters: a vault-bound writer's first letter comes from their own vault (#3203).

#3183 made a :attr:`~services.reflection_boundary.ReflectionBoundary.VAULT_BOUND`
writer's letter fail closed, because the app provider was the only thing that
could write one. Creek's contract 0.17 publishes ``letters``: the vault writes
one margin note's letter itself, under its own tier-routed generation, and keeps
it as an AI-attributed Voice Draft. This module is adepthood's half of that call
and holds nothing that can reach the app provider -- there is no fallback to
express.

Two rules shape it.

* **No letter the app cannot withdraw.** The vault stores what it writes, so a
  letter is a Voice Draft the moment it exists. The content-free intent row of
  :mod:`services.creek_vault_voice_drafts` is committed *before* the call, under
  the same external id a mirrored draft uses, so an Intimate reclassification or
  a journal deletion owes -- and retries until confirmed -- the withdrawal of a
  vault-written letter exactly as it does a mirrored one, even when the answer
  was lost. A vault that does not also serve ``voice-drafts`` could hold a
  letter adepthood can never retract, so it is not asked at all.
* **Closed outcomes, no content in logs.** Every way the call ends is one member
  of :class:`VaultLetterOutcome`; log records carry the external id, an outcome
  word and the vault's store action, never the entry, the note or the letter.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final, cast

from sqlalchemy.ext.asyncio import AsyncSession

from domain.creek_vault import (
    CreekCapability,
    CreekVaultCareEscalationError,
    CreekVaultError,
    CreekVaultLetterClient,
    VaultLetterRequest,
    VaultSendSuspendedError,
    tier_ceiling_for,
)
from domain.privacy_tier import admits_egress
from domain.resonance import accept_vault_letter
from models.journal_entry import JournalEntry
from services.creek_vault_voice_drafts import (
    drop_staged_mirror_intent,
    stage_mirror_intent,
    voice_draft_external_id,
)
from services.privacy_lineage import LineageOperation, observe_entry_lineage
from services.reflection_boundary import VaultSourceUnavailableReason

_LOGGER = logging.getLogger(__name__)

_LETTER_WRITTEN_EVENT: Final = "creek vault letter written"
_LETTER_DEGRADED_EVENT: Final = "creek vault letter degraded"
_LETTER_WITHHELD_EVENT: Final = "creek vault letter withheld"
_LETTER_SUSPENDED_EVENT: Final = "creek vault letter suspended"
_LETTER_ESCALATED_EVENT: Final = "creek vault letter care escalation"

#: Every ``extra`` key this module logs: an opaque id and closed vocabularies.
LETTER_LOG_EXTRAS: Final = frozenset({"external_id", "reason", "action"})


class VaultLetterOutcome(StrEnum):
    """How one vault letter request ended -- a closed vocabulary that carries no content."""

    WRITTEN = "written"  # the vault wrote and stored a letter this app may cache
    NOT_OFFERED = "not_offered"  # the entry's tier may not reach any vault: nothing sent
    WITHHELD = "withheld"  # a withdrawal is still owed at this id: nothing sent
    SUSPENDED = "suspended"  # the operator's vault-send switch refused it before the wire
    ESCALATED = "escalated"  # the vault's care guard answered instead of a letter
    FAILED = "failed"  # refused, unreadable, unreachable, or not a letter


@dataclass(frozen=True)
class VaultLetterAnswer:
    """One request's outcome, and the letter only when it was written."""

    outcome: VaultLetterOutcome
    letter: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class LetterAsk:
    """The margin note a letter expands, its entry, and whose they are.

    ``body`` is the sanitized entry text; ``note`` / ``anchor_text`` / ``kind``
    are the stored margin note. Prose fields stay out of ``repr()``.
    """

    owner_user_id: int
    marginalia_id: int
    body: str = field(repr=False)
    note: str = field(repr=False)
    anchor_text: str = field(repr=False)
    kind: str
    classification: str


async def vault_letter_refusal(
    client: CreekVaultLetterClient,
) -> VaultSourceUnavailableReason | None:
    """Negotiate once; ``None`` when this vault can write a letter, else why it cannot.

    Content-free: only the handshake is dialled. ``letters`` alone is not
    enough -- the letter becomes a Voice Draft, and one this app could not
    retract through ``voice-drafts`` must never be written.
    """
    try:
        handshake = await client.handshake()
    except CreekVaultError:
        return VaultSourceUnavailableReason.UNAVAILABLE
    if not handshake.available:
        return VaultSourceUnavailableReason.UNAVAILABLE
    if not (
        client.supports(CreekCapability.LETTERS) and client.supports(CreekCapability.VOICE_DRAFTS)
    ):
        return VaultSourceUnavailableReason.CAPABILITY_MISSING
    return None


async def write_vault_letter(
    session: AsyncSession,
    client: CreekVaultLetterClient,
    ask: LetterAsk,
    *,
    entry: JournalEntry,
    destination: str | None,
) -> VaultLetterAnswer:
    """Record the offer, ask the vault for the letter, and report how it ended.

    The tier is decided first from the persisted classification, so an entry
    outside the egress allowlist is never put on a request at all. The intent
    row is committed before the call -- it answers ``None`` while an earlier
    withdrawal at this id is still owed, and the letter is then withheld rather
    than written over that obligation. A request the operator's vault-send
    suspension refused never left the process, so its intent is dropped; every
    other request that staged one keeps it and is counted as a Voice Draft
    egress, a raise or a cancellation included -- the safe direction.

    Must run under the caller's account hold and this entry's
    :data:`~services.voice_draft_privacy.voice_draft_privacy` hold, the same
    nesting the mirror uses, so a privacy PATCH or a DELETE either lands before
    the call (and the caller's re-read stops it) or after (and retracts it).
    """
    if not admits_egress(ask.classification):
        return VaultLetterAnswer(VaultLetterOutcome.NOT_OFFERED)
    external_id = voice_draft_external_id(ask.owner_user_id, ask.marginalia_id)
    staged = await stage_mirror_intent(
        session,
        user_id=ask.owner_user_id,
        entry_id=cast("int", entry.id),
        marginalia_id=ask.marginalia_id,
        destination=destination,
    )
    if staged is None:
        _LOGGER.warning(
            _LETTER_WITHHELD_EVENT,
            extra={"external_id": external_id, "reason": "withdrawal_outstanding"},
        )
        return VaultLetterAnswer(VaultLetterOutcome.WITHHELD)
    answer = await _dial_and_count(session, client, _letter_request(external_id, ask), entry)
    if answer.outcome is VaultLetterOutcome.SUSPENDED:
        await drop_staged_mirror_intent(session, staged)
    return answer


def _letter_request(external_id: str, ask: LetterAsk) -> VaultLetterRequest:
    """The wire request for ``ask``, at the tier its persisted classification maps to."""
    return VaultLetterRequest(
        external_id=external_id,
        content=ask.body,
        note=ask.note,
        anchor_text=ask.anchor_text,
        kind=ask.kind,
        tier=tier_ceiling_for(ask.classification),
    )


async def _dial_and_count(
    session: AsyncSession,
    client: CreekVaultLetterClient,
    request: VaultLetterRequest,
    entry: JournalEntry,
) -> VaultLetterAnswer:
    """Make the call and count its Voice Draft egress unless it provably never left.

    A raise or a cancellation is counted too: the request may have been on the
    wire, and counting it is the safe direction for an egress log.
    """
    answer: VaultLetterAnswer | None = None
    try:
        answer = await _dial_letter(client, request)
    finally:
        if answer is None or answer.outcome is not VaultLetterOutcome.SUSPENDED:
            await observe_entry_lineage(session, LineageOperation.VOICE_DRAFT_MIRROR, entry)
            await session.commit()
    return answer


async def _dial_letter(
    client: CreekVaultLetterClient, request: VaultLetterRequest
) -> VaultLetterAnswer:
    """Make the one call and map every ending onto a closed outcome; never raises a vault error.

    :class:`VaultSendSuspendedError` is matched first: it proves nothing left
    the server, which is what lets the caller drop the intent. A care
    escalation is a published answer, not a fault, and is reported as such.
    """
    external_id = request.external_id
    try:
        written = await client.write_letter(request)
    except VaultSendSuspendedError:
        _LOGGER.info(_LETTER_SUSPENDED_EVENT, extra={"external_id": external_id})
        return VaultLetterAnswer(VaultLetterOutcome.SUSPENDED)
    except CreekVaultCareEscalationError:
        _LOGGER.warning(_LETTER_ESCALATED_EVENT, extra={"external_id": external_id})
        return VaultLetterAnswer(VaultLetterOutcome.ESCALATED)
    except CreekVaultError:
        _LOGGER.warning(
            _LETTER_DEGRADED_EVENT, extra={"external_id": external_id, "reason": "vault_error"}
        )
        return VaultLetterAnswer(VaultLetterOutcome.FAILED)
    letter = accept_vault_letter(written.letter)
    if letter is None:
        _LOGGER.warning(
            _LETTER_DEGRADED_EVENT, extra={"external_id": external_id, "reason": "not_a_letter"}
        )
        return VaultLetterAnswer(VaultLetterOutcome.FAILED)
    _LOGGER.info(
        _LETTER_WRITTEN_EVENT, extra={"external_id": external_id, "action": written.action.value}
    )
    return VaultLetterAnswer(VaultLetterOutcome.WRITTEN, letter)
