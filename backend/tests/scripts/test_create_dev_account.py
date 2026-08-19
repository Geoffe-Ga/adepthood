"""Tests for ``backend/scripts/create_dev_account.py``.

Every account-creation path in this app requires a Gumroad-verified APTITUDE
license, so a developer cannot reach the journal screen on their own machine.
The fix is a *seeding command* rather than a runtime bypass flag: nothing in the
request path branches, there is no switch that can be left on, and the license
gate is exactly as it was for every real signup.

That still leaves a command that mints an entitled account, so the contract
tested here is refusal-first:

* The default state grants nothing. An empty environment is not "probably
  local" -- it is unproven, and unproven refuses.
* Several independent conditions each veto on their own, so no single
  mistyped or forgotten variable can be the difference between refusing and
  seeding a live database.
* A refusal touches no database at all. That is asserted by handing the
  command a session factory that fails the test if it is ever called, rather
  than by inspecting rows afterwards -- a connection attempt against a
  production URL is itself the thing being prevented.
* The Gumroad-verified path is untouched: the signup route still rejects a
  license-less request in the very environment where this command is fully
  permitted.

And one more, because a guarded command that produces an unusable account has
guarded nothing: the address is folded and validated the way the API folds and
validates its own, proven by logging the seeded account in through the real
route rather than by re-reading the row this command just wrote.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from http import HTTPStatus
from typing import NoReturn

import bcrypt
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from domain.entitlements import has_course_access
from models.entitlement import Entitlement
from models.user import User
from routers.auth import AuthRequest
from scripts import create_dev_account

# A machine a developer is actually sitting at: explicitly development, a
# database on the loopback interface, no live storefront credentials, no
# platform-injected deployment markers.
LOCAL_DATABASE_URL = (
    "postgresql+asyncpg://aptitude:aptitude@localhost:5432/aptitude"  # pragma: allowlist secret
)
LOCAL_ENV: Mapping[str, str] = {
    "ENV": "development",
    "DATABASE_URL": LOCAL_DATABASE_URL,
}

SEED_EMAIL = create_dev_account.DEFAULT_DEV_EMAIL
SEED_PASSWORD = "dev-account-password"  # pragma: allowlist secret

# The same address as ``SEED_EMAIL``, spelled the way a person types one: the
# auth router lower-cases and strips every inbound email, so this is what a
# developer may pass and ``SEED_EMAIL`` is the only row that can ever match it.
SEED_EMAIL_AS_TYPED = "  Dev@Example.COM\n"

# Spellings the boundary must fold together. Each is fed to both the command and
# the router so a one-sided change to either shows up as a disagreement rather
# than as an account nobody can log in to.
EQUIVALENT_EMAIL_SPELLINGS = [
    SEED_EMAIL,
    SEED_EMAIL_AS_TYPED,
    "DEV@EXAMPLE.COM",
    "\tDev@example.Com ",
]

# Addresses that read as reassuringly local and that ``EmailStr`` refuses: RFC
# 6761 reserves these names, so no client can ever send one. An account keyed to
# one is unreachable through the login route no matter what else is right.
UNUSABLE_LOCAL_LOOKING_EMAILS = [
    "dev@localhost.test",
    "dev@localhost.localhost",
    "dev@localhost",
]

# One case per veto, each built by mutating the *permitted* environment, so a
# passing case proves that single variable is independently sufficient to
# refuse rather than riding on some other defect in the fixture.
REFUSING_ENVS = [
    pytest.param({}, "ENV", id="empty-environment"),
    pytest.param({**LOCAL_ENV, "ENV": "production"}, "ENV", id="env-production"),
    pytest.param({**LOCAL_ENV, "ENV": "staging"}, "ENV", id="env-staging"),
    pytest.param({**LOCAL_ENV, "ENV": ""}, "ENV", id="env-blank"),
    pytest.param(
        {k: v for k, v in LOCAL_ENV.items() if k != "ENV"},
        "ENV",
        id="env-unset",
    ),
    pytest.param(
        {k: v for k, v in LOCAL_ENV.items() if k != "DATABASE_URL"},
        "DATABASE_URL",
        id="database-url-unset",
    ),
    pytest.param(
        {**LOCAL_ENV, "DATABASE_URL": "postgresql://u:p@db.railway.internal:5432/railway"},
        "DATABASE_URL",
        id="database-url-remote",
    ),
    pytest.param(
        {**LOCAL_ENV, "DATABASE_URL": "postgresql://u:p@10.0.0.7:5432/adepthood"},
        "DATABASE_URL",
        id="database-url-private-ip",
    ),
    pytest.param(
        {**LOCAL_ENV, "DATABASE_URL": "://:::"},
        "DATABASE_URL",
        id="database-url-unparseable",
    ),
    pytest.param(
        {**LOCAL_ENV, "GUMROAD_API_TOKEN": "live-seller-token"},  # pragma: allowlist secret
        "GUMROAD_API_TOKEN",
        id="gumroad-api-token",
    ),
    pytest.param(
        {**LOCAL_ENV, "GUMROAD_WEBHOOK_SECRET": "live-webhook-secret"},  # pragma: allowlist secret
        "GUMROAD_WEBHOOK_SECRET",  # pragma: allowlist secret
        id="gumroad-webhook-secret",
    ),
    pytest.param(
        {**LOCAL_ENV, "RAILWAY_ENVIRONMENT": "production"},
        "RAILWAY_ENVIRONMENT",
        id="railway-marker",
    ),
    pytest.param(
        {**LOCAL_ENV, "RAILWAY_PUBLIC_DOMAIN": "adepthood.up.railway.app"},
        "RAILWAY_PUBLIC_DOMAIN",
        id="railway-domain-marker",
    ),
]

# Loopback spellings a developer plausibly uses, plus the SQLite file a test or
# a throwaway run points at. Each must be accepted, or the command refuses the
# very machines it exists to serve.
PERMITTED_DATABASE_URLS = [
    LOCAL_DATABASE_URL,
    "postgresql://aptitude:aptitude@127.0.0.1:5432/aptitude",  # pragma: allowlist secret
    "postgresql+asyncpg://aptitude:aptitude@[::1]:5432/aptitude",  # pragma: allowlist secret
    "sqlite+aiosqlite:///./local.db",
]


def _set_environment(monkeypatch: pytest.MonkeyPatch, env: Mapping[str, str]) -> None:
    """Install ``env`` as the whole of the process environment the command reads.

    Every variable the command consults is cleared first, so a value inherited
    from the developer's own shell cannot turn a refusing case into a
    permitted one (or the reverse) without the test saying so.
    """
    for name in create_dev_account.CONSULTED_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)


def _refuse_any_session(*_args: object, **_kwargs: object) -> NoReturn:
    """Session factory stand-in that fails the test the moment it is called."""
    pytest.fail("the command opened a database session despite refusing to run")


@pytest.mark.parametrize(("env", "expected_variable"), REFUSING_ENVS)
def test_a_deployment_shaped_environment_is_refused(
    env: Mapping[str, str],
    expected_variable: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Each signal vetoes on its own, says which variable it read, and writes nothing.

    The empty environment is in this list deliberately: absent configuration is
    the state a forgotten ``.env`` produces, and it must grant nothing rather
    than be read as "no evidence of production, therefore local".
    """
    _set_environment(monkeypatch, env)
    monkeypatch.setattr(create_dev_account, "async_session_factory", _refuse_any_session)

    exit_code = create_dev_account.main(["--email", SEED_EMAIL, "--password", SEED_PASSWORD])

    assert exit_code == create_dev_account.REFUSED_EXIT_CODE
    assert expected_variable in capsys.readouterr().err


def test_the_permitted_environment_is_the_only_quiet_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A developer's own machine produces no vetoes -- the proven quiet side.

    Without this the refusal tests above would pass for a detector that vetoes
    unconditionally, which would be a command nobody can use.
    """
    _set_environment(monkeypatch, LOCAL_ENV)

    assert create_dev_account.deployment_signals(dict(LOCAL_ENV)) == []


@pytest.mark.parametrize("database_url", PERMITTED_DATABASE_URLS)
def test_every_local_database_spelling_is_accepted(database_url: str) -> None:
    """Loopback by name, by IPv4 literal, by IPv6 literal, and a SQLite file."""
    assert create_dev_account.deployment_signals({**LOCAL_ENV, "DATABASE_URL": database_url}) == []


def test_the_permitted_environment_does_reach_the_database(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prove the refusal tests above are not vacuous.

    "The command opened no session" is only evidence of a refusal if this
    command opens one when it is allowed to. Without this case, every refusal
    assertion would also pass for a ``main`` that never touched a database at
    all.
    """

    class _OpenedError(Exception):
        """Raised by the stand-in factory the moment it is called."""

        def __init__(self) -> None:
            super().__init__("session factory reached")

    def _record_call(*_args: object, **_kwargs: object) -> NoReturn:
        raise _OpenedError

    _set_environment(monkeypatch, LOCAL_ENV)
    monkeypatch.setattr(create_dev_account, "async_session_factory", _record_call)

    with pytest.raises(_OpenedError):
        create_dev_account.main(["--email", SEED_EMAIL, "--password", SEED_PASSWORD])


@pytest.mark.asyncio
async def test_a_password_bcrypt_would_truncate_is_refused(
    db_session: AsyncSession,
) -> None:
    """Past 72 bytes bcrypt silently drops the rest, so this refuses instead.

    An account whose password is effectively its first 72 bytes is an account
    the developer believes is stronger than it is -- the same cap the auth
    router enforces on the real signup path.
    """
    with pytest.raises(create_dev_account.DevAccountRefusedError, match="72"):
        await create_dev_account.seed_dev_account(
            db_session,
            email=SEED_EMAIL,
            password="p" * 73,
            timezone="UTC",
        )

    remaining = (
        (await db_session.execute(select(User).where(User.email == SEED_EMAIL))).scalars().first()
    )
    assert remaining is None


@pytest.mark.asyncio
async def test_the_seeded_account_can_log_in_and_holds_course_access(
    db_session: AsyncSession,
) -> None:
    """The point of the command: an account that works, without a license key.

    Password verified with bcrypt directly rather than through the login route,
    because what is under test is the row this command writes; the route's own
    behaviour is covered by the auth suite and deliberately untouched.
    """
    user = await create_dev_account.seed_dev_account(
        db_session,
        email=SEED_EMAIL,
        password=SEED_PASSWORD,
        timezone="UTC",
    )

    stored = (
        (await db_session.execute(select(User).where(User.email == SEED_EMAIL))).scalars().first()
    )
    assert stored is not None
    assert stored.id == user.id
    assert user.id is not None
    assert bcrypt.checkpw(SEED_PASSWORD.encode(), stored.password_hash.encode())
    assert await has_course_access(db_session, user.id) is True


@pytest.mark.asyncio
async def test_a_mixed_case_email_seeds_an_account_that_can_actually_log_in(
    db_session: AsyncSession,
    async_client: AsyncClient,
) -> None:
    """``--email Dev@Example.COM`` must produce credentials that work.

    Login normalizes its payload and then looks the row up by exact string, so
    a mixed-case row is unreachable by every spelling: the typed one is folded
    away before the query, and the folded one does not match what was stored.
    Asserted through the real login route rather than against the row, because
    "the row exists" is precisely the fact that was already true while the
    account was unusable.
    """
    await create_dev_account.seed_dev_account(
        db_session,
        email=SEED_EMAIL_AS_TYPED,
        password=SEED_PASSWORD,
        timezone="UTC",
    )

    response = await async_client.post(
        "/auth/login",
        json={"email": SEED_EMAIL_AS_TYPED, "password": SEED_PASSWORD},
    )

    assert response.status_code == HTTPStatus.OK
    stored = (
        (await db_session.execute(select(User).where(User.email == SEED_EMAIL))).scalars().first()
    )
    assert stored is not None
    assert response.json()["user_id"] == stored.id


@pytest.mark.parametrize("address", UNUSABLE_LOCAL_LOOKING_EMAILS)
@pytest.mark.asyncio
async def test_an_address_the_api_rejects_is_refused_rather_than_stored(
    address: str,
    db_session: AsyncSession,
) -> None:
    """A row the login route cannot address is worse than no row at all.

    ``dev@localhost.test`` looks like the obvious local address and is a
    special-use reserved name, so ``EmailStr`` refuses it and the login request
    never reaches the lookup. Seeding it would hand a developer credentials,
    print a password, report success -- and produce 422 on every attempt to use
    them, with nothing in the message pointing at the address.
    """
    with pytest.raises(create_dev_account.DevAccountRefusedError, match="could not be logged in"):
        await create_dev_account.seed_dev_account(
            db_session,
            email=address,
            password=SEED_PASSWORD,
            timezone="UTC",
        )

    assert (await db_session.execute(select(User))).scalars().first() is None


@pytest.mark.parametrize("spelling", EQUIVALENT_EMAIL_SPELLINGS)
def test_the_command_normalizes_an_email_exactly_as_the_auth_boundary_does(
    spelling: str,
) -> None:
    """Pin the command's rule to the router's, so neither can drift alone.

    The command cannot import the router's rule: it lives as a private
    ``field_validator`` on ``AuthRequest``, and the only other copy is an
    equally private helper in the password-reset schema. Rather than reach into
    either -- or edit a request-path module this change deliberately leaves
    byte-for-byte alone -- the two are held together here, by comparing their
    output on every spelling that matters. A one-sided edit fails this test.
    """
    boundary = AuthRequest(email=spelling, password=SEED_PASSWORD)

    assert create_dev_account.normalize_email(spelling) == boundary.email


@pytest.mark.asyncio
async def test_a_case_variant_of_a_seeded_address_refuses_instead_of_colliding(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A second run spelled differently exits 3, not with an IntegrityError.

    ``ix_user_lower_email_unique`` makes case-insensitive uniqueness a database
    guarantee, so a pre-check that compares case-sensitively does not prevent
    the collision -- it only moves it to the INSERT, where it surfaces as an
    unhandled traceback instead of the documented refusal.
    """
    await create_dev_account.seed_dev_account(
        db_session,
        email=SEED_EMAIL,
        password=SEED_PASSWORD,
        timezone="UTC",
    )

    @asynccontextmanager
    async def _factory() -> AsyncIterator[AsyncSession]:
        yield db_session

    monkeypatch.setattr(create_dev_account, "async_session_factory", _factory)

    exit_code = await create_dev_account.seed_with_session(
        email="DEV@EXAMPLE.COM",
        password="a-different-password",  # pragma: allowlist secret
        timezone="UTC",
    )

    assert exit_code == create_dev_account.REFUSED_EXIT_CODE
    assert SEED_EMAIL in capsys.readouterr().err
    users = (await db_session.execute(select(User))).scalars().all()
    assert len(users) == 1


@pytest.mark.asyncio
async def test_the_grant_is_recorded_as_a_comp_not_a_purchase(
    db_session: AsyncSession,
) -> None:
    """Nothing paid for this account, and the row must not pretend otherwise.

    A seeded entitlement with a product id would be indistinguishable from a
    real redemption in every later query -- revenue reconciliation included.
    The absent sale link is what makes a dev account auditable after the fact.
    """
    user = await create_dev_account.seed_dev_account(
        db_session,
        email=SEED_EMAIL,
        password=SEED_PASSWORD,
        timezone="UTC",
    )

    entitlement = (
        (await db_session.execute(select(Entitlement).where(Entitlement.user_id == user.id)))
        .scalars()
        .first()
    )
    assert entitlement is not None
    assert entitlement.source_sale_id is None
    assert entitlement.product_id is None


@pytest.mark.asyncio
async def test_seeding_an_existing_email_refuses_rather_than_reissuing(
    db_session: AsyncSession,
) -> None:
    """A second run must not silently re-key an account that already exists.

    Overwriting a password on a matched email is the shape of an account
    takeover, and a command that does it locally is a command that would do it
    anywhere it was ever pointed.
    """
    await create_dev_account.seed_dev_account(
        db_session,
        email=SEED_EMAIL,
        password=SEED_PASSWORD,
        timezone="UTC",
    )

    with pytest.raises(create_dev_account.DevAccountRefusedError, match=SEED_EMAIL):
        await create_dev_account.seed_dev_account(
            db_session,
            email=SEED_EMAIL,
            password="a-different-password",  # pragma: allowlist secret
            timezone="UTC",
        )


@pytest.mark.asyncio
async def test_the_seeding_announces_itself_and_what_it_skipped(
    db_session: AsyncSession,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A run nobody would notice is the run that ends up in somebody's history.

    The record has to name the account and say plainly that no license was
    verified, so an operator who finds this in a shell history or a log knows
    what it did without reading the source.
    """
    await create_dev_account.seed_dev_account(
        db_session,
        email=SEED_EMAIL,
        password=SEED_PASSWORD,
        timezone="UTC",
    )

    announced = capsys.readouterr().err.lower()
    assert SEED_EMAIL in announced
    assert "license" in announced


@pytest.mark.real_license_gate
@pytest.mark.asyncio
async def test_signup_still_demands_a_license_in_the_permitted_environment(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real path is untouched in exactly the environment the seeder allows.

    This is the whole justification for choosing a command over a flag: with
    the environment as permissive as it ever gets -- the very configuration
    under which the seeding command agrees to run -- the signup route still
    refuses an account with no verified license. There is no request-path
    branch to leave switched on. Marked ``real_license_gate`` so the suite-wide
    stub is out of the way and the genuine gate answers.
    """
    _set_environment(monkeypatch, LOCAL_ENV)

    response = await async_client.post(
        "/auth/signup",
        json={
            "email": "someone@example.com",
            "password": "a-long-enough-password",  # pragma: allowlist secret
        },
    )

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == "license_required"
