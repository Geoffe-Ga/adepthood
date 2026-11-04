"""Pace the seeds that spend the owner's generations, so the guard they meet stays a guard.

A margin note and its Resonance Letter exist only once a model has written them
(#3658), so the seed that makes one walks the real routes: an entry, a resonance
pass, a letter. Under the CI stub seam that is two generations of the owner's,
and the application admits **five generations a minute per user** (#623,
:data:`services.generation_guardrails.GENERATIONS_PER_MINUTE_PER_USER`). The
matrix runs as one owner, so seeding enough lettered notes walks straight into
that limit -- and the limit is a correct refusal, not something to switch off on
the instance under test.

So the seeds that spend a generation are *paced*, by two rules that only ever
make the harness wait:

* **Admission.** A paced create is sent only while the owner has spent fewer
  than :data:`PACED_PER_WINDOW` generations, by this ledger, in the last
  :data:`GENERATION_WINDOW_SECONDS`. That is one fewer than the server admits:
  the slot held back is the one a probe or a positive control may itself spend
  (``POST /journal/{entry_id}/resonance`` is probed), because a 429 on a probe
  still fails the run. The ledger stamps each create when its *response*
  arrives, which is never earlier than the server counted it, so the ledger
  never believes a slot is free before the server does.
* **Refusal.** A paced create answered 429 waits the ``Retry-After`` it was
  given (a full window when it gave none) and is sent again. That 429 is a seed
  waiting its turn, not a throttled probe, so it is tallied apart from the
  statuses the throttling guard reads.

Every wait counts against :data:`DEFAULT_MAX_PACING_SECONDS`. A wait that would
cross it raises :class:`PacingCapError`, which the runner reports as a harness
error -- exit 3, never a pass. The cap sits under the matrix's own time budget,
which still measures the whole run, waits included.

The clock and the sleep are parameters so a test can drive every branch without
waiting a minute; production uses the monotonic clock and ``asyncio.sleep``.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Final

from services.generation_guardrails import GENERATIONS_PER_MINUTE_PER_USER

#: The span the server's moving window counts generations over.
GENERATION_WINDOW_SECONDS: Final = 60.0

#: Generation slots the paced seeds leave free for a probe that spends one.
PROBE_RESERVE: Final = 1

#: How many paced creates the ledger admits per window.
PACED_PER_WINDOW: Final = GENERATIONS_PER_MINUTE_PER_USER - PROBE_RESERVE

#: The most a whole run may spend waiting on the owner's generation window.
#: Today's seeds need about one window; this leaves half a window of headroom
#: and stays under the matrix's 120-second budget.
DEFAULT_MAX_PACING_SECONDS: Final = 90.0

_RETRY_AFTER_HEADER: Final = "retry-after"

Clock = Callable[[], float]
Sleep = Callable[[float], Awaitable[None]]


class PacingCapError(Exception):
    """A paced seed would have waited past the run's pacing cap.

    The run cannot be finished without either waiting longer than it was given
    or sending a request the server would refuse, so it stops as a harness
    error rather than reporting coverage it never reached.
    """


@dataclass(frozen=True)
class PacingPolicy:
    """How the paced seeds of one run are admitted, and how long they may wait.

    Attributes:
        per_window: Paced creates the ledger admits per window.
        window_seconds: The span the window covers.
        max_wait_seconds: The most the run may spend waiting, in total.
        clock: A monotonic clock, in seconds.
        sleep: Waits the given number of seconds.
    """

    per_window: int = PACED_PER_WINDOW
    window_seconds: float = GENERATION_WINDOW_SECONDS
    max_wait_seconds: float = DEFAULT_MAX_PACING_SECONDS
    clock: Clock = time.monotonic
    sleep: Sleep = asyncio.sleep


@dataclass
class Pacer:
    """The ledger of one run's paced creates, and what they have cost in waiting.

    Attributes:
        policy: The rules this run follows.
        spent: When each recent paced create's response arrived, oldest first.
        waited_seconds: Every second spent waiting so far.
        refusals: How many paced creates were answered 429 and sent again.
    """

    policy: PacingPolicy
    spent: deque[float] = field(default_factory=deque)
    waited_seconds: float = 0.0
    refusals: int = 0

    def _expire(self, now: float) -> None:
        """Forget the creates that have left the window."""
        while self.spent and self.spent[0] + self.policy.window_seconds <= now:
            self.spent.popleft()

    async def admit(self) -> None:
        """Wait, if need be, until one more paced create fits in the window."""
        self._expire(self.policy.clock())
        while len(self.spent) >= self.policy.per_window:
            now = self.policy.clock()
            await self.wait(self.spent[0] + self.policy.window_seconds - now)
            self._expire(self.policy.clock())

    def record(self) -> None:
        """Stamp one paced create, now that its response has arrived."""
        self.spent.append(self.policy.clock())

    async def wait(self, seconds: float) -> None:
        """Wait ``seconds``, unless that would take the run past its cap.

        Raises:
            PacingCapError: When the wait would cross ``max_wait_seconds``. It
                is raised before sleeping, so a run that cannot finish says so
                at once rather than after the wait it was refused.
        """
        delay = max(seconds, 0.0)
        if self.waited_seconds + delay > self.policy.max_wait_seconds:
            msg = (
                f"seeding would wait {self.waited_seconds + delay:.1f}s on the owner's "
                f"generation window, past the {self.policy.max_wait_seconds:.1f}s pacing cap"
            )
            raise PacingCapError(msg)
        await self.policy.sleep(delay)
        self.waited_seconds += delay

    async def wait_out(self, headers: Mapping[str, str]) -> None:
        """Wait out one 429: its ``Retry-After``, or a whole window when it gave none."""
        self.refusals += 1
        advertised = retry_after_seconds(headers)
        await self.wait(self.policy.window_seconds if advertised is None else advertised)


def retry_after_seconds(headers: Mapping[str, str]) -> float | None:
    """Read a ``Retry-After`` given in whole seconds, or ``None`` when there is none to read.

    An HTTP-date form is treated as absent: this application only ever sends
    seconds, and guessing at a clock skew would be worse than waiting a window.
    """
    for name, value in headers.items():
        if name.lower() == _RETRY_AFTER_HEADER:
            text = value.strip()
            return float(text) if text.isdigit() else None
    return None
