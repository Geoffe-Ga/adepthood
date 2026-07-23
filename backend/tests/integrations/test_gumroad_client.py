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
            "chargebacked": False,
        },
    }


# The canonical successful-verify example transcribed verbatim from Gumroad's
# own API docs (POST /v2/licenses/verify), captured from
# https://app.gumroad.com/api (Wayback snapshot 2024-12-28). The purchase
# object's reversal state is spelled exactly ``refunded``, ``disputed``,
# ``dispute_won``, and ``chargebacked`` there; the ``#`` inline comments in the
# published example are dropped here because JSON carries no comments. This
# fixture exists to break test circularity: it is sourced from the docs, not
# from our own schema, so a field-name drift with the real API fails CI here.
DOCUMENTED_VERIFY_EXAMPLE: dict[str, object] = {
    "success": True,
    "uses": 3,
    "purchase": {
        "seller_id": "kL0psVL2admJSYRNs-OCMg==",
        "product_id": "32-nPAicqbLj8B_WswVlMw==",
        "product_name": "licenses demo product",
        "permalink": "QMGY",
        "product_permalink": "https://sahil.gumroad.com/l/pencil",
        "email": "customer@example.com",
        "price": 0,
        "gumroad_fee": 0,
        "currency": "usd",
        "quantity": 1,
        "discover_fee_charged": False,
        "can_contact": True,
        "referrer": "direct",
        "card": {"visual": None, "type": None},
        "order_number": 524459935,
        "sale_id": "FO8TXN-dbxYaBdahG97Y-Q==",
        "sale_timestamp": "2021-01-05T19:38:56Z",
        "purchaser_id": "5550321502811",
        "subscription_id": "GDzW4_aBdQc-o7Gbjng7lw==",
        "variants": "",
        "license_key": "85DB562A-C11D4B06-A2335A6B-8C079166",  # pragma: allowlist secret
        "is_multiseat_license": False,
        "ip_country": "United States",
        "recurrence": "monthly",
        "is_gift_receiver_purchase": False,
        "refunded": False,
        "disputed": False,
        "dispute_won": False,
        "id": "FO8TXN-dvaYbBbahG97a-Q==",
        "created_at": "2021-01-05T19:38:56Z",
        "custom_fields": [],
        "chargebacked": False,
        "subscription_ended_at": None,
        "subscription_cancelled_at": None,
        "subscription_failed_at": None,
    },
}


def test_documented_verify_example_parses_with_all_reversal_flags() -> None:
    """The verbatim documented Gumroad example validates and is not reversed.

    Guards against a field-name drift between ``GumroadPurchase`` and Gumroad's
    real response: parsing the docs' own example must succeed and surface the
    documented ``refunded``/``disputed``/``dispute_won``/``chargebacked`` flags.
    """
    result = GumroadLicenseResult.model_validate(DOCUMENTED_VERIFY_EXAMPLE)

    assert result.success is True
    assert result.uses == EXPECTED_USES
    assert result.purchase.email == "customer@example.com"
    assert result.purchase.refunded is False
    assert result.purchase.disputed is False
    assert result.purchase.dispute_won is False
    assert result.purchase.chargebacked is False


def test_verify_response_missing_reversal_flags_parses_with_safe_defaults() -> None:
    """A purchase that omits every reversal flag parses; absence is not reversed.

    If Gumroad drops one of the reversal booleans from a response, the schema
    must degrade to "not known reversed" (all flags ``False``) rather than raise
    a ``ValidationError`` that would 500 the signup happy path.
    """
    payload = {
        "success": True,
        "uses": EXPECTED_USES,
        "purchase": {
            "email": "buyer@example.com",
            "product_id": PRODUCT_ID,
            "sale_id": "S-123",
        },
    }

    result = GumroadLicenseResult.model_validate(payload)

    assert result.purchase.refunded is False
    assert result.purchase.disputed is False
    assert result.purchase.dispute_won is False
    assert result.purchase.chargebacked is False


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
async def test_connect_timeout_is_retried_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A connect timeout stays in the retried bucket, not the wrapped-timeout one.

    ``ConnectTimeout`` is a sibling of ``ReadTimeout``/``WriteTimeout`` under
    httpx's ``TimeoutException``; this guards the seam that keeps it retried
    (never reached Gumroad) rather than failing fast like a post-send timeout.
    """
    monkeypatch.setenv("GUMROAD_API_TOKEN", API_TOKEN)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        raise httpx.ConnectTimeout("connect timed out", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(GumroadUnavailableError):
            await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    assert len(captured) == 2


@pytest.mark.asyncio
async def test_read_timeout_is_wrapped_without_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A read timeout wraps to a normalized error immediately, without a retry.

    A read/write timeout means Gumroad accepted the request then stalled, so the
    call may already have had a server-side effect; retrying it is unsafe, so the
    client fails fast with the normalized error instead of a second attempt.
    """
    monkeypatch.setenv("GUMROAD_API_TOKEN", API_TOKEN)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        raise httpx.ReadTimeout("read timed out", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(GumroadUnavailableError):
            await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    assert len(captured) == 1


@pytest.mark.asyncio
async def test_write_timeout_is_wrapped_without_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A write timeout is normalized the same way a read timeout is."""
    monkeypatch.setenv("GUMROAD_API_TOKEN", API_TOKEN)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        raise httpx.WriteTimeout("write timed out", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(GumroadUnavailableError):
            await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    assert len(captured) == 1


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

    def timeout_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(timeout_handler)) as client:
        with pytest.raises(GumroadUnavailableError):
            await verify_license(PRODUCT_ID, LICENSE_KEY, client=client)

    assert API_TOKEN not in caplog.text
    assert LICENSE_KEY not in caplog.text
