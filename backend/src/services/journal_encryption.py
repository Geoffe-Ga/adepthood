"""Column-level encryption at rest for journal content.

Journal ``message`` text is encrypted before the DB write and decrypted on read
via a Fernet key registry. Multiple keys enable rotation: the first key
encrypts, every key can decrypt. Keys come from ``JOURNAL_ENCRYPTION_KEYS``
(comma-separated urlsafe-base64 Fernet keys).

Rotation does **not** finish itself. SQLAlchemy flushes only the attributes a
write modified, so prepending a new key re-encrypts a column only when that
column is rewritten; every untouched value keeps the token of the key it was
written under, and a row written before any key was configured stays
plaintext. ``scripts.journal_encryption_sweep`` is what moves the rest:
``audit`` counts, per column, which rows are plaintext and which key each token
needs (never the values), and ``reencrypt`` rewrites them under the primary key
via :func:`rotate`. A retired key may be removed only after the audit is clean.

Honesty over a hollow flag (audit-destub-05): key presence *is* the switch.
With no key configured the column stays plaintext (explicitly disabled) --
except where :func:`production_in_force` holds, where the write is refused
instead, so a deploy whose boot check was bypassed (a script, a migration, a
worker) still cannot store prose in the clear. A configured-but-invalid key, or
ciphertext encountered with no key to decrypt it, raises rather than silently
degrading to plaintext.

The key registry is cached, so a ``JOURNAL_ENCRYPTION_KEYS`` change requires a
process restart to take effect (rotation is a deploy-time operation); tests call
``reset_cache`` to pick up a new value within a run.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from sqlalchemy import Text, TypeDecorator

# Public because the startup configuration check in ``main`` names this
# variable to the operator, and a message that names it by a different string
# than the one the code reads is the failure mode that check exists to prevent.
KEYS_ENV_VAR = "JOURNAL_ENCRYPTION_KEYS"
# Marks our ciphertext so reads can tell an encrypted value from a legacy
# plaintext row (pre-migration) without guessing.
_PREFIX = "enc::v1::"


# The production decision. ``ENV`` is the variable a person types; the
# ``RAILWAY_*`` names are injected by the platform itself, so they are evidence
# of where this process runs rather than an opinion about it. Either one saying
# production is enough -- a mismatch fails closed.
ENV_VAR = "ENV"
PRODUCTION = "production"
#: Railway injects the environment's name under the current spelling and, for
#: older services, the legacy one (``backend/.env.example`` documents both).
PLATFORM_ENVIRONMENT_NAME_ENV_VARS = ("RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT")
#: Present on every Railway deploy. Seen without an environment name, the
#: process is on the platform but cannot say which environment it is in, and an
#: unproven environment is treated as production.
PLATFORM_MARKER_ENV_VARS = ("RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_PUBLIC_DOMAIN")
#: Every variable :func:`production_in_force` reads, so a test can clear exactly
#: that set and no inherited shell value can flip a result.
PRODUCTION_SIGNAL_ENV_VARS = (
    ENV_VAR,
    *PLATFORM_ENVIRONMENT_NAME_ENV_VARS,
    *PLATFORM_MARKER_ENV_VARS,
)

logger = logging.getLogger(__name__)


@dataclass
class _LegacyReadSignal:
    """Legacy plaintext reads while keyed, in this process.

    A count and a one-shot flag: never the value, its length, its row, or its
    owner.
    """

    count: int = 0
    warned: bool = False


_legacy_reads = _LegacyReadSignal()


class JournalEncryptionError(RuntimeError):
    """Encryption/decryption could not be performed as configured."""


def _normalised(value: str | None) -> str:
    return (value or "").strip().lower()


def production_in_force(env: Mapping[str, str] | None = None) -> bool:
    """Whether this process must be treated as a production deploy.

    True when ``ENV`` says production, when the platform names this environment
    production, or when a platform marker is present but no environment name
    is -- a deploy that cannot say where it is has not proven it is not
    production. Staging (``RAILWAY_ENVIRONMENT_NAME=staging``) stays exempt.
    Not cached: the live environment is read on every call.

    Args:
        env: The environment to judge; ``None`` reads ``os.environ``.

    Returns:
        ``True`` when production rules apply.
    """
    source: Mapping[str, str] = os.environ if env is None else env
    if _normalised(source.get(ENV_VAR)) == PRODUCTION:
        return True
    names = _present(source, PLATFORM_ENVIRONMENT_NAME_ENV_VARS)
    if names:
        return PRODUCTION in names
    return bool(_present(source, PLATFORM_MARKER_ENV_VARS))


def _present(source: Mapping[str, str], variables: tuple[str, ...]) -> set[str]:
    """The non-blank, normalised values of ``variables`` in ``source``."""
    return {_normalised(source.get(var)) for var in variables} - {""}


def _configured_keys() -> list[str]:
    return [k.strip() for k in os.getenv(KEYS_ENV_VAR, "").split(",") if k.strip()]


@lru_cache(maxsize=1)
def _fernets() -> tuple[Fernet, ...]:
    """One Fernet per configured key, in configured order (empty when disabled)."""
    try:
        return tuple(Fernet(key.encode()) for key in _configured_keys())
    except (ValueError, TypeError) as exc:
        # Fail fast: a configured-but-invalid key must never fall back to plaintext.
        msg = f"{KEYS_ENV_VAR} contains an invalid Fernet key"
        raise JournalEncryptionError(msg) from exc


@lru_cache(maxsize=1)
def _registry() -> MultiFernet | None:
    """Build the MultiFernet from configured keys, or ``None`` when disabled."""
    fernets = _fernets()
    return MultiFernet(list(fernets)) if fernets else None


def _require_registry() -> MultiFernet:
    """The registry, or a refusal naming the variable (never a value)."""
    registry = _registry()
    if registry is None:
        msg = f"{KEYS_ENV_VAR} is not configured"
        raise JournalEncryptionError(msg)
    return registry


def is_enabled() -> bool:
    """Whether journal encryption is active (a valid key is configured).

    Raises ``JournalEncryptionError`` if a key is configured but invalid (the
    fail-fast path), so callers never treat a misconfiguration as "disabled".
    """
    return _registry() is not None


def reset_cache() -> None:
    """Drop the cached keys (rotation / tests) and the legacy-read signal."""
    _fernets.cache_clear()
    _registry.cache_clear()
    _legacy_reads.count = 0
    _legacy_reads.warned = False


def key_count() -> int:
    """How many keys are configured (0 when disabled); raises on an invalid key."""
    return len(_fernets())


def legacy_plaintext_reads() -> int:
    """How many plaintext values were read from encrypted columns while keyed."""
    return _legacy_reads.count


def is_ciphertext(value: str) -> bool:
    """Whether ``value`` carries this module's ciphertext marker."""
    return value.startswith(_PREFIX)


def encrypt(plaintext: str) -> str:
    """Return the marked ciphertext, or the plaintext unchanged when disabled.

    Disabled means no key *and* not production: where
    :func:`production_in_force` holds, a missing key refuses the write instead.
    """
    registry = _registry()
    if registry is None:
        if production_in_force():
            msg = (
                f"{KEYS_ENV_VAR} is not configured in production; refusing to write "
                "journal content in plaintext"
            )
            raise JournalEncryptionError(msg)
        return plaintext
    return _PREFIX + registry.encrypt(plaintext.encode()).decode()


def key_index(value: str) -> int | None:
    """The position of the configured key that decrypts ``value``.

    Fernet tokens carry no key id, so each key is tried in order. Reports a
    position, never a key; ``None`` when no configured key decrypts the token.

    Raises:
        ValueError: ``value`` is not marked ciphertext.
        JournalEncryptionError: no key is configured.
    """
    if not is_ciphertext(value):
        msg = "key_index expects marked ciphertext"
        raise ValueError(msg)
    _require_registry()
    token = value.removeprefix(_PREFIX).encode()
    for index, fernet in enumerate(_fernets()):
        try:
            fernet.decrypt(token)
        except InvalidToken:
            continue
        return index
    return None


def rotate(value: str) -> str:
    """Re-encrypt ``value`` under the primary key; never returns plaintext.

    Legacy plaintext is encrypted; a token under any configured key is
    re-issued under the first. Requires a key in every environment -- unlike
    :func:`encrypt`, there is no plaintext pass-through.

    Raises:
        JournalEncryptionError: no key is configured, or no key decrypts the token.
    """
    registry = _require_registry()
    if not is_ciphertext(value):
        return _PREFIX + registry.encrypt(value.encode()).decode()
    try:
        rotated = registry.rotate(value.removeprefix(_PREFIX).encode())
    except InvalidToken as exc:
        msg = "journal ciphertext failed to decrypt under any configured key"
        raise JournalEncryptionError(msg) from exc
    return _PREFIX + rotated.decode()


def _signal_legacy_plaintext_read() -> None:
    """Count a keyed plaintext read and warn once per process, content-free."""
    _legacy_reads.count += 1
    if _legacy_reads.warned:
        return
    _legacy_reads.warned = True
    logger.warning(
        "journal_plaintext_read: a legacy plaintext value was read from an encrypted "
        "column while %s is configured; run `python -m scripts.journal_encryption_sweep "
        "audit` for per-column counts",
        KEYS_ENV_VAR,
    )


def decrypt(value: str) -> str:
    """Decrypt a marked ciphertext; pass through legacy/plaintext values.

    Pass-through is by the ``enc::v1::`` marker, so a (vanishingly unlikely)
    user message that literally starts with that marker would be treated as
    ciphertext — and raise in an un-keyed environment rather than round-trip.
    A plaintext value read while a key is configured is a legacy row the sweep
    has not reached; it is counted and logged once, without its content.
    """
    if not is_ciphertext(value):
        if _registry() is not None:
            _signal_legacy_plaintext_read()
        return value
    registry = _registry()
    if registry is None:
        # Ciphertext at rest but no key to read it — surface it, never return
        # the raw token as if it were the user's text.
        msg = f"encrypted journal content found but {KEYS_ENV_VAR} is not configured"
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
