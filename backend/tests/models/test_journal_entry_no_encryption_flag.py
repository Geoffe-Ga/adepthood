"""Regression: the hollow encryption flag must stay gone (audit-destub-05).

``ENCRYPTION_AT_REST_ENABLED`` advertised Fernet column encryption that was
never implemented — ``message`` was stored plaintext regardless. The flag was
removed so the codebase stops promising a guarantee it does not keep; real
encryption is tracked separately. This test fails if the flag is reintroduced
without an actual encrypt/decrypt path.
"""

from __future__ import annotations

import models.journal_entry as journal_entry_module


def test_hollow_encryption_flag_is_removed() -> None:
    assert not hasattr(journal_entry_module, "ENCRYPTION_AT_REST_ENABLED")


def test_module_makes_no_false_encryption_claim() -> None:
    """The module no longer claims ``message`` is encrypted before write."""
    source = journal_entry_module.__doc__ or ""
    # The module docstring (if any) must not assert message-level encryption.
    assert "encrypted before" not in source.lower()
