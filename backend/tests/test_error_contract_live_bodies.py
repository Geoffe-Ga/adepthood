"""What a refusal actually puts on the wire, judged by its own published schema.

The direct regression for two ``response_schema_conformance`` failures a real
Schemathesis run raised against a live Postgres: ``GET /reflections/sources``
answers a malformed scope key with ``{"detail": "invalid_scope"}`` and
``PUT /vault/connection`` answers a URL with neither scheme nor host with
``{"detail": "vault_url_malformed"}``, while both operations declare a 422
whose ``detail`` is an array of validation entries.

The difference from ``tests/test_openapi_error_contract.py`` is that nothing
here is synthetic. The request is real, the refusal comes out of the router,
and the schema it is measured against is resolved out of that operation's own
``responses`` block -- which is the whole of what a contract fuzzer does.

The refusal code is asserted verbatim alongside the schema check on purpose.
Making the document admit a string is the fix; renaming ``invalid_scope`` to
something the array shape happens to accept would also make the fuzzer quiet,
and would break every client that switches on the code.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Any, Final

import pytest
from httpx import AsyncClient

from tests.helpers.openapi_errors import (
    declared_response_schema,
    live_document,
    response_validator,
)

# Judged by ``services.creek_vault_url.classify_vault_url`` as MALFORMED: it
# parses, and comes out with neither a scheme nor a host.
_MALFORMED_VAULT_URL: Final = "not a vault url"

# A credential the request schema accepts, so the URL is what gets refused.
_USABLE_VAULT_KEY: Final = "vault-key-0123456789"  # pragma: allowlist secret

# A scope key of no recognised shape, which ``domain.reflection_hierarchy``
# rejects for every level.
_UNPARSEABLE_SCOPE_KEY: Final = "not-a-scope"

_SIGNUP_PASSWORD: Final = "secret12345"  # pragma: allowlist secret


async def _auth_headers(client: AsyncClient, email: str) -> dict[str, str]:
    """Create an account through the real signup route and return its bearer header."""
    response = await client.post(
        "/auth/signup", json={"email": email, "password": _SIGNUP_PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _validate_against_declaration(
    document: dict[str, Any], method: str, path: str, status_code: int, body: object
) -> None:
    """Check ``body`` against the schema this very operation publishes for the status."""
    schema = declared_response_schema(document, method, path, status_code)
    response_validator(document, schema).validate(body)


@pytest.mark.asyncio
async def test_invalid_reflection_scope_body_matches_its_declared_422(
    async_client: AsyncClient,
) -> None:
    """A malformed scope key is refused as ``invalid_scope`` in a documented shape."""
    headers = await _auth_headers(async_client, "scope-contract@example.com")
    response = await async_client.get(
        "/reflections/sources",
        params={"level": "week", "scope_key": _UNPARSEABLE_SCOPE_KEY},
        headers=headers,
    )
    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert response.json() == {"detail": "invalid_scope"}
    _validate_against_declaration(
        live_document(), "get", "/reflections/sources", 422, response.json()
    )


@pytest.mark.asyncio
async def test_malformed_vault_url_body_matches_its_declared_422(
    async_client: AsyncClient,
) -> None:
    """A URL with no scheme or host is refused as ``vault_url_malformed``, documented."""
    headers = await _auth_headers(async_client, "vault-contract@example.com")
    response = await async_client.put(
        "/vault/connection",
        json={"vault_url": _MALFORMED_VAULT_URL, "api_key": _USABLE_VAULT_KEY},
        headers=headers,
    )
    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert response.json() == {"detail": "vault_url_malformed"}
    _validate_against_declaration(live_document(), "put", "/vault/connection", 422, response.json())


@pytest.mark.asyncio
async def test_schema_rejection_body_still_matches_its_declared_422(
    async_client: AsyncClient,
) -> None:
    """The other 422 shape must keep validating once the declaration widens.

    A Pydantic rejection sends the array of ``{type, loc, msg}`` entries. Both
    shapes genuinely occur on the same operation, so a declaration corrected to
    admit the string has to go on admitting this one -- otherwise the fix has
    only moved which half of the traffic is undocumented.
    """
    headers = await _auth_headers(async_client, "shape-contract@example.com")
    response = await async_client.put(
        "/vault/connection", json={"vault_url": "https://vault.example.com"}, headers=headers
    )
    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    detail = response.json()["detail"]
    assert isinstance(detail, list)
    assert all(set(entry) == {"type", "loc", "msg"} for entry in detail)
    _validate_against_declaration(live_document(), "put", "/vault/connection", 422, response.json())
