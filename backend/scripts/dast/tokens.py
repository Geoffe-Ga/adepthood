"""Mint working bearer tokens for a live instance, and prove they work.

Every DAST check in this package needs the same thing before it can start: a
real, working credential for the instance under test. Signup cannot provide one
-- it is gated on a live license verification that cannot be satisfied across a
socket -- so a user row is inserted through the application's own ORM, hashed
with the application's own hasher, and the token is then minted over the real
``POST /auth/login``. Only the row creation is bypassed; every credential that
leaves this module came out of the genuine auth stack.

Two consumers share it. The authorization matrix imports :func:`mint_identities`
for its owner/intruder pair. The contract-fuzz job runs this module as a command
and splices its stdout into an ``Authorization`` header, which is why stdout
carries the bare token and nothing else, and why every diagnostic goes to stderr.

The verification probe is the reason this is a module rather than two lines of
shell. A fuzz run holding a token that does not work answers 401 to every
request, violates none of the response checks, and reports a clean gate having
reached no handler at all. So the token is spent once against a genuinely
authenticated route before it is printed, and a probe that does not succeed is a
harness error rather than a credential.

Usage:

    python -m scripts.dast.tokens --base-url URL --database-url URL
    python -m scripts.dast.tokens --base-url URL --database-url URL \
        --label fuzz --probe-path /habits/

Run it from ``backend/`` with ``PYTHONPATH=src``, the way the other repository
scripts are invoked, so both the harness package and the application's own
modules are importable.

Exit codes:
    0 — a token was minted, proved usable, and printed on stdout.
    3 — the instance, the identity database, or the credential itself could not
        be used. Deliberately the same "harness error" code the rest of this
        package uses: a run that proved nothing must never be mistaken for a
        finding, and must never print a token a caller would go on to trust.
"""

from __future__ import annotations

import argparse
import asyncio
import secrets
import sys
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass

from httpx import AsyncClient, HTTPError
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from models.user import User
from routers.auth import _hash_password
from scripts.dast.report import EXIT_CLEAN, EXIT_HARNESS_ERROR
from scripts.dast.runner import (
    DEFAULT_AUTH_PROBE_PATH,
    Identity,
    LiveTargetError,
    forwarded_for,
)

__all__ = [
    "Credentials",
    "Minter",
    "TokenOverrides",
    "insert_users",
    "login",
    "main",
    "mint_identities",
    "new_credentials",
    "redacted",
    "verify",
]

# Generated per run rather than written down, so there is no credential literal
# anywhere in the repository and no reusable account left behind.
_PASSWORD_BYTES = 24
_EMAIL_TOKEN_BYTES = 4
# RFC 2606's documentation domain: the email validator rejects reserved TLDs
# such as ``.invalid`` outright, which would 422 the login before it was tried.
_EMAIL_DOMAIN = "example.com"
_SEED_TIMEZONE = "UTC"

_LOGIN_PATH = "/auth/login"
_REQUEST_TIMEOUT_SECONDS = 30.0

# What a report says instead of a DSN it could not even parse. Echoing the
# string back verbatim would put whatever it does contain into the log.
_UNPARSEABLE_DSN = "<unparseable database URL>"

# The label the standalone CLI gives the one identity it mints. It appears in no
# assertion; it exists so a stray log line names the account it came from.
_DEFAULT_LABEL = "fuzz"

_SUCCESS_FLOOR = 200
_SUCCESS_CEILING = 300


@dataclass(frozen=True)
class Credentials:
    """One throwaway identity, before it has a token.

    Attributes:
        label: How a report names this actor.
        email: The address the identity is created with.
        password: The plaintext the login route is asked to accept.
    """

    label: str
    email: str
    password: str


# Injected so a test can drive the CLI without an ORM or a database, while
# production mints its identity the only way an outside process can.
Minter = Callable[[AsyncClient], Awaitable[Identity]]


@dataclass(frozen=True)
class TokenOverrides:
    """Seams a test may replace, defaulting to the production wiring.

    Attributes:
        client: An HTTP client to use instead of dialling ``--base-url``.
        minter: An identity minter to use instead of the ORM insert plus real
            login.
    """

    client: AsyncClient | None = None
    minter: Minter | None = None


def new_credentials(label: str) -> Credentials:
    """Mint credentials for one throwaway identity.

    Args:
        label: How a report should name this actor.

    Returns:
        A fresh, unregistered identity.
    """
    return Credentials(
        label=label,
        email=f"dast-{label.lower()}-{secrets.token_hex(_EMAIL_TOKEN_BYTES)}@{_EMAIL_DOMAIN}",
        password=secrets.token_urlsafe(_PASSWORD_BYTES),
    )


def redacted(database_url: str) -> str:
    """Render a database URL with its password removed, for a line of output.

    Args:
        database_url: The DSN to name.

    Returns:
        The same URL with its credential replaced, or a fixed marker when the
        string cannot be parsed at all. A report is pasted into issues and CI
        logs, so the DSN has to be nameable without the credential travelling
        along, and an unparseable one must not be echoed back verbatim either.
    """
    try:
        return make_url(database_url).render_as_string(hide_password=True)
    except ArgumentError:
        return _UNPARSEABLE_DSN


async def _commit_users(database_url: str, credentials: Sequence[Credentials]) -> None:
    """Open an engine of the harness's own, insert every identity's row, dispose of it.

    Args:
        database_url: The async database URL the target instance is using.
        credentials: The identities to create.
    """
    engine = create_async_engine(database_url)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with factory() as session:
            for item in credentials:
                session.add(
                    User(
                        email=item.email,
                        password_hash=await _hash_password(item.password),
                        timezone=_SEED_TIMEZONE,
                    ),
                )
            await session.commit()
    finally:
        await engine.dispose()


async def insert_users(database_url: str, credentials: Sequence[Credentials]) -> None:
    """Insert the identities' rows through the application's own ORM.

    Args:
        database_url: The async database URL the target instance is using.
        credentials: The identities to create.

    Raises:
        LiveTargetError: When the database cannot be reached or will not accept
            the rows. Left to propagate as-is it would exit the process on 1 --
            the code that means "a foreign object was reached" -- so it is
            re-raised as the type the runner reports as a harness error, naming
            the DSN it could not use. The DSN is scrubbed out of the driver's own
            message too, because several drivers echo it back.

    Signup is gated on a live license verification with no local override, so a
    row insert is the only way to make an identity from outside the process. The
    password is hashed with the application's own hasher, which is what lets the
    real login route accept it a moment later.
    """
    try:
        await _commit_users(database_url, credentials)
    except (SQLAlchemyError, OSError) as error:
        scrubbed = redacted(database_url)
        detail = str(error).replace(database_url, scrubbed)
        message = (
            f"the identity database {scrubbed} could not be used to insert the identities: "
            f"{type(error).__name__}: {detail}"
        )
        raise LiveTargetError(message) from error


async def login(client: AsyncClient, credentials: Credentials) -> Identity:
    """Mint one identity's token over the target's real login route.

    Args:
        client: A client pointed at the target instance.
        credentials: The identity to log in.

    Returns:
        The logged-in identity, carrying a token the target itself issued.
    """
    response = await client.post(
        _LOGIN_PATH,
        json={"email": credentials.email, "password": credentials.password},
        headers={"X-Forwarded-For": forwarded_for()},
    )
    response.raise_for_status()
    return Identity(
        label=credentials.label,
        email=credentials.email,
        token=str(response.json()["token"]),
    )


async def mint_identities(
    client: AsyncClient,
    *,
    database_url: str,
    labels: Sequence[str],
) -> tuple[Identity, ...]:
    """Create one identity per label and log them all in, in order.

    Args:
        client: A client pointed at the target instance.
        database_url: The database that instance is serving from.
        labels: How each identity should be named, in the order they are wanted.

    Returns:
        The logged-in identities, in the order their labels were given.

    Every row is committed before the first login, in one transaction: an
    identity that exists only after its sibling has already been rejected would
    turn a credential problem into a race.
    """
    credentials = [new_credentials(label) for label in labels]
    await insert_users(database_url, credentials)
    return tuple([await login(client, item) for item in credentials])


async def verify(client: AsyncClient, identity: Identity, *, probe_path: str) -> None:
    """Spend the token once against an authenticated route.

    Args:
        client: A client pointed at the target instance.
        identity: The identity whose token is being proved.
        probe_path: A route that requires a credential.

    Raises:
        LiveTargetError: When the probe answers anything but a 2xx. That is the
            vacuity guard: a consumer handed an unusable token would send
            thousands of requests, be denied every one of them, and read the
            uniform denial as a clean result.
    """
    response = await client.get(
        probe_path,
        headers={
            "Authorization": f"Bearer {identity.token}",
            "X-Forwarded-For": forwarded_for(),
        },
    )
    if not _SUCCESS_FLOOR <= response.status_code < _SUCCESS_CEILING:
        message = (
            f"the minted token did not authenticate on {probe_path}: "
            f"HTTP {response.status_code}. A run using it would be denied "
            f"uniformly and prove nothing."
        )
        raise LiveTargetError(message)


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the command line.

    Neither target has a default on purpose: a defaulted base URL is how a run
    silently credentials itself against localhost instead of the ephemeral
    instance the job started, and a defaulted database URL is how it seeds an
    identity into the wrong place.

    Args:
        argv: The command line, without the program name.

    Returns:
        The parsed arguments.
    """
    parser = argparse.ArgumentParser(
        prog="tokens",
        description="Mint a bearer token for a live instance and prove it works.",
    )
    parser.add_argument("--base-url", required=True, help="Base URL of the running instance.")
    parser.add_argument(
        "--database-url",
        required=True,
        help="Async database URL that instance is serving from.",
    )
    parser.add_argument(
        "--label",
        default=_DEFAULT_LABEL,
        help="How the minted identity is named in diagnostics.",
    )
    parser.add_argument(
        "--probe-path",
        default=DEFAULT_AUTH_PROBE_PATH,
        help="Authenticated route the minted token is proved against.",
    )
    return parser.parse_args(argv)


async def _mint_and_verify(
    client: AsyncClient,
    args: argparse.Namespace,
    overrides: TokenOverrides,
) -> Identity:
    """Produce one proved identity from either the injected minter or the real one.

    Args:
        client: The client to use.
        args: The parsed command line.
        overrides: The seams a test injected.

    Returns:
        An identity whose token has been spent successfully on the probe route.
    """
    if overrides.minter is not None:
        identity = await overrides.minter(client)
    else:
        minted = await mint_identities(
            client,
            database_url=args.database_url,
            labels=(args.label,),
        )
        identity = minted[0]
    await verify(client, identity, probe_path=args.probe_path)
    return identity


async def _execute(args: argparse.Namespace, overrides: TokenOverrides) -> Identity:
    """Run the mint, owning the client's lifetime only when it created one.

    Args:
        args: The parsed command line.
        overrides: The seams a test injected.

    Returns:
        The proved identity.
    """
    if overrides.client is not None:
        return await _mint_and_verify(overrides.client, args, overrides)
    async with AsyncClient(base_url=args.base_url, timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        return await _mint_and_verify(client, args, overrides)


def main(argv: Sequence[str] | None = None, *, overrides: TokenOverrides | None = None) -> int:
    """Mint a token, prove it, and print it.

    Args:
        argv: The command line, without the program name.
        overrides: Seams a test replaces; production passes nothing.

    Returns:
        ``EXIT_CLEAN`` with the bare token on stdout, or ``EXIT_HARNESS_ERROR``
        with the reason on stderr and stdout left empty. Nothing but the token
        is ever written to stdout: the caller splices it straight into an
        ``Authorization`` header, so one line of progress reporting would travel
        into that header and deny every request the run went on to make.
    """
    args = _parse_args(argv)
    settings = overrides if overrides is not None else TokenOverrides()
    try:
        identity = asyncio.run(_execute(args, settings))
    except (LiveTargetError, HTTPError) as error:
        sys.stderr.write(f"HARNESS ERROR  {type(error).__name__}: {error}\n")
        return EXIT_HARNESS_ERROR
    sys.stdout.write(f"{identity.token}\n")
    return EXIT_CLEAN


if __name__ == "__main__":  # pragma: no cover — exercised via tests/CLI
    sys.exit(main(sys.argv[1:]))
