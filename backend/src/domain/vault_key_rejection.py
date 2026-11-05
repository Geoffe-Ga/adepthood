"""A writer key its vendor refused: Creek contract 0.28's ``request_key_rejected``.

When a vault relays the writer's own provider key for a reflection or a letter
and the vendor turns it down, Creek 0.28 answers ``POST /v1/reflections`` and
``POST /v1/letters/{external_id}`` with ``424 request_key_rejected``, retry
disposition terminal. A caller declaring an older minor gets ``503
temporarily_unavailable`` for the same refusal, which reads as an outage and
tells the writer to wait for something that never clears.

Its own module rather than more of :mod:`domain.creek_vault`, which imports
nothing from here, so the error can extend that hierarchy without a cycle.
"""

from __future__ import annotations

from typing import Final

from domain.creek_vault import CreekVaultError

#: The first Creek minor that answers a refused writer key as ``424
#: request_key_rejected``. Declared on the reflection and letter calls only, and
#: only to a vault whose handshake lists it; the base pin stays put.
REQUEST_KEY_REJECTED_SINCE_MINOR: Final = "0.28"


class CreekVaultRequestKeyRejectedError(CreekVaultError):
    """The vendor of the writer's own relayed key refused it (contract 0.28).

    The retry disposition is terminal: the same key fails the same way until the
    writer replaces it.

    A sibling of :class:`~domain.creek_vault.CreekVaultUnavailableError` rather
    than a subclass of it, because the remedy is the opposite one. An outage
    clears by waiting; a refused key never does, and a pipeline ladder or a
    caller that retries an unavailable vault must not retry this. Nor is it a
    :class:`~domain.creek_vault.CreekVaultContractError` (adepthood's request
    was well formed) or a :class:`~domain.creek_vault.CreekVaultAuthError` (that
    is the vault's own bearer, not the writer's key). The message is static and
    capability-named; it never carries the key, the vendor's words, or anything
    the vault said.
    """
