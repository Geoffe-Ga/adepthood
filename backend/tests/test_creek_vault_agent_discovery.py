"""Optional 0.24 agent discovery never changes the pinned 0.22 content seam."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from http import HTTPStatus
from pathlib import Path

import httpx
import pytest
from jsonschema import Draft202012Validator

from domain.creek_vault import CONTRACT_VERSION, AgentMcpDiscovery, HandshakeResult
from services.creek_vault_agent_discovery import is_allocation_resource_of, owned_agent_resource
from services.creek_vault_client import HttpCreekVaultClient

_DISCOVERY = Path(__file__).parent / "fixtures" / "creek_discovery_0_24"
_RESOURCE = "https://pilot.vaults.example/mcp"
_ISSUER = "https://api.adepthood.example"
_BASE = (
    Path(__file__).parent / "fixtures" / "creek_v1" / "examples" / "capabilities" / "success.json"
)


def _payload(agent_mcp: object) -> dict[str, object]:
    """An unversioned 0.24 document that still serves 0.22 content."""
    payload = json.loads((_DISCOVERY / "agent-mcp-ready.json").read_text())
    assert isinstance(payload, dict)
    payload["agent_mcp"] = agent_mcp
    return payload


async def _handshake(payload: Mapping[str, object]) -> tuple[HandshakeResult, list[httpx.Request]]:
    """Read discovery through the real HTTP adapter, recording its request."""
    requests: list[httpx.Request] = []

    def _serve(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(HTTPStatus.OK, json=payload)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_serve)) as http:
        client = HttpCreekVaultClient(
            "https://pilot.vaults.example/v1", "test-credential", http_client=http
        )
        result = await client.handshake()
    return result, requests


@pytest.mark.asyncio
async def test_authenticated_discovery_is_unversioned_while_content_pin_stays_022() -> None:
    """The public agent address comes from this allocation, not shared edge metadata."""
    result, requests = await _handshake(
        _payload({"resource": _RESOURCE, "authorization_server": _ISSUER})
    )

    assert result.available
    assert result.agent_mcp is not None
    assert result.agent_mcp.resource == _RESOURCE
    assert result.agent_mcp.authorization_server == _ISSUER
    assert CONTRACT_VERSION == "0.22.0"
    assert len(requests) == 1
    assert requests[0].url.path == "/v1/capabilities"
    assert requests[0].headers["authorization"] == "Bearer test-credential"
    assert "x-creek-contract-version" not in requests[0].headers


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "metadata",
    [
        None,
        False,
        [],
        {},
        {"resource": _RESOURCE},
        {"resource": _RESOURCE, "authorization_server": _ISSUER, "extra": "discard me"},
        {"resource": 1, "authorization_server": _ISSUER},
        {"resource": _RESOURCE, "authorization_server": False},
        {"resource": "http://pilot.vaults.example/mcp", "authorization_server": _ISSUER},
        {"resource": "HTTPS://pilot.vaults.example/mcp", "authorization_server": _ISSUER},
        {"resource": _RESOURCE, "authorization_server": "HTTPS://api.adepthood.example"},
        {"resource": "https://127.0.0.1/mcp", "authorization_server": _ISSUER},
        {"resource": _RESOURCE, "authorization_server": "https://localhost"},
        {"resource": f"{_RESOURCE}?secret=value", "authorization_server": _ISSUER},
        {"resource": _RESOURCE, "authorization_server": f"{_ISSUER}#fragment"},
        {"resource": _RESOURCE + "\n", "authorization_server": _ISSUER},
        {"resource": _RESOURCE + "x" * 2048, "authorization_server": _ISSUER},
        {"resource": "https://pilot.vaults.example/other", "authorization_server": _ISSUER},
        {"resource": "https://pilot.vaults.example/mcp/", "authorization_server": _ISSUER},
        {
            "resource": "https://user:fake@pilot.vaults.example/mcp",  # pragma: allowlist secret
            "authorization_server": _ISSUER,
        },
        {"resource": "https://pilot.vaults.example:bad/mcp", "authorization_server": _ISSUER},
        {"resource": _RESOURCE + "?", "authorization_server": _ISSUER},
        {"resource": _RESOURCE + "#", "authorization_server": _ISSUER},
        {"resource": _RESOURCE, "authorization_server": " " + _ISSUER},
        {"resource": _RESOURCE, "authorization_server": _ISSUER + "\u202e"},
        {"resource": _RESOURCE, "authorization_server": _ISSUER + "x" * 2048},
    ],
)
async def test_bad_optional_discovery_hides_only_agent_address(metadata: object) -> None:
    """An old, disabled or malformed extension must not take writing offline."""
    result, _ = await _handshake(_payload(metadata))
    assert result.available
    assert result.capabilities
    assert result.agent_mcp is None


@pytest.mark.asyncio
async def test_old_discovery_response_with_no_extension_remains_usable() -> None:
    """Pre-extension allocations have no agent address and retain their content seam."""
    result, _ = await _handshake(json.loads(_BASE.read_text()))
    assert result.available
    assert result.agent_mcp is None


@pytest.mark.parametrize("name", ["agent-mcp-ready.json", "agent-mcp-unavailable.json"])
def test_canonical_producer_discovery_fixtures_match_the_published_schema(name: str) -> None:
    """The optional extension is a published producer shape, not a 0.22 content invention."""
    document = json.loads((_DISCOVERY / name).read_text())
    schema = json.loads((_DISCOVERY / "CapabilitiesResponse.schema.json").read_text())
    Draft202012Validator(schema).validate(document)
    assert document["vault"]["available"] is True
    assert document["contract_minor"] == "0.24"
    assert "0.22" in document["supported_contract_minors"]


@pytest.mark.asyncio
@pytest.mark.parametrize("minor", [None, False, "0.22", "0.23", "0.24.0", "00.24", "bad"])
async def test_unpublished_discovery_vocabulary_cannot_advertise_an_agent_address(
    minor: object,
) -> None:
    """A malformed minor changes only optional agent availability."""
    payload = _payload({"resource": _RESOURCE, "authorization_server": _ISSUER})
    payload["contract_minor"] = minor
    result, _ = await _handshake(payload)
    assert result.available
    assert result.agent_mcp is None


@pytest.mark.asyncio
async def test_discovery_preserves_a_valid_issuer_at_the_exact_published_bound() -> None:
    """A 2048-character public issuer stays verbatim rather than being shortened."""
    issuer = _ISSUER + "/" + "a" * (2048 - len(_ISSUER) - 1)
    result, _ = await _handshake(_payload({"resource": _RESOURCE, "authorization_server": issuer}))
    assert result.agent_mcp is not None
    assert result.agent_mcp.authorization_server == issuer


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "host",
    [
        "vault",
        "localhost.",
        "vault.localhost.",
        "vault.localdomain",
        "vault.local",
        "vault.internal",
        "vault.lan",
        "vault.home",
        "vault.home.arpa.",
        "192.168.1.1",
        "[2001:4860:4860::8888%25eth0]",
    ],
)
async def test_local_host_discovery_does_not_become_a_public_agent_address(host: str) -> None:
    """Private aliases and scoped addresses cannot be public discovery identifiers."""
    result, _ = await _handshake(
        _payload({"resource": f"https://{host}/mcp", "authorization_server": _ISSUER})
    )
    assert result.available
    assert result.agent_mcp is None


def test_discovery_files_match_the_canonical_producer_artifact_hashes() -> None:
    """A fixture edit must update its recorded producer evidence deliberately."""
    vendor = json.loads((_DISCOVERY / "vendor.json").read_text())
    assert vendor["discovery_minor"] == "0.24"
    assert vendor["content_minor"] == "0.22"
    for name, digest in vendor["sha256"].items():
        assert hashlib.sha256((_DISCOVERY / name).read_bytes()).hexdigest() == digest


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["resource", "authorization_server"])
@pytest.mark.parametrize("host", ["127.1", "0177.0.0.1", "0x7f.0.0.1", "0x7f.1", "127.1."])
async def test_alternate_numeric_hosts_are_not_public_discovery(field: str, host: str) -> None:
    """Match the producer's inert rejection of alternate IPv4 spellings in both URLs."""
    metadata = {"resource": _RESOURCE, "authorization_server": _ISSUER}
    metadata[field] = f"https://{host}" + ("/mcp" if field == "resource" else "")
    result, _ = await _handshake(_payload(metadata))
    assert result.available
    assert result.agent_mcp is None


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["resource", "authorization_server"])
@pytest.mark.parametrize("host", ["1.1.1.1", "[2606:4700:4700::1111]", "123.vaults.example"])
async def test_public_hosts_retain_verbatim_discovery(field: str, host: str) -> None:
    """Global literals and real DNS labels stay usable when numeric aliases are refused."""
    metadata = {"resource": _RESOURCE, "authorization_server": _ISSUER}
    metadata[field] = f"https://{host}" + ("/mcp" if field == "resource" else "")
    result, _ = await _handshake(_payload(metadata))
    assert result.agent_mcp is not None
    assert result.agent_mcp.resource == metadata["resource"]
    assert result.agent_mcp.authorization_server == metadata["authorization_server"]


@pytest.mark.asyncio
@pytest.mark.parametrize("keyless", [True, False, None])
async def test_agent_discovery_preserves_the_separate_funding_declaration(
    keyless: bool | None,
) -> None:
    """Both handshake extensions survive, including an OAuth-ready vault without a pool."""
    payload = _payload({"resource": _RESOURCE, "authorization_server": _ISSUER})
    payload["keyless_inference"] = keyless
    result, _ = await _handshake(payload)
    assert result.available
    assert result.agent_mcp is not None
    assert result.agent_mcp.resource == _RESOURCE
    assert result.keyless_inference is keyless
    assert result.refuses_keyless_inference() is (keyless is False)


# --- per-allocation resources (R3-1, Creek-Vault#2001/#2002) --------------------

_SLUG = "alice" + "_" * 27
_ALLOCATION = f"https://pilot.vaults.example/a/{_SLUG}/mcp"


@pytest.mark.asyncio
async def test_a_per_allocation_resource_is_read_verbatim() -> None:
    """Creek 0.24+ may advertise ``/a/<32-char slug>/mcp`` as this allocation's resource."""
    result, _ = await _handshake(
        _payload({"resource": _ALLOCATION, "authorization_server": _ISSUER})
    )
    assert result.agent_mcp is not None
    assert result.agent_mcp.resource == _ALLOCATION


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        f"/a/{_SLUG[:-1]}/mcp",
        f"/a/{_SLUG}x/mcp",
        f"/a/{_SLUG}/mcp/",
        f"/a/{_SLUG}/x/mcp",
        f"/a/{_SLUG}",
        "/a//mcp",
        f"/b/{_SLUG}/mcp",
        f"/x/a/{_SLUG}/mcp",
        f"/a/{_SLUG[:-3]}%2F/mcp",
        f"/a/{_SLUG[:-1]}=/mcp",
        f"/a/{_SLUG[:-1]}./mcp",
        f"/A/{_SLUG}/mcp",
        f"/a/{_SLUG}/MCP",
    ],
)
async def test_lookalike_allocation_paths_are_not_agent_resources(path: str) -> None:
    """Only the exact allocation grammar Creek's router serves, never a nearby path."""
    result, _ = await _handshake(
        _payload(
            {"resource": f"https://pilot.vaults.example{path}", "authorization_server": _ISSUER}
        )
    )
    assert result.available
    assert result.agent_mcp is None


@pytest.mark.parametrize(
    ("advertised", "issuer", "expected"),
    [
        (_RESOURCE, _ISSUER, _RESOURCE),
        (_ALLOCATION, _ISSUER, _ALLOCATION),
        (_RESOURCE, "https://other.issuer.example", None),
        (_ALLOCATION, "https://other.issuer.example", None),
        (f"https://other.vaults.example/a/{_SLUG}/mcp", _ISSUER, None),
        (f"https://pilot.vaults.example:8443/a/{_SLUG}/mcp", _ISSUER, None),
        ("https://other.vaults.example/mcp", _ISSUER, None),
    ],
)
def test_owned_agent_resource_is_the_shared_edge_or_one_allocation_on_it(
    advertised: str, issuer: str, expected: str | None
) -> None:
    """An allocation resource must sit on the same origin as the account's shared resource."""
    discovery = AgentMcpDiscovery(resource=advertised, authorization_server=issuer)
    assert owned_agent_resource(discovery, shared_resource=_RESOURCE, issuer=_ISSUER) == expected


def test_no_discovery_owns_no_resource() -> None:
    """An absent extension yields no address at all."""
    assert owned_agent_resource(None, shared_resource=_RESOURCE, issuer=_ISSUER) is None


def test_a_prefixed_shared_resource_has_no_allocation_resources() -> None:
    """Creek's allocation path sits at the origin root, so a prefixed vault has none."""
    shared = "https://pilot.vaults.example/tenant/mcp"
    discovery = AgentMcpDiscovery(resource=_ALLOCATION, authorization_server=_ISSUER)
    assert owned_agent_resource(discovery, shared_resource=shared, issuer=_ISSUER) is None
    nested = f"https://pilot.vaults.example/tenant/a/{_SLUG}/mcp"
    assert not is_allocation_resource_of(nested, shared)
    assert is_allocation_resource_of(_ALLOCATION, _RESOURCE)
