"""Parse optional authenticated agent discovery without changing content negotiation.

Creek 0.24 adds ``agent_mcp`` to its unversioned capability document. It is
per-allocation metadata, unlike the shared edge's RFC 9728 document. A bad or
absent extension hides the agent address; it never takes an otherwise usable
content vault offline. Values stay verbatim for exact resource/issuer matching.
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


def _public_mcp_resource(value: object) -> TypeGuard[str]:
    """The producer serves MCP on its exact published path, never a redirect or subtree."""
    return _public_https_url(value) and urlsplit(value).path == "/mcp"


def parse_agent_mcp(raw: object, *, minor: object) -> AgentMcpDiscovery | None:
    """Read exactly the two public URLs, or disable only optional agent discovery."""
    if not _published_extension(minor) or not _discovery_mapping(raw):
        return None
    resource = raw.get("resource")
    issuer = raw.get("authorization_server")
    if not _public_mcp_resource(resource) or not _public_https_url(issuer):
        return None
    return AgentMcpDiscovery(resource=resource, authorization_server=issuer)


def matching_agent_resource(
    discovery: AgentMcpDiscovery | None, *, resource: str, issuer: str
) -> str | None:
    """Expose only the owned resource, and only for this authorization server."""
    if discovery is None:
        return None
    advertised = (discovery.resource, discovery.authorization_server)
    return resource if advertised == (resource, issuer) else None
