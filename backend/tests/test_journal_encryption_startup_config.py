"""Tests for the startup journal-encryption configuration check.

Contract: journal encryption is opt-in by key presence, which is right for a
laptop and dangerous on a server. In production an unset (or blank)
``JOURNAL_ENCRYPTION_KEYS`` is a deploy that would store every user's journal in
plaintext without anybody being told, so it refuses to boot, naming the variable
and how to mint a key. Outside production the same state is the ordinary local
case and stays silent.

The existing fail-fast on a configured-but-invalid key is not softened by any of
this: that path still raises from the encryption service itself, so a typo in a
key can never be re-read as "encryption is off".

No key value ever appears in a message this check emits -- the failure names the
variable, never its contents.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator, Generator
from contextlib import asynccontextmanager
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from conftest import test_engine
from main import app, lifespan, validate_journal_encryption_config
from services import journal_encryption

ENV_VAR = "ENV"
KEYS_ENV_VAR = "JOURNAL_ENCRYPTION_KEYS"  # pragma: allowlist secret

MAIN_LOGGER = "main"

# The command an operator can paste. Pinned as a substring so the sentence
# around it can be rewritten freely, but a failure that does not hand over a
# working way to generate a key is not a remedy.
GENERATION_MARKER = "Fernet.generate_key"

# Values that mean "no key" -- unset, empty, and whitespace/comma noise that
# parses to zero usable keys. Each must fail closed in production rather than
# be read as a configured-but-odd key list.
ABSENT_KEY_VALUES = [None, "", "   ", ",", " , "]

# Environments where running unencrypted is the normal case rather than news.
NON_PRODUCTION_ENVS = [None, "development", "staging"]


@pytest.fixture(autouse=True)
def _reset_registry() -> Generator[None, None, None]:
    """Clear the cached key registry around each test so env changes take effect."""
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


def _set_keys(monkeypatch: pytest.MonkeyPatch, value: str | None) -> None:
    """Set the keys variable, treating ``None`` as unset."""
    if value is None:
        monkeypatch.delenv(KEYS_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(KEYS_ENV_VAR, value)
    journal_encryption.reset_cache()


@asynccontextmanager
async def _isolated_factory_patch() -> AsyncGenerator[None, None]:
    """Point main's session factory at the conftest SQLite engine for lifespan runs."""
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with patch("main.async_session_factory", new=factory):
        yield


@pytest.mark.parametrize("keys", ABSENT_KEY_VALUES)
def test_production_without_a_usable_key_refuses_to_boot(
    keys: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unset, blank, and separator-only all mean plaintext, so all three refuse.

    The realistic failure here is not misuse: it is an operator who configured
    everything the documentation mentioned and never learned this variable
    exists. A deploy that stores journals in the clear must not be reachable by
    omission.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    _set_keys(monkeypatch, keys)

    with pytest.raises(RuntimeError, match=KEYS_ENV_VAR) as excinfo:
        validate_journal_encryption_config()

    assert GENERATION_MARKER in str(excinfo.value)


def test_production_with_a_key_boots_silently(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The configured case is the quiet case -- nothing to raise, nothing to warn."""
    monkeypatch.setenv(ENV_VAR, "production")
    _set_keys(monkeypatch, Fernet.generate_key().decode())
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_journal_encryption_config()

    assert caplog.records == []


@pytest.mark.parametrize("env_value", NON_PRODUCTION_ENVS)
@pytest.mark.parametrize("keys", ABSENT_KEY_VALUES)
def test_non_production_without_a_key_is_unaffected(
    env_value: str | None,
    keys: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Requiring a key to run tests or a local server would be friction, not security."""
    if env_value is None:
        monkeypatch.delenv(ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(ENV_VAR, env_value)
    _set_keys(monkeypatch, keys)

    validate_journal_encryption_config()

    assert journal_encryption.is_enabled() is False


def test_the_refusal_never_echoes_a_configured_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A key that is present but unusable must not be quoted back in the failure.

    ``JOURNAL_ENCRYPTION_KEYS`` is the one variable in this deployment whose
    value decrypts every journal in the database. Whatever this seam says about
    it, it says by name.
    """
    sentinel = "SENTINEL-NOT-A-FERNET-KEY"  # pragma: allowlist secret
    monkeypatch.setenv(ENV_VAR, "production")
    _set_keys(monkeypatch, sentinel)

    with pytest.raises(journal_encryption.JournalEncryptionError) as excinfo:
        validate_journal_encryption_config()

    assert sentinel not in str(excinfo.value)


def test_an_invalid_key_still_fails_fast_rather_than_reading_as_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pre-existing fail-fast survives, and outside production too.

    A typo in a key is not "encryption is off": the deployment asked for
    encryption and did not get it, which is the case this check must never
    absorb into its own environment gate.
    """
    monkeypatch.setenv(ENV_VAR, "development")
    _set_keys(monkeypatch, "not-a-fernet-key")  # pragma: allowlist secret

    with pytest.raises(journal_encryption.JournalEncryptionError, match=KEYS_ENV_VAR):
        validate_journal_encryption_config()


@pytest.mark.asyncio
async def test_boot_refuses_under_a_production_configuration_with_no_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Driven through the real ``lifespan``: a validator nobody wired in guards nothing.

    Calling the function proves the rule; running the app's own startup proves
    the rule is on the path a deployment actually takes.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    _set_keys(monkeypatch, None)

    with pytest.raises(RuntimeError, match=KEYS_ENV_VAR):
        async with _isolated_factory_patch(), lifespan(app):
            pytest.fail("startup completed without journal encryption configured")


@pytest.mark.asyncio
async def test_boot_completes_in_development_with_no_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same startup path, unencrypted, still boots a laptop -- the quiet side."""
    monkeypatch.setenv(ENV_VAR, "development")
    _set_keys(monkeypatch, None)

    async with _isolated_factory_patch(), lifespan(app):
        assert journal_encryption.is_enabled() is False
