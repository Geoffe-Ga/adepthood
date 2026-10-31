"""Parse optional authenticated agent discovery without changing content negotiation.

Creek 0.24 adds ``agent_mcp`` to its unversioned capability document. It is
per-allocation metadata, unlike the shared edge's RFC 9728 document. A bad or
absent extension hides the agent address; it never takes an otherwise usable
content vault offline. Values stay verbatim for exact resource/issuer matching.

The resource is either the shared edge's ``/mcp`` or, once Creek-Vault#2002
gives an allocation its own audience (owner decision R3-1), exactly
``/a/<32-character base64url slug>/mcp`` on that same origin. Nothing nearby --
another length, a nested path, percent-encoding -- is read as either.
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Mapping
from typing import Final, TypeGuard
from urllib.parse import SplitResult, urlsplit

from domain.creek_vault import AgentMcpDiscovery
from services.creek_vault_url import classify_vault_url
from services.creek_vault_url_user import classify_user_vault_url_host

AGENT_MCP_DISCOVERY_SINCE_MINOR: Final = (0, 24)
AGENT_MCP_URL_MAX_LENGTH: Final = 2048
_MINOR_MAX_LENGTH: Final = 16
_MINOR: Final = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
_UNSAFE_URL_CHARACTERS: Final = re.compile(r'[\x00-\x20\x7f"\\]')
_FIELDS: Final = frozenset({"resource", "authorization_server"})
SHARED_MCP_PATH: Final = "/mcp"
# Creek-Vault#2002 ``creek_mcp/mcp_path.py``: ``secrets.token_urlsafe(24)`` is
# exactly 32 base64url characters, and the router serves no other spelling.
ALLOCATION_SLUG_LENGTH: Final = 32
_ALLOCATION_MCP_PATH: Final = re.compile(rf"/a/[A-Za-z0-9_-]{{{ALLOCATION_SLUG_LENGTH}}}/mcp")
# Public discovery follows the producer's stricter inert-host contract; the
# user-URL guard separately combines its smaller suffix set with live DNS admission.
_LOCAL_SUFFIXES: Final = (
    ".localhost",
    ".local",
    ".localdomain",
    ".internal",
    ".lan",
    ".home",
    ".home.arpa",
)


def _published_extension(minor: object) -> bool:
    """Whether this discovery document speaks the extension's published vocabulary."""
    if not isinstance(minor, str) or len(minor) > _MINOR_MAX_LENGTH:
        return False
    match = _MINOR.fullmatch(minor)
    return match is not None and tuple(map(int, match.groups())) >= AGENT_MCP_DISCOVERY_SINCE_MINOR


def _bounded_url(value: object) -> TypeGuard[str]:
    """Bound untrusted strings and refuse whitespace before URL parsing can strip it."""
    return (
        isinstance(value, str)
        and value.isascii()
        and value.startswith("https://")
        and len(value) <= AGENT_MCP_URL_MAX_LENGTH
        and _UNSAFE_URL_CHARACTERS.search(value) is None
    )


def _https_parts(value: str) -> SplitResult | None:
    """Parse only credential-free HTTPS addresses with valid ports and no query/fragment."""
    try:
        parts = urlsplit(value)
        _ = parts.port
    except ValueError:
        return None
    if parts.scheme != "https" or classify_vault_url(value) is not None:
        return None
    return parts


def _public_dns_name(host: str) -> bool:
    """DNS names must be dotted, nonlocal, and free of alternate numeric IP forms."""
    return (
        "." in host
        and not host.endswith(_LOCAL_SUFFIXES)
        and not all(part.isdecimal() or part.startswith("0x") for part in host.split("."))
    )


def _public_host(host: str) -> bool:
    """Judge literal addresses and local names without performing DNS."""
    normalized = host.lower().rstrip(".")
    if "%" in normalized:
        return False
    if classify_user_vault_url_host(normalized) is not None:
        return False
    try:
        ipaddress.ip_address(normalized)
    except ValueError:
        return _public_dns_name(normalized)
    return True


def _public_https_url(value: object) -> TypeGuard[str]:
    """An inert, bounded public HTTPS URL; no lookup or dial happens here."""
    if not _bounded_url(value):
        return False
    parts = _https_parts(value)
    return parts is not None and _public_host(parts.hostname or "")


def _discovery_mapping(raw: object) -> TypeGuard[Mapping[str, object]]:
    """Exactly the published two fields; unknown metadata is never carried onward."""
    return isinstance(raw, Mapping) and set(raw) == _FIELDS


def _is_mcp_path(path: str) -> bool:
    """The shared edge path, or exactly one allocation's path on it."""
    return path == SHARED_MCP_PATH or _ALLOCATION_MCP_PATH.fullmatch(path) is not None


def _public_mcp_resource(value: object) -> TypeGuard[str]:
    """The producer serves MCP on its exact published path, never a redirect or subtree."""
    return _public_https_url(value) and _is_mcp_path(urlsplit(value).path)


def is_allocation_resource_of(candidate: str, shared_resource: str) -> bool:
    """Whether ``candidate`` is one allocation's resource on ``shared_resource``'s edge.

    Same scheme, host and port as the shared ``/mcp`` resource, with the exact
    ``/a/<slug>/mcp`` path. A shared resource with a path prefix has none: Creek
    serves the allocation path only at the origin's root.
    """
    shared = urlsplit(shared_resource)
    allocation = urlsplit(candidate)
    return (
        shared.path == SHARED_MCP_PATH
        and (allocation.scheme, allocation.netloc) == (shared.scheme, shared.netloc)
        and _ALLOCATION_MCP_PATH.fullmatch(allocation.path) is not None
        and not allocation.query
        and not allocation.fragment
    )


def parse_agent_mcp(raw: object, *, minor: object) -> AgentMcpDiscovery | None:
    """Read exactly the two public URLs, or disable only optional agent discovery."""
    if not _published_extension(minor) or not _discovery_mapping(raw):
        return None
    resource = raw.get("resource")
    issuer = raw.get("authorization_server")
    if not _public_mcp_resource(resource) or not _public_https_url(issuer):
        return None
    return AgentMcpDiscovery(resource=resource, authorization_server=issuer)


def owned_agent_resource(
    discovery: AgentMcpDiscovery | None, *, shared_resource: str, issuer: str
) -> str | None:
    """The advertised resource, if it is this account's edge and this authorization server.

    Either the shared edge resource the account's ``/v1`` URL derives, or one
    allocation's resource on that same edge. Which allocation is the caller's
    to settle: discovery was read with the account's own credential, and the
    adoption that stores it refuses a resource another account already holds.
    """
    if discovery is None or discovery.authorization_server != issuer:
        return None
    advertised = discovery.resource
    if advertised == shared_resource or is_allocation_resource_of(advertised, shared_resource):
        return advertised
    return None
