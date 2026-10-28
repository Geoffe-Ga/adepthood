"""Shared steps for driving the vault-agent authorization flow through HTTP (#3532).

The router tests and the cross-tenant regression in ``tests/security/test_idor.py``
walk the same flow -- sign up, connect a vault, register an agent, ask to
authorize, and (#3533) exchange the code -- so the steps live once, here, and a
change to the flow changes one place.
"""

from __future__ import annotations

import base64
import hashlib
import re
from http import HTTPStatus
from typing import Final
from urllib.parse import parse_qs, urlsplit

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from services.oauth_signing_keys import SIGNING_KEYS_ENV_VAR
from services.oauth_signing_keys import reset_cache as reset_signing_key_cache
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


async def decide(
    client: AsyncClient, ticket: str, decision: str, *, scopes: tuple[str, ...] | None = None
) -> Response:
    """Press a decision with explicit checkbox choices (all requested by default in tests)."""
    if scopes is None:
        try:
            claims = jwt.decode(ticket, options={"verify_signature": False})
            scopes = tuple(str(claims.get("sc", "")).split())
        except jwt.PyJWTError:
            scopes = ()
    return await client.post(
        "/oauth/authorize/decision",
        data={
            "ticket": ticket,
            "decision": decision,
            **{f"grant.{scope}": "on" for scope in scopes},
        },
    )


# --- the token endpoint (#3533) -------------------------------------------------


def generate_signing_key() -> ec.EllipticCurvePrivateKey:
    """A fresh P-256 private key, made per test so no key material is committed."""
    return ec.generate_private_key(ec.SECP256R1())


def pem_of(key: ec.EllipticCurvePrivateKey) -> str:
    """``key`` as the unencrypted PKCS#8 PEM ``OAUTH_SIGNING_KEYS`` carries."""
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def install_signing_keys(
    monkeypatch: pytest.MonkeyPatch, *keys: ec.EllipticCurvePrivateKey
) -> tuple[ec.EllipticCurvePrivateKey, ...]:
    """Configure ``keys`` (newest first) as the deployment's signing keys."""
    chosen = keys or (generate_signing_key(),)
    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, ",".join(pem_of(key) for key in chosen))
    reset_signing_key_cache()
    return chosen


async def approved_code(
    client: AsyncClient,
    db_session: AsyncSession,
    name: str,
    *,
    scope: str = "vault:read vault:desk",
) -> tuple[str, str, str, int]:
    """Walk the whole consent flow for a fresh account; return code, client, resource, account."""
    headers, user_id = await signup(client, name)
    resource = await connect_vault(db_session, user_id, name)
    client_id = await register_agent(client)
    code = await approve(client, headers, client_id, resource, scope=scope)
    return code, client_id, resource, user_id


async def approve(
    client: AsyncClient,
    headers: dict[str, str],
    client_id: str,
    resource: str,
    *,
    scope: str = "vault:read vault:desk",
) -> str:
    """Land on the consent page as the signed-in account, press Approve, return the code."""
    page = await client.get(
        "/oauth/authorize",
        params=authorize_params(client_id, resource, scope=scope),
        headers=headers,
    )
    assert page.status_code == HTTPStatus.OK, page.text
    approved = await decide(client, ticket_from(page), "approve")
    assert approved.status_code == HTTPStatus.SEE_OTHER, approved.text
    _address, query = redirect_query(approved)
    return query["code"]


def code_exchange_form(code: str, client_id: str, /, **overrides: str) -> dict[str, str]:
    """A complete ``authorization_code`` token request, with any field replaced."""
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "code_verifier": VERIFIER,
        "client_id": client_id,
        "redirect_uri": PRESENTED_REDIRECT,
    }
    form.update(overrides)
    return form


async def exchange(client: AsyncClient, form: dict[str, str]) -> Response:
    """POST ``form`` to the token endpoint, form-encoded as every OAuth client sends it."""
    return await client.post("/oauth/token", data=form)
