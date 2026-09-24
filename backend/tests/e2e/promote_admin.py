"""Make an e2e account an administrator, for the feedback-triage journey.

Run it the way the frontend lane runs its other arrange modules: from
``backend``, with ``PYTHONPATH=src`` and ``DATABASE_URL`` naming the lane's
throwaway database::

    python -m tests.e2e.promote_admin promote --email <EMAIL>

It writes a single JSON object to stdout and exits 0.

Why this exists at all: ``User.is_admin`` has no HTTP writer, by design. No
request schema accepts it and no route sets it -- an operator is made in the
database, deliberately, by somebody with the database. So a journey that has to
act as an operator cannot become one over the wire, and the only honest arrange
is this one: flip the flag on the lane's own throwaway Postgres, then drive the
unmocked production client as that account. Nothing on the request path is
stubbed, patched or rebound. The only thing arranged is who is an operator.

Failure is loud. A missing ``DATABASE_URL`` or an address no account holds
raises and exits non-zero; an arrange step that quietly promoted nobody would
leave the spec asserting a 403 it then mistook for the gate working.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import col, select

from database import normalize_database_url
from models import User

#: URL of the lane's throwaway database, the only one this module will touch.
DATABASE_URL_ENV = "DATABASE_URL"

#: The one subcommand: promote the named account.
PROMOTE_COMMAND = "promote"


class PromoteAdminError(RuntimeError):
    """The arrange step cannot be carried out as asked."""


def _require_env(name: str) -> str:
    """Return the value of ``name``, or raise naming what to set."""
    value = os.environ.get(name, "").strip()
    if not value:
        msg = f"{name} is unset or blank; no account can be promoted without it"
        raise PromoteAdminError(msg)
    return value


async def promote(session: AsyncSession, email: str) -> dict[str, object]:
    """Set ``is_admin`` on the account registered as ``email`` and report it.

    The address is normalised the way the signup boundary stores it (stripped,
    lowercased), so a mixed-case address typed by a spec still resolves.

    Raises:
        PromoteAdminError: No account holds that address.
    """
    normalized = email.strip().lower()
    user = (
        (await session.execute(select(User).where(col(User.email) == normalized))).scalars().first()
    )
    if user is None or user.id is None:
        msg = f"no user is registered as {normalized!r}; sign the account up before promoting it"
        raise PromoteAdminError(msg)
    user.is_admin = True
    session.add(user)
    await session.commit()
    return {"user_id": user.id, "is_admin": True}


async def _run(email: str) -> dict[str, object]:
    """Promote ``email`` against the lane database, disposing the engine after."""
    engine = create_async_engine(
        normalize_database_url(_require_env(DATABASE_URL_ENV)),
        poolclass=NullPool,
    )
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            return await promote(session, email)
    finally:
        await engine.dispose()


def main() -> None:
    """Parse ``promote --email``, run it, and write its one JSON line to stdout."""
    parser = argparse.ArgumentParser(description="Promote an e2e account to administrator.")
    subcommands = parser.add_subparsers(dest="command", required=True)
    promote_parser = subcommands.add_parser(PROMOTE_COMMAND, help="set is_admin on an account")
    promote_parser.add_argument("--email", required=True, help="address the account signed up with")
    args = parser.parse_args()
    payload = asyncio.run(_run(str(args.email)))
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
