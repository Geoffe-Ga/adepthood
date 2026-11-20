"""One capability handshake per Seed run, instead of one per document (#3770).

A folder import sends its documents one request at a time, and every request
resolves a fresh vault adapter -- so until #3770 every document probed
``GET /v1/capabilities`` before it was uploaded, and every retry of a document
waiting out a busy vault probed again. Nothing about the vault's capabilities
changes between two documents of one run a few seconds apart, so the probe is
remembered for the run and handed to the next document's adapter instead.

**Keyed on what makes a probe someone's.** The key is the owner, the vault the
adapter reaches (its :attr:`~services.creek_vault_client.HttpCreekVaultClient.base_url`),
and the run name the client sent. The run name alone is client-chosen, so it
never decides anything by itself: a guessed or replayed name finds nothing
unless it is the same account reaching the same vault, which is exactly the
case the reuse is for. A credential rotated mid-run is caught by the upload
itself: the vault refuses it, the failure forgets the probe, and the next
document asks again.

**Only a probe worth reusing is remembered**: an available vault that
advertised ``upload``. A vault that was absent, or that cannot take files, is
asked again by the next document, so recovering from either is never delayed.
A real failure during the upload :meth:`~UploadHandshakeMemo.forget` drops the
run's probe for the same reason; a busy refusal does not, because a busy vault
is a reachable one.

**Bounded twice.** A probe is reused for :data:`UPLOAD_HANDSHAKE_REUSE_SECONDS`
at most, so a long run still re-reads the vault's capabilities now and then,
and at most :data:`UPLOAD_HANDSHAKE_MEMO_MAX_RUNS` runs are held, oldest let go
first, so no flood of run ids grows the process. The memo is per process; a run
whose requests land on two machines simply probes once on each.

A caller that names no run, and any client that cannot adopt a handshake (every
test double, the local fallback), handshakes exactly as before.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Protocol, runtime_checkable

from domain.creek_vault import CreekCapability, CreekVaultClient, HandshakeResult

#: How long one run reuses a probe before asking the vault again. Long enough to
#: cover a run's back-to-back documents and a busy vault's retries; short enough
#: that a capability the vault withdraws is noticed within a couple of minutes.
UPLOAD_HANDSHAKE_REUSE_SECONDS: Final[float] = 120.0

#: How many runs' probes one process holds at once, the oldest let go first.
UPLOAD_HANDSHAKE_MEMO_MAX_RUNS: Final[int] = 1024


@runtime_checkable
class AdoptsHandshake(Protocol):
    """A client that can be handed a probe instead of making one."""

    @property
    def base_url(self) -> str:
        """The vault this client reaches."""

    def adopt_handshake(self, result: HandshakeResult, /) -> None:
        """Answer the cached reads from ``result`` as if it had just probed."""


_MemoKey = tuple[int, str, str]


@dataclass(frozen=True)
class _Remembered:
    """One run's reusable probe and the moment it stops being fresh."""

    result: HandshakeResult
    expires_at: float


def _worth_reusing(result: HandshakeResult) -> bool:
    """Whether a probe says the vault is there and takes files."""
    return result.available and CreekCapability.UPLOAD in result.capabilities


class UploadHandshakeMemo:
    """A bounded, expiring memo of the probes Seed runs have already made."""

    def __init__(
        self,
        *,
        ttl_seconds: float = UPLOAD_HANDSHAKE_REUSE_SECONDS,
        max_entries: int = UPLOAD_HANDSHAKE_MEMO_MAX_RUNS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Bind the reuse window, the size bound and the clock (injectable for tests)."""
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._clock = clock
        self._entries: OrderedDict[_MemoKey, _Remembered] = OrderedDict()

    def _fresh(self, key: _MemoKey) -> HandshakeResult | None:
        """Return the remembered probe for ``key`` while it is fresh, dropping it once stale."""
        remembered = self._entries.get(key)
        if remembered is None:
            return None
        if self._clock() >= remembered.expires_at:
            del self._entries[key]
            return None
        return remembered.result

    def _remember(self, key: _MemoKey, result: HandshakeResult) -> None:
        """Hold ``result`` for ``key``, letting the oldest run go past the bound."""
        self._entries[key] = _Remembered(result, self._clock() + self._ttl_seconds)
        self._entries.move_to_end(key)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)

    async def prepare(
        self, client: CreekVaultClient, *, owner_user_id: int, run_id: str | None
    ) -> None:
        """Leave ``client`` handshaken: from this run's probe if fresh, else by probing."""
        if run_id is None or not isinstance(client, AdoptsHandshake):
            await client.handshake()
            return
        key = (owner_user_id, client.base_url, run_id)
        remembered = self._fresh(key)
        if remembered is not None:
            client.adopt_handshake(remembered)
            return
        result = await client.handshake()
        if _worth_reusing(result):
            self._remember(key, result)

    def clear(self) -> None:
        """Drop every remembered probe."""
        self._entries.clear()

    def forget(self, client: CreekVaultClient, *, owner_user_id: int, run_id: str | None) -> None:
        """Drop this run's probe, so its next document asks the vault again."""
        if run_id is None or not isinstance(client, AdoptsHandshake):
            return
        self._entries.pop((owner_user_id, client.base_url, run_id), None)


#: The process's one memo, shared by every upload request.
UPLOAD_HANDSHAKE_MEMO: Final[UploadHandshakeMemo] = UploadHandshakeMemo()
