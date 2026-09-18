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

**The sweep never reaches outside adepthood.** The HTTP route first detaches a
content-free Creek teardown receipt and asks the provisioning service with no
database transaction held. This module then performs local erasure regardless
of that answer; an unreachable vault cannot block the sweep.

That third property was only ever true *of the sweep*, and it was read for
longer than it should have been as a statement about the account. Nothing here
dials outward, and nothing here used to order the sweep against a concurrent
request that does: a journal write already inside ``ingest()`` could land after
the receipt said "erased". The ordering is supplied by
:mod:`services.account_egress_barrier`, taken by the route around both the
disposition resolution and this sweep -- so erasure now waits for this account's
in-flight outbound writes while still dialling nothing itself, and the barrier
waits on the database rather than on Creek, which is what keeps the sentence
above true of the barrier too.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import CursorResult, Table, delete, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import SQLModel

from domain.account_deletion import (
    POLICY,
    Disposition,
    TablePolicy,
    erasure_order,
    policy_gaps,
)
from domain.ownership import OwnedBy, owner_predicate
from models.account_deletion_audit import AccountDeletionAudit

logger = logging.getLogger(__name__)

# The legacy disposition for a manually connected vault. Provisioned vaults use
# Creek's separately tracked delete states; a manual connection still has no
# upstream allocation handle Adepthood could honestly claim to purge.
VAULT_NOT_PURGED = "not_purged"
VAULT_NOT_CONFIGURED = "not_configured"

VAULT_GUIDANCE_NONE = "No Creek Vault was connected, so nothing of yours is held outside Adepthood."
VAULT_GUIDANCE_CONFIGURED = (
    "Your Creek Vault is yours, not ours. Adepthood withdraws individual journal "
    "pages when you make them Intimate or delete them, but account deletion cannot "
    "run an account-wide purge — the vault contract has no such capability. Run "
    "`creek purge` against your vault to erase everything else it holds."
)
VAULT_GUIDANCE_TEARDOWN_PENDING = (
    "Your managed vault deletion has been requested. Adepthood will keep "
    "reconciling the content-free cleanup receipt until Creek confirms that no "
    "billable resource remains."
)
VAULT_GUIDANCE_TEARDOWN_COMPLETE = (
    "Creek confirmed that the provisioned managed-vault allocation was deleted."
)


class ErasurePolicyGapError(RuntimeError):
    """The deletion policy no longer covers the schema, so no erasure was run."""


@dataclass(frozen=True)
class Account:
    """The two identifiers the sweep needs; nothing else about the person."""

    user_id: int
    email: str


@dataclass(frozen=True)
class AccountVaultDisposition:
    """Account-scoped truth about what may remain outside Adepthood.

    Receipt construction deliberately accepts this value rather than reading
    deployment configuration. A global endpoint is not a global claim: it
    belongs only to the account named by its owner binding, while a stored
    per-user connection belongs to that account regardless of the environment.
    Resolving that distinction before the sweep also matters because the sweep
    deletes the stored connection row.
    """

    configured: bool
    audit_state: str

    @classmethod
    def unconfigured(cls) -> AccountVaultDisposition:
        """No vault belongs to this account, so no external purge is owed."""
        return cls(configured=False, audit_state=VAULT_NOT_CONFIGURED)

    @classmethod
    def manual(cls) -> AccountVaultDisposition:
        """A manually managed vault may retain data until its owner purges it."""
        return cls(configured=True, audit_state=VAULT_NOT_PURGED)

    @classmethod
    def provisioned(cls, state: str) -> AccountVaultDisposition:
        """A provisioned allocation has Creek's durable teardown state."""
        return cls(configured=True, audit_state=state)


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
    vault_disposition: str
    vault_guidance: str


def _policy_parent(name: str) -> tuple[Table, OwnedBy]:
    """A parent table and how the policy says *that* table is owned.

    Handed to :func:`~domain.ownership.owner_predicate` so the recursion asks
    this policy — rather than assuming one — how ``habit`` is reached from
    ``goal``.
    """
    owned = POLICY[name].owned_by
    if owned is None:  # pragma: no cover - guarded by the policy-gap check
        msg = f"table {name!r} is reached as a parent but declares no ownership column"
        raise ErasurePolicyGapError(msg)
    return SQLModel.metadata.tables[name], owned


def _owner_predicate(table: Table, policy: TablePolicy, account: Account) -> ColumnElement[bool]:
    """Build the WHERE clause that selects exactly ``account``'s rows in ``table``.

    The predicate itself is :mod:`domain.ownership`'s, shared with the export
    path so the two features can never disagree about which rows are whose.
    """
    owned = policy.owned_by
    if owned is None:  # pragma: no cover - guarded by the policy-gap check
        msg = f"table {table.name!r} is swept but declares no ownership column"
        raise ErasurePolicyGapError(msg)
    return owner_predicate(
        table,
        owned,
        user_id=account.user_id,
        email=account.email,
        parent_lookup=_policy_parent,
    )


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


def _build_receipt(
    account: Account,
    counts: dict[str, int],
    vault_disposition: AccountVaultDisposition,
) -> DeletionReceipt:
    """Turn raw row counts into the receipt returned to the caller and stored."""
    return DeletionReceipt(
        user_id=account.user_id,
        rows_erased=sum(counts.values()),
        row_counts=counts,
        erased=_tables_with(Disposition.ERASE),
        anonymised=_tables_with(Disposition.ANONYMISE),
        retained=_tables_with(Disposition.RETAIN),
        vault_configured=vault_disposition.configured,
        vault_disposition=vault_disposition.audit_state,
        vault_guidance=_vault_guidance(vault_disposition),
    )


def _vault_guidance(vault_disposition: AccountVaultDisposition) -> str:
    """Choose deletion guidance without mixing it into receipt construction."""
    if vault_disposition.audit_state == "deleted":
        return VAULT_GUIDANCE_TEARDOWN_COMPLETE
    if vault_disposition.audit_state not in {VAULT_NOT_CONFIGURED, VAULT_NOT_PURGED}:
        return VAULT_GUIDANCE_TEARDOWN_PENDING
    return VAULT_GUIDANCE_CONFIGURED if vault_disposition.configured else VAULT_GUIDANCE_NONE


async def delete_account(
    session: AsyncSession,
    account: Account,
    *,
    vault_disposition: AccountVaultDisposition,
) -> DeletionReceipt:
    """Erase one account and everything the policy assigns to it, then commit.

    Returns a receipt describing what was removed, what survives anonymised,
    and what a user with a Creek Vault still has to do themselves. The same
    receipt is persisted as an :class:`~models.account_deletion_audit.AccountDeletionAudit`
    row — counts only, never content.

    Calls nothing outside adepthood, and is called by
    :func:`routers.users.delete_my_account` inside that account's egress
    barrier, so a write that was already in flight finishes before this runs or
    finds the account gone and sends nothing.
    """
    _require_total_policy()
    counts = await _sweep(session, account)
    receipt = _build_receipt(account, counts, vault_disposition)
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
