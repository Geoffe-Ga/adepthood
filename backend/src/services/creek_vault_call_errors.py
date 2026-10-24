"""The exception sets that mean a vault call did not land.

Shared by :mod:`services.creek_vault_client` and the reads that live beside it
(:mod:`services.creek_vault_activity_wire`, #3535), so every ``except`` that
tells an absent vault from a slow one names the same two sets in the same
order. They are about the transport alone: nothing here knows a capability.
"""

from __future__ import annotations

import httpx

# Every way an httpx call can fail to land, whether it left this process or
# not. ``OSError`` covers connection and timeout errors (the whole-request
# deadline raises ``TimeoutError``, an ``OSError`` subclass), and
# ``httpx.HTTPError`` covers every transport and status failure.
# ``httpx.InvalidURL`` has to be named separately because it is *not* an
# ``HTTPError`` -- httpx raises it, from outside its own hierarchy, while
# building the request, so an unparseable vault URL would otherwise escape every
# degrade set and turn an optional replication into an exception on the caller's
# request path. A URL httpx cannot build a request for is unreachable in exactly
# the sense a refused connection is (the construction-time validator already
# refused the *unsafe* URLs, which is a different question), so it degrades the
# same way rather than raising.
HTTP_CALL_FAILED_ERRORS: tuple[type[Exception], ...] = (
    OSError,
    httpx.HTTPError,
    httpx.InvalidURL,
)

# The two ways a call can end because it ran out of time rather than because it
# failed to land. Both are already inside :data:`HTTP_CALL_FAILED_ERRORS` --
# ``TimeoutError`` is an ``OSError`` and ``httpx.TimeoutException`` is an
# ``httpx.HTTPError`` -- so every ``except`` that wants to tell a slow vault from
# an absent one has to name this set *first* or the wider one silently swallows
# it. The distinction is worth the ordering: an operator reading "unreachable"
# goes looking for a network that is up, while a timeout says the vault answered
# and could not finish, whose remedy is capacity rather than connectivity.
HTTP_CALL_TIMED_OUT_ERRORS: tuple[type[Exception], ...] = (
    TimeoutError,
    httpx.TimeoutException,
)
