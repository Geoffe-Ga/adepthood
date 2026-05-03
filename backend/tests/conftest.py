"""Pytest conftest for the ``backend/tests`` tree.

The repo-level ``conftest.py`` (``backend/conftest.py``) sets up
``async_client`` / ``db_session`` for every test.  This file adds
the password-reset-specific fixtures (``email_sender`` +
``wire_email_sender``) once so all three reset test modules
(``test_password_reset.py``, ``test_password_reset_e2e.py``,
``security/test_password_reset_timing.py``) discover them
automatically -- avoiding the per-module duplication the round-6
review flagged.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from services.email import (
    RecordingEmailSender,
    get_email_sender,
    reset_email_sender_for_tests,
)

if TYPE_CHECKING:
    from collections.abc import Iterator


@pytest.fixture
def email_sender() -> RecordingEmailSender:
    """Recording fake substituted for ``get_email_sender`` in every test."""
    sender = RecordingEmailSender()
    reset_email_sender_for_tests()
    return sender


@pytest.fixture
def wire_email_sender(email_sender: RecordingEmailSender) -> Iterator[None]:
    """Override the FastAPI dependency so handlers see the recording fake.

    Test modules opt in via
    ``pytestmark = pytest.mark.usefixtures("wire_email_sender")``.
    Pops only the ``get_email_sender`` override so the
    ``async_client`` fixture's session override survives.
    """
    from main import app  # noqa: PLC0415  -- avoid import-time side-effects

    app.dependency_overrides[get_email_sender] = lambda: email_sender
    yield
    app.dependency_overrides.pop(get_email_sender, None)
