"""Report an e2e account's wallet and its audit trail, changing nothing.

Run it the way the frontend lane runs its other helpers: from ``backend``, with
``PYTHONPATH=src`` and ``DATABASE_URL`` naming the lane's throwaway database::

    python -m tests.e2e.wallet_audit show --email <EMAIL>

It writes a single JSON object to stdout and exits 0.

Why this exists at all: a journey about a provider refusing to be paid has to
be able to say what the *writer* was charged, and the only durable record of
that is a table with no API in front of it. ``models.wallet_audit`` says so in
its own words -- "intentionally not exposed via the API: it's a forensic
surface read by ops via direct SQL, not a feature" -- and that is a deliberate
product decision, not a gap for a test to close by adding a route. So the
lane reads it the way an operator would.

Reading it matters because the two claims a spec can make about a refused pass
are not the same claim. ``POST /journal/{id}/resonance`` deducts one message and
commits that deduction *before* the first dial, so a refusal that left the
counter alone would not mean the writer was never charged -- it would mean the
compensating credit landed. Only the rows distinguish "never charged" from
"charged and put back", and the second is what the code actually promises
(``routers.journal._refund_failed_pass``). A spec that could see the balance and
not the trail would pass just as happily against a build that had quietly
stopped charging at all, which is a different bug wearing the same balance.

This module reads and only reads. It opens its own engine against the lane's own
database, issues two ``SELECT``s, and disposes. It stubs, mocks, patches and
rebinds nothing: the request path is untouched, and every wallet mutation the
JSON reports was made by the production service through the production route.

Failure is loud. A missing ``DATABASE_URL`` or an email no user holds raises and
exits non-zero. There is no fallback and no empty-on-error result: a read that
quietly answered "no rows" for a database it never reached would let a spec
assert an unchanged balance it had never actually looked at.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import col, select

from database import normalize_database_url
from models import User
from models.wallet_audit import WalletAudit

#: URL of the lane's throwaway database, the only one this module will touch.
DATABASE_URL_ENV = "DATABASE_URL"

#: Subcommand that reports the wallet and its trail, writing nothing.
SHOW_COMMAND = "show"

#: The JSON object the subcommand emits; values are ints, strings and lists.
JsonObject = dict[str, object]


class WalletAuditReadError(RuntimeError):
    """The wallet cannot be read as asked."""


def _require_env(name: str) -> str:
    """Return the value of ``name``, or raise naming what to set.

    Raises:
        WalletAuditReadError: The variable is unset or blank.
    """
    value = os.environ.get(name, "").strip()
    if not value:
        msg = f"{name} is unset or blank; the wallet cannot be read without it"
        raise WalletAuditReadError(msg)
    return value


def _normalize_email(email: str) -> str:
    """Return ``email`` in the form the signup boundary stores.

    ``routers.auth`` strips and lowercases every address before it reaches the
    database, so the lookup here has to do the same or an address the caller
    typed in mixed case would appear not to exist.
    """
    return email.strip().lower()


def _amount(value: Decimal) -> str:
    """Render a wallet amount as a string rather than a float.

    ``delta`` and both balances are ``Numeric(18, 6)``. Passing them through
    ``float`` to make them JSON-safe would round exactly the values the trail
    exists to reconcile, so they cross as their own decimal text and the reading
    spec compares text.
    """
    return str(value)


async def _load_user(session: AsyncSession, email: str) -> User:
    """Return the user registered under ``email``.

    Raises:
        WalletAuditReadError: No user holds that address.
    """
    result = await session.execute(select(User).where(User.email == email))
    user = result.scalars().first()
    if user is None:
        msg = f"no user is registered as {email!r}; sign the account up before reading its wallet"
        raise WalletAuditReadError(msg)
    return user


async def _load_rows(session: AsyncSession, user_id: int) -> list[WalletAudit]:
    """Return every audit row for ``user_id``, oldest first.

    Ordered by id rather than by ``created_at``: a spend and the credit that
    compensates it are written milliseconds apart and a timestamp tie would let
    them come back in either order, which is the one thing the reading spec is
    looking at.
    """
    result = await session.execute(
        select(WalletAudit).where(WalletAudit.user_id == user_id).order_by(col(WalletAudit.id))
    )
    return list(result.scalars().all())


def _serialize(user: User, rows: list[WalletAudit]) -> JsonObject:
    """Return the wallet and its trail as JSON-safe values."""
    return {
        "user_id": user.id,
        "monthly_messages_used": user.monthly_messages_used,
        "offering_balance": user.offering_balance,
        "rows": [
            {
                "bucket": row.bucket,
                "reason": row.reason,
                "delta": _amount(row.delta),
                "balance_before": _amount(row.balance_before),
                "balance_after": _amount(row.balance_after),
            }
            for row in rows
        ],
    }


async def _show(email: str) -> JsonObject:
    """Report the account's wallet and audit trail against the lane's database."""
    engine = create_async_engine(
        normalize_database_url(_require_env(DATABASE_URL_ENV)),
        poolclass=NullPool,
    )
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            user = await _load_user(session, email)
            rows = await _load_rows(session, int(user.id or 0))
            return _serialize(user, rows)
    finally:
        await engine.dispose()


def _build_parser() -> argparse.ArgumentParser:
    """Return the parser for the one subcommand the frontend lane invokes."""
    parser = argparse.ArgumentParser(
        description="Read the wallet and its audit trail for the frontend e2e lane.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    show = subcommands.add_parser(SHOW_COMMAND, help="report the wallet, changing nothing")
    show.add_argument("--email", required=True, help="address the account signed up with")
    return parser


def main() -> None:
    """Run the requested subcommand and write its one JSON line to stdout."""
    args = _build_parser().parse_args()
    payload = asyncio.run(_show(_normalize_email(str(args.email))))
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
