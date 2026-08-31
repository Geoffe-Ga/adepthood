"""Tests for the HTTPS email backend that replaces SMTP on a blocked network.

Railway blocks outbound SMTP below its Pro plan, so ``EMAIL_BACKEND=smtp`` on
the deployed service does not fail: it hangs for the adapter's 30-second connect
timeout and then answers 202 anyway, because the anti-enumeration contract
requires the endpoint to answer 202 whatever happened. Every symptom of that is
indistinguishable from delivery. The fix is a sender that reaches the provider
over HTTPS on 443 -- a port the platform does route -- rather than a plan
upgrade that keeps a transport the platform recommends against.

What these tests pin is the part a reviewer cannot check by reading: that the
HTTPS path is genuinely HTTPS and genuinely never touches ``smtplib``. Both
assertions are made from the same send, because a test that only proves no SMTP
socket was opened would also pass against a sender that does nothing at all.

The network is stubbed at ``httpx``'s real transport boundary --
``AsyncHTTPTransport.handle_async_request``, the last call before a socket --
rather than by replacing the sender's client or its ``send`` method. Everything
above that line is the code under test: the URL it builds, the headers it
attaches, the JSON it serialises, and the way it reads the response back. A stub
placed any higher would pass against a sender that was never called.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import httpx
import pytest

from services.email import (
    BACKEND_RESEND,
    EmailDeliveryError,
    EmailMessagePayload,
    ResendEmailSender,
    _build_default_sender,
    reset_email_sender_for_tests,
)
from tests.helpers.resend_env import RESEND_ENV_VALUES

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

# The wire value an operator types into the platform's variable editor. Pinned
# against the module constant so a rename cannot quietly invalidate every
# runbook and every deployed service that already carries it.
RESEND_BACKEND_NAME = "resend"

# Spellings ``configured_backend`` strips and lowercases into the same choice.
# The SMTP selector already accepts these; a second backend that did not would
# make the normalization a per-backend accident.
RESEND_BACKEND_SPELLINGS = ["resend", "RESEND", " Resend "]

# The transport this backend exists to use, and the only one it may use. 443 is
# named rather than written bare because the whole point of the change is which
# port the platform routes.
HTTPS_SCHEME = "https"
HTTPS_PORT = 443
RESEND_API_HOSTNAME = "api.resend.com"

# Two variables, one of them a credential. Named here as keys so the assertion
# below reads them out of the shared mapping rather than restating values.
CREDENTIAL_ENV_NAME = "RESEND_API_KEY"
FROM_ADDRESS_ENV_NAME = "EMAIL_FROM"

# A "from" address no other test uses, so a repr assertion cannot pass on a
# value something else in the suite happened to leave behind.
REPR_SENDER_ADDRESS = "relay-repr@adepthood.invalid"

# An API key long enough to be unmistakable if it ever renders into a log line,
# a repr, or an exception message.
REPR_CREDENTIAL_SENTINEL = "re_repr_must_never_render_9f31ba"  # pragma: allowlist secret

# A plaintext reset token, standing in for the one the recovery flow puts in the
# email body. It is the value that must survive nowhere except the wire.
TOKEN_SENTINEL = "tokenvalue-must-not-surface-7b21"  # pragma: allowlist secret

# Resend answers a rejected send with a JSON body that quotes the submitted
# fields back. That is realistic and it is the trap: an adapter that folds the
# response body into its exception message publishes the reset link into every
# log the exception reaches.
REJECTED_STATUS = 422
ACCEPTED_STATUS = 200

# A permanent redirect, which ``httpx`` returns as an ordinary response because
# ``follow_redirects`` defaults to False. It is the status a "below 400" check
# reports as delivery: the provider moving this endpoint, or an egress proxy
# answering 302, would silently evaporate every reset email while the endpoint
# kept answering 202. Non-2xx is the bar, not non-4xx.
REDIRECTED_STATUS = 308

# Every answer that is not a delivery, whatever its class.
UNDELIVERED_STATUSES = [REJECTED_STATUS, REDIRECTED_STATUS]


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Drop the process-wide singleton and clear the selector for each test."""
    reset_email_sender_for_tests()
    monkeypatch.delenv("EMAIL_BACKEND", raising=False)
    yield
    reset_email_sender_for_tests()


@pytest.fixture(autouse=True)
def _forbid_smtp(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail loudly if anything in this module reaches for an SMTP socket.

    The backend exists because the deployment cannot open one. A sender that
    still constructed ``smtplib.SMTP`` would hang for the connect timeout in
    production and answer 202 anyway, which is exactly the outage being fixed
    -- so it has to be an error here rather than a slow test.
    """

    def _refuse(*args: object, **kwargs: object) -> None:
        del args, kwargs
        msg = "the HTTPS email backend must never open an SMTP connection"
        raise AssertionError(msg)

    monkeypatch.setattr("services.email.smtplib.SMTP", _refuse)


def _set_resend_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a complete HTTPS provider from the shared mapping."""
    for name, value in RESEND_ENV_VALUES.items():
        monkeypatch.setenv(name, value)


def _capture_https(
    monkeypatch: pytest.MonkeyPatch,
    responder: Callable[[httpx.Request], httpx.Response],
) -> list[httpx.Request]:
    """Intercept httpx one call above the socket and return the recorded requests.

    ``AsyncHTTPTransport.handle_async_request`` is the last thing httpx calls
    before it connects, so everything the sender does -- build the URL, attach
    the credential, serialise the payload, read the status back -- runs for
    real. Patching the class rather than an instance keeps the stub agnostic
    about how the sender constructs its client.
    """
    recorded: list[httpx.Request] = []

    async def _handle(
        _transport: httpx.AsyncHTTPTransport,
        request: httpx.Request,
    ) -> httpx.Response:
        recorded.append(request)
        return responder(request)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _handle)
    return recorded


def _accepted(request: httpx.Request) -> httpx.Response:
    """Answer as the provider does on a queued send."""
    return httpx.Response(ACCEPTED_STATUS, json={"id": "queued"}, request=request)


def _request_payload(request: httpx.Request) -> dict[str, Any]:
    """Return the JSON body the sender put on the wire."""
    decoded: dict[str, Any] = json.loads(request.content)
    return decoded


def _sender() -> ResendEmailSender:
    """Build a sender directly, bypassing the environment."""
    return ResendEmailSender(
        api_key=REPR_CREDENTIAL_SENTINEL,
        from_address=REPR_SENDER_ADDRESS,
    )


def test_the_backend_name_is_the_value_operators_type() -> None:
    """The selector is a deployment setting, so its spelling is a contract.

    It is written into a platform variable editor by hand and quoted in the
    runbook. Renaming the constant without renaming the value would leave every
    deployed service selecting a backend the app no longer implements -- and an
    unrecognised name falls through to the console adapter, which is the outage.
    """
    assert BACKEND_RESEND == RESEND_BACKEND_NAME


@pytest.mark.parametrize("selector", RESEND_BACKEND_SPELLINGS)
def test_the_selector_builds_the_https_sender(
    selector: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``EMAIL_BACKEND=resend`` must reach the factory, casing and spaces included.

    The casing variants are not pedantry: every unrecognised value falls through
    to the console adapter, so a selector the factory does not normalise the way
    the startup check does is a boot certified as delivering whose mail goes to
    the log.
    """
    monkeypatch.setenv("EMAIL_BACKEND", selector)
    _set_resend_env(monkeypatch)

    sender = _build_default_sender()

    assert isinstance(sender, ResendEmailSender)
    assert sender.from_address == RESEND_ENV_VALUES[FROM_ADDRESS_ENV_NAME]


@pytest.mark.asyncio
async def test_send_goes_out_over_https_and_never_opens_an_smtp_socket(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The whole point of the backend, asserted from one send.

    Port 443 and the absence of ``smtplib`` are the same claim seen from two
    sides, and neither half is worth anything alone: proving no SMTP socket was
    opened would also pass against a sender that silently does nothing, so the
    recorded request is asserted first. The credential rides an Authorization
    header rather than the URL, because a query-string credential is copied into
    every proxy log between here and the provider.
    """
    recorded = _capture_https(monkeypatch, _accepted)
    payload = EmailMessagePayload(
        to="rcpt@adepthood.invalid",
        subject="Reset your Adepthood password",
        body=f"Reset: https://app.example/reset-password?token={TOKEN_SENTINEL}",
    )

    await _sender().send(payload, redact_for_log=TOKEN_SENTINEL)

    assert len(recorded) == 1, "the HTTPS sender must actually transmit"
    request = recorded[0]
    assert request.method == "POST"
    assert request.url.scheme == HTTPS_SCHEME
    assert request.url.host == RESEND_API_HOSTNAME
    assert (request.url.port or HTTPS_PORT) == HTTPS_PORT
    assert REPR_CREDENTIAL_SENTINEL not in str(request.url)
    assert REPR_CREDENTIAL_SENTINEL in request.headers["authorization"]


@pytest.mark.asyncio
async def test_send_transmits_the_body_verbatim_despite_the_redaction_hint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transmitting adapter must ignore ``redact_for_log`` -- the user needs the link.

    The hint exists for adapters that write the body to a log stream. An HTTPS
    sender that honoured it would deliver a truncated token, which is a reset
    email that cannot reset anything: delivery succeeds, the user is still
    locked out, and nothing reports a failure.
    """
    recorded = _capture_https(monkeypatch, _accepted)
    body = f"Reset: https://app.example/reset-password?token={TOKEN_SENTINEL}"
    payload = EmailMessagePayload(to="rcpt@adepthood.invalid", subject="Reset", body=body)

    await _sender().send(payload, redact_for_log=TOKEN_SENTINEL)

    sent = _request_payload(recorded[0])
    assert payload.to in json.dumps(sent["to"])
    assert sent["subject"] == payload.subject
    assert body in json.dumps(sent)


@pytest.mark.parametrize("missing", sorted(RESEND_ENV_VALUES))
def test_from_env_refuses_a_half_wired_provider(
    missing: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every required variable must raise by name, in the register of the SMTP build.

    Half-wired is worse than unconfigured because it looks configured. The
    production boot builds this sender eagerly for exactly that reason, and a
    refusal that does not name the variable moves the outage to whoever has to
    read the traceback.
    """
    _set_resend_env(monkeypatch)
    monkeypatch.delenv(missing, raising=False)

    with pytest.raises(RuntimeError, match=missing):
        ResendEmailSender.from_env()


def test_from_env_reads_both_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    """The configured case: the values reach the sender, not just the check."""
    _set_resend_env(monkeypatch)

    sender = ResendEmailSender.from_env()

    assert sender.from_address == RESEND_ENV_VALUES[FROM_ADDRESS_ENV_NAME]
    assert sender.api_key == RESEND_ENV_VALUES[CREDENTIAL_ENV_NAME]


@pytest.mark.asyncio
async def test_a_transport_failure_becomes_an_email_delivery_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Wire failures must arrive as the one narrow type the reset path swallows.

    ``_send_reset_email_safely`` catches ``EmailDeliveryError`` and nothing
    else, so that a downed provider cannot turn the hit path into a 500 while
    the miss path stays 202 -- which would leak account existence. A raw
    ``httpx.ConnectError`` escaping this adapter breaks that parity.
    """

    def _refused(request: httpx.Request) -> httpx.Response:
        msg = "connection refused"
        raise httpx.ConnectError(msg, request=request)

    _capture_https(monkeypatch, _refused)

    with pytest.raises(EmailDeliveryError):
        await _sender().send(
            EmailMessagePayload(to="rcpt@adepthood.invalid", subject="s", body="b"),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("status", UNDELIVERED_STATUSES)
async def test_an_answer_that_is_not_a_2xx_becomes_an_email_delivery_error(
    status: int,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Anything but a 2xx is a failed delivery, not a successful send.

    ``httpx`` returns a 4xx as an ordinary response, so an adapter that never
    inspects the status reports every rejection as a delivery -- the same
    "reports success while failing" shape the console default had, one layer
    down. The status must reach the exception so an operator can act on it.

    The redirect is the case a "status >= 400" check gets wrong, and it fails
    the same silent way: ``follow_redirects`` defaults to False, so a 3xx is
    returned here rather than chased, and reporting it as delivery would lose
    every reset email behind an endpoint move or an egress proxy while the API
    kept answering 202.
    """

    def _undelivered(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            json={"name": "validation_error", "message": "invalid to"},
            request=request,
        )

    _capture_https(monkeypatch, _undelivered)

    with pytest.raises(EmailDeliveryError, match=str(status)):
        await _sender().send(
            EmailMessagePayload(to="rcpt@adepthood.invalid", subject="s", body="b"),
        )


@pytest.mark.asyncio
async def test_a_rejected_send_leaks_neither_the_token_nor_the_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The provider echoes the submitted fields back; the exception must not pass them on.

    This is the realistic shape of the leak. The rejection body quotes the
    ``text`` field, which for this flow is the reset link, and an adapter that
    folds the response body into its message publishes a working credential into
    every log, Sentry event and traceback the exception reaches. The API key is
    checked in the same assertion because both live on the same code path out.
    """
    body = f"Reset: https://app.example/reset-password?token={TOKEN_SENTINEL}"

    def _echoing_rejection(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            REJECTED_STATUS,
            json={"name": "validation_error", "text": body},
            request=request,
        )

    _capture_https(monkeypatch, _echoing_rejection)

    with pytest.raises(EmailDeliveryError) as excinfo:
        await _sender().send(
            EmailMessagePayload(to="rcpt@adepthood.invalid", subject="s", body=body),
            redact_for_log=TOKEN_SENTINEL,
        )

    rendered = str(excinfo.value)
    assert TOKEN_SENTINEL not in rendered
    assert REPR_CREDENTIAL_SENTINEL not in rendered


def test_repr_hides_the_api_key_but_keeps_the_rest() -> None:
    """A repr is what a traceback, a log line and a debugger all print.

    The SMTP adapter already holds this line for its relay password. Blanking
    the whole repr would hide the credential and the diagnostic value with it,
    so the sending identity must survive.
    """
    rendered = repr(_sender())

    assert REPR_CREDENTIAL_SENTINEL not in rendered
    assert REPR_SENDER_ADDRESS in rendered
