"""A vault URL handed over with its API version still attached reaches the same routes.

Creek's provisioning driver hands Adepthood its public route as
``https://<pilot>.fly.dev/v1``, while every path this adapter dials already
begins with ``/v1/``. Joined as-is the two produced ``/v1/v1/capabilities``,
which Creek's router answers ``404`` -- so every managed vault failed its
handshake in about a millisecond and every reflection degraded. These tests pin
the one normalisation both the client and the handoff now share.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient, MockTransport, Request, Response

from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_url import vault_base_url


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("https://vault.example.test/v1", "https://vault.example.test"),
        ("https://vault.example.test/v1/", "https://vault.example.test"),
        ("https://vault.example.test", "https://vault.example.test"),
        ("https://vault.example.test/", "https://vault.example.test"),
        ("https://vault.example.test/prefix/v1", "https://vault.example.test/prefix"),
        ("https://vault.example.test/prefix", "https://vault.example.test/prefix"),
        # Only a whole trailing ``v1`` segment is the API version.
        ("https://vault.example.test/v10", "https://vault.example.test/v10"),
        ("https://vault.example.test/apiv1", "https://vault.example.test/apiv1"),
        # A host spelled ``v1`` is a host, not a path segment.
        ("https://v1", "https://v1"),
        ("https://v1.example.test", "https://v1.example.test"),
    ],
)
def test_vault_base_url_drops_only_a_trailing_v1_path_segment(given: str, expected: str) -> None:
    """The version segment goes; hosts, prefixes and look-alike segments stay."""
    assert vault_base_url(given) == expected


@pytest.mark.asyncio
async def test_client_built_from_a_v1_url_dials_the_capabilities_route_once_prefixed() -> None:
    """The handshake reaches ``/v1/capabilities``, never ``/v1/v1/capabilities``."""
    dialled: list[str] = []

    def vault(request: Request) -> Response:
        dialled.append(request.url.path)
        return Response(HTTPStatus.SERVICE_UNAVAILABLE)

    async with AsyncClient(transport=MockTransport(vault)) as http:
        client = HttpCreekVaultClient(
            "https://vault.example.test/v1", "vault-key", http_client=http, pin_destination=False
        )
        await client.handshake()

    assert dialled == ["/v1/capabilities"]
