r"""Give one e2e account back the allowance a journey spent, and never more.

Run from ``backend`` with ``PYTHONPATH=src`` and ``DATABASE_URL`` naming the
lane's throwaway database::

    python -m tests.e2e.restore_allowance restore --email <EMAIL> \
        --monthly-messages-used <USED> --offering-balance <BALANCE>

The lane has exactly one vault-bound account, and every journey that asks the
lane's Creek vault for a reflection spends from that one account's real
BotMason wallet. The monthly allowance is deployment configuration, so a
journey that spends it leaves the next journey on that account with less than
it would have had alone -- and once enough journeys share a shard, a later spec
meets a ``402`` it never earned. A journey that records the wallet before it
spends (``tests.e2e.wallet_audit show``) hands those values back here when it
is done, so its spending does not change the outcome of whatever runs next.

The write moves only that account's two wallet counters, and only in the
direction that undoes a spend: ``monthly_messages_used`` may come down to the
recorded value and ``offering_balance`` may come up to it, never the other way
round. A counter already on the far side of its recorded value (a monthly reset
landed mid-journey, an operator credit arrived) is left alone, so this can never
grant capacity the account did not have when it was recorded. No audit row is
written: this is an arrange, like ``tests.e2e.exhaust_allowance``, and the
audit trail stays a record of what the production routes actually did. No
request-path function is replaced; the browser requests that follow still cross
the ordinary screens, clients, routes and database.
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

DATABASE_URL_ENV = "DATABASE_URL"
RESTORE_COMMAND = "restore"


class RestoreAllowanceError(RuntimeError):
    """The lane account's allowance cannot be restored as asked."""


def _require_database_url() -> str:
    """Return the lane database URL, or fail instead of touching a default."""
    value = os.environ.get(DATABASE_URL_ENV, "").strip()
    if not value:
        msg = f"{DATABASE_URL_ENV} is unset or blank; no allowance can be restored"
        raise RestoreAllowanceError(msg)
    return normalize_database_url(value)


async def restore(
    session: AsyncSession,
    email: str,
    *,
    recorded_used: int,
    recorded_balance: int,
) -> dict[str, object]:
    """Undo ``email``'s spending since the recorded wallet, never granting more.

    Raises:
        RestoreAllowanceError: No user holds ``email``, or a recorded value is
            negative and so cannot be a wallet reading at all.
    """
    if recorded_used < 0 or recorded_balance < 0:
        msg = "recorded wallet values are never negative; refusing to write them"
        raise RestoreAllowanceError(msg)
    normalized = email.strip().lower()
    user = (await session.execute(select(User).where(User.email == normalized))).scalars().first()
    if user is None:
        msg = f"no user is registered as {normalized!r}; there is no allowance to restore"
        raise RestoreAllowanceError(msg)
    user.monthly_messages_used = min(user.monthly_messages_used, recorded_used)
    user.offering_balance = max(user.offering_balance, recorded_balance)
    session.add(user)
    await session.commit()
    return {
        "monthly_messages_used": user.monthly_messages_used,
        "offering_balance": user.offering_balance,
    }


async def _run(email: str, recorded_used: int, recorded_balance: int) -> dict[str, object]:
    """Restore the named lane account and dispose the one-shot engine."""
    engine = create_async_engine(_require_database_url(), poolclass=NullPool)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            return await restore(
                session,
                email,
                recorded_used=recorded_used,
                recorded_balance=recorded_balance,
            )
    finally:
        await engine.dispose()


def main() -> None:
    """Parse the one supported restore command and write its JSON receipt."""
    parser = argparse.ArgumentParser(description="Restore an e2e account's recorded AI allowance.")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser(RESTORE_COMMAND, help="undo one account's spending")
    command.add_argument("--email", required=True)
    command.add_argument("--monthly-messages-used", type=int, required=True)
    command.add_argument("--offering-balance", type=int, required=True)
    args = parser.parse_args()
    receipt = asyncio.run(
        _run(str(args.email), int(args.monthly_messages_used), int(args.offering_balance))
    )
    sys.stdout.write(json.dumps(receipt) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
