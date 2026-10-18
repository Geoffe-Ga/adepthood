"""Exhaust one e2e account's served monthly allowance without faking a request.

Run from ``backend`` with ``PYTHONPATH=src`` and ``DATABASE_URL`` naming the
lane's throwaway database::

    python -m tests.e2e.exhaust_allowance exhaust --email <EMAIL>

The monthly allowance is deployment configuration, so changing it for one
browser account is impossible. This arrange instead moves only that account's
real ``monthly_messages_used`` counter to the currently served cap and empties
its offering balance. The subsequent browser requests still cross the ordinary
screens, clients, routes and database; no request-path function is patched.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import select

from database import normalize_database_url
from models import User
from services.usage import get_monthly_cap

DATABASE_URL_ENV = "DATABASE_URL"
EXHAUST_COMMAND = "exhaust"


class ExhaustAllowanceError(RuntimeError):
    """The lane account cannot be moved to an exhausted allowance."""


def _require_database_url() -> str:
    """Return the lane database URL, or fail instead of touching a default."""
    value = os.environ.get(DATABASE_URL_ENV, "").strip()
    if not value:
        msg = f"{DATABASE_URL_ENV} is unset or blank; no allowance can be arranged"
        raise ExhaustAllowanceError(msg)
    return normalize_database_url(value)


async def exhaust(session: AsyncSession, email: str) -> dict[str, object]:
    """Move ``email`` to the served cap with no offerings and report the state."""
    normalized = email.strip().lower()
    user = (await session.execute(select(User).where(User.email == normalized))).scalars().first()
    if user is None:
        msg = f"no user is registered as {normalized!r}; sign the account up before exhausting it"
        raise ExhaustAllowanceError(msg)
    monthly_cap = get_monthly_cap()
    if monthly_cap <= 0:
        msg = "the lane serves no positive monthly cap; there is nothing account-local to exhaust"
        raise ExhaustAllowanceError(msg)
    user.monthly_messages_used = monthly_cap
    user.offering_balance = 0
    session.add(user)
    await session.commit()
    return {
        "monthly_cap": monthly_cap,
        "monthly_messages_used": user.monthly_messages_used,
        "offering_balance": user.offering_balance,
        "rows": [],
    }


async def _run(email: str) -> dict[str, object]:
    """Arrange the named lane account and dispose the one-shot engine."""
    engine = create_async_engine(_require_database_url(), poolclass=NullPool)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            return await exhaust(session, email)
    finally:
        await engine.dispose()


def main() -> None:
    """Parse the one supported arrange command and write its JSON receipt."""
    parser = argparse.ArgumentParser(description="Exhaust an e2e account's AI allowance.")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser(EXHAUST_COMMAND, help="move one account to the served cap")
    command.add_argument("--email", required=True)
    args = parser.parse_args()
    sys.stdout.write(json.dumps(asyncio.run(_run(str(args.email)))) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
