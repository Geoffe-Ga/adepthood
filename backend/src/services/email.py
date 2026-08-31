"""Email-sending port + adapters used by the password-recovery flow.

This module defines the smallest possible port -- a single ``send``
coroutine -- and two adapters:

* :class:`ConsoleEmailSender` (default, used in dev and tests) writes
  the rendered email to the application logger so a developer can copy
  the reset link out of terminal output.  The ``token`` portion of the
  link is redacted to its first 8 characters so a casual screen-share
  does not leak a working credential; tests use the recording fake
  below to capture the full payload.

* :class:`SmtpEmailSender` (gated by ``EMAIL_BACKEND=smtp``) speaks
  RFC 5321 to a configured relay.  Mandatory env: ``SMTP_HOST``,
  ``SMTP_PORT``, ``SMTP_USERNAME``, ``SMTP_PASSWORD``, ``EMAIL_FROM``.
  Each accessor raises ``RuntimeError`` on missing config so prod
  cannot boot a half-wired sender.

* :class:`ResendEmailSender` (gated by ``EMAIL_BACKEND=resend``) hands
  the message to Resend's HTTPS send API on port 443.  Mandatory env:
  ``RESEND_API_KEY``, ``EMAIL_FROM``.  It exists because the hosting
  platform blocks outbound SMTP below its paid tier, and it does so
  invisibly: the relay adapter above then hangs for its connect timeout
  and ``POST /auth/password-reset/request`` answers 202 anyway, so a
  correctly configured relay and a delivered email look identical from
  outside.  443 is a port the platform routes.

The :func:`get_email_sender` factory is the FastAPI dependency.  Tests
substitute :class:`RecordingEmailSender` so they can assert on every
outbound message without snooping the logger.
"""

from __future__ import annotations

import asyncio
import logging
import os
import smtplib
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)

# Number of plaintext token characters surfaced in console / log output.
# Long enough that a developer can spot which token they just minted in a
# busy log stream, short enough that the redacted form alone cannot be
# replayed to confirm a reset (the full token is 32 url-safe bytes).
_TOKEN_LOG_PREFIX = 8

# Public because the startup configuration check in ``main`` names this
# variable, and the backend names it compares against, back to the operator.
# A refusal that spells the variable differently from the string this module
# actually reads sends them to edit a setting nothing consults -- which is the
# outage the check exists to prevent, wearing the check's own message.
EMAIL_BACKEND_ENV_VAR = "EMAIL_BACKEND"
BACKEND_CONSOLE = "console"
BACKEND_SMTP = "smtp"
BACKEND_RESEND = "resend"


@dataclass(frozen=True, slots=True)
class EmailMessagePayload:
    """An outbound email -- plain-text only for now (HTML is a future epic)."""

    to: str
    subject: str
    body: str


class EmailDeliveryError(Exception):
    """Raised by an :class:`EmailSender` when wire delivery cannot complete.

    The anti-enumeration callers in ``routers.auth`` catch this to
    preserve identical 202 responses on hit and miss when the SMTP
    relay is unavailable, refuses the recipient, or times out.  Other
    exception types (``RuntimeError`` for missing config, programmer
    bugs, etc.) are intentionally NOT wrapped -- they propagate so
    they surface in error monitoring rather than silently disappear
    behind an anti-enumeration shield meant for transient outages.
    """


class EmailSender(Protocol):
    """Smallest viable email port -- a single async ``send`` method."""

    async def send(
        self,
        message: EmailMessagePayload,
        *,
        redact_for_log: str | None = None,
    ) -> None:
        """Deliver ``message``.  Adapters MUST raise on a hard failure.

        Anti-enumeration callers (the ``/auth/password-reset/request``
        handler) wrap this in a try/except so a transient SMTP outage
        cannot reveal whether the address was registered.

        ``redact_for_log`` is an optional plaintext substring that
        adapters which write the body to a log stream (e.g.
        :class:`ConsoleEmailSender`) MUST mask before logging.
        Adapters that only transmit (e.g. :class:`SmtpEmailSender`)
        ignore the hint -- the recipient needs the full link.  The
        keyword is required to be passed explicitly so the call site
        cannot silently forget when adding a new sender.
        """
        ...


def redact_token_in_body(body: str, plaintext_token: str | None) -> str:
    """Mask ``plaintext_token`` inside ``body`` for safe-to-log rendering.

    Returns ``body`` unchanged when ``plaintext_token`` is ``None`` /
    empty (e.g. the change-notification email carries no token).
    Adapters which write the body to a log stream call this from
    inside ``send`` after receiving ``redact_for_log`` from the
    caller; transmitting adapters (SMTP) ignore the hint and send
    the body verbatim because the recipient needs the full link.
    """
    if not plaintext_token:
        return body
    redacted = plaintext_token[:_TOKEN_LOG_PREFIX] + "..."
    return body.replace(plaintext_token, redacted)


@dataclass(slots=True)
class ConsoleEmailSender:
    """Dev / test adapter that logs the rendered email at INFO level.

    Redacts the ``redact_for_log`` substring (typically the plaintext
    reset token) inside the body BEFORE writing to the logger so a
    casual screen-share or recorded demo cannot leak a working
    credential.  When the caller passes ``redact_for_log=None`` the
    body is logged verbatim (e.g. the change-notification email
    carries no token).
    """

    async def send(
        self,
        message: EmailMessagePayload,
        *,
        redact_for_log: str | None = None,
    ) -> None:
        """Log ``message`` at INFO with ``redact_for_log`` masked in the body."""
        body = redact_token_in_body(message.body, redact_for_log)
        logger.info(
            "email_console_send",
            extra={
                "to_domain": message.to.split("@", 1)[-1] if "@" in message.to else "",
                "subject": message.subject,
                "body": body,
            },
        )


@dataclass(slots=True)
class RecordingEmailSender:
    """In-memory adapter for tests -- stores every outbound message verbatim."""

    sent: list[EmailMessagePayload] = field(default_factory=list)

    async def send(
        self,
        message: EmailMessagePayload,
        *,
        redact_for_log: str | None = None,
    ) -> None:
        """Append ``message`` to :attr:`sent` (verbatim) so tests can assert on it."""
        # Discard the redaction hint -- tests need to assert on the raw
        # body, and the keyword exists only for Protocol conformance.
        del redact_for_log
        self.sent.append(message)


def _required_env(name: str, backend: str) -> str:
    """Return a non-empty ``name`` or raise -- prod cannot boot without it.

    Unset and empty are one case on purpose: a variable exported as ``""`` is
    not a configured sender, and treating it as one only moves the failure to
    the first send.

    ``backend`` is the selector whose choice made ``name`` mandatory. It is a
    parameter rather than a constant because two backends now read required
    variables through here, and a refusal that told a ``resend`` operator to set
    ``EMAIL_BACKEND=smtp`` would send them to configure the transport the
    platform blocks.
    """
    value = os.getenv(name, "")
    if not value:
        selector = f"{EMAIL_BACKEND_ENV_VAR}={backend}"
        msg = f"{name} environment variable must be set when {selector}"
        raise RuntimeError(msg)
    return value


# Named once each so the tuple below and the lookups in ``from_env`` cannot
# spell the same variable two ways. The credential one is named for the role it
# fills rather than for the variable it points at: a module constant whose own
# identifier says PASSWORD reads to the security linters as a hardcoded
# credential, and this is a variable name, not a value.
SMTP_HOST_ENV_VAR = "SMTP_HOST"
SMTP_PORT_ENV_VAR = "SMTP_PORT"
SMTP_USERNAME_ENV_VAR = "SMTP_USERNAME"
SMTP_CREDENTIAL_ENV_VAR = "SMTP_PASSWORD"
EMAIL_FROM_ENV_VAR = "EMAIL_FROM"

# Every variable :meth:`SmtpEmailSender.from_env` reads, in the order it reads
# them. Public because the startup check in ``main`` quotes the list in its
# refusal: an operator told to set the backend switch and nothing else has only
# been moved to the next failure. One tuple, so the remedy an operator is handed
# cannot drift from the settings the sender actually requires.
SMTP_RELAY_ENV_VARS = (
    SMTP_HOST_ENV_VAR,
    SMTP_PORT_ENV_VAR,
    SMTP_USERNAME_ENV_VAR,
    SMTP_CREDENTIAL_ENV_VAR,
    EMAIL_FROM_ENV_VAR,
)


# The TCP port space, named because a bare 1 and 65535 in a comparison say
# nothing about what they bound, and because the refusal below quotes the range
# it enforces -- a range spelled twice is one that eventually disagrees with the
# sentence reporting it. Public for the reason ``MIN_IPV6_THROTTLE_PREFIX_LEN``
# is, with one difference worth stating: an unusable prefix length falls back to
# a default, because a bucket of the wrong width still throttles. A relay has no
# such default -- no port can be assumed to have something listening on it -- so
# a value outside these bounds is refused rather than replaced.
MIN_SMTP_PORT = 1
MAX_SMTP_PORT = 65535


def _parse_port(name: str, raw: str) -> int:
    """Read ``raw`` as an integer or refuse in the register of the missing-var raise.

    The bare ``int()`` this replaces failed just as hard and said only ``invalid
    literal for int() with base 10``, which names neither the variable nor the
    file it lives in. Since the relay is built at boot in production, that
    traceback is the whole of what an operator gets from a deploy that stopped.
    """
    try:
        return int(raw)
    except ValueError as exc:
        msg = (
            f"{name}={raw!r} is not a number, so no relay port can be read from it and "
            f"password recovery would fail on its first send. Set {name} to the TCP port "
            f"the relay listens on, between {MIN_SMTP_PORT} and {MAX_SMTP_PORT}. "
            "backend/.env.example and DEPLOYMENT.md document it."
        )
        raise RuntimeError(msg) from exc


def _required_port(name: str) -> int:
    """Return the relay port ``name`` configures, or refuse with a sentence.

    Three ways to be wrong, one kind of answer. Unset falls to
    :func:`_required_env` unchanged; unreadable and out-of-range are separated
    because an operator who typed ``eighty`` and one who typed ``70000`` are
    looking for different mistakes. The range check is what keeps a value that
    parses cleanly from building a healthy-looking sender that only fails at
    socket time, on the first user to ask for a reset -- which is the deferred
    failure the boot-time build exists to eliminate.
    """
    port = _parse_port(name, _required_env(name, BACKEND_SMTP))
    if not (MIN_SMTP_PORT <= port <= MAX_SMTP_PORT):
        msg = (
            f"{name}={port} is outside the connectable port range {MIN_SMTP_PORT}-"
            f"{MAX_SMTP_PORT}, so nothing can be dialled on it and password recovery "
            f"would fail on its first send. Set {name} to the TCP port the relay "
            "listens on. backend/.env.example and DEPLOYMENT.md document it."
        )
        raise RuntimeError(msg)
    return port


@dataclass(slots=True)
class SmtpEmailSender:
    """Production adapter that speaks RFC 5321 to a configured relay.

    Connects per-message; for the password-recovery cadence (a handful
    of mails per user lifetime) a connection pool is unnecessary
    overhead.  STARTTLS is mandatory -- ``_connect`` upgrades the plain
    connection unconditionally, so a relay that does not offer it raises
    -- then authenticates with whatever mechanism the server advertises
    for the configured credentials.
    """

    host: str
    port: int
    username: str
    password: str = field(repr=False)
    from_address: str

    @classmethod
    def from_env(cls) -> SmtpEmailSender:
        """Build an instance from the relay env vars; raise on the first missing one.

        :data:`SMTP_RELAY_ENV_VARS` is the one list both this build and the
        startup refusal read, so an operator is never handed a remedy shorter
        than what the sender needs. Each value is looked up by name rather than
        unpacked in order: an unpack is coupled to the tuple's length, which no
        type checker can see, so a sixth entry would land as ``too many values
        to unpack`` on a production boot -- fail-closed, but unreadable at
        exactly the moment someone is following the remedy. A name below that
        the tuple does not carry is a ``KeyError`` naming it, which keeps the
        two in step; an unset *variable* is the operator's case and raises
        ``RuntimeError`` from :func:`_required_env` instead. The comprehension
        preserves the tuple's order, so the variable the refusal lists first is
        still the first to raise.

        The port is the exception, and takes :func:`_required_port` after the
        strings rather than inside the comprehension: it is the only value that
        is not a string once validated, and reading it in both places would ask
        the environment for it twice. Unset still raises from
        :func:`_required_env`, so the missing-variable case is the same sentence
        it always was.
        """
        values = {
            name: _required_env(name, BACKEND_SMTP)
            for name in SMTP_RELAY_ENV_VARS
            if name != SMTP_PORT_ENV_VAR
        }
        return cls(
            host=values[SMTP_HOST_ENV_VAR],
            port=_required_port(SMTP_PORT_ENV_VAR),
            username=values[SMTP_USERNAME_ENV_VAR],
            password=values[SMTP_CREDENTIAL_ENV_VAR],
            from_address=values[EMAIL_FROM_ENV_VAR],
        )

    async def send(
        self,
        message: EmailMessagePayload,
        *,
        redact_for_log: str | None = None,
    ) -> None:
        """Send ``message`` via SMTP STARTTLS + AUTH PLAIN.

        ``smtplib`` is synchronous (RFC-5321 chatter, blocking sockets).
        FastAPI is async, so calling it directly inside ``async def``
        would freeze the entire asyncio event loop for the duration of
        the SMTP handshake -- typically 100 ms-2 s per message,
        capped at 30 s by the connect timeout.  Offload to a worker
        thread via :func:`asyncio.to_thread` so other in-flight
        requests keep moving.

        Wire failures (SMTP-level rejections, broken sockets, DNS
        resolution failures, connect timeouts) are converted to
        :class:`EmailDeliveryError` so callers can catch a single
        narrow type instead of a blind ``except Exception`` -- the
        latter would also swallow programmer bugs and configuration
        errors, which we want to surface loudly.
        """
        # Discard the redaction hint -- the recipient needs the full
        # link, and the keyword exists only for Protocol conformance.
        del redact_for_log
        try:
            await asyncio.to_thread(self._send_blocking, message)
        except (smtplib.SMTPException, OSError) as exc:
            msg = f"SMTP delivery failed: {type(exc).__name__}"
            raise EmailDeliveryError(msg) from exc

    def _send_blocking(self, message: EmailMessagePayload) -> None:
        """Synchronous body of :meth:`send` -- called via ``asyncio.to_thread``."""
        envelope = EmailMessage()
        envelope["From"] = self.from_address
        envelope["To"] = message.to
        envelope["Subject"] = message.subject
        envelope.set_content(message.body)
        with self._connect() as client:
            client.send_message(envelope)

    @contextmanager
    def _connect(self) -> Iterator[smtplib.SMTP]:
        """Open an authenticated SMTP session; close it on exit.

        RFC 3207 sequence: EHLO -> STARTTLS -> EHLO (re-negotiate
        capabilities under TLS) -> AUTH.  ``smtplib`` does not auto-
        send EHLO before ``starttls()`` -- relays that strictly
        enforce the RFC will hang or reject without it, even though
        looser ones tolerate the omission.  Calling ``ehlo()``
        explicitly costs one extra round-trip and removes the
        compatibility risk.
        """
        client = smtplib.SMTP(self.host, self.port, timeout=30)
        try:
            client.ehlo()
            client.starttls()
            client.ehlo()
            client.login(self.username, self.password)
            yield client
        finally:
            client.quit()


# Named once each so the tuple below and the lookups in ``from_env`` cannot
# spell the same variable two ways. The credential one is named for the role it
# fills rather than for the variable it points at, for the reason
# ``SMTP_CREDENTIAL_ENV_VAR`` is.
RESEND_CREDENTIAL_ENV_VAR = "RESEND_API_KEY"

# Every variable :meth:`ResendEmailSender.from_env` reads, in the order it reads
# them. Public for the same reason :data:`SMTP_RELAY_ENV_VARS` is: the startup
# refusal in ``main`` quotes the list, so an operator told to set the backend
# switch and nothing else has only been moved to the next failure.
RESEND_ENV_VARS = (
    RESEND_CREDENTIAL_ENV_VAR,
    EMAIL_FROM_ENV_VAR,
)

# Resend's documented send endpoint. HTTPS on the default port is the whole
# point of this adapter -- 443 is a port the hosting platform routes, and 587 is
# not.
RESEND_SEND_URL = "https://api.resend.com/emails"

# Wall-clock budget for one send. The reset handler awaits this inline, so a
# wedged provider must fail fast rather than hold the request open: the SMTP
# adapter's 30-second connect timeout is what turned a blocked network into a
# reset form that hangs on "Sending...".
RESEND_TIMEOUT_SECONDS: float = 10.0


@dataclass(slots=True)
class ResendEmailSender:
    """Production adapter that hands the message to Resend over HTTPS.

    Speaks the provider's JSON send API rather than SMTP, because the hosting
    platform blocks outbound SMTP below its paid tier and does so without any
    signal an application can read: the relay adapter simply stalls until its
    connect timeout, and the anti-enumeration contract answers 202 regardless.

    Secrets discipline follows :mod:`integrations.gumroad`. The API key travels
    in an ``Authorization`` header, never in the URL, because a query-string
    credential is copied into every proxy log between here and the provider.
    Every :class:`EmailDeliveryError` raised below carries a status code or an
    exception type name and nothing else -- the provider echoes the submitted
    ``text`` field back on a rejection, and that field is the reset link.
    """

    api_key: str = field(repr=False)
    from_address: str

    @classmethod
    def from_env(cls) -> ResendEmailSender:
        """Build an instance from :data:`RESEND_ENV_VARS`; raise on the first missing one.

        Reads by name out of the shared tuple for the reason
        :meth:`SmtpEmailSender.from_env` does: the list the startup refusal
        quotes and the list the sender actually needs have to be one list, and
        an unpack coupled to the tuple's length would land as ``too many values
        to unpack`` on a production boot -- fail-closed, but unreadable at
        exactly the moment someone is following the remedy.
        """
        values = {name: _required_env(name, BACKEND_RESEND) for name in RESEND_ENV_VARS}
        return cls(
            api_key=values[RESEND_CREDENTIAL_ENV_VAR],
            from_address=values[EMAIL_FROM_ENV_VAR],
        )

    async def send(
        self,
        message: EmailMessagePayload,
        *,
        redact_for_log: str | None = None,
    ) -> None:
        """POST ``message`` to Resend's send API and refuse anything but a 2xx.

        Wire failures and non-2xx answers both arrive as
        :class:`EmailDeliveryError` so the anti-enumeration callers keep
        catching a single narrow type. The status check is not optional
        bookkeeping: ``httpx`` returns a 4xx as an ordinary response, so an
        adapter that never inspected it would report every rejection as a
        delivery -- the console default's "reports success while failing" shape,
        one layer down.

        The test is "was it a 2xx", not "was it below 400". ``follow_redirects``
        defaults to ``False``, so a 3xx is returned here as an ordinary response
        and is never followed: the provider moving this endpoint behind a 308,
        or an egress proxy answering 302, would otherwise be reported as
        delivery while every reset email evaporated silently.
        """
        # Discard the redaction hint -- the recipient needs the full link, and
        # the keyword exists only for Protocol conformance.
        del redact_for_log
        timeout = httpx.Timeout(RESEND_TIMEOUT_SECONDS)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    RESEND_SEND_URL,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json=self._wire_payload(message),
                )
        except httpx.HTTPError as exc:
            msg = f"Resend delivery failed: {type(exc).__name__}"
            # ``from None`` severs the chain deliberately: the caught error
            # carries a ``.request`` whose body holds the reset link and whose
            # headers hold the API key, and any ``exc_info`` logger would
            # surface both.
            raise EmailDeliveryError(msg) from None
        if not response.is_success:
            msg = f"Resend rejected the message with HTTP {response.status_code}"
            raise EmailDeliveryError(msg)

    def _wire_payload(self, message: EmailMessagePayload) -> dict[str, object]:
        """Render ``message`` as the provider's send-request JSON."""
        return {
            "from": self.from_address,
            "to": [message.to],
            "subject": message.subject,
            "text": message.body,
        }


# Process-wide singleton so tests that override the dependency do not
# fight a fresh ConsoleEmailSender on every request.  ``None`` means
# "build the default backend lazily on first use".
_default_sender: EmailSender | None = None


def configured_backend() -> str:
    """Return the selected backend name, normalized the one way that counts.

    Exists so the startup check in ``main`` and this module's factory cannot
    disagree about what counts as ``smtp``.  A validator that re-read the
    variable with its own strip / lower semantics could certify a boot whose
    mail the factory then routes to the console adapter -- and every symptom of
    that would look like successful delivery.  One read, one normalization,
    shared by both callers.

    Unset, blank and whitespace all read as :data:`BACKEND_CONSOLE`, because
    that is where the factory sends them: the default is a real choice the
    caller can compare against, not an absence they have to re-derive.
    """
    return os.getenv(EMAIL_BACKEND_ENV_VAR, "").strip().lower() or BACKEND_CONSOLE


def _build_default_sender() -> EmailSender:
    """Return the configured backend, defaulting to console.

    ``console`` is the safe default for dev / test; ``smtp`` and ``resend`` flip
    to a delivering adapter and force every variable that adapter needs to be
    present (raising on first use is much more debuggable than silently dropping
    the email).  Every other value -- including a typo -- lands on console, which
    is why production refuses to boot on anything but a delivering backend.
    """
    backend = configured_backend()
    if backend == BACKEND_SMTP:
        return SmtpEmailSender.from_env()
    if backend == BACKEND_RESEND:
        return ResendEmailSender.from_env()
    return ConsoleEmailSender()


def get_email_sender() -> EmailSender:
    """FastAPI dependency: yield the process-wide email sender."""
    global _default_sender  # noqa: PLW0603 -- module-level cache by design
    if _default_sender is None:
        _default_sender = _build_default_sender()
    return _default_sender


def reset_email_sender_for_tests() -> None:
    """Drop the cached sender so the next ``get_email_sender`` rebuilds.

    Intended for pytest fixtures that want a clean adapter per test;
    production code never calls this.
    """
    global _default_sender  # noqa: PLW0603 -- test-only reset path
    _default_sender = None
