"""Column-level encryption at rest for journal content.

Journal ``message`` text is encrypted before the DB write and decrypted on read
via a Fernet key registry. Multiple keys enable rotation: the first key
encrypts, every key can decrypt, so a compromised key can be retired without
downtime (re-encrypt lazily on the next write). Keys come from
``JOURNAL_ENCRYPTION_KEYS`` (comma-separated urlsafe-base64 Fernet keys).

Honesty over a hollow flag (audit-destub-05): key presence *is* the switch.
With no key configured the column stays plaintext (explicitly disabled). A
configured-but-invalid key, or ciphertext encountered with no key to decrypt
it, raises rather than silently degrading to plaintext.

The key registry is cached, so a ``JOURNAL_ENCRYPTION_KEYS`` change requires a
process restart to take effect (rotation is a deploy-time operation); tests call
``reset_cache`` to pick up a new value within a run.
"""

from __future__ import annotations

import os
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from sqlalchemy import Text, TypeDecorator

_ENV_VAR = "JOURNAL_ENCRYPTION_KEYS"
# Marks our ciphertext so reads can tell an encrypted value from a legacy
# plaintext row (pre-migration) without guessing.
_PREFIX = "enc::v1::"


class JournalEncryptionError(RuntimeError):
    """Encryption/decryption could not be performed as configured."""


def _configured_keys() -> list[str]:
    return [k.strip() for k in os.getenv(_ENV_VAR, "").split(",") if k.strip()]


@lru_cache(maxsize=1)
def _registry() -> MultiFernet | None:
    """Build the MultiFernet from configured keys, or ``None`` when disabled."""
    keys = _configured_keys()
    if not keys:
        return None
    try:
        return MultiFernet([Fernet(key.encode()) for key in keys])
    except (ValueError, TypeError) as exc:
        # Fail fast: a configured-but-invalid key must never fall back to plaintext.
        msg = f"{_ENV_VAR} contains an invalid Fernet key"
        raise JournalEncryptionError(msg) from exc


def is_enabled() -> bool:
    """Whether journal encryption is active (a valid key is configured).

    Raises ``JournalEncryptionError`` if a key is configured but invalid (the
    fail-fast path), so callers never treat a misconfiguration as "disabled".
    """
    return _registry() is not None


def reset_cache() -> None:
    """Drop the cached registry so a key change (rotation / tests) takes effect."""
    _registry.cache_clear()


def encrypt(plaintext: str) -> str:
    """Return the marked ciphertext, or the plaintext unchanged when disabled."""
    registry = _registry()
    if registry is None:
        return plaintext
    return _PREFIX + registry.encrypt(plaintext.encode()).decode()


def decrypt(value: str) -> str:
    """Decrypt a marked ciphertext; pass through legacy/plaintext values.

    Pass-through is by the ``enc::v1::`` marker, so a (vanishingly unlikely)
    user message that literally starts with that marker would be treated as
    ciphertext — and raise in an un-keyed environment rather than round-trip.
    """
    if not value.startswith(_PREFIX):
        return value
    registry = _registry()
    if registry is None:
        # Ciphertext at rest but no key to read it — surface it, never return
        # the raw token as if it were the user's text.
        msg = f"encrypted journal content found but {_ENV_VAR} is not configured"
        raise JournalEncryptionError(msg)
    try:
        return registry.decrypt(value.removeprefix(_PREFIX).encode()).decode()
    except InvalidToken as exc:
        msg = "journal ciphertext failed to decrypt (key rotated out?)"
        raise JournalEncryptionError(msg) from exc


class EncryptedString(TypeDecorator[str]):
    """Encrypt on write / decrypt on read for a text column.

    Applied at the ORM boundary so call sites read/write ``message`` as a plain
    ``str`` and never have to remember to (de)crypt. Backed by ``Text`` (not a
    bounded ``String``) because a Fernet token is ~1.3x the plaintext plus the
    marker; input length is capped upstream by the request schema + sanitizer.
    """

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: str | None, _dialect: object) -> str | None:
        return None if value is None else encrypt(value)

    def process_result_value(self, value: str | None, _dialect: object) -> str | None:
        return None if value is None else decrypt(value)
