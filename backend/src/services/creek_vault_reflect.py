"""Creek Vault read path: route a Higher Self reflection to a connected vault, degrading safely.

This is the read-path twin of :mod:`services.creek_vault_write`. Where the write
path turns the seam's ingest/classify surface into one best-effort store, this
module turns the seam's ``reflect`` capability into a
:class:`~domain.resonance.ResonanceLLM` the journal router can inject in place of
the cloud LLM -- so a connected, capable vault answers from the user's own
enclave-held corpus, and everything else falls back to the cloud.

The governing rule is the same **graceful degradation**: an absent, unreachable,
or capability-poor vault never raises into the resonance pass -- it collapses to
the injected cloud ``fallback``. Two gates precede any vault call, in a
load-bearing order: an elevated distress signal (``care_flagged``) and an
unrecognized-to-non-intimate tier both fail safe to the cloud *before* a
handshake, so the vault is provably untouched for those entries.

The seam hands back a structured :class:`~domain.creek_vault.VaultReflection`,
and this module turns it into the strict ``{"notes": [...]}`` JSON
:func:`~domain.resonance.generate_marginalia` anchors verbatim quotes against --
the same contract the cloud LLM answers in. That serialization lives *here*
rather than in the client adapter because it is this seam's contract with the
resonance pass, not a property of any wire; the adapter's job ends at projecting
Creek's note kinds onto adepthood's vocabulary. The cloud-shaped prompt is not
forwarded across the seam either: the vault builds its own enclave-side prompt
from the body.

The structure is what keeps the vault's real answers apart, which a blank string
could not. A vault that had nothing to say (``EMPTY``), and one whose notes did
not survive projection (``OK`` with no notes), both defer to the cloud
``fallback`` and log **nothing** -- a legitimate answer is not a degrade, and
recording one would train an operator to ignore the signal that means something.
A :class:`~domain.creek_vault.CreekVaultError` defers too, but is recorded
through :mod:`services.creek_vault_read` so the failure stays countable. A care
escalation is neither: it propagates un-caught, because answering it from the
cloud would hand a person in acute distress exactly the model prose the vault's
care guard refused to produce.

The vault's optional ``essay`` is free model prose rather than the user's own
words, so it reaches no note, no JSON, and no log line -- the whole point of the
Higher Self is that it speaks in words the user actually wrote.

Intimate content is out of scope here by construction: the router's privacy floor
returns for an intimate entry before this module is ever reached, so
:func:`select_reflection_llm` is only ever called for non-intimate entries and
never binds an intimate-tier vault reflection (that attested read path is future
work).
"""

from __future__ import annotations

import json

from domain.creek_vault import (
    CreekCapability,
    CreekVaultClient,
    CreekVaultError,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
    tier_ceiling_for,
)
from domain.resonance import ResonanceLLM
from services.creek_vault_read import log_read_degraded


def _marginalia_contract(notes: tuple[VaultReflectionNote, ...]) -> str:
    """Serialize projected notes into the strict JSON the resonance pass expects.

    This seam's own contract with :func:`~domain.resonance.generate_marginalia`,
    which is why it lives here rather than in the wire adapter: the cloud LLM
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
    projection. Neither is a failure, and neither can be rendered -- anchoring to
    zero notes would leave the user with a Higher Self that said nothing at all,
    which is worse than a cloud answer.
    """
    return reflection.status is VaultReflectionStatus.OK and bool(reflection.notes)


class VaultResonanceLLM:
    """A :class:`~domain.resonance.ResonanceLLM` backed by a vault's ``reflect`` call.

    Adapts the vault's enclave-side reflection into the router's LLM seam. A
    normalized vault failure, or an answer with nothing to anchor, defers to the
    injected cloud ``fallback`` so the resonance pass always has an answer -- but
    only the failure is recorded, since a vault answering that it has nothing to
    add is not a degrade. A care escalation is not deferred at all: it leaves this
    seam un-caught.
    """

    def __init__(
        self,
        client: CreekVaultClient,
        *,
        body: str,
        tier_ceiling: VaultTierCeiling,
        fallback: ResonanceLLM,
    ) -> None:
        """Bind the vault client, the body to reflect on, its tier, and a cloud fallback."""
        self._client = client
        self._body = body
        self._tier_ceiling = tier_ceiling
        self._fallback = fallback

    async def _reflection(self) -> VaultReflection | None:
        """Ask the vault, recording and swallowing a degrade as ``None``.

        Catches :class:`~domain.creek_vault.CreekVaultError` -- the base covering
        an unreadable payload, a refused request, a rejected credential, an
        unavailable vault, and an unadvertised capability -- and records which of
        those it was through :mod:`services.creek_vault_read`, whose fields are a
        closed vocabulary so nothing the vault chose can reach the record. That
        log is the only place a read degrade is visible at all, since the cloud
        answers in its place and the user sees a healthy pass either way.

        :class:`~domain.creek_vault.CreekVaultCareEscalationError` is deliberately
        outside that hierarchy and so propagates untouched.
        """
        try:
            return await self._client.reflect(self._body, self._tier_ceiling)
        except CreekVaultError as error:
            log_read_degraded(CreekCapability.REFLECT, error)
            return None

    async def complete(self, prompt: str) -> str:
        """Return the vault's reflection on the bound body, or the fallback's completion.

        ``prompt`` is intentionally unused on the vault-success path: the vault
        does its own enclave-side retrieval and prompt construction from the body,
        so the router's cloud-shaped prompt is not sent across the seam. It MUST
        still be passed through verbatim to the fallback, whose contract is the
        ordinary prompt-in/completion-out LLM seam.

        Three outcomes, and only the first is a vault answer this app can use: a
        reflection carrying notes is serialized into the marginalia contract; a
        degrade (already recorded) or an answer with nothing to anchor falls back
        to the cloud; and a care escalation is not caught here at all.
        """
        reflection = await self._reflection()
        if reflection is None or not _carries_notes(reflection):
            return await self._fallback.complete(prompt)
        return _marginalia_contract(reflection.notes)


async def select_reflection_llm(
    client: CreekVaultClient,
    *,
    body: str,
    classification: str,
    care_flagged: bool,
    fallback: ResonanceLLM,
) -> ResonanceLLM:
    """Choose the reflection source for an entry: a connected vault, else the cloud fallback.

    The order of the gates is load-bearing:

    1. A ``care_flagged`` entry (an elevated distress signal) returns the
       ``fallback`` immediately, without touching ``client`` -- no handshake. On
       distress, adepthood does not call the vault for a reflection.
    2. :func:`~domain.creek_vault.tier_ceiling_for` resolves the tier; an
       unrecognized classification fails safe to the cloud (the current behavior
       for non-intimate content) rather than ever widening the tier.
    3. A handshake probes the vault; an unavailable vault, or one that does not
       advertise REFLECT, falls back to the cloud.
    4. Otherwise a :class:`VaultResonanceLLM` bound to the resolved tier is
       returned.
    """
    if care_flagged:
        return fallback
    try:
        tier_ceiling = tier_ceiling_for(classification)
    except ValueError:
        return fallback
    await client.handshake()
    if not (client.is_available() and client.supports(CreekCapability.REFLECT)):
        return fallback
    return VaultResonanceLLM(client, body=body, tier_ceiling=tier_ceiling, fallback=fallback)
