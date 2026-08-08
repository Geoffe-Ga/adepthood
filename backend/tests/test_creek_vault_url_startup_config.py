"""Tests for the startup Creek Vault URL configuration check.

Contract: ``CREEK_VAULT_URL`` is read per request, and a value the transport
cannot use degrades that request onto the local fallback. The request path says
so, but it says so at request rate and to whoever happens to be reading logs
under load. Boot is the one place the finding can be stated once, before any
traffic, which makes this the operator's first and best chance to notice that
their vault is configured and inert.

It never raises, on any defect. The vault is an optional capability layered over
a deployment that works without it, so refusing to boot over a typo in it would
be a worse outage than the typo -- the same reasoning
``validate_ipv6_throttle_prefix_config`` follows, and for the same kind of
setting. Unset and blank stay silent, because a deployment with no vault is the
normal, fully supported case and ``backend/.env.example`` ships the variable
present and empty.

Every call below that reaches its assertions is the proof that nothing raises.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from unittest.mock import patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from conftest import test_engine
from main import app, lifespan, validate_creek_vault_url_config
from services.creek_vault_client import VaultUrlDefect, build_creek_vault_client

URL_ENV_VAR = "CREEK_VAULT_URL"
KEY_ENV_VAR = "CREEK_VAULT_API_KEY"
PROTOCOL_ENV_VAR = "CREEK_VAULT_PROTOCOL"
ENV_VAR = "ENV"

# The greppable event name this record is filtered and alerted on, in the shape
# its siblings in ``main`` already use (``ipv6_throttle_prefix_unusable``,
# ``trusted_proxies_unconfigured``). Part of the contract with whoever wrote the
# alert, so renaming it is a breaking change rather than an edit.
UNUSABLE_MARKER = "creek_vault_url_unusable"

MAIN_LOGGER = "main"
EXPECTED_WARNING_COUNT = 1

# The credential the vault seam exists to protect, and a userinfo pair the
# operator put in the URL itself. A boot record is the least supervised log line
# a deployment emits, so neither may appear in it.
SENTINEL_KEY = "SENTINEL_VAULT_KEY_DO_NOT_LEAK"  # pragma: allowlist secret
SENTINEL_USER = "SENTINELUSER"
SENTINEL_PASSWORD = "SENTINELPASSWORD"  # pragma: allowlist secret

USERINFO_URL = f"https://{SENTINEL_USER}:{SENTINEL_PASSWORD}@vault.example.test"

# What the record has to tell an operator who has never read this seam's code:
# what stops happening, what keeps happening, and what to do about it. Matched
# case-insensitively as substrings so the sentence can be rewritten without the
# test dictating its prose -- what is pinned is that each fact is present.
CONSEQUENCE_MARKERS = ("replicat", "reflect", "wheel", "postgres")
REMEDY_MARKER = "unset"

# One URL per defect class, so "never raises" is asserted against every branch
# the classifier can take rather than against whichever one is cheapest to type.
DEFECTIVE_URLS = [
    pytest.param("https://[::1", VaultUrlDefect.UNPARSEABLE, id="unparseable"),
    pytest.param(USERINFO_URL, VaultUrlDefect.FORBIDDEN_COMPONENTS, id="forbidden_components"),
    pytest.param("https://", VaultUrlDefect.MALFORMED, id="malformed"),
    pytest.param("http://vault.example.test", VaultUrlDefect.INSECURE_TRANSPORT, id="insecure"),
]

USABLE_URLS = [
    "https://vault.example.test",
    "https://vault.example.test/vault/",
    "http://localhost:8000",
]

ABSENT_URLS = [None, "", "   "]

ENV_VALUES = [None, "development", "staging", "production"]


def _unusable_warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return the captured records carrying the unusable-config marker."""
    return [record for record in caplog.records if UNUSABLE_MARKER in record.getMessage()]


def _rendered_values(record: logging.LogRecord) -> list[str]:
    """Render every string one record could carry: its message plus each of its fields."""
    return [record.getMessage(), *[str(value) for value in record.__dict__.values()]]


def _set_url(monkeypatch: pytest.MonkeyPatch, url: str | None) -> None:
    """Set the vault URL variable, treating None as unset."""
    if url is None:
        monkeypatch.delenv(URL_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(URL_ENV_VAR, url)


@asynccontextmanager
async def _isolated_factory_patch() -> AsyncGenerator[None, None]:
    """Point main's session factory at the conftest SQLite engine for lifespan runs."""
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with patch("main.async_session_factory", new=factory):
        yield


@pytest.mark.parametrize(("url", "defect"), DEFECTIVE_URLS)
def test_an_unusable_url_warns_once_carrying_the_defect_and_the_detail(
    url: str,
    defect: VaultUrlDefect,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Every defect class is announced, once, in terms an operator can act on.

    Which variable is wrong and what is wrong with it, because "the vault is not
    working" is the one thing the deployment's behaviour already shows: the
    entries keep saving and nothing ever reaches the vault, which looks exactly
    like a healthy app to everything except this record.
    """
    monkeypatch.delenv(ENV_VAR, raising=False)
    monkeypatch.setenv(URL_ENV_VAR, url)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_creek_vault_url_config()

    warnings = _unusable_warnings(caplog)
    assert len(warnings) == EXPECTED_WARNING_COUNT
    assert warnings[0].levelno == logging.WARNING
    rendered = " ".join(_rendered_values(warnings[0]))
    assert URL_ENV_VAR in rendered
    assert defect.value in rendered


def test_the_warning_says_what_stops_what_continues_and_what_to_do(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An operator reading this once, at boot, must not have to read the code next.

    The three facts are inseparable: replication, reflection, and the wheel all
    stop; the entries themselves keep saving to Postgres, which is the
    reassurance that decides whether this is a page or a ticket; and the remedy
    includes unsetting the variable, because running without a vault is a
    supported configuration rather than a failure to be tolerated.
    """
    monkeypatch.setenv(URL_ENV_VAR, "http://vault.example.test")
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_creek_vault_url_config()

    message = _unusable_warnings(caplog)[0].getMessage().lower()
    for marker in CONSEQUENCE_MARKERS:
        assert marker in message
    assert REMEDY_MARKER in message


def test_the_boot_warning_is_not_the_per_request_one(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Boot and request rate are different news, and must read differently.

    The boot record is addressed to whoever deployed this, minutes before any
    traffic; the per-request one is addressed to whoever is reading logs while a
    user saves an entry. One message doing both jobs would either bury the boot
    finding in repetition or leave the request degrade unexplained.
    """
    monkeypatch.setenv(URL_ENV_VAR, "http://vault.example.test")
    monkeypatch.setenv(KEY_ENV_VAR, SENTINEL_KEY)
    monkeypatch.delenv(PROTOCOL_ENV_VAR, raising=False)
    caplog.set_level(logging.WARNING)

    validate_creek_vault_url_config()
    boot_messages = [record.getMessage() for record in _unusable_warnings(caplog)]
    caplog.clear()
    build_creek_vault_client()
    request_messages = [record.getMessage() for record in caplog.records]

    assert len(boot_messages) == EXPECTED_WARNING_COUNT
    assert len(request_messages) == EXPECTED_WARNING_COUNT
    assert boot_messages[0] != request_messages[0]


def test_the_boot_record_carries_neither_the_url_nor_any_credential(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The one variable most likely to hold a pasted secret is the one never echoed.

    A vault URL sits next to ``CREEK_VAULT_API_KEY`` in every deployment's
    configuration, and can carry userinfo that is a credential in its own right.
    The record names the variable and the defect; the value stays where the
    operator put it.
    """
    monkeypatch.setenv(URL_ENV_VAR, USERINFO_URL)
    monkeypatch.setenv(KEY_ENV_VAR, SENTINEL_KEY)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_creek_vault_url_config()

    for record in _unusable_warnings(caplog):
        for rendered in _rendered_values(record):
            assert USERINFO_URL not in rendered
            assert SENTINEL_USER not in rendered
            assert SENTINEL_PASSWORD not in rendered
            assert SENTINEL_KEY not in rendered


@pytest.mark.parametrize("url", USABLE_URLS)
def test_a_usable_url_stays_silent(
    url: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A vault the deployment can actually reach has nothing to announce."""
    monkeypatch.setenv(URL_ENV_VAR, url)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_creek_vault_url_config()

    assert _unusable_warnings(caplog) == []


@pytest.mark.parametrize("url", ABSENT_URLS)
def test_unset_and_blank_stay_silent(
    url: str | None,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Choosing no vault is the floor this whole product runs on, not a misconfiguration.

    Blank counts as unset because the shipped ``.env.example`` leaves the
    variable present and empty; warning there would fire on every stock boot and
    train operators to scroll past the one record that means something.
    """
    monkeypatch.delenv(ENV_VAR, raising=False)
    _set_url(monkeypatch, url)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_creek_vault_url_config()

    assert _unusable_warnings(caplog) == []


@pytest.mark.parametrize("env_value", ENV_VALUES)
def test_the_warning_is_not_gated_on_env(
    env_value: str | None,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A URL nobody can use is wrong in staging too -- staging is where it gets typed."""
    if env_value is None:
        monkeypatch.delenv(ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(ENV_VAR, env_value)
    monkeypatch.setenv(URL_ENV_VAR, "http://vault.example.test")
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_creek_vault_url_config()

    assert len(_unusable_warnings(caplog)) == EXPECTED_WARNING_COUNT


def test_the_check_reads_the_environment_afresh_each_call(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The check keeps no state: it announces, returns, and judges the next read anew."""
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)
    monkeypatch.setenv(URL_ENV_VAR, "https://")

    validate_creek_vault_url_config()

    monkeypatch.setenv(URL_ENV_VAR, "https://vault.example.test")

    validate_creek_vault_url_config()

    assert len(_unusable_warnings(caplog)) == EXPECTED_WARNING_COUNT


@pytest.mark.parametrize(("url", "defect"), DEFECTIVE_URLS)
@pytest.mark.asyncio
async def test_boot_completes_with_the_warning_for_every_defect(
    url: str,
    defect: VaultUrlDefect,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Startup runs the check and finishes anyway, which is the whole design.

    Driven through the real ``lifespan`` rather than by calling the function,
    because a validator nobody wired in is a validator that warns in a test suite
    and nowhere else. Reaching the assertions at all is the proof that no defect
    class takes a deployment down: an optional capability is not worth an outage,
    and the entries keep saving without it.
    """
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    monkeypatch.setenv(URL_ENV_VAR, url)
    monkeypatch.setenv(KEY_ENV_VAR, SENTINEL_KEY)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    async with _isolated_factory_patch(), lifespan(app):
        pass

    warnings = _unusable_warnings(caplog)
    assert len(warnings) == EXPECTED_WARNING_COUNT
    assert defect.value in " ".join(_rendered_values(warnings[0]))
