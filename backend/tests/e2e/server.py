"""Boot the real FastAPI app on an ephemeral, alembic-built Postgres.

Run it the way the frontend lane's ``globalSetup`` does, from ``backend`` with
``PYTHONPATH=src``, having exported ``DATABASE_URL`` (the throwaway database),
``E2E_ADMIN_DATABASE_URL`` (a database that already exists on the same server)
and a per-run ``SECRET_KEY``::

    python -m tests.e2e.server

Everything arrives through the environment rather than argv, so no password ever
reaches a process listing, and ``SECRET_KEY`` in particular has to be set by the
caller because ``routers.auth`` reads it at import time. ``DATABASE_URL`` names a
database that does not exist yet: this module creates it, builds its schema with
``alembic upgrade head`` (never ``SQLModel.metadata.create_all``, which would
test the models against themselves), serves the app on a loopback port, and
drops the database again on shutdown. The bound port is announced on stdout as
``E2E_READY port=<n>`` once the application has finished starting, which is what
the caller waits for -- a sleep would either be too short on a cold machine or
waste the budget on a warm one. Because uvicorn re-raises the signal that stopped
it, the caller runs ``--drop-only`` after reaping this process rather than
trusting a ``finally`` that a SIGTERM never reaches.

Exactly one thing is substituted, and it is the only third-party call on the
signup path: ``routers.auth.verify_aptitude_license``, whose real implementation
POSTs to Gumroad over the internet. The lane forbids third-party network, and
``backend/conftest.py`` stubs the same seam for the same reason. Nothing on the
frontend-to-backend request path is faked: the routers, middleware, session
handling, schemas and migrations are the production ones, and the journeys reach
them over a real socket.

Failure is loud everywhere. A missing variable, a refused connection, a database
that did not migrate to every script head, or a dialect that is not Postgres all
raise before the server starts serving. There is no fallback and no skip: a lane
that quietly tests nothing is the defect this whole exercise exists to remove.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import socket
import sys
from pathlib import Path

import uvicorn
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

import routers.auth as auth_router
from database import normalize_database_url
from domain.entitlements import AptitudeLicenseCheck, LicenseOutcome
from main import app
from rate_limit import limiter
from schemas.gumroad import GumroadPurchase

#: URL of the throwaway database this process owns for its whole lifetime.
DATABASE_URL_ENV = "DATABASE_URL"

#: URL of an existing database on the same server, used only to CREATE/DROP.
ADMIN_URL_ENV = "E2E_ADMIN_DATABASE_URL"

#: Signing key for the session JWTs, generated per run by the caller.
SECRET_KEY_ENV = "SECRET_KEY"  # pragma: allowlist secret -- a variable name, not a value

#: Line the caller waits for; the port is chosen by the kernel, not guessed.
READY_PREFIX = "E2E_READY port="

_LOOPBACK_HOST = "127.0.0.1"
_POSTGRESQL_DIALECT = "postgresql"

# Database names are interpolated into DDL, which cannot take bind parameters,
# so the name is constrained to an unambiguous identifier shape first.
_SAFE_IDENTIFIER = re.compile(r"[a-z0-9_]+")

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_ALEMBIC_INI = _BACKEND_ROOT / "alembic.ini"
_MIGRATIONS_DIR = _BACKEND_ROOT / "migrations"

_STUB_LICENSE_PRODUCT_ID = "prod_e2e_aptitude"
_STUB_LICENSE_SALE_PREFIX = "e2e-sale-"


class E2EServerError(RuntimeError):
    """The lane cannot be brought up as specified."""


def _require_env(name: str) -> str:
    """Return the value of ``name``, or raise naming what to set.

    Raises:
        E2EServerError: The variable is unset or blank.
    """
    value = os.environ.get(name, "").strip()
    if not value:
        msg = f"{name} is unset or blank; the e2e lane cannot start without it"
        raise E2EServerError(msg)
    return value


def _require_database_url(name: str) -> str:
    """Return a database URL from the environment, normalized to the app's driver."""
    return normalize_database_url(_require_env(name))


def _quoted_database_name(name: str) -> str:
    """Return ``name`` quoted for DDL, rejecting anything but a bare identifier.

    Raises:
        E2EServerError: ``name`` is not a lowercase identifier.
    """
    if not _SAFE_IDENTIFIER.fullmatch(name):
        msg = f"refusing to build DDL for the non-identifier database name {name!r}"
        raise E2EServerError(msg)
    return f'"{name}"'


def _database_name(url: str) -> str:
    """Return the database component of ``url``.

    Raises:
        E2EServerError: The URL names no database.
    """
    name = make_url(url).database
    if not name:
        msg = f"{DATABASE_URL_ENV} names no database, so there is nothing to create"
        raise E2EServerError(msg)
    return name


async def _run_admin_statements(admin_url: URL, statements: tuple[str, ...]) -> None:
    """Execute DDL against the admin URL's own database with autocommit.

    ``CREATE`` / ``DROP DATABASE`` cannot run inside a transaction block, hence
    the AUTOCOMMIT isolation level and the pool-less engine.
    """
    engine = create_async_engine(admin_url, isolation_level="AUTOCOMMIT", poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            for statement in statements:
                await connection.execute(text(statement))
    finally:
        await engine.dispose()


def _alembic_config(url: str) -> Config:
    """Return an alembic config pointed at ``url``.

    ``config_file_name`` is suppressed so ``env.py`` skips its ``fileConfig``
    call, which would otherwise disable every logger configured before it --
    including the app's own, whose startup lines are the boot evidence.
    """
    config = Config(str(_ALEMBIC_INI))
    config.config_file_name = None
    config.set_main_option("script_location", str(_MIGRATIONS_DIR))
    config.set_main_option("sqlalchemy.url", url)
    return config


def _migrate_to_head(url: str) -> set[str]:
    """Build the schema at ``url`` from zero and return the script head revisions."""
    config = _alembic_config(url)
    command.upgrade(config, "head")
    return set(ScriptDirectory.from_config(config).get_heads())


async def _read_provenance(url: str) -> tuple[str, set[str]]:
    """Return the dialect name and stamped revisions of the database at ``url``."""
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            dialect = connection.dialect.name
            result = await connection.execute(text("SELECT version_num FROM alembic_version"))
            return dialect, set(result.scalars().all())
    finally:
        await engine.dispose()


def _assert_provenance(dialect: str, stamped: set[str], heads: set[str]) -> None:
    """Assert the schema came from a complete upgrade of a real Postgres.

    This is the tripwire for the lane degrading into something it exists to
    replace. The expected revisions come from the script directory, so adding a
    migration cannot leave the comparison stale.

    Raises:
        E2EServerError: The dialect is not Postgres, or the stamp is not at head.
    """
    if dialect != _POSTGRESQL_DIALECT:
        msg = f"the e2e lane connected to a {dialect!r} database, not Postgres"
        raise E2EServerError(msg)
    if stamped != heads:
        msg = (
            f"the e2e database is stamped at {sorted(stamped)} but the migration "
            f"scripts head at {sorted(heads)}; the schema did not come from a "
            f"complete `alembic upgrade head`"
        )
        raise E2EServerError(msg)


async def _stub_license_check(
    email: str,
    *_args: object,
    **_kwargs: object,
) -> AptitudeLicenseCheck:
    """Verify any license, echoing the submitted email so the match check passes.

    Stands in for the live Gumroad call the real gate makes. Everything the gate
    does with the answer -- the duplicate-email refusal, password hashing, the
    entitlement grant -- still runs for real. The signature swallows the license
    key and the optional client the real function takes, because the stub's
    answer does not depend on either.
    """
    purchase = GumroadPurchase(
        email=email,
        product_id=_STUB_LICENSE_PRODUCT_ID,
        sale_id=f"{_STUB_LICENSE_SALE_PREFIX}{email}",
        refunded=False,
        chargebacked=False,
    )
    return AptitudeLicenseCheck(LicenseOutcome.VERIFIED, purchase)


def _prepare_app() -> None:
    """Apply the two lane-local adjustments to the imported app.

    The license stub replaces the only third-party network call on the signup
    path. The limiter is disarmed because this lane exercises wiring, not abuse
    controls: every journey shares one loopback address, so the 3/minute signup
    cap would make "how many journeys exist" a hidden global constraint and turn
    a fourth journey into a flake. Rate limiting keeps its own tests.
    """
    auth_router.verify_aptitude_license = _stub_license_check
    limiter.enabled = False


class _AnnouncingServer(uvicorn.Server):
    """Uvicorn server that names its port once startup has actually completed.

    Announcing from inside ``startup`` rather than polling a flag means the
    caller's first request cannot arrive before the lifespan has run: the line
    is written after the routers are mounted, the seeders have run and the
    socket is listening.
    """

    def __init__(self, config: uvicorn.Config, port: int) -> None:
        """Store the port to announce alongside the usual server config."""
        super().__init__(config)
        self._announced_port = port

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        """Start serving, then write the ready line to stdout."""
        await super().startup(sockets=sockets)
        sys.stdout.write(f"{READY_PREFIX}{self._announced_port}\n")
        sys.stdout.flush()


async def _serve(port: int) -> None:
    """Serve the app on ``port`` until the process is asked to stop."""
    config = uvicorn.Config(app, host=_LOOPBACK_HOST, port=port, log_level="info")
    await _AnnouncingServer(config, port).serve()


def _reserve_port() -> int:
    """Return a free loopback port the kernel picked."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((_LOOPBACK_HOST, 0))
        return int(probe.getsockname()[1])


def _drop_statement(quoted: str) -> str:
    """Return the DROP that also evicts connections a crashed run left behind."""
    return f"DROP DATABASE IF EXISTS {quoted} WITH (FORCE)"


def _provision(database_url: str, admin_url: URL, quoted: str) -> None:
    """Create the database and build its schema, verifying what was built."""
    create = (_drop_statement(quoted), f"CREATE DATABASE {quoted}")
    asyncio.run(_run_admin_statements(admin_url, create))
    heads = _migrate_to_head(database_url)
    dialect, stamped = asyncio.run(_read_provenance(database_url))
    _assert_provenance(dialect, stamped, heads)


def run() -> None:
    """Provision, serve, and drop the database again on the way out.

    The drop here covers the paths this process controls -- a boot failure, a
    crash inside ``serve`` -- but not a signal: uvicorn re-raises the SIGTERM it
    captured once ``serve`` returns, which ends the process before any ``finally``
    of ours runs. The caller therefore owns the ordinary drop and invokes
    ``--drop-only`` after reaping this process. Both paths issue the same
    ``DROP DATABASE IF EXISTS``, so running them both is harmless.
    """
    database_url = _require_database_url(DATABASE_URL_ENV)
    admin_url = make_url(_require_database_url(ADMIN_URL_ENV))
    quoted = _quoted_database_name(_database_name(database_url))
    _require_env(SECRET_KEY_ENV)

    # The try opens before provisioning, not after: a migration that throws or a
    # stamp that does not match leaves a created-but-unusable database behind
    # otherwise, and that path dies before the ready line, so the caller has no
    # lane state to recover from either.
    try:
        _provision(database_url, admin_url, quoted)
        _prepare_app()
        asyncio.run(_serve(_reserve_port()))
    finally:
        asyncio.run(_run_admin_statements(admin_url, (_drop_statement(quoted),)))


def drop() -> None:
    """Drop the lane's database without starting a server.

    The teardown fallback for a run whose server process died before its own
    cleanup could run.
    """
    database_url = _require_database_url(DATABASE_URL_ENV)
    admin_url = make_url(_require_database_url(ADMIN_URL_ENV))
    quoted = _quoted_database_name(_database_name(database_url))
    asyncio.run(_run_admin_statements(admin_url, (_drop_statement(quoted),)))


def main() -> None:
    """Dispatch between serving the lane and dropping its leftovers."""
    parser = argparse.ArgumentParser(description="Live server for the frontend e2e lane.")
    parser.add_argument(
        "--drop-only",
        action="store_true",
        help="drop the database named by DATABASE_URL and exit",
    )
    if parser.parse_args().drop_only:
        drop()
        return
    run()


if __name__ == "__main__":
    main()
