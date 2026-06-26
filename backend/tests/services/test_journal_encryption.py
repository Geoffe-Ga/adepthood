"""Journal encryption at rest: round-trip, rotation, ciphertext-at-rest, fail-fast."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import JournalEntry
from services import journal_encryption as je

_ENV = "JOURNAL_ENCRYPTION_KEYS"


@pytest.fixture(autouse=True)
def _reset_registry() -> object:
    """Each test configures its own keys; clear the cached registry around it."""
    je.reset_cache()
    yield
    je.reset_cache()


def _key() -> str:
    return Fernet.generate_key().decode()


def test_disabled_passthrough(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no key configured, encryption is off and text is unchanged."""
    monkeypatch.delenv(_ENV, raising=False)
    je.reset_cache()
    assert je.is_enabled() is False
    assert je.encrypt("hello") == "hello"
    assert je.decrypt("hello") == "hello"


def test_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    """A configured key encrypts to opaque ciphertext and decrypts back."""
    monkeypatch.setenv(_ENV, _key())
    je.reset_cache()
    token = je.encrypt("a private reflection")
    assert je.is_enabled() is True
    assert token != "a private reflection"
    assert "private" not in token
    assert je.decrypt(token) == "a private reflection"


def test_rotation_old_ciphertext_still_readable(monkeypatch: pytest.MonkeyPatch) -> None:
    """After rotating in a new primary key, old-key ciphertext still decrypts."""
    old, new = _key(), _key()
    monkeypatch.setenv(_ENV, old)
    je.reset_cache()
    old_token = je.encrypt("written under the old key")

    # Rotate: new key first (encrypts), old key retained (decrypts).
    monkeypatch.setenv(_ENV, f"{new},{old}")
    je.reset_cache()
    assert je.decrypt(old_token) == "written under the old key"
    new_token = je.encrypt("written under the new key")
    assert je.decrypt(new_token) == "written under the new key"

    # Retiring the old key makes its ciphertext unreadable (fails loud).
    monkeypatch.setenv(_ENV, new)
    je.reset_cache()
    with pytest.raises(je.JournalEncryptionError):
        je.decrypt(old_token)


def test_invalid_key_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    """A configured-but-invalid key raises rather than silently disabling."""
    monkeypatch.setenv(_ENV, "not-a-valid-fernet-key")
    je.reset_cache()
    with pytest.raises(je.JournalEncryptionError):
        je.is_enabled()


def test_ciphertext_with_no_key_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    """Encrypted content with no key to read it raises (never returned raw)."""
    monkeypatch.setenv(_ENV, _key())
    je.reset_cache()
    token = je.encrypt("secret")
    monkeypatch.delenv(_ENV, raising=False)
    je.reset_cache()
    with pytest.raises(je.JournalEncryptionError):
        je.decrypt(token)


@pytest.mark.asyncio
async def test_ciphertext_lands_in_the_column(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A raw DB read returns ciphertext; the ORM transparently decrypts."""
    monkeypatch.setenv(_ENV, _key())
    je.reset_cache()
    db_session.add(JournalEntry(user_id=1, sender="user", message="my plaintext secret"))
    await db_session.commit()

    # Raw column read bypasses the TypeDecorator — must be ciphertext, not plaintext.
    raw = (await db_session.execute(text("SELECT message FROM journalentry"))).scalar_one()
    assert raw != "my plaintext secret"
    assert "secret" not in raw
    assert je.decrypt(raw) == "my plaintext secret"

    # ORM read decrypts transparently.
    db_session.expire_all()
    entry = (await db_session.execute(text("SELECT id FROM journalentry"))).scalar_one()
    loaded = await db_session.get(JournalEntry, entry)
    assert loaded is not None
    assert loaded.message == "my plaintext secret"
