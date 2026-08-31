"""The HTML alternative must reach the wire, and must stay optional.

A payload carrying HTML that no sender transmits is the same class of bug
as the console backend in production: the code looks done, the send
reports success, and the recipient sees none of it.
"""

from __future__ import annotations

import contextlib
from email.message import EmailMessage
from typing import TYPE_CHECKING

import pytest

from services.email import EmailMessagePayload, ResendEmailSender, SmtpEmailSender

if TYPE_CHECKING:
    from collections.abc import Iterator

TEXT = "Reset your password: https://app.aptitude.guru/reset-password?token=abc"
HTML = "<!doctype html><html><body><p>Reset your password</p></body></html>"


@pytest.fixture
def resend() -> ResendEmailSender:
    """A sender with credentials that are never dialled in these tests."""
    return ResendEmailSender(
        api_key="re_test",  # pragma: allowlist secret
        from_address="noreply@example.com",
    )


def test_resend_payload_omits_html_when_absent(resend: ResendEmailSender) -> None:
    """A text-only message must not send an empty ``html`` field."""
    message = EmailMessagePayload(to="a@example.com", subject="s", body=TEXT)
    wire = resend._wire_payload(message)  # noqa: SLF001
    assert wire["text"] == TEXT
    assert "html" not in wire


def test_resend_payload_carries_html_when_present(resend: ResendEmailSender) -> None:
    """Both parts travel, so a text-only client still has something to show."""
    message = EmailMessagePayload(to="a@example.com", subject="s", body=TEXT, html=HTML)
    wire = resend._wire_payload(message)  # noqa: SLF001
    assert wire["text"] == TEXT
    assert wire["html"] == HTML


def _capture_envelope(
    sender: SmtpEmailSender,
    message: EmailMessagePayload,
    monkeypatch: pytest.MonkeyPatch,
) -> EmailMessage:
    """Run ``_send_blocking`` against a stub transport and return the envelope.

    ``monkeypatch`` rather than a hand-rolled save/restore: it undoes the
    class attribute even when an assertion raises, so one failing test cannot
    leave a stubbed transport behind for the next one.
    """
    captured: list[EmailMessage] = []

    class _Client:
        def send_message(self, envelope: EmailMessage) -> None:
            captured.append(envelope)

    @contextlib.contextmanager
    def _connect(_self: SmtpEmailSender) -> Iterator[_Client]:
        yield _Client()

    monkeypatch.setattr(SmtpEmailSender, "_connect", _connect)
    sender._send_blocking(message)  # noqa: SLF001
    return captured[0]


@pytest.fixture
def smtp() -> SmtpEmailSender:
    """A relay adapter whose transport is stubbed by ``_capture_envelope``."""
    return SmtpEmailSender(
        host="smtp.example.com",
        port=587,
        username="u",
        password="p",
        from_address="noreply@example.com",
    )


def test_smtp_stays_single_part_without_html(
    smtp: SmtpEmailSender, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No HTML means no multipart wrapper -- the simplest thing that works."""
    message = EmailMessagePayload(to="a@e.com", subject="s", body=TEXT)
    envelope = _capture_envelope(smtp, message, monkeypatch)
    assert not envelope.is_multipart()


def test_smtp_sends_multipart_alternative_with_text_first(
    smtp: SmtpEmailSender, monkeypatch: pytest.MonkeyPatch
) -> None:
    """RFC 2046: least-faithful part first, so text precedes HTML."""
    message = EmailMessagePayload(to="a@e.com", subject="s", body=TEXT, html=HTML)
    envelope = _capture_envelope(smtp, message, monkeypatch)
    assert envelope.get_content_type() == "multipart/alternative"
    subtypes = [part.get_content_subtype() for part in envelope.iter_parts()]
    assert subtypes == ["plain", "html"]
