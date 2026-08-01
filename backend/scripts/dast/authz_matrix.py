"""Run the authenticated BOLA/IDOR authorization matrix against a live instance.

Two identities are created, and the check asks one question of every route that
addresses an object by id in its path: can identity B reach identity A's object?
A denial only counts once the same route has answered A herself, which is what
keeps "everything was refused" from passing as "nothing was wrong".

Signup cannot be used to make those identities -- it is gated on a live license
verification that cannot be satisfied across a socket -- so the two user rows are
inserted through the application's own ORM and both tokens are then minted over
the real login route. The real auth stack still mints and verifies every
credential the matrix sends; only the row creation is bypassed.

Usage:

    python -m scripts.dast.authz_matrix --base-url URL --database-url URL
    python -m scripts.dast.authz_matrix --base-url URL --database-url URL \
        --allowlist path/to/allowlist.toml --min-routes 20 \
        --budget-seconds 120 --max-allowlist-fraction 0.5

Run it from ``backend/`` with ``PYTHONPATH=src``, the way the other repository
scripts are invoked, so both the harness package and the application's own
modules are importable.

Exit codes:
    0 — the matrix ran, every cell passed, and nothing was left uncovered.
    1 — an authorization finding: a foreign object was reached, or a probe
        returned a status that is not a denial.
    2 — at least one route has neither a seed strategy nor an allow-list entry,
        so the matrix does not cover the application it claims to.
    3 — a vacuity guard tripped: the run proved nothing, which outranks both of
        the above because its "clean" would have been meaningless.
"""

from __future__ import annotations

import argparse
import asyncio
import secrets
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from models.user import User
from routers.auth import _hash_password
from scripts.dast.policy import DEFAULT_ALLOWLIST_PATH, load_allowlist
from scripts.dast.report import (
    EXIT_AUTHZ_FINDING,
    EXIT_CLEAN,
    EXIT_HARNESS_ERROR,
    EXIT_UNCOVERED,
    MatrixReport,
    render_report,
)
from scripts.dast.runner import (
    DEFAULT_AUTH_PROBE_PATH,
    DEFAULT_BUDGET_SECONDS,
    DEFAULT_MAX_ALLOWLIST_FRACTION,
    DEFAULT_MIN_ROUTES,
    Bootstrap,
    Identity,
    MatrixConfig,
    ReplayBodies,
    forwarded_for,
    run_matrix,
)
from scripts.dast.seeds import REPLAY_BODIES, SEED_REGISTRY, SeedSpec

# The exit codes are defined once, in the report module, and re-exported here
# because this script is the only thing CI actually reads them from.
__all__ = [
    "EXIT_AUTHZ_FINDING",
    "EXIT_CLEAN",
    "EXIT_HARNESS_ERROR",
    "EXIT_UNCOVERED",
    "HarnessOverrides",
    "main",
]

# Generated per run rather than written down, so there is no credential literal
# anywhere in the repository and no reusable account left behind.
_PASSWORD_BYTES = 24
_EMAIL_TOKEN_BYTES = 4
# RFC 2606's documentation domain: the email validator rejects reserved TLDs
# such as ``.invalid`` outright, which would 422 the login before it was tried.
_EMAIL_DOMAIN = "example.com"
_SEED_TIMEZONE = "UTC"

_REQUEST_TIMEOUT_SECONDS = 30.0
_LOGIN_PATH = "/auth/login"


@dataclass(frozen=True)
class HarnessOverrides:
    """Seams a test may replace, defaulting to the production wiring.

    Attributes:
        client: An HTTP client to use instead of dialling ``--base-url``.
        bootstrap: An identity bootstrap to use instead of the ORM insert plus
            real login.
        seed_registry: Seed strategies for the target application.
        replay_bodies: Valid request bodies for the mutating replays.
        auth_probe_path: The route used to prove authentication works.
    """

    client: AsyncClient | None = None
    bootstrap: Bootstrap | None = None
    seed_registry: Mapping[str, SeedSpec] = SEED_REGISTRY
    replay_bodies: ReplayBodies = REPLAY_BODIES
    auth_probe_path: str = DEFAULT_AUTH_PROBE_PATH


@dataclass(frozen=True)
class _Credentials:
    """One throwaway identity, before it has a token."""

    label: str
    email: str
    password: str


def _new_credentials(label: str) -> _Credentials:
    """Mint credentials for one throwaway identity."""
    return _Credentials(
        label=label,
        email=f"dast-{label.lower()}-{secrets.token_hex(_EMAIL_TOKEN_BYTES)}@{_EMAIL_DOMAIN}",
        password=secrets.token_urlsafe(_PASSWORD_BYTES),
    )


async def _insert_users(database_url: str, credentials: Sequence[_Credentials]) -> None:
    """Insert the identities' rows through the application's own ORM.

    Args:
        database_url: The async database URL the target instance is using.
        credentials: The identities to create.

    Signup is gated on a live license verification with no local override, so a
    row insert is the only way to make an identity from outside the process. The
    password is hashed with the application's own hasher, which is what lets the
    real login route accept it a moment later.
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


async def _login(client: AsyncClient, credentials: _Credentials) -> Identity:
    """Mint one identity's token over the target's real login route."""
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


async def _bootstrap_identities(
    client: AsyncClient,
    *,
    database_url: str,
) -> tuple[Identity, Identity]:
    """Create the owner and the intruder, and log them both in.

    Args:
        client: A client pointed at the target instance.
        database_url: The database that instance is serving from.

    Returns:
        The owner first, then the intruder.
    """
    owner_credentials = _new_credentials("A")
    intruder_credentials = _new_credentials("B")
    await _insert_users(database_url, (owner_credentials, intruder_credentials))
    return (
        await _login(client, owner_credentials),
        await _login(client, intruder_credentials),
    )


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the command line.

    Neither target has a default on purpose: a defaulted base URL is how a run
    silently probes localhost instead of the ephemeral instance the job started,
    and a defaulted database URL is how it seeds identities into the wrong place.
    """
    parser = argparse.ArgumentParser(
        prog="authz_matrix",
        description="Probe every object-scoped route for cross-user access.",
    )
    parser.add_argument("--base-url", required=True, help="Base URL of the running instance.")
    parser.add_argument(
        "--database-url",
        required=True,
        help="Async database URL that instance is serving from.",
    )
    parser.add_argument(
        "--allowlist",
        type=Path,
        default=DEFAULT_ALLOWLIST_PATH,
        help="Opt-out list to load instead of the shipped one.",
    )
    parser.add_argument(
        "--min-routes",
        type=int,
        default=DEFAULT_MIN_ROUTES,
        help="Fail unless at least this many routes were probed.",
    )
    parser.add_argument(
        "--budget-seconds",
        type=float,
        default=DEFAULT_BUDGET_SECONDS,
        help="Fail if the matrix takes longer than this.",
    )
    parser.add_argument(
        "--max-allowlist-fraction",
        type=float,
        default=DEFAULT_MAX_ALLOWLIST_FRACTION,
        help="Fail if the allow-list excuses more than this share of routes.",
    )
    return parser.parse_args(argv)


def _build_config(args: argparse.Namespace, overrides: HarnessOverrides) -> MatrixConfig:
    """Fold the command line and the injected seams into one run configuration."""
    return MatrixConfig(
        seed_registry=overrides.seed_registry,
        replay_bodies=overrides.replay_bodies,
        allowlist=load_allowlist(args.allowlist),
        auth_probe_path=overrides.auth_probe_path,
        min_routes=args.min_routes,
        budget_seconds=args.budget_seconds,
        max_allowlist_fraction=args.max_allowlist_fraction,
    )


async def _execute(
    args: argparse.Namespace,
    config: MatrixConfig,
    overrides: HarnessOverrides,
) -> MatrixReport:
    """Run the matrix, owning the client's lifetime only when it created one."""
    bootstrap = overrides.bootstrap or partial(
        _bootstrap_identities,
        database_url=args.database_url,
    )
    if overrides.client is not None:
        return await run_matrix(overrides.client, bootstrap=bootstrap, config=config)
    async with AsyncClient(base_url=args.base_url, timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        return await run_matrix(client, bootstrap=bootstrap, config=config)


def main(argv: Sequence[str] | None = None, *, overrides: HarnessOverrides | None = None) -> int:
    """Run the matrix and report it.

    Args:
        argv: The command line, without the program name.
        overrides: Seams a test replaces; production passes nothing.

    Returns:
        The report's exit code. A clean run reports on stdout and every failure
        reports on stderr, so a red job's output is unambiguous in the log.
    """
    args = _parse_args(argv)
    settings = overrides if overrides is not None else HarnessOverrides()
    report = asyncio.run(_execute(args, _build_config(args, settings), settings))
    stream = sys.stdout if report.exit_code == EXIT_CLEAN else sys.stderr
    stream.write(render_report(report))
    return report.exit_code


if __name__ == "__main__":  # pragma: no cover — exercised via tests/CLI
    sys.exit(main(sys.argv[1:]))
