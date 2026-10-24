"""Shared steps for driving the vault-agent authorization flow through HTTP (#3532).

The router tests and the cross-tenant regression in ``tests/security/test_idor.py``
walk the same flow -- sign up, connect a vault, register an agent, ask to
authorize -- so the steps live once, here, and a change to the flow changes one
place.
"""

from __future__ import annotations

import base64
import hashlib
import re
from http import HTTPStatus
from typing import Final
from urllib.parse import parse_qs, urlsplit

from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from services.user_vault_config import store_vault_config

PASSWORD: Final = "securepassword123"  # pragma: allowlist secret
# RFC 7636 appendix B's published example verifier, and its S256 challenge.
VERIFIER: Final = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"  # pragma: allowlist secret
CHALLENGE: Final = (
    base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).rstrip(b"=").decode()
)
LOOPBACK_REDIRECT: Final = "http://127.0.0.1/callback"
PRESENTED_REDIRECT: Final = "http://127.0.0.1:3118/callback"
VAULT_KEY: Final = "vault-key-0123456789"  # pragma: allowlist secret
ISSUER: Final = "https://api.adepthood.example"

_TICKET: Final = re.compile(r'name="ticket" value="([^"]+)"')


def vault_url_for(name: str) -> str:
    """A distinct public vault ``/v1`` address per account."""
    return f"https://v-{name}.vaults.example/v1"


def mcp_url_for(name: str) -> str:
    """The MCP resource the vault at :func:`vault_url_for` serves."""
    return f"https://v-{name}.vaults.example/mcp"


async def signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int]:
    """Create an account through the real signup route; return its bearer header and id."""
    response = await client.post(
        "/auth/signup", json={"email": f"{name}@example.com", "password": PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK, response.text
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def connect_vault(db_session: AsyncSession, user_id: int, name: str) -> str:
    """Store a self-connected vault for ``user_id``; return its MCP resource."""
    await store_vault_config(db_session, user_id, vault_url=vault_url_for(name), api_key=VAULT_KEY)
    return mcp_url_for(name)


async def register_agent(
    client: AsyncClient, *, name: str = "Claude Code", redirect_uri: str = LOOPBACK_REDIRECT
) -> str:
    """Register a public client through the real registration route; return its id."""
    response = await client.post(
        "/oauth/register",
        json={
            "client_name": name,
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        },
    )
    assert response.status_code == HTTPStatus.CREATED, response.text
    return str(response.json()["client_id"])


def authorize_params(client_id: str, resource: str, **overrides: str) -> dict[str, str]:
    """A complete authorization query, with any field replaced."""
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": PRESENTED_REDIRECT,
        "code_challenge": CHALLENGE,
        "code_challenge_method": "S256",
        "state": "xyz",
        "scope": "vault:read vault:desk",
        "resource": resource,
    }
    params.update(overrides)
    return params


def ticket_from(page: Response) -> str:
    """The consent ticket a rendered decision page carries."""
    match = _TICKET.search(page.text)
    assert match is not None, page.text
    return match.group(1)


def redirect_query(response: Response) -> tuple[str, dict[str, str]]:
    """Split a redirect's ``Location`` into its address and single-valued query."""
    location = response.headers["location"]
    parts = urlsplit(location)
    query = {key: values[0] for key, values in parse_qs(parts.query).items()}
    return f"{parts.scheme}://{parts.netloc}{parts.path}", query


async def decide(client: AsyncClient, ticket: str, decision: str) -> Response:
    """Press Approve or Decline on a rendered consent page."""
    return await client.post(
        "/oauth/authorize/decision",
        data={"ticket": ticket, "decision": decision},
    )
