"""The idempotency digest has one owner, and its value is pinned.

Two feature services used to carry private copies of these three lines. Pulling
them into :mod:`security.idempotency` is only safe if the extracted function
produces exactly what the copies produced — a digest that changed value would
silently orphan every stored ``idem_key`` and turn live retries into fresh
writes. The literal below is that proof: it was computed from the pre-extraction
implementation and does not move.
"""

from __future__ import annotations

import hashlib

from security.idempotency import (
    IDEMPOTENCY_DIGEST_COLUMN_WIDTH,
    IDEMPOTENCY_KEY_MAX_LENGTH,
    hash_idem_key,
)
from services.goal_completion_idempotency import _hash_key
from services.practice_session_idempotency import hash_idem_key as practice_hash

_FIXED_USER_ID = 7
_FIXED_RAW_KEY = "c0ffee-retry-1"  # pragma: allowlist secret

# SHA-256 of the literal bytes ``b"7:c0ffee-retry-1"``. Spelled out rather than
# recomputed from the function under test, which would assert nothing.
# Not a credential: the public digest of a public test key, spelled out so a
# rewrite that changes the value fails here.
_PINNED_DIGEST = (
    "35178f76e2d87f5107f28e6411dc46e628b0bddfab00c3e600ab044a0eb99e52"  # pragma: allowlist secret
)

_SHA256_HEX_LENGTH = 64


def test_the_digest_is_sha256_of_the_namespaced_key() -> None:
    """The stored value is ``sha256("{user_id}:{raw_key}")``, hex-encoded."""
    expected = hashlib.sha256(b"7:c0ffee-retry-1").hexdigest()
    assert hash_idem_key(_FIXED_USER_ID, _FIXED_RAW_KEY) == expected
    assert len(expected) == _SHA256_HEX_LENGTH


def test_the_digest_value_has_not_moved() -> None:
    """A literal, so a "harmless" rewrite that changes the value fails here."""
    assert hash_idem_key(_FIXED_USER_ID, _FIXED_RAW_KEY) == _PINNED_DIGEST


def test_two_accounts_sending_one_key_get_different_digests() -> None:
    """The ``user_id`` prefix is what keeps the hash space disjoint per account."""
    assert hash_idem_key(1, _FIXED_RAW_KEY) != hash_idem_key(2, _FIXED_RAW_KEY)


def test_both_retrofitted_services_resolve_to_the_shared_digest() -> None:
    """Neither feature kept a private copy that could drift away from this one."""
    assert practice_hash(_FIXED_USER_ID, _FIXED_RAW_KEY) == _PINNED_DIGEST
    assert _hash_key(_FIXED_USER_ID, _FIXED_RAW_KEY) == _PINNED_DIGEST


def test_the_column_is_wide_enough_for_the_digest_it_stores() -> None:
    """A width narrower than the digest would truncate every key silently."""
    assert IDEMPOTENCY_DIGEST_COLUMN_WIDTH >= _SHA256_HEX_LENGTH
    assert IDEMPOTENCY_KEY_MAX_LENGTH > 0
