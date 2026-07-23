"""Tests for the Gumroad license-verification client (integrations.gumroad).

All Gumroad HTTP is mocked with ``httpx.MockTransport``; no test touches the
network.  The client contract: ``verify_license`` POSTs form fields to the
Gumroad verify endpoint, returns a parsed ``GumroadLicenseResult`` on success,
``None`` on Gumroad 404, retries a connection error exactly once, and never
logs the API token or license key.
"""

from __future__ import annotations

import logging
from urllib.parse import parse_qs

import httpx
import pytest

from integrations.gumroad import (
    GUMROAD_TIMEOUT_SECONDS,
    GumroadUnavailableError,
    verify_license,
)
from schemas.gumroad import GumroadLicenseResult

VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify"
PRODUCT_ID = "prod_abc123"
LICENSE_KEY = "AAAA1111-BBBB2222-CCCC3333-DDDD4444"  # pragma: allowlist secret
API_TOKEN = "gumroad-access-token-test-only"  # pragma: allowlist secret
EXPECTED_USES = 3


def _success_payload() -> dict[str, object]:
    """Build the JSON body Gumroad returns for a valid license."""
    return {
        "success": True,
        "uses": EXPECTED_USES,
        "purchase": {
            "email": "buyer@example.com",
            "product_id": PRODUCT_ID,
            "sale_id": "S-123",
            "refunded": False,
        },
    }


@pytest.mark.asyncio
async def test_verify_license_valid_returns_parsed_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A valid license yields a GumroadLicenseResult and a well-formed request."""
    monkeypatch.setenv("GUMROAD_API_TOKEN", API_TOKEN)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(httpx.codes.OK, json=_success_payload())

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    assert isinstance(result, GumroadLicenseResult)
    assert result.success is True
    assert result.uses == EXPECTED_USES
    assert result.purchase.email == "buyer@example.com"
    assert result.purchase.product_id == PRODUCT_ID
    assert result.purchase.sale_id == "S-123"
    assert result.purchase.refunded is False

    assert len(captured) == 1
    request = captured[0]
    assert str(request.url) == VERIFY_URL
    form = parse_qs(request.content.decode())
    assert form["product_id"] == [PRODUCT_ID]
    assert form["license_key"] == [LICENSE_KEY]
    assert form["access_token"] == [API_TOKEN]


@pytest.mark.asyncio
async def test_verify_license_gumroad_404_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Gumroad 404 (unknown license) returns None without any retry."""
    monkeypatch.setenv("GUMROAD_API_TOKEN", API_TOKEN)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            httpx.codes.NOT_FOUND,
            json={"success": False, "message": "That license does not exist."},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    assert result is None
    assert len(captured) == 1


@pytest.mark.asyncio
async def test_connect_error_is_retried_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A connection error triggers exactly one retry, then a normalized error."""
    monkeypatch.setenv("GUMROAD_API_TOKEN", API_TOKEN)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        raise httpx.ConnectError("connection refused", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(GumroadUnavailableError):
            await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    assert len(captured) == 2


@pytest.mark.asyncio
async def test_http_5xx_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 500 response surfaces a normalized error without any retry."""
    monkeypatch.setenv("GUMROAD_API_TOKEN", API_TOKEN)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(httpx.codes.INTERNAL_SERVER_ERROR, json={"success": False})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(GumroadUnavailableError):
            await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    assert len(captured) == 1


@pytest.mark.asyncio
async def test_http_4xx_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-404 4xx response surfaces a normalized error without any retry."""
    monkeypatch.setenv("GUMROAD_API_TOKEN", API_TOKEN)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(httpx.codes.UNAUTHORIZED, json={"success": False})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(GumroadUnavailableError):
            await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    assert len(captured) == 1


def test_client_timeout_is_five_seconds() -> None:
    """The module pins a 5-second timeout for its default httpx client."""
    assert GUMROAD_TIMEOUT_SECONDS == 5.0


@pytest.mark.asyncio
async def test_default_client_is_built_with_the_configured_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no injected client, a default client pinned to the 5s timeout is used."""
    monkeypatch.setenv("GUMROAD_API_TOKEN", API_TOKEN)
    real_async_client = httpx.AsyncClient
    captured_timeouts: list[object] = []

    def factory(*_args: object, **kwargs: object) -> httpx.AsyncClient:
        captured_timeouts.append(kwargs.get("timeout"))
        return real_async_client(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(httpx.codes.OK, json=_success_payload())
            )
        )

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    result = await verify_license(PRODUCT_ID, LICENSE_KEY)

    assert isinstance(result, GumroadLicenseResult)
    assert captured_timeouts == [httpx.Timeout(GUMROAD_TIMEOUT_SECONDS)]


@pytest.mark.asyncio
async def test_token_and_license_key_never_logged(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Neither the API token nor the license key appears in any log record."""
    monkeypatch.setenv("GUMROAD_API_TOKEN", API_TOKEN)
    caplog.set_level(logging.DEBUG)

    def success_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(httpx.codes.OK, json=_success_payload())

    async with httpx.AsyncClient(transport=httpx.MockTransport(success_handler)) as client:
        await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    def failing_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(failing_handler)) as client:
        with pytest.raises(GumroadUnavailableError):
            await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    assert API_TOKEN not in caplog.text
    assert LICENSE_KEY not in caplog.text
