"""The one digest an ``Idempotency-Key`` is reduced to before it is stored.

Three surfaces on this API accept a client-supplied idempotency key, and two of
them hashed it with their own private copy of the same three lines —
``services.practice_session_idempotency.hash_idem_key`` and
``services.goal_completion_idempotency._hash_key``, byte-identical and
independently maintained. A fourth feature wanting the digest had two bad
options: copy it again, or import it from one arbitrary peer feature's service
module and make that feature's hashing decisions silently re-key its own dedup.

So the digest lives here, owned by neither feature. The module is deliberately
small and dependency-free: no model, no session, no FastAPI. What it is *for*
is the invariant, which is worth stating once where it cannot drift.

The raw header is never stored. Hashing keeps the stored column bounded and
one-way, and prefixing the account id keeps the hash space disjoint across
accounts so a crafted key cannot collide into another account's namespace.
"""

from __future__ import annotations

import hashlib
from typing import Final

# Client-supplied keys are short opaque tokens. 255 is the bound
# ``/v1/goal-completions`` already publishes; declaring it here lets a route
# refuse an over-long header with a clean 422 instead of a native DB error.
IDEMPOTENCY_KEY_MAX_LENGTH: Final = 255

# A SHA-256 hex digest is 64 characters. Columns storing one are declared wider
# (128) so a future hash migration is a data change rather than a schema one.
IDEMPOTENCY_DIGEST_COLUMN_WIDTH: Final = 128


def hash_idem_key(user_id: int, raw_key: str) -> str:
    """Return the stable SHA-256 digest of ``(user_id, raw_key)``.

    The value every idempotency column on this API stores. The ``user_id``
    prefix is the namespacing: without it, two accounts sending the same key
    would hash to the same digest and a partial-unique index spanning both
    would let one account's retry resolve to the other's row.
    """
    return hashlib.sha256(f"{user_id}:{raw_key}".encode()).hexdigest()
