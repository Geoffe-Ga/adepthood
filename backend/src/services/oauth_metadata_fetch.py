"""Fetch a client metadata document: the one outbound call the authorization server makes.

When an agent's ``client_id`` is an ``https`` URL, the document at that URL *is*
the client (#3532). This module fetches it, under the limits that make an
attacker-chosen URL safe to dial from inside this server:

* **A budget.** Ten seconds for the whole fetch, redirects included -- the same
  budget Claude gives the whole authorization step, so a slow page cannot
  stall a sign-in past the point the agent has already given up.
* **A ceiling.** 64 KiB. A real document is a few hundred bytes; the cap is read
  incrementally, so an endless body costs this server 64 KiB and no more.
* **No redirects off the host.** A same-host ``https`` redirect is followed a
  few times, because hosting platforms add trailing slashes; anything else is a
  page sending this server somewhere its URL never named, and is refused.
* **No private destinations.** The URL's host is judged on sight by
  :func:`~services.oauth_client_metadata.is_metadata_document_client_id`, then
  resolved and pinned by
  :class:`~services.creek_vault_pinned_transport.PinnedDestinationTransport`,
  the same guard a user-supplied vault URL is dialled through. A name that
  resolves anywhere internal is refused as a name.

Every failure is the same ``None``. The caller tells the person the agent could
not be identified; what the remote page said, or why it could not be read, is
not this server's to repeat.

No credential of any kind travels on this request. The fetch is anonymous.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Final
from urllib.parse import urljoin, urlsplit

import httpx

from services.creek_vault_pinned_transport import build_pinned_destination_transport
from services.oauth_client_metadata import (
    ClientMetadata,
    is_metadata_document_client_id,
    parse_client_metadata_document,
)

logger = logging.getLogger(__name__)

#: The whole fetch, redirects included, in seconds.
METADATA_FETCH_BUDGET_SECONDS: Final = 10.0

#: The largest document read, in bytes.
MAX_METADATA_DOCUMENT_BYTES: Final = 64 * 1024

#: Same-host redirects followed before giving up.
MAX_SAME_HOST_REDIRECTS: Final = 3

_ACCEPT: Final = {"Accept": "application/json"}
_REFUSED_EVENT: Final = "oauth_client_metadata_unavailable"


def build_metadata_transport() -> httpx.AsyncBaseTransport:
    """Return the transport documents are fetched over: the pinning one.

    A function rather than a constant so tests can substitute a scripted
    transport without opening a socket.
    """
    return build_pinned_destination_transport()


def _same_host_redirect(current: str, location: str | None) -> str | None:
    """Return where a redirect points if it stays on this host over ``https``."""
    if not location:
        return None
    target = urljoin(current, location)
    if not is_metadata_document_client_id(target):
        return None
    if urlsplit(target).netloc != urlsplit(current).netloc:
        return None
    return target


async def _read_capped(response: httpx.Response) -> bytes | None:
    """Read the body, or ``None`` as soon as it passes the ceiling."""
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > MAX_METADATA_DOCUMENT_BYTES:
            return None
    return bytes(body)


async def _fetch_once(client: httpx.AsyncClient, url: str) -> tuple[bytes | None, str | None]:
    """Fetch ``url`` once: its body on a 200, or the next URL on a same-host redirect."""
    async with client.stream("GET", url, headers=_ACCEPT) as response:
        if response.is_redirect:
            return None, _same_host_redirect(url, response.headers.get("location"))
        if response.status_code != httpx.codes.OK:
            return None, None
        return await _read_capped(response), None


async def _fetch_body(url: str) -> bytes | None:
    """Follow at most a few same-host redirects to a body, or give up."""
    transport = build_metadata_transport()
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
        current: str | None = url
        for _ in range(MAX_SAME_HOST_REDIRECTS + 1):
            if current is None:
                return None
            body, current = await _fetch_once(client, current)
            if body is not None:
                return body
    return None


async def fetch_client_metadata(client_id: str) -> ClientMetadata | None:
    """Fetch and judge the document ``client_id`` names, or ``None`` if it cannot be used.

    The caller must not hold a database connection across this call: it waits
    on somebody else's server for up to the whole budget.
    """
    if not is_metadata_document_client_id(client_id):
        return None
    try:
        async with asyncio.timeout(METADATA_FETCH_BUDGET_SECONDS):
            body = await _fetch_body(client_id)
    except (TimeoutError, httpx.HTTPError):
        logger.info(_REFUSED_EVENT, extra={"reason": "unreachable"})
        return None
    if body is None:
        logger.info(_REFUSED_EVENT, extra={"reason": "unusable_response"})
        return None
    return parse_client_metadata_document(body, client_id)
