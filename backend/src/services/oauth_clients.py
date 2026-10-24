"""The registry of vault agents: registering one, and finding one by its ``client_id``.

Two kinds of client share one table (#3532), and :func:`resolve_client` is the
one place that tells them apart:

* A **registered** client was given a ``cl_`` identifier by
  :func:`register_client`. Its row is the whole record and is never fetched.
* A **metadata document** client's identifier is an ``https`` URL. The document
  at that URL is the authority, and its row is a cache: fresh for
  :data:`METADATA_DOCUMENT_TTL`, fetched again after that. A document that can no
  longer be fetched is a client that can no longer be identified, so a stale
  copy is not served in its place.

A ``client_id`` of neither shape -- or a ``cl_`` one nobody was issued -- names
no client, and every caller treats that the same way: it never redirects
anywhere on that client's behalf.

**The connection is given up before the fetch.** A document fetch waits on
somebody else's server for up to ten seconds; holding a pooled database
connection across that would let a handful of slow agent pages starve every
other request of the pool. :func:`resolve_client` commits before it dials, and
reads and writes again on a fresh checkout afterwards.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.oauth_client import OAuthClient, OAuthClientSource
from services.oauth_client_metadata import ClientMetadata, is_metadata_document_client_id
from services.oauth_metadata_fetch import fetch_client_metadata

#: Prefix on every identifier this server mints, so a registered client can never
#: be mistaken for a metadata document URL and the two never collide.
REGISTERED_CLIENT_PREFIX: Final = "cl_"

# 16 bytes: an identifier, not a secret, but unguessable all the same so the
# registry cannot be walked.
_CLIENT_ID_BYTES: Final = 16

#: How long a fetched metadata document is trusted before it is fetched again.
#: An hour keeps a busy agent from re-fetching on every sign-in while letting a
#: changed redirect list take effect the same day.
METADATA_DOCUMENT_TTL: Final = timedelta(hours=1)


def mint_client_id() -> str:
    """Return a fresh registered-client identifier."""
    return f"{REGISTERED_CLIENT_PREFIX}{secrets.token_urlsafe(_CLIENT_ID_BYTES)}"


async def register_client(
    session: AsyncSession, metadata: ClientMetadata, *, now: datetime | None = None
) -> OAuthClient:
    """Store a validated dynamic registration and return the new client."""
    client = OAuthClient(
        client_id=mint_client_id(),
        client_name=metadata.client_name,
        logo_uri=metadata.logo_uri,
        redirect_uris=list(metadata.redirect_uris),
        source=OAuthClientSource.DYNAMIC_REGISTRATION.value,
        created_at=now or datetime.now(UTC),
    )
    session.add(client)
    await session.commit()
    await session.refresh(client)
    return client


async def load_client(session: AsyncSession, client_id: str) -> OAuthClient | None:
    """Return the stored row for ``client_id`` without fetching anything."""
    result = await session.execute(select(OAuthClient).where(OAuthClient.client_id == client_id))
    return result.scalars().first()


def _is_fresh(client: OAuthClient | None, now: datetime) -> bool:
    """Whether a cached document exists and was fetched recently enough to trust."""
    fetched = None if client is None else client.metadata_fetched_at
    if fetched is None:
        return False
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=UTC)
    return now - fetched < METADATA_DOCUMENT_TTL


def _apply_document(
    client: OAuthClient | None, client_id: str, metadata: ClientMetadata, now: datetime
) -> OAuthClient:
    """Write a freshly fetched document onto its cache row, creating it if needed."""
    row = client or OAuthClient(
        client_id=client_id,
        client_name=metadata.client_name,
        source=OAuthClientSource.METADATA_DOCUMENT.value,
        created_at=now,
    )
    row.client_name = metadata.client_name
    row.logo_uri = metadata.logo_uri
    row.redirect_uris = list(metadata.redirect_uris)
    row.metadata_fetched_at = now
    return row


async def _store_document(
    session: AsyncSession, client_id: str, metadata: ClientMetadata, now: datetime
) -> OAuthClient | None:
    """Cache a fetched document, tolerating a concurrent sign-in that cached it first."""
    row = _apply_document(await load_client(session, client_id), client_id, metadata, now)
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        # Another request inserted the same client between our read and our
        # write. Its row holds the same document; read it rather than fail.
        await session.rollback()
        return await load_client(session, client_id)
    await session.refresh(row)
    return row


async def _registered_client(session: AsyncSession, client_id: str) -> OAuthClient | None:
    """Return a dynamically registered client, and only that kind, for ``client_id``."""
    stored = await load_client(session, client_id)
    if stored is None or stored.source != OAuthClientSource.DYNAMIC_REGISTRATION:
        return None
    return stored


async def resolve_client(
    session: AsyncSession, client_id: str, *, now: datetime | None = None
) -> OAuthClient | None:
    """Return the client ``client_id`` names, fetching its document if it needs one.

    ``None`` means the identifier names no client this server can serve: never
    issued, or a document that could not be fetched or did not validate.
    """
    current = now or datetime.now(UTC)
    if not is_metadata_document_client_id(client_id):
        return await _registered_client(session, client_id)
    cached = await load_client(session, client_id)
    if _is_fresh(cached, current):
        return cached
    # Release the pooled connection before waiting on the agent's own server.
    await session.commit()
    metadata = await fetch_client_metadata(client_id)
    if metadata is None:
        return None
    return await _store_document(session, client_id, metadata, current)
