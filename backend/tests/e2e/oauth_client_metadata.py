"""Arrange Claude Code's fresh CIMD cache for the network-isolated e2e lane.

The journey must use Claude Code's real URL identifier, not register a DCR
client. Its metadata is an external boundary the lane cannot fetch from the
internet, so this arrange validates the vendor-shaped document and stores the
same cache row a successful fetch leaves. Authorize, code exchange, listing and
revoke run through the production CIMD path over real HTTP. Fetching, cache
expiry and destination guards remain covered by backend tests; this helper
claims no coverage of the external HTTPS fetch.

Run from ``backend`` with ``PYTHONPATH=src`` and ``DATABASE_URL`` pointing only
at the lane's throwaway database: ``python -m tests.e2e.oauth_client_metadata``.
No request-path callable is replaced, and no grant or authorization is seeded.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from database import normalize_database_url
from models.oauth_client import OAuthClient, OAuthClientSource
from services.oauth_client_metadata import parse_client_metadata_document
from services.oauth_clients import load_client

CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata"
REDIRECTS = ("http://localhost/callback", "http://127.0.0.1/callback")


async def _cache_document() -> dict[str, object]:
    """Store only the validated client document and return its registration shape."""
    document = json.dumps(
        {"client_id": CLIENT_ID, "client_name": "Claude Code", "redirect_uris": REDIRECTS}
    ).encode()
    metadata = parse_client_metadata_document(document, CLIENT_ID)
    if metadata is None:
        msg = "the Claude Code metadata fixture failed the production validator"
        raise ValueError(msg)
    engine = create_async_engine(
        normalize_database_url(os.environ["DATABASE_URL"]), poolclass=NullPool
    )
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            row = await load_client(session, CLIENT_ID)
            if row is None:
                row = OAuthClient(client_id=CLIENT_ID, source=OAuthClientSource.METADATA_DOCUMENT)
            row.client_name = metadata.client_name
            row.redirect_uris = list(metadata.redirect_uris)
            row.metadata_fetched_at = datetime.now(UTC)
            session.add(row)
            await session.commit()
            return {
                "client_id": row.client_id,
                "source": row.source,
                "redirect_uris": row.redirect_uris,
            }
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.stdout.write(json.dumps(asyncio.run(_cache_document())) + "\n")
