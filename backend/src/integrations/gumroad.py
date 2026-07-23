"""Gumroad license-verification client.

``verify_license`` POSTs the form-encoded verify call Gumroad documents and
maps the outcome onto three states: a parsed :class:`GumroadLicenseResult`
(2xx), ``None`` (404 — unknown license, a normal answer, not a failure), or
:class:`GumroadUnavailableError` (anything else). Connection failures get
exactly one immediate retry; HTTP error responses get none.

Secrets discipline: the API token and license key travel only in the request
body. Every log line here is static text plus status/latency metadata — the
secrets are never interpolated anywhere loggable.
"""

from __future__ import annotations

import logging
import os
import time
from http import HTTPStatus

import httpx

from schemas.gumroad import GumroadLicenseResult

logger = logging.getLogger(__name__)

# Gumroad's documented license-verification endpoint (form-encoded POST).
GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify"

# Wall-clock budget for the default client. License checks sit on interactive
# paths, so a wedged Gumroad must fail fast rather than hold a request open.
GUMROAD_TIMEOUT_SECONDS: float = 5.0

# For latency reporting in log metadata.
_MS_PER_SECOND = 1000.0

# The single message every failure path raises with. Static on purpose: a
# dynamic message could accidentally echo the API token or license key into
# logs or client-visible error text.
_UNAVAILABLE_MESSAGE = "Gumroad license verification is unavailable"

# Failures that mean "we never reached Gumroad" — the only retriable class.
# An HTTP response, even a 5xx, means Gumroad answered; retrying would just
# hammer a struggling service.
_CONNECT_FAILURES = (httpx.ConnectError, httpx.ConnectTimeout)


class GumroadUnavailableError(Exception):
    """Normalized "Gumroad could not answer" failure.

    Raised after the single connection-error retry is exhausted, and for any
    non-404 4xx/5xx response. Callers get one exception type to handle; the
    static message keeps credentials out of error text.
    """


async def verify_license(
    product_id: str,
    license_key: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> GumroadLicenseResult | None:
    """Verify a license key against Gumroad's verify endpoint.

    Args:
        product_id: The Gumroad product the key should belong to.
        license_key: The key the user supplied.
        client: Optional preconfigured client (tests inject a MockTransport
            here). When omitted, a default client pinned to
            ``GUMROAD_TIMEOUT_SECONDS`` is created and closed per call; an
            injected client is never closed — its lifecycle belongs to the
            caller.

    Returns:
        The parsed result on 2xx, or ``None`` when Gumroad answers 404
        (license does not exist).

    Raises:
        GumroadUnavailableError: After the single connection-error retry is
            exhausted, or on any non-404 4xx/5xx response.
    """
    if client is not None:
        return await _verify_with_client(client, product_id, license_key)
    timeout = httpx.Timeout(GUMROAD_TIMEOUT_SECONDS)
    async with httpx.AsyncClient(timeout=timeout) as default_client:
        return await _verify_with_client(default_client, product_id, license_key)


async def _verify_with_client(
    client: httpx.AsyncClient,
    product_id: str,
    license_key: str,
) -> GumroadLicenseResult | None:
    """Build the form, POST with retry, and interpret Gumroad's answer."""
    form = {
        "product_id": product_id,
        "license_key": license_key,
        # Read at call time so a rotated token takes effect without a
        # process restart (and so tests can monkeypatch the environment).
        "access_token": os.getenv("GUMROAD_API_TOKEN", ""),
    }
    started = time.perf_counter()
    response = await _post_with_connect_retry(client, form)
    latency_ms = round((time.perf_counter() - started) * _MS_PER_SECOND, 1)
    return _interpret_response(response, latency_ms)


async def _post_with_connect_retry(
    client: httpx.AsyncClient,
    form: dict[str, str],
) -> httpx.Response:
    """POST the verification form, retrying a connection failure exactly once."""
    try:
        return await client.post(GUMROAD_VERIFY_URL, data=form)
    except _CONNECT_FAILURES:
        # The first attempt never reached Gumroad; one immediate retry
        # rescues transient DNS/TCP blips without hammering a down service.
        logger.info(
            "gumroad_verify_retrying",
            extra={"reason_code": "gumroad_connect_retry"},
        )
    try:
        return await client.post(GUMROAD_VERIFY_URL, data=form)
    except _CONNECT_FAILURES:
        logger.warning(
            "gumroad_verify_unreachable",
            extra={"reason_code": "gumroad_unreachable"},
        )
        # ``from None`` (not ``from exc``) mirrors ``services.creek_vault_client``:
        # the caught ``httpx.ConnectError`` carries a ``.request`` whose body is
        # the verify form -- it holds ``access_token`` and ``license_key``.
        # Chaining it would keep that Request reachable through ``__cause__`` for
        # any ``exc_info`` logger or error tracker, so the chain is severed and
        # only the static, credential-free message propagates.
        raise GumroadUnavailableError(_UNAVAILABLE_MESSAGE) from None


def _interpret_response(
    response: httpx.Response,
    latency_ms: float,
) -> GumroadLicenseResult | None:
    """Map Gumroad's HTTP answer onto the client's three-way contract.

    Log lines carry only status and latency — never the token or key.
    """
    status = response.status_code
    if response.is_success:
        logger.info(
            "gumroad_verify_completed",
            extra={
                "reason_code": "license_verified",
                "status_code": status,
                "latency_ms": latency_ms,
            },
        )
        return GumroadLicenseResult.model_validate(response.json())
    if status == HTTPStatus.NOT_FOUND:
        # "That license does not exist" is a normal answer, not an outage.
        logger.info(
            "gumroad_verify_completed",
            extra={
                "reason_code": "license_not_found",
                "status_code": status,
                "latency_ms": latency_ms,
            },
        )
        return None
    logger.warning(
        "gumroad_verify_failed",
        extra={
            "reason_code": "gumroad_error",
            "status_code": status,
            "latency_ms": latency_ms,
        },
    )
    raise GumroadUnavailableError(_UNAVAILABLE_MESSAGE)
