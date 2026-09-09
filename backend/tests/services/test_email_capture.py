"""Tests for the capture email adapter and the gate that keeps it out of production.

Contract: ``EMAIL_BACKEND=capture`` writes every rendered message -- verbatim,
unredacted, reset token and all -- as one JSON object per line to the file
``EMAIL_CAPTURE_FILE`` names, and delivers nothing. It exists for one caller:
the frontend end-to-end lane, which drives password recovery over HTTP against a
real server and therefore cannot reach the process-local
:class:`~services.email.RecordingEmailSender` the backend suites override the
dependency with. The plaintext token exists nowhere but the rendered body, so a
lane that cannot read that body cannot press the journey the outage came through.

Writing a live bearer credential to a file is exactly as dangerous as it sounds,
which is why the adapter is gated rather than merely discouraged, and why the
gate is tested from both sides here. Two independent things have to hold:

* the adapter refuses to come into existence when ``ENV`` names production, so
  no configuration reaches a capture sender on a production boot even if the
  startup validator were edited to permit the backend name; and
* :func:`main.validate_email_config` refuses the boot outright, because
  ``capture`` is not a delivering backend -- covered in
  ``tests/test_email_startup_config.py`` alongside the console and typo cases.

The second gate alone would be one edit away from silence: adding ``capture`` to
the production builder map is a plausible mistake, and it is the only edit that
defeats it. The first gate is what makes that edit still fail closed.

Outside production the adapter is the ordinary local case, and its one
substantive promise is that it does *not* redact: the console adapter masks the
token to its first eight characters on purpose, and a capture file that
inherited that would hand the lane a token no confirm accepts.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from services import email
from services.email import (
    CaptureEmailSender,
    EmailMessagePayload,
    _build_default_sender,
    get_email_sender,
    reset_email_sender_for_tests,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

# A token shaped like the real thing -- 43 url-safe characters, the width
# ``secrets.token_urlsafe(32)`` produces -- so an adapter that truncated it the
# way the console one does would be visible rather than plausible.
TOKEN = "Wc2l0nQ9tVx7ZbKr5Ay3Hs1Pf8Ud6Mj4Gn0Ee2Ll7Q"  # pragma: allowlist secret

WEB_ORIGIN = "https://app.aptitude.guru"

#: The name of the file mode bits nobody but the owner may hold.
GROUP_AND_OTHER_BITS = stat.S_IRWXG | stat.S_IRWXO


def _body(token: str) -> str:
    """Render a reset-shaped body carrying ``token`` in both link schemes."""
    return (
        f"Reset your password:  {WEB_ORIGIN}/reset-password?token={token}\n"
        f"Reset your password:  adepthood://reset-password?token={token}\n"
    )


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Drop the process-wide sender and clear every variable these tests read."""
    reset_email_sender_for_tests()
    monkeypatch.delenv(email.EMAIL_BACKEND_ENV_VAR, raising=False)
    monkeypatch.delenv(email.EMAIL_CAPTURE_FILE_ENV_VAR, raising=False)
    monkeypatch.delenv(email.DEPLOYMENT_ENV_VAR, raising=False)
    yield
    reset_email_sender_for_tests()


@pytest.fixture
def capture_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the capture backend at a file inside this test's own directory."""
    path = tmp_path / "outbound.jsonl"
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, email.BACKEND_CAPTURE)
    monkeypatch.setenv(email.EMAIL_CAPTURE_FILE_ENV_VAR, str(path))
    return path


def _permission_bits(path: Path) -> int:
    """Return the capture file's mode, read from outside an async body.

    A sibling of :func:`_records`: both touch the filesystem synchronously, and
    both are called from ``async def`` tests, so both live out here rather than
    inline where an async-blocking-call lint would (correctly) object.
    """
    return path.stat().st_mode


def _records(path: Path) -> list[dict[str, object]]:
    """Read the capture file back as the JSON objects it holds, one per line."""
    lines = path.read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


@pytest.mark.asyncio
async def test_capture_sender_writes_the_body_verbatim(capture_file: Path) -> None:
    """The whole token reaches the file, because that is the point of the adapter.

    A capture file that inherited the console adapter's redaction would look
    like a working seam and hand the lane a token every confirm rejects, which
    is a green lane proving nothing -- the shape this journey exists to remove.
    """
    sender = CaptureEmailSender.from_env()

    await sender.send(
        EmailMessagePayload(to="user@example.com", subject="Reset", body=_body(TOKEN)),
        redact_for_log=TOKEN,
    )

    record = _records(capture_file)[0]
    assert record["to"] == "user@example.com"
    assert record["subject"] == "Reset"
    assert record["body"] == _body(TOKEN)
    assert TOKEN in str(record["body"])


@pytest.mark.asyncio
async def test_capture_sender_records_the_html_alternative(capture_file: Path) -> None:
    """Both halves of the multipart pair are kept, and the absent half reads as null."""
    sender = CaptureEmailSender.from_env()

    await sender.send(
        EmailMessagePayload(to="a@b.test", subject="Reset", body="text", html="<p>text</p>"),
        redact_for_log=None,
    )
    await sender.send(
        EmailMessagePayload(to="a@b.test", subject="Changed", body="text"),
        redact_for_log=None,
    )

    with_html, without_html = _records(capture_file)
    assert with_html["html"] == "<p>text</p>"
    assert without_html["html"] is None


@pytest.mark.asyncio
async def test_capture_sender_appends_rather_than_replacing(capture_file: Path) -> None:
    """Every message is kept: a journey asserts on the second mail as well as the first."""
    sender = CaptureEmailSender.from_env()

    for subject in ("first", "second", "third"):
        await sender.send(
            EmailMessagePayload(to="a@b.test", subject=subject, body="body"),
            redact_for_log=None,
        )

    assert [record["subject"] for record in _records(capture_file)] == [
        "first",
        "second",
        "third",
    ]


@pytest.mark.asyncio
async def test_capture_file_is_readable_only_by_its_owner(capture_file: Path) -> None:
    """The file holds live reset tokens, so no group or other bit may be set."""
    sender = CaptureEmailSender.from_env()

    await sender.send(
        EmailMessagePayload(to="a@b.test", subject="Reset", body=_body(TOKEN)),
        redact_for_log=TOKEN,
    )

    assert _permission_bits(capture_file) & GROUP_AND_OTHER_BITS == 0


def _plant_group_readable_file(path: Path) -> None:
    """Create ``path`` group- and world-readable, whatever the ambient umask.

    ``os`` rather than ``Path`` because the caller is a coroutine, and the mode
    is forced after the open because ``O_CREAT`` masks its mode with the umask.
    """
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT, 0o644)
    try:
        os.fchmod(descriptor, 0o644)
    finally:
        os.close(descriptor)


@pytest.mark.asyncio
async def test_capture_file_permissions_are_tightened_when_the_file_already_exists(
    capture_file: Path,
) -> None:
    """A file already on disk is narrowed too, not left at whatever mode it had.

    ``O_CREAT`` carries its mode only when the open actually creates the file,
    so a capture file left behind by an earlier run -- or planted by another
    process -- would keep a group- or world-readable mode while this adapter
    appended live reset tokens to it. The descriptor is narrowed after opening,
    which closes that gap without a path-based ``chmod`` a symlink swap could
    redirect between the check and the change.
    """
    _plant_group_readable_file(capture_file)
    assert _permission_bits(capture_file) & GROUP_AND_OTHER_BITS != 0

    sender = CaptureEmailSender.from_env()
    await sender.send(
        EmailMessagePayload(to="a@b.test", subject="Reset", body=_body(TOKEN)),
        redact_for_log=TOKEN,
    )

    assert _permission_bits(capture_file) & GROUP_AND_OTHER_BITS == 0


def test_capture_sender_refuses_a_missing_capture_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Naming the backend without naming the file is a sender that writes nowhere."""
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, email.BACKEND_CAPTURE)

    with pytest.raises(RuntimeError, match=email.EMAIL_CAPTURE_FILE_ENV_VAR) as excinfo:
        CaptureEmailSender.from_env()

    assert email.BACKEND_CAPTURE in str(excinfo.value)


def test_build_default_sender_returns_capture_outside_production(
    capture_file: Path,
) -> None:
    """The factory routes the backend name to the adapter, or the lane configures nothing."""
    sender = _build_default_sender()

    assert isinstance(sender, CaptureEmailSender)
    assert sender.path == capture_file


@pytest.mark.parametrize("env_value", ["production", "PRODUCTION", " Production "])
def test_capture_sender_refuses_to_build_in_production(
    env_value: str,
    capture_file: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The adapter itself refuses production, whatever casing the platform stored.

    This is the gate with teeth. The startup validator refuses the boot too, but
    it refuses by not finding ``capture`` in a map, and adding it there is one
    edit. After that edit this refusal is the only thing left between a live
    reset token and a file on a production disk.
    """
    monkeypatch.setenv(email.DEPLOYMENT_ENV_VAR, env_value)

    with pytest.raises(RuntimeError, match=email.EMAIL_BACKEND_ENV_VAR) as excinfo:
        CaptureEmailSender.from_env()

    message = str(excinfo.value)
    assert email.BACKEND_CAPTURE in message
    assert email.BACKEND_RESEND in message
    assert not capture_file.exists(), "a refused sender still created its capture file"


def test_get_email_sender_yields_no_capture_sender_in_production(
    capture_file: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The dependency every route resolves cannot hand back a capture sender in production.

    Asserted through the factory the request path actually calls, not only
    through ``from_env``: a future selector that reached the class by another
    route would pass the narrower test and fail here.
    """
    monkeypatch.setenv(email.DEPLOYMENT_ENV_VAR, "production")

    with pytest.raises(RuntimeError, match=email.BACKEND_CAPTURE):
        get_email_sender()

    assert not capture_file.exists(), "a refused sender still created its capture file"


@pytest.mark.parametrize("env_value", ["development", "staging", "test"])
def test_capture_sender_builds_in_every_non_production_environment(
    env_value: str,
    capture_file: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other side of the same comparison: the lane and a laptop still get a sender.

    Paired with the refusal above so a gate widened by deleting the comparison
    fails one of the two, rather than passing the half that was checked.
    """
    monkeypatch.setenv(email.DEPLOYMENT_ENV_VAR, env_value)

    assert CaptureEmailSender.from_env().path == capture_file
