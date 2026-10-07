"""A user's writing never reaches a commercial, mail, identity or monitoring recipient (#3065).

The recipient register (:mod:`privacy.recipients`) marks which parties receive
content and which do not. This is the test that the "do not" half holds on the
wire: a unique synthetic sentinel is written through the flows that carry a
user's words -- a journal entry, a reflection on it, a feedback report -- and
then every recipient the register says receives no content is driven through
its real dial while every byte leaving the process is captured:

* Gumroad and Resend and the Creek provisioning control plane at httpx's last
  call before a socket (``AsyncHTTPTransport.handle_async_request``), so the
  URL, form and JSON each client really builds are what is read;
* the SMTP relay at ``smtplib.SMTP``, reading the serialised message;
* Sentry through the production client and a capturing transport, with the
  sentinel only in frame locals, request data and extras (message-borne
  canaries are B10's, in ``test_telemetry_sentinels.py``);
* the Google/Apple JWKS fetch at the URL opener PyJWT builds;
* every log record the whole run produced.

The sentinel must be absent from every capture, and every capture must be
non-empty and carry its own positive control -- an "absent" pass from a sink
that never fired would prove nothing.

The commercial half: the only offer and price surfaces at HEAD are
``GET /user/balance`` and ``GET /user/usage``; two accounts that differ only in
what they wrote must get byte-identical answers from both.
"""

from __future__ import annotations

import json
import logging
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.message import EmailMessage
from http import HTTPStatus
from pathlib import Path
from typing import Final, Self
from urllib.parse import parse_qs
from uuid import uuid4

import httpx
import pytest
import sentry_sdk
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import ec
from httpx import AsyncClient
from jwt.algorithms import ECAlgorithm

import sentry as error_monitoring
from domain.entitlements import PRODUCT_IDS_ENV_VAR
from main import app
from privacy.recipients import RECIPIENTS, DataClass, RecipientId
from services import creek_provisioning_client as provisioning_client
from services import journal_encryption
from services.creek_provisioning_client import (
    PROVISIONING_URL_ENV_VAR,
    HttpCreekProvisioningClient,
    get_creek_provisioning_client,
)
from services.email import (
    ResendEmailSender,
    SmtpEmailSender,
    get_email_sender,
    reset_email_sender_for_tests,
)
from services.managed_vault_rollout import (
    MANAGED_VAULT_ALERT_EMAIL_ENV_VAR,
    MANAGED_VAULT_ENABLED_ENV_VAR,
    MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR,
)
from services.oauth_apple import APPLE_JWKS_URL
from services.oauth_google import GOOGLE_JWKS_URL
from services.oidc import build_bounded_jwk_client
from tests.helpers.log_lines import assert_no_text
from tests.helpers.resend_env import RESEND_ENV_VALUES
from tests.helpers.sentry_capture import capturing_sentry
from tests.helpers.smtp_env import SMTP_ENV_VALUES

pytestmark = pytest.mark.real_license_gate

PASSWORD: Final = "securepassword123"  # pragma: allowlist secret
PRODUCT_ID: Final = "prod_canary"
LICENSE_A: Final = "CANA-0001-LICENSE-A"  # pragma: allowlist secret
LICENSE_B: Final = "CANA-0002-LICENSE-B"  # pragma: allowlist secret
GUMROAD_TOKEN: Final = "gumroad-canary-token"  # pragma: allowlist secret
CONTROL_URL: Final = "https://creek-control.canary.test"
CONTROL_HOST: Final = "creek-control.canary.test"
GUMROAD_HOST: Final = "api.gumroad.com"
RESEND_HOST: Final = "api.resend.com"
CONTRACT_HEADER: Final = "Creek-Provisioning-Version"
CONTRACT_VERSION: Final = "2.0.0"
PILOT_ACCOUNTS: Final = 100
APP_BASE_URL: Final = "https://app.canary.invalid"
ALERT_EMAIL: Final = "vault-alerts@example.com"

# One leg per register row that is dialled and receives no content. A recipient
# the register adds without a leg here fails the totality test below.
CANARY_LEGS: Final[dict[RecipientId, str]] = {
    RecipientId.GUMROAD: "licence verify at signup, after another account wrote the sentinel",
    RecipientId.RESEND: "password-reset mail over HTTPS",
    RecipientId.SMTP_RELAY: "password-reset mail over SMTP",
    RecipientId.CREEK_PROVISIONING: "managed-vault activation for the writing account",
    RecipientId.SENTRY: "an exception whose frame, request and extras hold the sentinel",
    RecipientId.GOOGLE_IDENTITY: "Google JWKS fetch",
    RecipientId.APPLE_IDENTITY: "Apple JWKS fetch",
}


@dataclass
class WireCapture:
    """Every request httpx put on the wire, answered per host, plus mail and JWKS fetches."""

    sentinel: str
    requests: list[tuple[str, str, bytes]] = field(default_factory=list)
    smtp_messages: list[bytes] = field(default_factory=list)
    jwks_requests: list[urllib.request.Request] = field(default_factory=list)
    sale_counter: int = 0

    def hosts(self) -> set[str]:
        """Every host httpx dialled."""
        return {host for host, _, _ in self.requests}

    def bodies_for(self, host: str) -> list[str]:
        """The decoded request bodies sent to ``host``."""
        return [body.decode() for h, _, body in self.requests if h == host]

    def blob(self) -> str:
        """Every captured byte, decoded, in one string."""
        parts = [f"{h} {u} {b.decode(errors='replace')}" for h, u, b in self.requests]
        parts += [m.decode(errors="replace") for m in self.smtp_messages]
        parts += [f"{r.full_url} {r.data!r} {r.header_items()!r}" for r in self.jwks_requests]
        return "\n".join(parts)

    def answer(self, request: httpx.Request) -> httpx.Response:
        """Record the request and answer it the way its real recipient would."""
        host = request.url.host
        body = request.read()
        self.requests.append((host, str(request.url), body))
        if host == GUMROAD_HOST:
            self.sale_counter += 1
            return httpx.Response(200, json=_gumroad_success(self.sale_counter), request=request)
        if host == RESEND_HOST:
            return httpx.Response(200, json={"id": "re_canary"}, request=request)
        if host == CONTROL_HOST:
            activation_id = str(json.loads(body)["activation_id"])
            return httpx.Response(
                202,
                json=_job_payload(activation_id),
                headers={CONTRACT_HEADER: CONTRACT_VERSION},
                request=request,
            )
        return httpx.Response(503, request=request)


def _gumroad_success(sale: int) -> dict[str, object]:
    return {
        "success": True,
        "uses": 1,
        "purchase": {
            "email": "buyer@example.com",
            "product_id": PRODUCT_ID,
            "sale_id": f"S-CANARY-{sale}",
            "refunded": False,
            "chargebacked": False,
        },
    }


def _job_payload(activation_id: str) -> dict[str, object]:
    stamp = datetime(2026, 10, 6, tzinfo=UTC).isoformat()
    return {
        "job_id": "job-canary",
        "activation_id": activation_id,
        "state": "pending",
        "attempts": 0,
        "retryable": False,
        "failure_reason": None,
        "created_at": stamp,
        "updated_at": stamp,
        "attested_confidential": None,
        "custody_mode": None,
        "status_url": "/control/v1/jobs/job-canary",
    }


class _RecordingSmtp:
    """Stands in for ``smtplib.SMTP``: performs nothing, keeps the serialised message."""

    sink: list[bytes]

    def __init__(self, host: str, port: int, timeout: float) -> None:
        del host, port, timeout

    def ehlo(self) -> None:
        """Accept the greeting."""

    def starttls(self) -> None:
        """Accept the upgrade."""

    def login(self, user: str, password: str) -> None:
        """Accept the credentials."""
        del user, password

    def send_message(self, message: EmailMessage) -> None:
        """Keep the bytes a relay would have received."""
        self.sink.append(message.as_bytes())

    def quit(self) -> None:
        """Close nothing."""


class _RecordingOpener:
    """Stands in for the opener PyJWT builds: records the request, serves a key set."""

    def __init__(self, sink: list[urllib.request.Request]) -> None:
        self.sink = sink

    def open(self, request: urllib.request.Request, timeout: float) -> _JwksResponse:
        """Record ``request`` and answer with a one-key JWK set."""
        del timeout
        self.sink.append(request)
        return _JwksResponse()


class _JwksResponse:
    """A context-managed response carrying a one-key JWK set."""

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self, *_: object) -> bytes:
        """The body PyJWT parses: one freshly minted public key."""
        public_key = ec.generate_private_key(ec.SECP256R1()).public_key()
        return json.dumps({"keys": [json.loads(ECAlgorithm.to_jwk(public_key))]}).encode()


@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[WireCapture]:
    """Capture every off-box byte and configure each non-content recipient for real."""
    capture = WireCapture(sentinel=f"SYNTHETIC_COMMERCIAL_CANARY_{uuid4().hex[:12]}")

    async def _handle(_self: httpx.AsyncHTTPTransport, request: httpx.Request) -> httpx.Response:
        return capture.answer(request)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _handle)
    _RecordingSmtp.sink = capture.smtp_messages
    monkeypatch.setattr("services.email.smtplib.SMTP", _RecordingSmtp)
    monkeypatch.setattr(
        urllib.request, "build_opener", lambda *_: _RecordingOpener(capture.jwks_requests)
    )

    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, PRODUCT_ID)
    monkeypatch.setenv("GUMROAD_API_TOKEN", GUMROAD_TOKEN)
    monkeypatch.setenv("APP_BASE_URL", APP_BASE_URL)
    for name, value in {**SMTP_ENV_VALUES, **RESEND_ENV_VALUES}.items():
        monkeypatch.setenv(name, value)

    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()
    control_token = tmp_path / "control-token"
    control_token.write_text("control-canary-token-" + "t" * 48, encoding="utf-8")
    control_token.chmod(0o400)
    handoff_token = tmp_path / "handoff-token"
    handoff_token.write_text("handoff-canary-token-" + "h" * 48, encoding="utf-8")
    handoff_token.chmod(0o400)
    monkeypatch.setattr(provisioning_client, "PROVISIONING_AUTH_FILE_PATH", control_token)
    monkeypatch.setattr(provisioning_client, "HANDOFF_AUTH_FILE_PATH", handoff_token)
    monkeypatch.setenv("CREEK_PROVISIONING_AUTH_FILE", str(control_token))
    monkeypatch.setenv("CREEK_PROVISIONING_HANDOFF_AUTH_FILE", str(handoff_token))
    monkeypatch.setenv(MANAGED_VAULT_ALERT_EMAIL_ENV_VAR, ALERT_EMAIL)
    monkeypatch.setenv(PROVISIONING_URL_ENV_VAR, CONTROL_URL)
    monkeypatch.setenv(MANAGED_VAULT_ENABLED_ENV_VAR, "true")
    monkeypatch.setenv(
        MANAGED_VAULT_PILOT_USER_IDS_ENV_VAR,
        ",".join(str(i) for i in range(1, PILOT_ACCOUNTS + 1)),
    )
    reset_email_sender_for_tests()
    try:
        yield capture
    finally:
        app.dependency_overrides.pop(get_email_sender, None)
        app.dependency_overrides.pop(get_creek_provisioning_client, None)
        reset_email_sender_for_tests()
        journal_encryption.reset_cache()


async def _signup(client: AsyncClient, email_address: str, license_key: str) -> dict[str, str]:
    response = await client.post(
        "/auth/signup",
        json={"email": email_address, "password": PASSWORD, "license_key": license_key},
    )
    assert response.status_code == HTTPStatus.OK, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _write_content(client: AsyncClient, headers: dict[str, str], text: str) -> None:
    """Carry ``text`` through every flow that holds a user's words."""
    entry = await client.post(
        "/journal/", json={"message": text, "classification": "personal"}, headers=headers
    )
    assert entry.status_code == HTTPStatus.CREATED, entry.text
    reflection = await client.post(f"/journal/{entry.json()['id']}/resonance", headers=headers)
    assert reflection.status_code == HTTPStatus.OK, reflection.text
    report = await client.post(
        "/feedback/",
        json={
            "category": "confusing",
            "impact": "can_continue",
            "summary": text,
            "context": {
                "screen": "journal.shelf",
                "platform": "web",
                "app_build": "1.4.2",
                "viewport_class": "regular",
            },
        },
        headers=headers,
    )
    assert report.status_code == HTTPStatus.CREATED, report.text


async def _request_reset(client: AsyncClient, email_address: str) -> None:
    response = await client.post("/auth/password-reset/request", json={"email": email_address})
    assert response.status_code == HTTPStatus.ACCEPTED, response.text


def _raise_with_sentinel_in_locals(sentinel: str) -> None:
    """Fail in a frame whose locals hold the sentinel."""
    body = sentinel
    if body:
        msg = "canary failure"
        raise RuntimeError(msg)


def test_every_noncontent_dialled_recipient_has_a_canary_leg() -> None:
    """A recipient the register says sees no content is driven below, or this fails."""
    expected = {r.id for r in RECIPIENTS.values() if r.dial_sites and not r.carries_content}

    assert set(CANARY_LEGS) == expected
    assert all(
        DataClass.CONTENT not in s.data_classes
        for rid in CANARY_LEGS
        for s in RECIPIENTS[rid].scopes
    )


@pytest.mark.asyncio
async def test_content_sentinel_never_reaches_commercial_or_monitoring_sinks(
    async_client: AsyncClient,
    wire: WireCapture,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The sentinel is written everywhere a user writes, and arrives nowhere it must not."""
    caplog.set_level(logging.DEBUG)
    sentinel = wire.sentinel
    writer = "canary-writer@example.com"

    headers = await _signup(async_client, writer, LICENSE_A)
    await _write_content(async_client, headers, sentinel)
    await _signup(async_client, "canary-later@example.com", LICENSE_B)

    app.dependency_overrides[get_email_sender] = ResendEmailSender.from_env
    await _request_reset(async_client, writer)
    app.dependency_overrides[get_email_sender] = SmtpEmailSender.from_env
    await _request_reset(async_client, writer)

    pool = httpx.AsyncClient()
    token = provisioning_client.PROVISIONING_AUTH_FILE_PATH.read_text(encoding="utf-8")
    app.dependency_overrides[get_creek_provisioning_client] = lambda: HttpCreekProvisioningClient(
        CONTROL_URL, token, pool
    )
    try:
        activation = await async_client.post("/vault/activation", headers=headers)
    finally:
        await pool.aclose()
    assert activation.status_code == HTTPStatus.ACCEPTED, activation.text

    with capturing_sentry(monkeypatch) as events:
        sentry_sdk.get_isolation_scope().set_extra("body", sentinel)
        sentry_sdk.get_isolation_scope().set_context("request", {"data": sentinel})
        try:
            _raise_with_sentinel_in_locals(sentinel)
        except RuntimeError as exc:
            error_monitoring.capture_exception(exc, request_id="canary-1", request_method="POST")
        sentry_sdk.get_isolation_scope().clear()
    for url in (GOOGLE_JWKS_URL, APPLE_JWKS_URL):
        build_bounded_jwk_client(url).fetch_data()

    # Positive controls: each sink fired, and fired with what it is meant to carry.
    assert wire.hosts() == {GUMROAD_HOST, RESEND_HOST, CONTROL_HOST}
    gumroad_keys = [parse_qs(b)["license_key"][0] for b in wire.bodies_for(GUMROAD_HOST)]
    assert gumroad_keys == [LICENSE_A, LICENSE_B]
    assert any(writer in body for body in wire.bodies_for(RESEND_HOST))
    assert wire.bodies_for(CONTROL_HOST)
    assert any(writer.encode() in message for message in wire.smtp_messages)
    assert [r.full_url for r in wire.jwks_requests] == [GOOGLE_JWKS_URL, APPLE_JWKS_URL]
    assert all(r.data is None for r in wire.jwks_requests)
    assert len(events) == 1
    assert events[0]["exception"]

    # The property: the sentinel reached none of them, nor any log line.
    assert sentinel not in wire.blob()
    assert sentinel not in json.dumps(events, default=str)
    assert sentinel not in json.dumps(events, default=str, ensure_ascii=False)
    assert caplog.records
    assert_no_text(caplog.records, sentinel)


@pytest.mark.asyncio
async def test_balance_and_usage_do_not_vary_with_content(async_client: AsyncClient) -> None:
    """The only price and offer surfaces answer two accounts alike whatever they wrote.

    The entries are the same length, so nothing but the words differs; the
    account-specific id is the only field that may, and neither surface carries it.
    """
    first_text = "I am thinking about leaving my job and moving home."
    second_text = "I am thinking about joining a band and buying gear."
    assert len(first_text) == len(second_text)

    answers: list[list[bytes]] = []
    for name, text in (("offer-a", first_text), ("offer-b", second_text)):
        signed = await async_client.post(
            "/auth/signup",
            json={"email": f"{name}@example.com", "password": PASSWORD, "license_key": LICENSE_A},
        )
        assert signed.status_code == HTTPStatus.OK, signed.text
        headers = {"Authorization": f"Bearer {signed.json()['token']}"}
        entry = await async_client.post(
            "/journal/", json={"message": text, "classification": "personal"}, headers=headers
        )
        assert entry.status_code == HTTPStatus.CREATED
        balance = await async_client.get("/user/balance", headers=headers)
        usage = await async_client.get("/user/usage", headers=headers)
        assert balance.status_code == HTTPStatus.OK
        assert usage.status_code == HTTPStatus.OK
        answers.append([balance.content, usage.content])

    assert answers[0] == answers[1]


@pytest.fixture(autouse=True)
def _gumroad_for_signup(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """Give tests that do not use ``wire`` a Gumroad that verifies, at the transport."""
    if "wire" in request.fixturenames:
        return
    capture = WireCapture(sentinel="unused")

    async def _handle(_self: httpx.AsyncHTTPTransport, req: httpx.Request) -> httpx.Response:
        return capture.answer(req)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _handle)
    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, PRODUCT_ID)
    monkeypatch.setenv("GUMROAD_API_TOKEN", GUMROAD_TOKEN)
