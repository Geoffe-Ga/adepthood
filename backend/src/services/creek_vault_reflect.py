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

The vault's ``reflect`` output is fed straight into
:func:`~domain.resonance.generate_marginalia`, which anchors verbatim quotes on
adepthood's side and expects the same strict ``{"notes": [...]}`` JSON the cloud
LLM returns. Because the cloud-shaped prompt is *not* forwarded across the seam
(the vault builds its own enclave-side prompt), the vault is responsible for
emitting that contract; a non-conforming reflection simply anchors to zero notes,
exactly as a malformed cloud completion already does.

Intimate content is out of scope here by construction: the router's privacy floor
returns for an intimate entry before this module is ever reached, so
:func:`select_reflection_llm` is only ever called for non-intimate entries and
never binds an intimate-tier vault reflection (that attested read path is future
work).
"""

from __future__ import annotations

from domain.creek_vault import (
    CreekCapability,
    CreekVaultClient,
    CreekVaultError,
    VaultTierCeiling,
    tier_ceiling_for,
)
from domain.resonance import ResonanceLLM


class VaultResonanceLLM:
    """A :class:`~domain.resonance.ResonanceLLM` backed by a vault's ``reflect`` call.

    Adapts the vault's enclave-side reflection into the router's LLM seam. On any
    normalized transport failure, or a blank reflection, it defers to the injected
    cloud ``fallback`` so the resonance pass always has an answer.
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

    async def complete(self, prompt: str) -> str:
        """Return the vault's reflection on the bound body, or the fallback's completion.

        ``prompt`` is intentionally unused on the vault-success path: the vault
        does its own enclave-side retrieval and prompt construction from the body,
        so the router's cloud-shaped prompt is not sent across the seam. It MUST
        still be passed through verbatim to the fallback, whose contract is the
        ordinary prompt-in/completion-out LLM seam.

        A :class:`~domain.creek_vault.CreekVaultError` (the base catching both an
        unavailable vault and an unsupported capability), or a blank
        (empty/whitespace-only) reflection, both defer to the fallback.
        """
        try:
            reflection = await self._client.reflect(self._body, self._tier_ceiling)
        except CreekVaultError:
            return await self._fallback.complete(prompt)
        if not reflection.strip():
            return await self._fallback.complete(prompt)
        return reflection


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
