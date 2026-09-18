"""Every two-int PostgreSQL advisory-lock namespace, in one place.

PostgreSQL's ``pg_advisory_lock(int4, int4)`` form gives each subsystem its own
key space while the second integer -- an entry id, an account id -- stays
directly inspectable in ``pg_locks``. That only holds while the *first*
integers are distinct, and two subsystems that picked the same one would share
a lock on equal second keys: a deadlock in production, and invisible on SQLite,
where no advisory statement is issued at all.

So the constants live here rather than beside their users, where a collision is
one function call away from being asserted, and the modules that take these
locks import their own namespace from here. Nothing in this module imports
anything, deliberately: it sits below every subsystem that reads it, so no
import cycle can form between two lock-taking modules.

``routers.auth`` is deliberately absent. Its per-email signup lock takes the
*single-argument* ``pg_advisory_xact_lock(bigint)`` form, which PostgreSQL keys
in a separate class from the two-int form, so it cannot collide with anything
here however its key is derived.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final

#: Per-entry ordering for Creek mutations against privacy/lifecycle transitions
#: (``VDRF``). Owned by :mod:`services.voice_draft_privacy`.
VOICE_DRAFT_LOCK_NAMESPACE: Final[int] = 0x56445246

#: Per-account run admission and terminalization for the ontologization ladder
#: (``APDP``). Owned by :mod:`services.creek_vault_pipeline`.
CLASSIFICATION_SCHEDULER_LOCK_NAMESPACE: Final[int] = 0x41504450

#: Per-account ordering of outbound writes against erasure (``AEGR``). Owned by
#: :mod:`services.account_egress_barrier`. The second key is the account id and
#: never content, a vault identifier, or anything derived from either.
ACCOUNT_EGRESS_LOCK_NAMESPACE: Final[int] = 0x41454752

#: The registry the distinctness test reads. A subsystem that starts taking a
#: two-int advisory lock belongs here on the same commit.
REGISTERED_ADVISORY_NAMESPACES: Final[Mapping[str, int]] = {
    "services.voice_draft_privacy": VOICE_DRAFT_LOCK_NAMESPACE,
    "services.creek_vault_pipeline": CLASSIFICATION_SCHEDULER_LOCK_NAMESPACE,
    "services.account_egress_barrier": ACCOUNT_EGRESS_LOCK_NAMESPACE,
}


def duplicate_namespaces(namespaces: Mapping[str, int]) -> tuple[str, ...]:
    """Name every subsystem sharing a two-int advisory namespace with another.

    A pure function asserted by a unit test, rather than an import-time raise:
    a module that ``main`` imports cannot fail the build at import time without
    also failing the boot, which would turn a test failure into an outage.
    """
    owners_by_namespace: dict[int, list[str]] = {}
    for owner, namespace in namespaces.items():
        owners_by_namespace.setdefault(namespace, []).append(owner)
    return tuple(
        sorted(
            owner for owners in owners_by_namespace.values() if len(owners) > 1 for owner in owners
        )
    )
