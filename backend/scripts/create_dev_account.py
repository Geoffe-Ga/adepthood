"""Seed one licensed account on a developer's own machine, without Gumroad.

Every account-creation path in this app -- password signup and both social
sign-ins -- requires a Gumroad-verified APTITUDE license. That is correct for
the product and fatal for local work: there is no way to reach the journal
screen on a laptop, so a full-feature local test cannot begin.

**Why a command and not a flag.** The obvious fix is an environment variable
that skips the license check, and the way those go wrong is well understood:
the flag ships enabled, or defaults to enabled when unset, or is readable in an
environment nobody audited. A seeding command has a smaller blast radius by
construction. Nothing in the request path branches on anything: the license gate
is byte-for-byte what it was, for every real signup, in every environment. There
is no switch to leave on -- the only way to mint an account this way is for a
human to run this command, at a shell, deliberately.

**It still refuses first.** A command that writes an entitled account is worth
guarding even though it is not reachable over the network, because the thing
that goes wrong is not an attacker: it is a tired operator with a production
``DATABASE_URL`` exported in their shell. So the safe state is the default and
several independent conditions each veto on their own:

* ``ENV`` must say ``development``, explicitly. Absent is not "probably local",
  it is unproven -- and unproven refuses.
* ``DATABASE_URL`` must be present and resolve to the loopback interface (or a
  SQLite file). A database this machine cannot reach without a network is not
  this machine's database.
* No live storefront credentials may be configured. ``GUMROAD_API_TOKEN`` or
  ``GUMROAD_WEBHOOK_SECRET`` in the environment means real purchases are being
  processed somewhere near here.
* No platform-injected deployment marker (``RAILWAY_*``) may be present. Those
  are set by the host, not by a person, so their presence is a fact about where
  this process is running rather than an opinion.

Each veto names the variable it read and never renders its value: a database URL
carries a credential, and so does a storefront token.

Usage, from ``backend/``::

    PYTHONPATH=src python -m scripts.create_dev_account --email dev@localhost.test

Exit codes:
    0 -- the account was created and the grant recorded.
    3 -- refused: the environment did not prove itself local, or the email is
         already taken. Nothing was written, and no database was contacted.
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import os
import secrets
import sys
from collections.abc import Mapping, Sequence
from urllib.parse import urlparse

import bcrypt
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import async_session_factory
from domain.entitlements import grant_manual_course_access
from models.user import DEFAULT_USER_TIMEZONE, User

ENV_VAR = "ENV"
DEVELOPMENT_ENV = "development"
DATABASE_URL_ENV_VAR = "DATABASE_URL"
# The credentials half of the storefront integration. Either one present means
# a real Gumroad account is wired to this process.
GUMROAD_ENV_VARS = ("GUMROAD_API_TOKEN", "GUMROAD_WEBHOOK_SECRET")  # pragma: allowlist secret
# Variables the hosting platform injects itself. A person can type ``ENV`` wrong;
# nobody types these by accident, so their presence is evidence rather than
# opinion. Documented as auto-injected in ``backend/.env.example``.
DEPLOYMENT_MARKER_ENV_VARS = (
    "RAILWAY_ENVIRONMENT",
    "RAILWAY_PUBLIC_DOMAIN",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_SERVICE_ID",
)
#: Every variable this command reads, in one tuple so a test can clear exactly
#: the set the decision is made from and no inherited shell value can flip it.
CONSULTED_ENV_VARS = (
    ENV_VAR,
    DATABASE_URL_ENV_VAR,
    *GUMROAD_ENV_VARS,
    *DEPLOYMENT_MARKER_ENV_VARS,
)

#: Distinct from argparse's usage exit code (2) on purpose: "you typed the
#: command wrong" and "this machine may not run this command" call for opposite
#: responses.
REFUSED_EXIT_CODE = 3

_LOOPBACK_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1"})
_SQLITE_SCHEME_PREFIX = "sqlite"

# bcrypt truncates silently past 72 bytes, which would leave an account any
# string sharing the first 72 bytes could authenticate -- the same cap
# ``routers.auth._hash_password`` enforces, for the same reason.
_BCRYPT_MAX_PASSWORD_BYTES = 72
_BCRYPT_ROUNDS = 12
_GENERATED_PASSWORD_BYTES = 12

#: Recorded on the entitlement so a seeded account stays distinguishable from a
#: real redemption in every later query, revenue reconciliation included.
GRANT_REASON = "local development account seeded by scripts.create_dev_account"


class DevAccountRefusedError(RuntimeError):
    """The account was not created, and nothing was written."""


def _environment_signal(env: Mapping[str, str]) -> str | None:
    """Veto unless ``ENV`` explicitly says development.

    Args:
        env: The environment to judge.

    Returns:
        The refusal reason, or ``None`` when this condition is satisfied.
    """
    value = env.get(ENV_VAR, "").strip()
    if value == DEVELOPMENT_ENV:
        return None
    described = repr(value) if value else "unset"
    return (
        f"{ENV_VAR} is {described}, and this command runs only when it is "
        f"explicitly '{DEVELOPMENT_ENV}'. An absent value is not evidence of a "
        "local machine."
    )


def _is_local_database_url(raw: str) -> bool:
    """Whether ``raw`` addresses a database on this machine.

    Args:
        raw: The configured connection URL.

    Returns:
        ``True`` for a SQLite file or a loopback host; ``False`` for anything
        else, including a URL that will not parse -- unparseable is unproven,
        and unproven refuses.
    """
    if raw.startswith(_SQLITE_SCHEME_PREFIX):
        return True
    try:
        hostname = urlparse(raw).hostname
    except ValueError:
        return False
    if hostname is None:
        return False
    if hostname in _LOOPBACK_HOSTNAMES:
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _database_signal(env: Mapping[str, str]) -> str | None:
    """Veto unless the configured database lives on this machine.

    The value is never rendered: a connection URL carries a password.

    Args:
        env: The environment to judge.

    Returns:
        The refusal reason, or ``None`` when this condition is satisfied.
    """
    raw = env.get(DATABASE_URL_ENV_VAR, "").strip()
    if not raw:
        return (
            f"{DATABASE_URL_ENV_VAR} is unset, so this command cannot prove the "
            "database it would write to is the one on this machine."
        )
    if _is_local_database_url(raw):
        return None
    return (
        f"{DATABASE_URL_ENV_VAR} does not resolve to the loopback interface or a "
        "SQLite file, so it names a database this machine reaches over a network. "
        "The value is not echoed here because it carries a credential."
    )


def _configured_name_signals(
    env: Mapping[str, str],
    names: Sequence[str],
    consequence: str,
) -> list[str]:
    """Return one refusal reason per configured variable in ``names``.

    Args:
        env: The environment to judge.
        names: Variables whose mere presence is disqualifying.
        consequence: What that presence says about where this is running.

    Returns:
        One reason per set variable, naming it and never its value.
    """
    return [f"{name} is set, {consequence}" for name in names if env.get(name, "").strip()]


def deployment_signals(env: Mapping[str, str]) -> list[str]:
    """Return every reason ``env`` is not a machine that may seed an account.

    An empty list is the only permission this command recognises, and it is
    reached only by satisfying each condition: they are independent, so no
    single forgotten or mistyped variable decides the outcome alone.

    Args:
        env: The environment to judge, passed in rather than read from the
            process so both sides of the decision are testable.

    Returns:
        Human-readable reasons, empty when the environment proved itself local.
    """
    signals = [
        signal for signal in (_environment_signal(env), _database_signal(env)) if signal is not None
    ]
    signals.extend(
        _configured_name_signals(
            env,
            GUMROAD_ENV_VARS,
            "so real purchases are being processed against this configuration.",
        )
    )
    signals.extend(
        _configured_name_signals(
            env,
            DEPLOYMENT_MARKER_ENV_VARS,
            "and that variable is injected by the hosting platform, not by a person.",
        )
    )
    return signals


def _hash_password(password: str) -> str:
    """Hash ``password`` at the same bcrypt cost the auth router uses.

    Args:
        password: The plaintext to hash.

    Returns:
        The bcrypt digest.

    Raises:
        DevAccountRefusedError: When the password exceeds bcrypt's 72-byte input cap,
            which bcrypt would otherwise absorb by truncating.
    """
    encoded = password.encode("utf-8")
    if len(encoded) > _BCRYPT_MAX_PASSWORD_BYTES:
        msg = (
            f"password exceeds bcrypt's {_BCRYPT_MAX_PASSWORD_BYTES}-byte limit, and "
            "hashing it would silently truncate the part that makes it unguessable"
        )
        raise DevAccountRefusedError(msg)
    return bcrypt.hashpw(encoded, bcrypt.gensalt(rounds=_BCRYPT_ROUNDS)).decode("utf-8")


async def _refuse_existing_email(session: AsyncSession, email: str) -> None:
    """Refuse when ``email`` already has an account.

    Re-keying a matched email is the shape of an account takeover; a command
    that does it on a laptop is a command that would do it wherever it was
    pointed.

    Args:
        session: Open database session.
        email: The address the caller asked for.

    Raises:
        DevAccountRefusedError: When the address is already registered.
    """
    result = await session.execute(select(User).where(User.email == email))
    if result.scalars().first() is None:
        return
    msg = (
        f"{email} already has an account; this command will not re-key an "
        "existing one. Pass --email with a different address."
    )
    raise DevAccountRefusedError(msg)


def _announce(email: str) -> None:
    """State on stderr what was just done and what was skipped.

    A run nobody notices is the run that ends up in somebody's shell history
    unexplained, so the record names the account and says plainly that no
    license was verified.

    Args:
        email: The address the account was created for.
    """
    sys.stderr.write(
        f"dev_account_seeded: created {email} and granted course access WITHOUT "
        "verifying any Gumroad license. This account exists only because a human "
        "ran this command on a machine that proved itself local; the signup route "
        "is unchanged and still requires a verified license.\n"
    )


async def seed_dev_account(
    session: AsyncSession,
    *,
    email: str,
    password: str,
    timezone: str = DEFAULT_USER_TIMEZONE,
) -> User:
    """Create the account and comp it course access, announcing both.

    The grant goes through :func:`grant_manual_course_access`, so it records a
    stated reason and no sale link -- the NULL ``source_sale_id`` is what keeps
    a seeded account distinguishable from a purchase forever after.

    Args:
        session: Open database session.
        email: Address for the new account.
        password: Plaintext password the developer will log in with.
        timezone: IANA timezone stored on the user row.

    Returns:
        The persisted user.

    Raises:
        DevAccountRefusedError: When the address is taken or the password cannot be
            hashed without truncation.
    """
    await _refuse_existing_email(session, email)
    user = User(email=email, password_hash=_hash_password(password), timezone=timezone)
    session.add(user)
    await session.commit()
    await session.refresh(user)
    await grant_manual_course_access(
        session,
        user,
        reason=GRANT_REASON,
        actor_admin_id=None,
    )
    _announce(email)
    return user


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the command line.

    Args:
        argv: Arguments without the program name, or ``None`` for ``sys.argv``.

    Returns:
        The parsed namespace.
    """
    parser = argparse.ArgumentParser(
        prog="python -m scripts.create_dev_account",
        description=(
            "Create one local account with course access, bypassing Gumroad "
            "license verification. Refuses on any machine that looks like a "
            "deployment."
        ),
    )
    parser.add_argument("--email", default="dev@localhost.test", help="address for the account")
    parser.add_argument(
        "--password",
        default=None,
        help="password to set; a random one is generated and printed when omitted",
    )
    parser.add_argument(
        "--timezone",
        default=DEFAULT_USER_TIMEZONE,
        help=f"IANA timezone for the account (default: {DEFAULT_USER_TIMEZONE})",
    )
    return parser.parse_args(argv)


def _print_refusal(signals: Sequence[str]) -> None:
    """Print every veto, so one fix does not reveal another on the next run.

    Args:
        signals: The reasons this environment may not seed an account.
    """
    sys.stderr.write(
        "refusing to seed a development account: this environment does not "
        "prove it is a local development machine.\n"
    )
    for signal in signals:
        sys.stderr.write(f"  - {signal}\n")


async def _seed_with_session(args: argparse.Namespace, password: str) -> int:
    """Open a session and seed, translating a refusal into an exit code.

    Args:
        args: Parsed command line.
        password: The password to set, already resolved.

    Returns:
        The process exit code.
    """
    async with async_session_factory() as session:
        try:
            await seed_dev_account(
                session,
                email=args.email,
                password=password,
                timezone=args.timezone,
            )
        except DevAccountRefusedError as exc:
            sys.stderr.write(f"refusing to seed a development account: {exc}\n")
            return REFUSED_EXIT_CODE
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Refuse, or seed one account and say so.

    The environment is judged before anything is opened, so a refusal contacts
    no database at all -- a connection attempt against a production URL is
    itself part of what this refuses to do.

    Args:
        argv: Arguments without the program name, or ``None`` for ``sys.argv``.

    Returns:
        The process exit code.
    """
    args = _parse_args(argv)
    signals = deployment_signals(os.environ)
    if signals:
        _print_refusal(signals)
        return REFUSED_EXIT_CODE
    password = args.password or secrets.token_urlsafe(_GENERATED_PASSWORD_BYTES)
    if args.password is None:
        sys.stderr.write(f"generated password: {password}\n")
    return asyncio.run(_seed_with_session(args, password))


if __name__ == "__main__":  # pragma: no cover — exercised via tests/CLI
    sys.exit(main(sys.argv[1:]))
