"""Execute the account-erasure policy against one account.

The policy (:mod:`domain.account_deletion`) says *what* happens to every table;
this module issues the statements. Three properties are load-bearing:

**It refuses rather than half-deletes.** If the policy no longer covers the
schema — someone added a model — the sweep raises before touching a row. A
partial erasure that reports success is worse than a loud failure: the user is
told their data is gone when some of it is not.

**It does not depend on the database's cascades.** Every row is removed by an
explicit statement whose predicate resolves back to the account, so the same
code produces the same result on Postgres and on the SQLite the tests run
against. Cascades are still declared, still correct, and still checked against
this policy — but they are a second belt, not the mechanism.

**It never reaches outside adepthood.** No vault call is made, so an
unreachable vault cannot block or slow an erasure. What that means for a user
who has one is stated in the receipt rather than silently assumed.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import CursorResult, Table, delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import SQLModel

from domain.account_deletion import (
    POLICY,
    Disposition,
    OwnerKey,
    TablePolicy,
    erasure_order,
    policy_gaps,
)
from models.account_deletion_audit import AccountDeletionAudit
from services.creek_vault_client import CREEK_VAULT_URL_ENV_VAR

logger = logging.getLogger(__name__)

# The only vault disposition adepthood can honestly claim. Creek's published
# capability set carries no purge verb, so an account deletion here does not and
# cannot reach into a vault; saying so plainly is the alternative to pretending.
VAULT_NOT_PURGED = "not_purged"

VAULT_GUIDANCE_NONE = "No Creek Vault was connected, so nothing of yours is held outside Adepthood."
VAULT_GUIDANCE_CONFIGURED = (
    "Your Creek Vault is yours, not ours. Adepthood cannot purge it — the vault "
    "contract has no purge capability — so anything it holds is still there. Run "
    "`creek purge` against your vault to erase that copy."
)


class ErasurePolicyGapError(RuntimeError):
    """The deletion policy no longer covers the schema, so no erasure was run."""


@dataclass(frozen=True)
class Account:
    """The two identifiers the sweep needs; nothing else about the person."""

    user_id: int
    email: str


@dataclass(frozen=True)
class DeletionReceipt:
    """What one erasure did, in terms a user and an auditor can both read."""

    user_id: int
    rows_erased: int
    row_counts: dict[str, int]
    erased: tuple[str, ...]
    anonymised: tuple[str, ...]
    retained: tuple[str, ...]
    vault_configured: bool
    vault_disposition: str = VAULT_NOT_PURGED
    vault_guidance: str = VAULT_GUIDANCE_NONE


def _owner_predicate(table: Table, policy: TablePolicy, account: Account) -> ColumnElement[bool]:
    """Build the WHERE clause that selects exactly ``account``'s rows in ``table``.

    Recurses through ``OwnedBy.through`` so a table with no reference to the
    account (``goal``) is reached by way of the one that has (``habit``).
    """
    owned = policy.owned_by
    if owned is None:  # pragma: no cover - guarded by the policy-gap check
        msg = f"table {table.name!r} is swept but declares no ownership column"
        raise ErasurePolicyGapError(msg)
    column = table.c[owned.column]
    if owned.through is not None:
        parent = SQLModel.metadata.tables[owned.through]
        parent_rows = select(parent.c.id).where(
            _owner_predicate(parent, POLICY[owned.through], account),
        )
        return column.in_(parent_rows)
    if owned.key is OwnerKey.EMAIL:
        return column == account.email
    return column == account.user_id


async def _erase_rows(session: AsyncSession, table: Table, account: Account) -> int:
    """Delete the account's rows from one table; return how many went.

    ``AsyncSession.execute`` is typed as returning a generic ``Result``, but a
    DML statement always produces a ``CursorResult`` — the cast names that
    rather than reaching for the attribute and hoping.
    """
    policy = POLICY[table.name]
    result = cast(
        "CursorResult[Any]",
        await session.execute(delete(table).where(_owner_predicate(table, policy, account))),
    )
    return result.rowcount or 0


async def _clear_references(session: AsyncSession, table: Table, account: Account) -> None:
    """Null every column of ``table`` that names the account on surviving rows."""
    for name in POLICY[table.name].clear_columns:
        column = table.c[name]
        await session.execute(
            update(table).where(column == account.user_id).values({name: None}),
        )


def _require_total_policy() -> None:
    """Refuse to erase anything while the policy has a hole in it."""
    gaps = policy_gaps(SQLModel.metadata)
    if gaps:
        msg = "account deletion refused: " + "; ".join(gaps)
        raise ErasurePolicyGapError(msg)


def _vault_is_configured() -> bool:
    """Whether this deployment points at a Creek Vault at all."""
    return bool(os.getenv(CREEK_VAULT_URL_ENV_VAR, "").strip())


def _tables_with(disposition: Disposition) -> tuple[str, ...]:
    """Policy table names carrying one disposition, alphabetically."""
    return tuple(
        sorted(name for name, policy in POLICY.items() if policy.disposition is disposition),
    )


async def _sweep(session: AsyncSession, account: Account) -> dict[str, int]:
    """Run the whole policy against one account, children before parents."""
    counts: dict[str, int] = {}
    for table in erasure_order(SQLModel.metadata):
        policy = POLICY[table.name]
        if policy.disposition is Disposition.ERASE:
            counts[table.name] = await _erase_rows(session, table, account)
        await _clear_references(session, table, account)
    return counts


def _build_receipt(account: Account, counts: dict[str, int]) -> DeletionReceipt:
    """Turn raw row counts into the receipt returned to the caller and stored."""
    configured = _vault_is_configured()
    return DeletionReceipt(
        user_id=account.user_id,
        rows_erased=sum(counts.values()),
        row_counts=counts,
        erased=_tables_with(Disposition.ERASE),
        anonymised=_tables_with(Disposition.ANONYMISE),
        retained=_tables_with(Disposition.RETAIN),
        vault_configured=configured,
        vault_guidance=VAULT_GUIDANCE_CONFIGURED if configured else VAULT_GUIDANCE_NONE,
    )


async def delete_account(session: AsyncSession, account: Account) -> DeletionReceipt:
    """Erase one account and everything the policy assigns to it, then commit.

    Returns a receipt describing what was removed, what survives anonymised,
    and what a user with a Creek Vault still has to do themselves. The same
    receipt is persisted as an :class:`~models.account_deletion_audit.AccountDeletionAudit`
    row — counts only, never content.
    """
    _require_total_policy()
    counts = await _sweep(session, account)
    receipt = _build_receipt(account, counts)
    session.add(
        AccountDeletionAudit(
            user_id=receipt.user_id,
            rows_erased=receipt.rows_erased,
            row_counts=dict(receipt.row_counts),
            vault_disposition=receipt.vault_disposition,
        ),
    )
    await session.commit()
    # Row counts and the surrogate id only: the log line has to be safe to ship
    # to an aggregator that the erased content deliberately never reaches.
    logger.info(
        "account_deleted",
        extra={"user_id": receipt.user_id, "rows_erased": receipt.rows_erased},
    )
    return receipt
