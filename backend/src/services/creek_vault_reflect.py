"""Creek Vault read path: route a Higher Self reflection to a connected vault, failing closed.

This is the read-path twin of :mod:`services.creek_vault_write`. Where the write
path turns the seam's ingest/classify surface into one best-effort store, this
module turns the seam's ``reflect`` capability into a
:class:`~domain.resonance.ResonanceLLM` the journal router injects for a caller
whose AI operations are bound to their vault
(:attr:`~services.reflection_boundary.ReflectionBoundary.VAULT_BOUND`).

The governing rule is **no substitution**. A vault-bound reflection is answered
by the vault or not at all: nothing in this module holds, constructs, or can be
handed the app's own model provider. A caller with no vault never reaches this
module -- the router answers them from the app provider directly -- so there is
no "else" here to fall back to. Every way the vault can fail to answer raises
:class:`~services.reflection_boundary.VaultSourceUnavailableError` with a
closed-vocabulary reason, which the router settles as a refunded, retryable
"unavailable":

* a classification outside the egress allowlist
  (:func:`domain.privacy_tier.admits_egress`: intimate, unknown, empty), before
  any handshake, so a tier is never widened and the vault is untouched (#3059);
* a vault that does not handshake as available, or never advertises REFLECT;
* a :class:`~domain.creek_vault.CreekVaultError` from the call itself, which is
  also recorded through :mod:`services.creek_vault_read` so it stays countable.

A distress-flagged entry never gets here either: the router answers it with
adepthood's own care surface and asks no model at all.

The seam hands back a structured :class:`~domain.creek_vault.VaultReflection`,
and this module turns it into the strict ``{"notes": [...]}`` JSON
:func:`~domain.resonance.generate_marginalia` anchors verbatim quotes against --
the same contract the app provider answers in. That serialization lives *here*
rather than in the client adapter because it is this seam's contract with the
resonance pass, not a property of any wire; the adapter's job ends at projecting
Creek's note kinds onto adepthood's vocabulary. The router's prompt is not
forwarded across the seam either: the vault builds its own prompt from the body.

The structure is what keeps the vault's real answers apart, which a blank string
could not. A vault that had nothing to say (``EMPTY``), and one whose notes did
not survive projection (``OK`` with no notes), both answer an empty notes list
and log **nothing** -- a legitimate answer is not a degrade, and recording one
would train an operator to ignore the signal that means something. The resonance
pass then settles it as a zero-note pass, with its own explanation and a refund.
A care escalation is neither an answer nor a degrade: it propagates un-caught,
and the router answers it with adepthood's own care surface.

The vault's optional ``essay`` is free model prose rather than the user's own
words, so it reaches no note, no JSON, and no log line -- the whole point of the
Higher Self is that it speaks in words the user actually wrote.

The related praxis and eddies a vault may surface alongside a reflection travel
the other way for the opposite reason. They *are* the user's own material --
pages their vault compiled from their own fragments -- but they are not quotes
and anchor to nothing, so they have no place in the marginalia contract either.
They ride on the adapter instead and are read back through
:func:`related_surfaces`, which answers empty for every source that is not a
vault, so the consumer asks one question rather than branching on a type.

Intimate content is out of scope here by construction: the router's privacy floor
returns for an intimate entry before this module is ever reached -- once before
the pass charges, and again under the account hold, where a PATCH that won the
barrier may have made the entry intimate (#2998) -- so
:func:`select_reflection_llm` is only ever called for non-intimate entries and
never binds an intimate-tier vault reflection (that attested read path is future
work). Since #3059 it also refuses one itself, as its first gate: the router
checks remain load-bearing, and this one makes the seam fail closed on its own
rather than on its caller's discipline.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass

from domain.creek_vault import (
    CreekCapability,
    CreekVaultClient,
    CreekVaultError,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultRelatedEddy,
    VaultRelatedPraxis,
    VaultTierCeiling,
    tier_ceiling_for,
)
from domain.privacy_tier import admits_egress
from domain.resonance import ResonanceLLM
from services.botmason import LLMResponse
from services.creek_vault_read import log_read_degraded
from services.marginalia import VAULT_RECEIPT, InferenceReceipt, receipt_since
from services.reflection_boundary import (
    VaultSourceUnavailableError,
    VaultSourceUnavailableReason,
)


@dataclass(frozen=True)
class VaultRelatedSurfaces:
    """The writer's own compiled pages a reflection surfaced, if any.

    Read back off the seam rather than carried in the completion, because the
    :class:`~domain.resonance.ResonanceLLM` contract is prompt-in/string-out and
    that string is the marginalia contract -- a set of the writer's own quotes.
    A praxis page is not a margin note and has nothing to anchor to, so smuggling
    one into that JSON would either be dropped by the anchor check or rendered as
    a note the vault never wrote.

    Empty is the ordinary value: it is what every app-provider pass reports,
    what a vault pass that kept no notes reports, and what a vault answering
    with no pages reports. Nothing downstream distinguishes those, because the writer sees the
    same thing in all of them -- a reflection with no pages beside it.
    """

    praxis: tuple[VaultRelatedPraxis, ...] = ()
    eddies: tuple[VaultRelatedEddy, ...] = ()


def _marginalia_contract(notes: tuple[VaultReflectionNote, ...]) -> str:
    """Serialize projected notes into the strict JSON the resonance pass expects.

    This seam's own contract with :func:`~domain.resonance.generate_marginalia`,
    which is why it lives here rather than in the wire adapter: the app provider
    answers in this exact shape, so a vault-backed completion has to be
    indistinguishable from one. Only the three note fields are written -- the
    vault's ``essay`` has no place in a contract about the user's own words.
    """
    return json.dumps(
        {"notes": [{"kind": note.kind, "quote": note.quote, "note": note.note} for note in notes]}
    )


def _carries_notes(reflection: VaultReflection) -> bool:
    """Return whether a reflection actually has something to anchor.

    Two answers are legitimate but empty-handed: a vault that reports ``EMPTY``,
    and one that reported ``OK`` but whose notes did not survive the adapter's
    projection. Neither is a failure, and neither has anything to render, so both
    answer an empty notes list and the pass settles as one that kept no notes.
    """
    return reflection.status is VaultReflectionStatus.OK and bool(reflection.notes)


class VaultResonanceLLM:
    """A :class:`~domain.resonance.ResonanceLLM` backed by a vault's ``reflect`` call.

    Adapts the vault's own reflection into the router's LLM seam. It holds no
    other source: an answer with nothing to anchor is an empty notes list, a
    normalized vault failure is recorded and raised as
    :class:`~services.reflection_boundary.VaultSourceUnavailableError`, and a
    care escalation leaves this seam un-caught.
    """

    def __init__(
        self,
        client: CreekVaultClient,
        *,
        body: str,
        tier_ceiling: VaultTierCeiling,
    ) -> None:
        """Bind the vault client, the body to reflect on, and its tier."""
        self._client = client
        self._body = body
        self._tier_ceiling = tier_ceiling
        self._related = VaultRelatedSurfaces()

    @property
    def related(self) -> VaultRelatedSurfaces:
        """Return the compiled pages of the reflection this adapter actually answered with.

        Empty until :meth:`complete` has run, and empty afterwards unless the
        vault's own notes are what the writer is reading: pages presented beside
        a pass that kept no notes would be relating the writer's corpus to
        nothing their vault said.
        """
        return self._related

    async def _reflection(self) -> VaultReflection:
        """Ask the vault, recording a degrade and raising it as unavailable.

        Catches :class:`~domain.creek_vault.CreekVaultError` -- the base covering
        an unreadable payload, a refused request, a rejected credential, an
        unavailable or timed-out vault, and an unadvertised capability -- and
        records which of those it was through :mod:`services.creek_vault_read`,
        whose fields are a closed vocabulary so nothing the vault chose can reach
        the record. The raise carries only this seam's own reason word.

        :class:`~domain.creek_vault.CreekVaultCareEscalationError` is deliberately
        outside that hierarchy and so propagates untouched.
        """
        try:
            return await self._client.reflect(self._body, self._tier_ceiling)
        except CreekVaultError as error:
            log_read_degraded(CreekCapability.REFLECT, error)
            raise VaultSourceUnavailableError(VaultSourceUnavailableReason.VAULT_ERROR) from None

    async def complete(self, prompt: str) -> str:
        """Return the vault's reflection on the bound body as the marginalia contract.

        ``prompt`` is intentionally unused: the vault does its own retrieval and
        prompt construction from the body, so the router's prompt -- and the
        other writing and earlier letters it carries -- is not sent across the
        seam, and there is no other source it could be sent to instead.

        Three outcomes: a reflection carrying notes is serialized into the
        marginalia contract; an answer with nothing to anchor is an empty notes
        list; and a failure raises (see :meth:`_reflection`). The first is the
        only one that records related pages, so what :attr:`related` reports
        always belongs to notes the writer is about to read.
        """
        del prompt
        reflection = await self._reflection()
        if not _carries_notes(reflection):
            return _marginalia_contract(())
        self._related = VaultRelatedSurfaces(
            praxis=reflection.related_praxis, eddies=reflection.related_eddies
        )
        return _marginalia_contract(reflection.notes)


def related_surfaces(llm: ResonanceLLM) -> VaultRelatedSurfaces:
    """Return the compiled pages the reflection source surfaced, if it was a vault at all.

    The twin of :func:`select_reflection_llm`: the router holds whichever
    source its boundary chose, and this asks that value what it surfaced, so the
    caller never has to know which it got. An app-provider LLM has no vault behind it and
    so surfaces nothing -- a fact of the seam rather than of the router, which is
    why the type test lives here and not at the call site.
    """
    return llm.related if isinstance(llm, VaultResonanceLLM) else VaultRelatedSurfaces()


def reflection_receipt(
    llm: ResonanceLLM, usage: Sequence[LLMResponse], mark: int = 0
) -> InferenceReceipt | None:
    """Return which side answered a reflection that completed on ``llm`` (#3062).

    The twin of :func:`related_surfaces`, and type-tested here for the same
    reason. A :class:`VaultResonanceLLM` that returned at all was answered by
    the vault -- it holds no other source, so there is nothing it could have
    substituted. Any other source is the app provider, read off the responses
    it metered at or after ``mark``; ``None`` when none answered.
    """
    if isinstance(llm, VaultResonanceLLM):
        return VAULT_RECEIPT
    return receipt_since(usage, mark)


async def select_reflection_llm(
    client: CreekVaultClient,
    *,
    body: str,
    classification: str,
) -> VaultResonanceLLM:
    """Bind a vault-bound entry's reflection to its vault, or raise that the vault cannot answer.

    Only called for a caller whose boundary is
    :attr:`~services.reflection_boundary.ReflectionBoundary.VAULT_BOUND`, with a
    non-intimate entry the router's local care screen did not flag. The order of
    the gates is load-bearing:

    1. :func:`~domain.privacy_tier.admits_egress` decides the tier: anything
       outside the allowlist -- intimate, unknown, empty -- raises
       ``UNKNOWN_TIER`` (the classification maps to no tier the vault may be
       asked at) before any handshake, so a tier is never widened and the vault
       is untouched. :func:`~domain.creek_vault.tier_ceiling_for` then resolves
       the ceiling, and a map that has drifted from the allowlist fails
       closed with the same ``UNKNOWN_TIER``.
    2. A handshake probes the vault; one that is not available raises
       ``UNAVAILABLE``, and one that does not advertise REFLECT raises
       ``CAPABILITY_MISSING``.
    3. Otherwise a :class:`VaultResonanceLLM` bound to the resolved tier is
       returned.

    There is deliberately no ``fallback`` parameter: a vault-then-app-provider
    composite is not expressible through this function.
    """
    if not admits_egress(classification):
        raise VaultSourceUnavailableError(VaultSourceUnavailableReason.UNKNOWN_TIER)
    try:
        tier_ceiling = tier_ceiling_for(classification)
    except ValueError:
        raise VaultSourceUnavailableError(VaultSourceUnavailableReason.UNKNOWN_TIER) from None
    await client.handshake()
    if not client.is_available():
        raise VaultSourceUnavailableError(VaultSourceUnavailableReason.UNAVAILABLE)
    if not client.supports(CreekCapability.REFLECT):
        raise VaultSourceUnavailableError(VaultSourceUnavailableReason.CAPABILITY_MISSING)
    return VaultResonanceLLM(client, body=body, tier_ceiling=tier_ceiling)
