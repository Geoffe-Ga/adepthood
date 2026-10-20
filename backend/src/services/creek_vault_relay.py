"""A writer's own provider key, relayed to their vault for one dial (#3437).

ADR 0009's 2026-10-16 amendment: a vault-bound writer's BYOK key travels device
-> adepthood -> vault, per request, so a managed vault can write with it
(Creek-Vault ADR-0015, contract 0.18). This module is that relay's whole
mechanism, kept out of :mod:`services.creek_vault_client` so the adapter itself
only asks one question per send: :func:`relay_headers`.

Three conditions, all required, decide whether a send carries the key:

* the route spends a key -- reflections, letters, and the classification pass,
  and nothing else (the caller says so per send);
* a dial set one with :func:`forwarding_provider_key`;
* the vault's handshake advertised that vendor in ``request_key_providers``, so a
  self-connected or older vault is never sent a key it would not use.

The key rides in Creek's ``X-Creek-Provider`` / ``X-Creek-Provider-Key`` headers,
never a body field, so it cannot reach Creek's body logging or a validation
error, and cannot enter anything adepthood builds from a request body either.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING, Final

from domain.creek_vault import VaultKeyProvider

if TYPE_CHECKING:
    from domain.creek_vault import HandshakeResult, VaultProviderKey

PROVIDER_HEADER: Final = "X-Creek-Provider"
PROVIDER_KEY_HEADER: Final = "X-Creek-Provider-Key"

# The key a request is relaying, if any. Set only by :func:`forwarding_provider_key`
# around a vault-bound writer's own dial, and read only by :func:`relay_headers`.
# A context variable rather than a parameter because the key must reach three
# sends through protocol methods every fake vault implements; it is reset when the
# block exits, so nothing outside the dial that set it can read it.
_FORWARDED_PROVIDER_KEY: ContextVar[VaultProviderKey | None] = ContextVar(
    "creek_vault_forwarded_provider_key", default=None
)


@contextmanager
def forwarding_provider_key(key: VaultProviderKey | None) -> Iterator[None]:
    """Relay ``key`` on the keyed vault calls made inside this block.

    ``None`` relays nothing, so a caller can wrap its dial unconditionally.

    Yields:
        Control to the dial.
    """
    token = _FORWARDED_PROVIDER_KEY.set(key)
    try:
        yield
    finally:
        _FORWARDED_PROVIDER_KEY.reset(token)


def relay_headers(*, spends_key: bool, handshake: HandshakeResult) -> Mapping[str, str]:
    """The writer's-key headers one send carries: both, or none.

    Args:
        spends_key: Whether the route calls a model and so may spend a key.
        handshake: The vault's cached handshake.

    Returns:
        The two headers when all three conditions hold, else an empty mapping.
    """
    key = _FORWARDED_PROVIDER_KEY.get() if spends_key else None
    if key is None or not handshake.accepts_key(key.provider):
        return {}
    return {PROVIDER_HEADER: key.provider.value, PROVIDER_KEY_HEADER: key.reveal()}


def parse_request_key_providers(raw: object) -> frozenset[VaultKeyProvider]:
    """Read ``request_key_providers`` leniently: known vendors only, anything else dropped.

    Absent on a vault older than contract 0.18 and empty on a self-connected
    one; both mean no key is ever relayed. A malformed value is treated the
    same way rather than failing the handshake, because the field can only ever
    widen what is sent, never what is served.
    """
    items = raw if isinstance(raw, list) else []
    return frozenset(
        provider for provider in map(_known_key_provider, items) if provider is not None
    )


def _known_key_provider(item: object) -> VaultKeyProvider | None:
    """One listed vendor, or ``None`` for anything that is not a vendor this app knows."""
    known = {provider.value: provider for provider in VaultKeyProvider}
    return known.get(item) if isinstance(item, str) else None
