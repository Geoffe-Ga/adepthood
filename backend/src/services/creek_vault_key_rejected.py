"""Creek contract 0.28's refused writer key on the reflection and letter calls.

Two halves, both used only by those two calls in
:mod:`services.creek_vault_client`: which minor each declares, and how its
failure is read. Optional later minors are declared per call, never by moving
the base pin, and only to a vault whose handshake lists them -- Creek refuses
any minor its ``supported_contract_minors`` does not name. The code is read only
there: ``request_key_rejected`` is published on those two routes alone. It
is read apart from :class:`~domain.creek_vault.VaultErrorCode`, which mirrors the
vendored 0.22 error envelope, and matched as an exact string, so nothing the
vault sent is kept.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Final

import httpx

from domain.creek_vault import CreekCapability, CreekVaultError, HandshakeResult
from domain.vault_key_rejection import (
    REQUEST_KEY_REJECTED_SINCE_MINOR,
    CreekVaultRequestKeyRejectedError,
)
from services.creek_vault_payload import _capability_message

#: The wire code Creek 0.28 answers a refused writer key with.
REQUEST_KEY_REJECTED_CODE: Final = "request_key_rejected"

#: The static prefix of the error raised for it; the capability is the only suffix.
_KEY_REJECTED: Final = "creek vault request key rejected"


def rejects_request_key(response: httpx.Response) -> bool:
    """Whether ``response`` is Creek 0.28's refused writer key."""
    try:
        payload = response.json()
    except ValueError:
        return False
    return isinstance(payload, Mapping) and payload.get("code") == REQUEST_KEY_REJECTED_CODE


def key_rejected_error(capability: CreekCapability) -> CreekVaultRequestKeyRejectedError:
    """The content-free error a refused writer key raises on ``capability``."""
    return CreekVaultRequestKeyRejectedError(_capability_message(_KEY_REJECTED, capability))


def keyed_generation_minor(handshake: HandshakeResult, pinned: str) -> str:
    """The minor a reflection or letter declares: 0.28 to a vault listing it, else ``pinned``.

    Only the minor moves. The call keeps its own deadline and key relay, so a
    reflection or letter against a 0.28 vault waits and pays exactly as it does
    against an older one. Creek gates nothing else on these two routes above
    0.21, so the higher declaration changes no other answer they rely on.
    """
    if handshake.serves_minor(REQUEST_KEY_REJECTED_SINCE_MINOR):
        return REQUEST_KEY_REJECTED_SINCE_MINOR
    return pinned


def key_rejected_or(
    capability: CreekCapability,
    response: httpx.Response,
    otherwise: Callable[[httpx.Response], CreekVaultError],
) -> CreekVaultError:
    """A refused writer key on ``capability``, else whatever ``otherwise`` classifies."""
    if rejects_request_key(response):
        return key_rejected_error(capability)
    return otherwise(response)
