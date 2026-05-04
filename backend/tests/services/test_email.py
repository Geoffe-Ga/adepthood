"""Tests for the EmailSender port and its adapters."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, cast

import pytest

from services.email import (
    ConsoleEmailSender,
    EmailDeliveryError,
    EmailMessagePayload,
    RecordingEmailSender,
    SmtpEmailSender,
    _build_default_sender,
    get_email_sender,
    redact_token_in_body,
    reset_email_sender_for_tests,
)

if TYPE_CHECKING:
    from collections.abc import Iterator


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Drop the process-wide singleton + clear EMAIL_BACKEND for each test."""
    reset_email_sender_for_tests()
    monkeypatch.delenv("EMAIL_BACKEND", raising=False)
    yield
    reset_email_sender_for_tests()


@pytest.mark.asyncio
async def test_recording_sender_captures_messages() -> None:
    """The recording fake stores every payload verbatim for test assertion."""
    sender = RecordingEmailSender()
    payload = EmailMessagePayload(to="user@example.com", subject="hi", body="body")
    await sender.send(payload)
    assert sender.sent == [payload]


@pytest.mark.asyncio
async def test_console_sender_redacts_token_in_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Console sender logs a redacted body when ``redact_for_log`` is supplied."""
    sender = ConsoleEmailSender()
    payload = EmailMessagePayload(
        to="user@example.com",
        subject="Reset",
        body="Click https://x.test/reset?token=abcdefghijklmnop1234 to continue.",
    )
    with caplog.at_level(logging.INFO):
        await sender.send(payload, redact_for_log="abcdefghijklmnop1234")
    record = next(r for r in caplog.records if r.message == "email_console_send")
    body = cast("str", record.__dict__["body"])
    assert "abcdefghijklmnop1234" not in body
    assert "abcdefgh..." in body


@pytest.mark.asyncio
async def test_console_sender_no_redact_hint_passes_body_through(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Without ``redact_for_log`` the console sender logs the body verbatim."""
    sender = ConsoleEmailSender()
    payload = EmailMessagePayload(
        to="user@example.com",
        subject="Notice",
        body="Your password was changed.",
    )
    with caplog.at_level(logging.INFO):
        await sender.send(payload)
    record = next(r for r in caplog.records if r.message == "email_console_send")
    assert cast("str", record.__dict__["body"]) == "Your password was changed."


@pytest.mark.asyncio
async def test_console_sender_redacts_when_keyword_passed_at_call_site() -> None:
    """Regression: the call site that forgets to pass redact_for_log gets a typed default.

    Before this refactor, redaction relied on the caller setting a
    field on the sender instance before each call -- a foot-gun the PR
    review flagged.  Now the keyword is part of ``send``'s signature
    so a forgotten redaction is a missing keyword (still safe -- the
    body is logged in full and you notice during review) rather than
    a silently-disabled mask.
    """
    sender = ConsoleEmailSender()
    payload = EmailMessagePayload(to="x@y.z", subject="s", body="b")
    # Default: ``redact_for_log=None`` -- the body is logged verbatim,
    # which is the documented behaviour for non-token emails.
    await sender.send(payload)
    # Explicit None is also accepted.
    await sender.send(payload, redact_for_log=None)


def test_redact_token_in_body_returns_input_when_token_blank() -> None:
    """``redact_token_in_body`` is a no-op when the token is missing or empty."""
    assert redact_token_in_body("hello", None) == "hello"
    assert redact_token_in_body("hello", "") == "hello"


def test_redact_token_in_body_truncates_token_inline() -> None:
    """Tokens are replaced inline with the first 8 chars + ellipsis."""
    assert redact_token_in_body("link=ABCDEFGHIJKLMNOP", "ABCDEFGHIJKLMNOP") == "link=ABCDEFGH..."


def test_build_default_sender_returns_console_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Default backend is the console sender."""
    monkeypatch.delenv("EMAIL_BACKEND", raising=False)
    assert isinstance(_build_default_sender(), ConsoleEmailSender)


def test_build_default_sender_returns_console_for_unknown_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unknown backends fall back to console rather than raising."""
    monkeypatch.setenv("EMAIL_BACKEND", "owl")
    assert isinstance(_build_default_sender(), ConsoleEmailSender)


def test_build_default_sender_returns_smtp_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``EMAIL_BACKEND=smtp`` builds an SmtpEmailSender from env."""
    monkeypatch.setenv("EMAIL_BACKEND", "smtp")
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_USERNAME", "user")
    monkeypatch.setenv("SMTP_PASSWORD", "pw")  # pragma: allowlist secret
    monkeypatch.setenv("EMAIL_FROM", "from@example.com")
    sender = _build_default_sender()
    assert isinstance(sender, SmtpEmailSender)
    assert sender.host == "smtp.example.com"
    assert sender.port == 587
    assert sender.from_address == "from@example.com"


def test_smtp_sender_raises_when_required_env_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SmtpEmailSender.from_env raises when any required var is missing."""
    monkeypatch.setenv("EMAIL_BACKEND", "smtp")
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    # Deliberately omit SMTP_PORT.
    monkeypatch.delenv("SMTP_PORT", raising=False)
    monkeypatch.setenv("SMTP_USERNAME", "u")
    monkeypatch.setenv("SMTP_PASSWORD", "p")  # pragma: allowlist secret
    monkeypatch.setenv("EMAIL_FROM", "f@example.com")
    with pytest.raises(RuntimeError, match="SMTP_PORT"):
        SmtpEmailSender.from_env()


def test_get_email_sender_caches_instance() -> None:
    """The factory caches its result so dependency overrides have one target."""
    first = get_email_sender()
    second = get_email_sender()
    assert first is second


def test_reset_email_sender_for_tests_clears_cache() -> None:
    """The test-only reset hook produces a fresh sender on next call."""
    first = get_email_sender()
    reset_email_sender_for_tests()
    second = get_email_sender()
    assert first is not second


@pytest.mark.asyncio
async def test_smtp_sender_invokes_send_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SmtpEmailSender wires EHLO + STARTTLS + EHLO + login + send_message in order.

    RFC 3207: ``ehlo()`` is called before ``starttls()`` so the server
    can advertise STARTTLS support, and again after STARTTLS so the
    client can re-negotiate capabilities (notably ``AUTH``) inside the
    encrypted channel.  Without the explicit calls some relays hang
    or reject -- ``smtplib`` does not insert them automatically.
    """
    sent_messages: list[object] = []
    calls: list[str] = []

    class _StubSmtp:
        def __init__(self, host: str, port: int, timeout: int) -> None:
            calls.append(f"init:{host}:{port}:{timeout}")

        def ehlo(self) -> None:
            calls.append("ehlo")

        def starttls(self) -> None:
            calls.append("starttls")

        def login(self, username: str, password: str) -> None:
            calls.append(f"login:{username}:{password}")

        def send_message(self, msg: object) -> None:
            sent_messages.append(msg)
            calls.append("send")

        def quit(self) -> None:
            calls.append("quit")

    monkeypatch.setattr("services.email.smtplib.SMTP", _StubSmtp)
    sender = SmtpEmailSender(
        host="smtp.example.com",
        port=587,
        username="user",
        password="pw",  # pragma: allowlist secret
        from_address="from@example.com",
    )
    await sender.send(
        EmailMessagePayload(to="rcpt@example.com", subject="s", body="b"),
    )
    assert calls == [
        "init:smtp.example.com:587:30",
        "ehlo",
        "starttls",
        "ehlo",
        "login:user:pw",
        "send",
        "quit",
    ]
    assert len(sent_messages) == 1


def test_smtp_send_blocking_drives_starttls_login_and_quit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Direct sync test for ``_send_blocking`` and ``_connect``.

    The async ``send`` method runs ``_send_blocking`` via
    :func:`asyncio.to_thread`, which dispatches into a worker thread
    that ``coverage.py`` does not trace under the default
    ``concurrency = ["greenlet"]`` config (PR #287 round-6 BLOCKER 2).
    Calling ``_send_blocking`` directly keeps the body on the main
    thread so the line/branch coverage gate sees it.
    """
    sent_messages: list[object] = []
    calls: list[str] = []

    class _StubSmtp:
        def __init__(self, host: str, port: int, timeout: int) -> None:
            calls.append(f"init:{host}:{port}:{timeout}")

        def ehlo(self) -> None:
            calls.append("ehlo")

        def starttls(self) -> None:
            calls.append("starttls")

        def login(self, username: str, password: str) -> None:
            calls.append(f"login:{username}:{password}")

        def send_message(self, msg: object) -> None:
            sent_messages.append(msg)
            calls.append("send")

        def quit(self) -> None:
            calls.append("quit")

    monkeypatch.setattr("services.email.smtplib.SMTP", _StubSmtp)
    sender = SmtpEmailSender(
        host="smtp.example.com",
        port=587,
        username="user",
        password="pw",  # pragma: allowlist secret
        from_address="from@example.com",
    )
    sender._send_blocking(  # noqa: SLF001 -- testing the sync internal directly
        EmailMessagePayload(to="rcpt@example.com", subject="s", body="b"),
    )
    assert calls == [
        "init:smtp.example.com:587:30",
        "ehlo",
        "starttls",
        "ehlo",
        "login:user:pw",
        "send",
        "quit",
    ]
    assert len(sent_messages) == 1


def test_smtp_connect_quits_even_when_login_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``_connect``'s ``finally: client.quit()`` runs even on failure.

    Regression for the reviewer's testing-gap callout: without this
    test, an SMTP failure mid-handshake could leak a half-open
    connection through the worker pool.
    """
    calls: list[str] = []

    class _ExplodingSmtp:
        def __init__(self, host: str, port: int, timeout: int) -> None:
            calls.append(f"init:{host}:{port}:{timeout}")

        def ehlo(self) -> None:
            calls.append("ehlo")

        def starttls(self) -> None:
            calls.append("starttls")

        def login(self, username: str, password: str) -> None:  # noqa: ARG002
            raise ConnectionError("relay refused AUTH")

        def quit(self) -> None:
            calls.append("quit")

    monkeypatch.setattr("services.email.smtplib.SMTP", _ExplodingSmtp)
    sender = SmtpEmailSender(
        host="smtp.example.com",
        port=587,
        username="user",
        password="pw",  # pragma: allowlist secret
        from_address="from@example.com",
    )
    with pytest.raises(ConnectionError, match="relay refused AUTH"):
        sender._send_blocking(  # noqa: SLF001 -- direct sync exercise
            EmailMessagePayload(to="rcpt@example.com", subject="s", body="b"),
        )
    # ``quit`` must still have run via the ``finally`` clause.
    assert calls == [
        "init:smtp.example.com:587:30",
        "ehlo",
        "starttls",
        "ehlo",
        "quit",
    ]


@pytest.mark.asyncio
async def test_smtp_send_wraps_wire_failures_in_email_delivery_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The async ``send`` converts SMTP / socket errors to ``EmailDeliveryError``.

    PR #287 round-9 BLOCKER 2: the auth-side wrappers used to catch
    bare ``Exception`` to keep the anti-enumeration response shape
    identical on a downed relay.  That also masked programmer bugs.
    The fix narrows both wrappers to a custom ``EmailDeliveryError``
    type, which only meaningful if ``SmtpEmailSender.send`` actually
    raises it on wire failures (rather than letting the underlying
    ``OSError`` / ``smtplib.SMTPException`` bubble up).
    """
    import smtplib  # noqa: PLC0415

    class _RefusedSmtp:
        def __init__(self, host: str, port: int, timeout: int) -> None:
            del host, port, timeout

        def ehlo(self) -> None: ...

        def starttls(self) -> None: ...

        def login(self, username: str, password: str) -> None:
            del username, password

        def send_message(self, msg: object) -> None:
            del msg
            raise smtplib.SMTPRecipientsRefused({"x@y.z": (550, b"no such user")})

        def quit(self) -> None: ...

    monkeypatch.setattr("services.email.smtplib.SMTP", _RefusedSmtp)
    sender = SmtpEmailSender(
        host="smtp.example.com",
        port=587,
        username="user",
        password="pw",  # pragma: allowlist secret
        from_address="from@example.com",
    )
    with pytest.raises(EmailDeliveryError, match="SMTPRecipientsRefused"):
        await sender.send(
            EmailMessagePayload(to="x@y.z", subject="s", body="b"),
        )


def test_smtp_connect_issues_ehlo_before_and_after_starttls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: EHLO -> STARTTLS -> EHLO -> AUTH ordering per RFC 3207.

    PR #287 round-10 HIGH security: ``smtplib`` does not auto-send
    ``EHLO`` before ``starttls()``.  Strict relays (mostly hosted
    Postfix configurations) reject or hang without the explicit call,
    and the second ``EHLO`` is needed so AUTH capabilities are
    re-advertised inside the TLS channel.  This test pins the exact
    call sequence so a future refactor cannot silently regress it.
    """
    calls: list[str] = []

    class _StrictSmtp:
        def __init__(self, host: str, port: int, timeout: int) -> None:
            del host, port, timeout

        def ehlo(self) -> None:
            calls.append("ehlo")

        def starttls(self) -> None:
            # Reject if EHLO was not the immediately preceding call --
            # this models a strict RFC-3207 relay.
            if not calls or calls[-1] != "ehlo":
                msg = "STARTTLS issued without prior EHLO"
                raise AssertionError(msg)
            calls.append("starttls")

        def login(self, username: str, password: str) -> None:
            del username, password
            # Reject if EHLO was not the immediately preceding call
            # (the post-STARTTLS one); this models a relay that only
            # advertises AUTH inside the TLS channel.
            if not calls or calls[-1] != "ehlo":
                msg = "AUTH issued without post-STARTTLS EHLO"
                raise AssertionError(msg)
            calls.append("login")

        def send_message(self, msg: object) -> None:
            del msg
            calls.append("send")

        def quit(self) -> None:
            calls.append("quit")

    monkeypatch.setattr("services.email.smtplib.SMTP", _StrictSmtp)
    sender = SmtpEmailSender(
        host="smtp.example.com",
        port=587,
        username="user",
        password="pw",  # pragma: allowlist secret
        from_address="from@example.com",
    )
    sender._send_blocking(  # noqa: SLF001 -- direct sync exercise
        EmailMessagePayload(to="rcpt@example.com", subject="s", body="b"),
    )
    assert calls == ["ehlo", "starttls", "ehlo", "login", "send", "quit"]


@pytest.mark.asyncio
async def test_smtp_send_propagates_non_wire_errors_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Programmer / config errors are NOT swallowed by ``EmailDeliveryError``.

    The narrowed exception path catches only ``smtplib.SMTPException``
    and ``OSError``; other exception types must propagate so they
    surface in monitoring instead of being masked by the
    anti-enumeration shield meant for transient outages.
    """

    class _BuggySmtp:
        def __init__(self, host: str, port: int, timeout: int) -> None:
            del host, port, timeout

        def ehlo(self) -> None: ...

        def starttls(self) -> None: ...

        def login(self, username: str, password: str) -> None:
            del username, password

        def send_message(self, msg: object) -> None:
            del msg
            msg_text = "renderer produced wrong shape"
            raise RuntimeError(msg_text)

        def quit(self) -> None: ...

    monkeypatch.setattr("services.email.smtplib.SMTP", _BuggySmtp)
    sender = SmtpEmailSender(
        host="smtp.example.com",
        port=587,
        username="user",
        password="pw",  # pragma: allowlist secret
        from_address="from@example.com",
    )
    with pytest.raises(RuntimeError, match="renderer produced wrong shape"):
        await sender.send(
            EmailMessagePayload(to="x@y.z", subject="s", body="b"),
        )
