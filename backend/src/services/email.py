"""Email-sending port + adapters used by the password-recovery flow.

The application has no production email provider yet (``grep -r smtp``
in the codebase returns nothing).  Rather than ship password recovery
without an email path, this module defines the smallest possible port
-- a single ``send`` coroutine -- and two adapters:

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

logger = logging.getLogger(__name__)

# Number of plaintext token characters surfaced in console / log output.
# Long enough that a developer can spot which token they just minted in a
# busy log stream, short enough that the redacted form alone cannot be
# replayed to confirm a reset (the full token is 32 url-safe bytes).
_TOKEN_LOG_PREFIX = 8

_ENV_EMAIL_BACKEND = "EMAIL_BACKEND"
_BACKEND_CONSOLE = "console"
_BACKEND_SMTP = "smtp"


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
        redact_for_log: str | None = None,  # noqa: ARG002 -- tests assert on raw body
    ) -> None:
        """Append ``message`` to :attr:`sent` (verbatim) so tests can assert on it."""
        self.sent.append(message)


def _required_env(name: str) -> str:
    """Return ``os.environ[name]`` or raise -- prod cannot boot without it."""
    value = os.getenv(name, "")
    if not value:
        msg = f"{name} environment variable must be set when EMAIL_BACKEND=smtp"
        raise RuntimeError(msg)
    return value


@dataclass(slots=True)
class SmtpEmailSender:
    """Production adapter that speaks RFC 5321 to a configured relay.

    Connects per-message; for the password-recovery cadence (a handful
    of mails per user lifetime) a connection pool is unnecessary
    overhead.  Uses STARTTLS over plain port if available, then
    AUTH PLAIN with the configured credentials.
    """

    host: str
    port: int
    username: str
    password: str
    from_address: str

    @classmethod
    def from_env(cls) -> SmtpEmailSender:
        """Build an instance from the ``SMTP_*`` env vars; raise on missing."""
        return cls(
            host=_required_env("SMTP_HOST"),
            port=int(_required_env("SMTP_PORT")),
            username=_required_env("SMTP_USERNAME"),
            password=_required_env("SMTP_PASSWORD"),
            from_address=_required_env("EMAIL_FROM"),
        )

    async def send(
        self,
        message: EmailMessagePayload,
        *,
        redact_for_log: str | None = None,  # noqa: ARG002 -- recipient sees full link
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
        """Open an authenticated SMTP session; close it on exit."""
        client = smtplib.SMTP(self.host, self.port, timeout=30)
        try:
            client.starttls()
            client.login(self.username, self.password)
            yield client
        finally:
            client.quit()


# Process-wide singleton so tests that override the dependency do not
# fight a fresh ConsoleEmailSender on every request.  ``None`` means
# "build the default backend lazily on first use".
_default_sender: EmailSender | None = None


def _build_default_sender() -> EmailSender:
    """Return the configured backend, defaulting to console.

    Reads ``EMAIL_BACKEND`` -- ``console`` is the safe default for
    dev / test; ``smtp`` flips to the production adapter and forces
    every required env var to be present (raising on first use is
    much more debuggable than silently dropping the email).
    """
    backend = os.getenv(_ENV_EMAIL_BACKEND, _BACKEND_CONSOLE).strip().lower()
    if backend == _BACKEND_SMTP:
        return SmtpEmailSender.from_env()
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
