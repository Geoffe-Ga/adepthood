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
* **A care escalation is care, and owes nothing.** Creek's ``letters``
  capability publishes a 200 care-escalation cell: the vault's acute-distress
  guard answered instead of writing, so nothing was stored. The writer is
  answered with adepthood's own reviewed care surface (#3380) -- never Creek's
  prose -- and the staged intent is released, as a suspended send's is, so no
  withdrawal of a letter that never existed is owed (#3379).
* **Closed outcomes, no content in logs.** Every way the call ends is one member
  of :class:`VaultLetterOutcome`; log records carry the external id, an outcome
  word and the vault's store action, never the entry, the note or the letter.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final, cast

from sqlalchemy.ext.asyncio import AsyncSession

from domain.creek_vault import (
    CreekCapability,
    CreekVaultCareEscalationError,
    CreekVaultError,
    CreekVaultLetterClient,
    VaultKeyProvider,
    VaultLetter,
    VaultLetterRequest,
    VaultSendSuspendedError,
    spent_request_key,
    tier_ceiling_for,
)
from domain.privacy_tier import admits_egress
from domain.resonance import accept_vault_letter
from errors import service_unavailable
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia
from services.creek_vault_relay import forwarded_key_vendor
from services.creek_vault_voice_drafts import (
    drop_staged_mirror_intent,
    stage_mirror_intent,
    voice_draft_external_id,
)
from services.llm_usage import GenerationFeature
from services.privacy_lineage import LineageOperation, observe_entry_lineage
from services.reflection_boundary import (
    REFLECTION_SOURCE_UNAVAILABLE,
    ReflectionBoundary,
    VaultSourceUnavailableReason,
)
from services.voice_draft_privacy import voice_draft_privacy

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


#: The endings that provably left no letter in the vault, so the intent staged for
#: one is released: a suspended send never left the server, and a care
#: escalation is Creek's published answer *instead of* a letter -- a 2xx document
#: carrying no fragment id, so nothing was written under this external id. Every
#: other ending (a refusal, an outage, an unreadable answer) may have lost the
#: answer to a stored letter, and keeps the intent owed.
_NOTHING_STORED_OUTCOMES: Final = frozenset(
    {VaultLetterOutcome.SUSPENDED, VaultLetterOutcome.ESCALATED}
)


@dataclass(frozen=True)
class LetterEscalation:
    """A letter ask the vault's care guard answered instead: the note, still without one.

    Returned rather than the bare note so the route answers it with adepthood's
    reviewed care surface (#3380); it carries no content of the vault's.
    """

    note: Marginalia


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
    suspension refused never left the process, and one the vault's care guard
    answered stored nothing, so either intent is dropped (#3379); every other
    request that staged one keeps it. Every request but the suspended one is
    counted as a Voice Draft egress, a raise or a cancellation included -- the
    safe direction.

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
    if answer.outcome in _NOTHING_STORED_OUTCOMES:
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


def _key_not_spent(written: VaultLetter, relayed_vendor: VaultKeyProvider | None) -> bool:
    """Whether a relayed key was to pay for ``written`` and, by the vault's receipt, did not.

    An ``unchanged`` letter is re-read without a model call and carries no
    receipt, so it is held to the same rule: a stored letter the key never paid
    for is not handed out free on a second ask.
    """
    return relayed_vendor is not None and spent_request_key(written.inference_source) is not (
        relayed_vendor
    )


async def _dial_letter(
    client: CreekVaultLetterClient, request: VaultLetterRequest
) -> VaultLetterAnswer:
    """Make the one call and map every ending onto a closed outcome; never raises a vault error.

    :class:`VaultSendSuspendedError` is matched first: it proves nothing left
    the server, which is what lets the caller drop the intent. A care
    escalation is a published answer, not a fault, and is reported as such. A
    letter a relayed key was to pay for
    (:func:`~services.creek_vault_relay.forwarding_provider_key`) is ``FAILED``
    unless the vault's receipt says that key paid (#3483): it may be stored, so
    the intent stays owed, but it is never cached as one the writer got free.
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
    return _answer_written(written, external_id)


def _answer_written(written: VaultLetter, external_id: str) -> VaultLetterAnswer:
    """Map a letter the vault returned onto ``WRITTEN``, or ``FAILED`` with its reason word.

    Refused first when a relayed key was to pay and the receipt says it did not
    (#3483), then when the text is not a letter at all.
    """
    if _key_not_spent(written, forwarded_key_vendor()):
        return _degraded(external_id, "key_not_spent")
    letter = accept_vault_letter(written.letter)
    if letter is None:
        return _degraded(external_id, "not_a_letter")
    _LOGGER.info(
        _LETTER_WRITTEN_EVENT, extra={"external_id": external_id, "action": written.action.value}
    )
    return VaultLetterAnswer(VaultLetterOutcome.WRITTEN, letter)


def _degraded(external_id: str, reason: str) -> VaultLetterAnswer:
    """Log one content-free degrade under ``reason`` and answer ``FAILED``."""
    _LOGGER.warning(_LETTER_DEGRADED_EVENT, extra={"external_id": external_id, "reason": reason})
    return VaultLetterAnswer(VaultLetterOutcome.FAILED)


def log_letter_unavailable(note: Marginalia, reason: VaultSourceUnavailableReason) -> None:
    """One WARNING in a closed vocabulary: ids, the operation and the reason word.

    Never the body, a prompt, a key or a letter -- the reflection route's
    refusal record, under its token (#3156).
    """
    _LOGGER.warning(
        REFLECTION_SOURCE_UNAVAILABLE,
        extra={
            "user_id": note.user_id,
            "id": note.id,
            "operation": GenerationFeature.ESSAY.value,
            "reason": reason.value,
        },
    )


async def require_vault_letters(
    session: AsyncSession,
    note: Marginalia,
    client: CreekVaultLetterClient,
    boundary: ReflectionBoundary,
) -> None:
    """Admit a vault-bound writer's first letter only when their vault writes letters (#3203).

    A vault-bound writer's letter is written by their vault or not at all
    (#3156): the app provider is never asked, and a BYOK key changes none of it
    -- a key pays for a call, it does not consent to one. So a vault that is not
    available, or that does not advertise ``letters`` (and the ``voice-drafts``
    resource that retracts what it writes), is the reflection route's refusal:
    a 503 ``reflection_source_unavailable``, raised by the essay route ahead of
    its payer, price and guardrail gates, so nothing is staged, charged or
    dialled and ``essay`` stays ``NULL`` for a later ask -- #3183's fail-closed
    answer, unchanged.

    The commit releases the pooled connection the route's ownership reads
    opened before the handshake dials.

    Raises:
        HTTPException: The 503 ``reflection_source_unavailable``.
    """
    if boundary is not ReflectionBoundary.VAULT_BOUND:
        return
    await session.commit()
    reason = await vault_letter_refusal(client)
    if reason is None:
        return
    log_letter_unavailable(note, reason)
    raise service_unavailable(REFLECTION_SOURCE_UNAVAILABLE)


def letter_ask(note: Marginalia, entry: JournalEntry, body: str) -> LetterAsk:
    """What the vault is asked to expand: the note, its sanitized entry ``body``, and the tier."""
    return LetterAsk(
        owner_user_id=entry.user_id,
        marginalia_id=cast("int", note.id),
        body=body,
        note=note.note,
        anchor_text=note.anchor_text,
        kind=note.kind,
        classification=entry.classification,
    )


async def answer_vault_letter(
    session: AsyncSession, note: Marginalia, answer: VaultLetterAnswer
) -> Marginalia | LetterEscalation:
    """Answer a settled vault letter: the cached note, a no-letter answer, or a 503.

    The vault's care guard speaking instead is a :class:`LetterEscalation`, which
    the route answers with adepthood's reviewed care surface (#3380). A tier that
    admitted no vault at all is the bare note with no letter. Every failure -- a
    refused, unreadable or unreachable vault, an answer that was not a letter, a
    withheld or suspended request -- is #3183's refusal under its token. Never a
    fallback to the app provider.

    Raises:
        HTTPException: The 503 ``reflection_source_unavailable``.
    """
    if answer.letter is not None:
        await session.refresh(note)
        _LOGGER.info(
            "marginalia_essay_generated",
            extra={"user_id": note.user_id, "id": note.id, "prior_draft_count": 0},
        )
        return note
    if answer.outcome is VaultLetterOutcome.ESCALATED:
        return LetterEscalation(note)
    if answer.outcome is VaultLetterOutcome.NOT_OFFERED:
        return note
    log_letter_unavailable(note, VaultSourceUnavailableReason.NO_ANSWER)
    raise service_unavailable(REFLECTION_SOURCE_UNAVAILABLE)


@dataclass(frozen=True)
class VaultLetterSettlement:
    """Where a letter is offered, and how the caller keeps or refunds its charge.

    ``keep`` caches the letter and settles the charge in one commit; ``refund``
    compensates the charge. The economy is the route's (#623); this module only
    decides which of the two every ending owes.
    """

    entry: JournalEntry
    destination: str | None
    keep: Callable[[str], Awaitable[None]]
    refund: Callable[[], Awaitable[None]]


async def settle_vault_letter(
    session: AsyncSession,
    client: CreekVaultLetterClient,
    ask: LetterAsk,
    settlement: VaultLetterSettlement,
) -> VaultLetterAnswer:
    """Write the letter under the entry's Voice Draft hold; keep it, or refund every other ending.

    Account outermost (the caller's hold) and entry innermost, the fixed
    nesting everywhere the two meet, because the letter *is* a Voice Draft:
    the intent row :func:`write_vault_letter` commits before dialling is what
    an Intimate PATCH or a DELETE retracts it by. A raise anywhere -- the call,
    or keeping the letter -- is refunded too.
    """
    entry = settlement.entry
    settled = False
    try:
        async with voice_draft_privacy.hold(session, cast("int", entry.id)):
            answer = await write_vault_letter(
                session, client, ask, entry=entry, destination=settlement.destination
            )
            if answer.letter is not None:
                await settlement.keep(answer.letter)
                settled = True
    finally:
        if not settled:
            await settlement.refund()
    return answer
