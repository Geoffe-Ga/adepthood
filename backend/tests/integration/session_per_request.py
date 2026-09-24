"""A client whose every request opens its own PostgreSQL session.

The default ``pg_client`` hands each request the test's one shared session, which
is right for reading back what a request wrote and wrong for a race: two
requests on one session serialise on it and can never interleave. The races in
this package need what production has -- a pool, and a session per request --
so that two transactions really do run side by side.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


class SessionPerRequest:
    """The session factory the requests draw from, and the client that drives them."""

    def __init__(
        self,
        factory: async_sessionmaker[AsyncSession],
        client: AsyncClient,
    ) -> None:
        """Hold the factory (for the test's own reads and seeds) and the client."""
        self.factory = factory
        self.client = client
