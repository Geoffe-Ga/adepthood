"""Journal encryption at rest: round-trip, rotation, ciphertext-at-rest, fail-fast."""

from __future__ import annotations

import logging

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text
from sqlalchemy.exc import StatementError
from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import JournalEntry
from models.user import User
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
    user = User(email="cipher@example.com", password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.flush()
    db_session.add(JournalEntry(user_id=user.id, sender="user", message="my plaintext secret"))
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


# ---------------------------------------------------------------------------
# Production signal and the write-path refusal (#3058)
# ---------------------------------------------------------------------------

_CANARY = "canary-3058 the sentence nobody else may read"


def _clear_production_signals(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every variable the production decision reads, so the shell cannot flip it."""
    for name in je.PRODUCTION_SIGNAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, False),
        ({"ENV": "development"}, False),
        ({"ENV": "staging"}, False),
        ({"ENV": "production"}, True),
        # A casing or whitespace slip on the one variable a person types is not
        # permission to store prose in the clear.
        ({"ENV": " Production "}, True),
        # The platform names its own environment; nobody types that by accident.
        ({"RAILWAY_ENVIRONMENT_NAME": "production"}, True),
        ({"RAILWAY_ENVIRONMENT": "production"}, True),
        # An ENV that disagrees with the platform loses: the mismatch fails closed.
        ({"ENV": "development", "RAILWAY_ENVIRONMENT_NAME": "production"}, True),
        ({"ENV": "staging", "RAILWAY_ENVIRONMENT": "production"}, True),
        # Staging stays exempt (requiring a key there is an owner decision).
        ({"RAILWAY_ENVIRONMENT_NAME": "staging"}, False),
        ({"ENV": "staging", "RAILWAY_ENVIRONMENT_NAME": "staging"}, False),
        # A platform deploy that does not say which environment it is cannot
        # prove it is not production, so it is treated as production.
        ({"RAILWAY_PROJECT_ID": "p"}, True),
        ({"RAILWAY_SERVICE_ID": "s"}, True),
        ({"RAILWAY_PUBLIC_DOMAIN": "api.example.com"}, True),
        ({"RAILWAY_PROJECT_ID": "p", "RAILWAY_ENVIRONMENT_NAME": "staging"}, False),
        # Blank values are absent values.
        ({"RAILWAY_ENVIRONMENT_NAME": "  ", "ENV": "development"}, False),
    ],
)
def test_production_in_force_truth_table(env: dict[str, str], *, expected: bool) -> None:
    """Production is ENV *or* the platform's own word, and an unnamed platform deploy."""
    assert je.production_in_force(env) is expected


def test_production_in_force_reads_the_process_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no mapping passed, the live environment decides (not a cached copy)."""
    _clear_production_signals(monkeypatch)
    assert je.production_in_force() is False
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    assert je.production_in_force() is True


def test_encrypt_refuses_plaintext_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    """No key under ENV=production: the codec refuses rather than storing prose."""
    _clear_production_signals(monkeypatch)
    monkeypatch.setenv("ENV", "production")
    monkeypatch.delenv(_ENV, raising=False)
    je.reset_cache()

    with pytest.raises(je.JournalEncryptionError, match=_ENV) as excinfo:
        je.encrypt(_CANARY)

    assert _CANARY not in str(excinfo.value)


def test_encrypt_refuses_plaintext_on_platform_production_with_env_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Railway production deploy that forgot ``ENV`` still cannot write plaintext."""
    _clear_production_signals(monkeypatch)
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    monkeypatch.delenv(_ENV, raising=False)
    je.reset_cache()

    with pytest.raises(je.JournalEncryptionError):
        je.encrypt(_CANARY)


def test_encrypt_still_passes_through_outside_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A laptop and a Railway staging deploy keep the documented plaintext default."""
    _clear_production_signals(monkeypatch)
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "staging")
    monkeypatch.delenv(_ENV, raising=False)
    je.reset_cache()

    assert je.encrypt(_CANARY) == _CANARY


@pytest.mark.asyncio
async def test_orm_write_of_prose_is_refused_in_production_and_nothing_persists(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The refusal reaches the ORM boundary: the row is not written at all."""
    _clear_production_signals(monkeypatch)
    monkeypatch.delenv(_ENV, raising=False)
    je.reset_cache()
    user = User(email="refuse@example.com", password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.commit()

    monkeypatch.setenv("ENV", "production")
    db_session.add(JournalEntry(user_id=user.id, sender="user", message=_CANARY))
    with pytest.raises(StatementError) as excinfo:
        await db_session.commit()
    await db_session.rollback()

    assert isinstance(excinfo.value.orig, je.JournalEncryptionError)
    assert _CANARY not in str(excinfo.value.orig)
    count = (await db_session.execute(text("SELECT count(*) FROM journalentry"))).scalar_one()
    assert count == 0


# ---------------------------------------------------------------------------
# Key-index, rotation, and the legacy-plaintext read signal (#3058)
# ---------------------------------------------------------------------------


def test_is_ciphertext_recognises_only_the_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    """The marker is the one test of "is this ciphertext", exposed without the constant."""
    monkeypatch.setenv(_ENV, _key())
    je.reset_cache()
    assert je.is_ciphertext(je.encrypt(_CANARY)) is True
    assert je.is_ciphertext(_CANARY) is False


def test_key_index_reports_which_key_decrypts(monkeypatch: pytest.MonkeyPatch) -> None:
    """The position of the decrypting key -- never the key -- is what is reported."""
    old, new, other = _key(), _key(), _key()
    monkeypatch.setenv(_ENV, old)
    je.reset_cache()
    old_token = je.encrypt(_CANARY)
    monkeypatch.setenv(_ENV, other)
    je.reset_cache()
    foreign_token = je.encrypt(_CANARY)

    monkeypatch.setenv(_ENV, f"{new},{old}")
    je.reset_cache()
    assert je.key_index(je.encrypt(_CANARY)) == 0
    assert je.key_index(old_token) == 1
    assert je.key_index(foreign_token) is None


def test_key_count_counts_positions_and_fails_fast_on_a_bad_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The count is what the audit sizes its per-key columns by; a bad key is not zero."""
    monkeypatch.delenv(_ENV, raising=False)
    je.reset_cache()
    assert je.key_count() == 0
    monkeypatch.setenv(_ENV, f"{_key()}, {_key()}")
    je.reset_cache()
    assert je.key_count() == 2
    monkeypatch.setenv(_ENV, "not-a-key")
    je.reset_cache()
    with pytest.raises(je.JournalEncryptionError):
        je.key_count()


def test_key_index_refuses_without_keys_and_rejects_plaintext(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No key means no answer, and plaintext is not something a key "decrypts"."""
    monkeypatch.setenv(_ENV, _key())
    je.reset_cache()
    token = je.encrypt(_CANARY)
    with pytest.raises(ValueError, match="ciphertext"):
        je.key_index(_CANARY)

    monkeypatch.delenv(_ENV, raising=False)
    je.reset_cache()
    with pytest.raises(je.JournalEncryptionError, match=_ENV):
        je.key_index(token)


def test_rotate_moves_old_key_and_plaintext_to_the_primary_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Old-key tokens and legacy plaintext both come out under key 0, same text."""
    old, new = _key(), _key()
    monkeypatch.setenv(_ENV, old)
    je.reset_cache()
    old_token = je.encrypt(_CANARY)

    monkeypatch.setenv(_ENV, f"{new},{old}")
    je.reset_cache()
    for value in (old_token, _CANARY):
        rotated = je.rotate(value)
        assert je.is_ciphertext(rotated)
        assert _CANARY not in rotated
        assert je.key_index(rotated) == 0
        assert je.decrypt(rotated) == _CANARY

    # Readable with the new key alone: the old key is no longer needed.
    rotated_old = je.rotate(old_token)
    monkeypatch.setenv(_ENV, new)
    je.reset_cache()
    assert je.decrypt(rotated_old) == _CANARY


def test_rotate_never_returns_plaintext(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without a key, rotate raises -- even outside production -- rather than pass through."""
    _clear_production_signals(monkeypatch)
    monkeypatch.delenv(_ENV, raising=False)
    je.reset_cache()
    with pytest.raises(je.JournalEncryptionError, match=_ENV) as excinfo:
        je.rotate(_CANARY)
    assert _CANARY not in str(excinfo.value)


def test_rotate_refuses_a_token_no_configured_key_decrypts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An undecryptable token is an integrity stop, never re-wrapped or dropped."""
    monkeypatch.setenv(_ENV, _key())
    je.reset_cache()
    token = je.encrypt(_CANARY)
    monkeypatch.setenv(_ENV, _key())
    je.reset_cache()
    with pytest.raises(je.JournalEncryptionError):
        je.rotate(token)


def test_legacy_plaintext_read_is_signalled_without_content(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Keyed, a plaintext read counts and warns once -- and never says what it read."""
    monkeypatch.setenv(_ENV, _key())
    je.reset_cache()
    caplog.set_level(logging.WARNING, logger=je.__name__)

    assert je.decrypt(_CANARY) == _CANARY
    assert je.decrypt(_CANARY) == _CANARY

    assert je.legacy_plaintext_reads() == 2
    warnings = [r for r in caplog.records if r.name == je.__name__]
    assert len(warnings) == 1
    assert _CANARY not in caplog.text
    assert all(_CANARY not in str(arg) for r in warnings for arg in (r.args or ()))
    assert "journal_plaintext_read" in warnings[0].getMessage()

    je.reset_cache()
    assert je.legacy_plaintext_reads() == 0


def test_plaintext_read_without_a_key_is_silent(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Unkeyed, plaintext is the normal state: no count, no warning."""
    monkeypatch.delenv(_ENV, raising=False)
    je.reset_cache()
    caplog.set_level(logging.WARNING, logger=je.__name__)

    assert je.decrypt(_CANARY) == _CANARY

    assert je.legacy_plaintext_reads() == 0
    assert caplog.records == []
