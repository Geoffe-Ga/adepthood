"""How long every table's rows live, stated once and checked against the schema.

The deletion policy (:mod:`domain.account_deletion`) answers one question: what
happens to a table when an account is erased. It is silent on the other one a
privacy promise has to answer: *how long does a row live* -- before account
deletion, after a soft delete, and, for the tables that survive erasure, after
it (#3063). This module is that second answer.

It is **total by construction**, like the deletion policy: every table in the
ORM metadata must carry an explicit :class:`RetentionRule`, and
:func:`retention_gaps` reports the ones that do not. Rules are deliberately
*not* inherited from the deletion policy. A new table the deletion policy
already erases would otherwise get a free "until account deletion" lifetime and
nobody would ever decide whether that is right -- which is exactly the decision
an obligation table such as ``voicedraftretraction`` needs.

Each rule carries:

* a :class:`RetentionKind`;
* the event that starts or ends the lifetime (``trigger``);
* the controller (always ``adepthood`` for a table in this database);
* a rationale;
* optionally a nested ``soft_deleted`` rule: how long a row lives once it has
  been soft-deleted, which is a different lifetime from a live row's;
* ``ratified``: whether the owner has decided this lifetime. Ratification is
  independent of kind. A lifetime that is a promise to users, or a legal
  question, stays ``ratified=False`` until the owner decides it (#3063 AC15),
  and :func:`unratified_rules` is the worklist.

What this registry does **not** cover: copies outside this database (backups,
logs, devices, the Creek vault). Those are inventoried as data in
:mod:`domain.retention_stores`. "Until account deletion" here means the live
database; a backup taken before the deletion can still hold the row for that
backup's own retention (see the store inventory).

Pure: imports no model, no session, no FastAPI.
"""

from __future__ import annotations

import enum
import re
from collections.abc import Mapping
from dataclasses import dataclass

from sqlalchemy import MetaData

from domain.account_deletion import POLICY, Disposition, TablePolicy

#: Every table in this database is controlled by the deployment operator.
CONTROLLER_ADEPTHOOD = "adepthood"

#: Mirrors ``services.energy.ENERGY_PLAN_RETENTION_DAYS`` (that module is
#: impure, so this one cannot import it). The registry test pins the two equal.
ENERGY_PLAN_SWEEP_DAYS = 30
#: Mirrors ``models.feedback.FEEDBACK_RETENTION_DAYS``; pinned equal by test.
FEEDBACK_SWEEP_DAYS = 180

ENERGY_PLAN_SWEEP = "POST /admin/maintenance/energy-plans"
FEEDBACK_SWEEP = "POST /admin/maintenance/feedback-reports"
JOURNAL_ENTRY_PURGE = "POST /admin/maintenance/journal-entries"

_ACCOUNT_DELETION = "account deletion"
_SWEEP_ROUTE = re.compile(r"^(GET|POST|PUT|PATCH|DELETE) /\S+$")


class RetentionKind(enum.StrEnum):
    """The shape of one table's lifetime."""

    #: Rows live until the owning account is erased, and no longer.
    UNTIL_ACCOUNT_DELETION = "until_account_deletion"
    #: Rows live a fixed number of days after the trigger.
    FIXED_DAYS = "fixed_days"
    #: Rows are removed by an operator-invoked sweep route.
    SWEPT_BY = "swept_by"
    #: No bound exists; the rationale says why and the owner must ratify it.
    INDEFINITE = "indefinite"
    #: Shared catalogue content that names no account.
    SHARED_CATALOGUE = "shared_catalogue"


@dataclass(frozen=True)
class RetentionRule:
    """How long one table's rows live, and why."""

    kind: RetentionKind
    trigger: str
    rationale: str
    controller: str = CONTROLLER_ADEPTHOOD
    days: int | None = None
    sweep_route: str | None = None
    soft_deleted: RetentionRule | None = None
    ratified: bool = True

    def is_bounded(self) -> bool:
        """Whether this lifetime ends on its own, independently of any account."""
        if self.kind is RetentionKind.FIXED_DAYS:
            return True
        return self.kind is RetentionKind.SWEPT_BY and self.days is not None


def until_account_deletion(
    rationale: str,
    *,
    soft_deleted: RetentionRule | None = None,
    ratified: bool = True,
) -> RetentionRule:
    """Rows live until their account is erased."""
    return RetentionRule(
        kind=RetentionKind.UNTIL_ACCOUNT_DELETION,
        trigger=_ACCOUNT_DELETION,
        rationale=rationale,
        soft_deleted=soft_deleted,
        ratified=ratified,
    )


def fixed_days(days: int, *, trigger: str, rationale: str, ratified: bool) -> RetentionRule:
    """Rows live ``days`` after ``trigger``."""
    if days <= 0:
        msg = f"a fixed lifetime must be a positive number of days, got {days}"
        raise ValueError(msg)
    return RetentionRule(
        kind=RetentionKind.FIXED_DAYS,
        trigger=trigger,
        rationale=rationale,
        days=days,
        ratified=ratified,
    )


def swept_by(
    route: str,
    *,
    trigger: str,
    rationale: str,
    days: int | None = None,
    ratified: bool = True,
) -> RetentionRule:
    """Rows are removed by an operator sweep, named ``'METHOD /path'``.

    ``days`` is the sweep's default window, or ``None`` when the route has no
    default and the operator must name one on every call.
    """
    if not _SWEEP_ROUTE.match(route):
        msg = f"a sweep route is named 'METHOD /path', got {route!r}"
        raise ValueError(msg)
    return RetentionRule(
        kind=RetentionKind.SWEPT_BY,
        trigger=trigger,
        rationale=rationale,
        days=days,
        sweep_route=route,
        ratified=ratified,
    )


def indefinite(reason: str, *, ratified: bool) -> RetentionRule:
    """No bound exists. The reason is mandatory; ratification is the owner's."""
    if not reason.strip():
        msg = "an indefinite lifetime must state its reason"
        raise ValueError(msg)
    return RetentionRule(
        kind=RetentionKind.INDEFINITE,
        trigger="none",
        rationale=reason,
        ratified=ratified,
    )


def shared_catalogue(rationale: str) -> RetentionRule:
    """Shared curriculum or catalogue content naming no account."""
    return RetentionRule(
        kind=RetentionKind.SHARED_CATALOGUE,
        trigger="none",
        rationale=rationale,
    )


_DERIVED_FROM_ENTRY = (
    " Rows anchored to a soft-deleted entry live as long as that entry does (see "
    "journalentry's soft-deleted rule): the soft delete hides them, and only the operator "
    "purge or account deletion removes them."
)

# --------------------------------------------------------------------------
# The registry. One explicit entry per table, alphabetical for review.
# --------------------------------------------------------------------------
RETENTION: Mapping[str, RetentionRule] = {
    "accountdeletionaudit": indefinite(
        "The content-free receipt that an erasure ran (surrogate id, instant, row "
        "counts). It is also the account tombstone a restore is suppressed with, so "
        "it has to outlive the longest backup; no bound has been chosen (#3063 AC17).",
        ratified=False,
    ),
    "authidentity": until_account_deletion("Social sign-in links of a live account."),
    "completionsuggestion": until_account_deletion(
        "Suggestions derived from the account's own entries." + _DERIVED_FROM_ENTRY,
    ),
    "contentcompletion": until_account_deletion("Which chapters the account marked read."),
    "corpusconsentevent": until_account_deletion("The account's ontology consent decisions."),
    "corpusfragment": until_account_deletion(
        "The account's ontologized corpus. A fragment is also withdrawn the moment its "
        "entry is deleted or made Intimate.",
    ),
    "corpusinvitationstate": until_account_deletion("Corpus invitation state."),
    "corpussweep": until_account_deletion("Content-free counts of corpus grants."),
    "coursestage": shared_catalogue("The shared 36-week curriculum."),
    "energyplan": swept_by(
        ENERGY_PLAN_SWEEP,
        trigger="plan creation",
        days=ENERGY_PLAN_SWEEP_DAYS,
        rationale="Energy plans have no TTL; the operator sweep removes plans older than "
        "its window. The window is an internal default, not a published promise.",
        ratified=False,
    ),
    "entitlement": until_account_deletion("The account's course access grant."),
    "feedbacknote": swept_by(
        FEEDBACK_SWEEP,
        trigger="report submission",
        days=FEEDBACK_SWEEP_DAYS,
        rationale="An operator note goes with the report it describes, in the same sweep.",
    ),
    "feedbackreport": swept_by(
        FEEDBACK_SWEEP,
        trigger="report submission",
        days=FEEDBACK_SWEEP_DAYS,
        rationale="The published 180-day window, applied when the operator runs the sweep.",
    ),
    "feedbacktriageevent": swept_by(
        FEEDBACK_SWEEP,
        trigger="report submission",
        days=FEEDBACK_SWEEP_DAYS,
        rationale="A report's triage trail goes with the report, in the same sweep.",
    ),
    "generationslot": until_account_deletion(
        "Transient generation leases; released in normal operation, bounded by the account.",
    ),
    "goal": until_account_deletion("Goals of the account's habits."),
    "goalcompletion": until_account_deletion("Every check-in the account logged."),
    "goalcompletionspend": until_account_deletion("Hashed check-in retry receipts."),
    "goalgroup": until_account_deletion(
        "The account's own goal groupings; shared templates carry no account.",
    ),
    "gumroadsale": indefinite(
        "A purchase receipt, anonymised on account deletion but keeping the buyer's "
        "email so a paid-for licence can be re-matched. No deadline exists; payment "
        "retention is a legal question for the owner (#3063 AC15).",
        ratified=False,
    ),
    "habit": until_account_deletion("The account's habits."),
    "invitationsignal": until_account_deletion("Which invitations the account saw."),
    "journalentry": until_account_deletion(
        "The writing. A live entry lives until the account is erased.",
        soft_deleted=swept_by(
            JOURNAL_ENTRY_PURGE,
            trigger="soft delete",
            rationale="A soft-deleted entry (BUG-JOURNAL-007) is hidden from every read "
            "path but kept, with its derivatives, until account deletion or until an "
            "operator runs the purge. The purge refuses a window shorter than the "
            "longest backup retention, has no default window, and nothing schedules "
            "it; both are owner decisions (#3063 AC15, AC18).",
            ratified=False,
        ),
    ),
    "licensebinding": until_account_deletion("The claim tying a sale to this account."),
    "llmusagelog": until_account_deletion(
        "Per-request AI metering rows. Kept for the account's whole life; whether "
        "metering should expire sooner is an owner decision (#3063 AC15).",
        ratified=False,
    ),
    "loginattempt": until_account_deletion(
        "Sign-in attempts with the typed address and IP. No expiry exists; a shorter "
        "lifetime is an owner decision (#3063 AC15). Attempts against an address that "
        "never had an account are swept by nothing.",
        ratified=False,
    ),
    "marginalia": until_account_deletion(
        "Margin notes on the account's entries, encrypted at rest." + _DERIVED_FROM_ENTRY,
    ),
    "mettareturnarc": until_account_deletion("The account's return arcs."),
    "mettareturnhabitrelease": until_account_deletion("Habits released during an arc."),
    "mettareturnofferdismissal": until_account_deletion("Return offers waved away."),
    "passwordresettoken": until_account_deletion(
        "Recovery tokens; expired ones stop working but are not swept.",
    ),
    "practice": shared_catalogue(
        "The shared practice catalogue. A user-contributed practice survives its "
        "author's deletion with the attribution cleared.",
    ),
    "practicerecipe": until_account_deletion("Recipes the account authored."),
    "practicerecipestep": until_account_deletion("Steps of the account's recipes."),
    "practicesession": until_account_deletion("Every sit the account logged."),
    "practicesessionspend": until_account_deletion("Wallet spend for the account's sessions."),
    "practicesharelink": indefinite(
        "A share link survives its creator's deletion, anonymised, because recipients "
        "may hold the URL. No expiry exists.",
        ratified=False,
    ),
    "practicetag": until_account_deletion("Tags the account defined."),
    "promotedquote": until_account_deletion(
        "Passages promoted out of the account's entries, encrypted at rest." + _DERIVED_FROM_ENTRY,
    ),
    "promptdismissal": until_account_deletion("Prompts the account set aside."),
    "promptresponse": until_account_deletion("Answers to the weekly prompts."),
    "restoremarker": indefinite(
        "Content-free operator record of each restore's reapply. It must outlive "
        "the cutover it guards; no bound has been chosen (#3063 AC17).",
        ratified=False,
    ),
    "revokedtoken": indefinite(
        "Opaque JWT ids and their expiry. Content-free, but nothing sweeps a row once "
        "its token has expired.",
        ratified=False,
    ),
    "stagecontent": shared_catalogue("Shared curriculum chapters."),
    "stageprogress": until_account_deletion("Where the account had reached."),
    "user": until_account_deletion(
        "The account row itself. Account deletion hard-deletes it; its soft-delete "
        "column is never written.",
    ),
    "userdepthpreferences": until_account_deletion("Chosen optional depths."),
    "userpractice": until_account_deletion("Assigned practices and customisations."),
    "useruiflags": until_account_deletion("One-time interface state."),
    "uservaultconfig": until_account_deletion("The connected vault and its credential."),
    "vaultactivation": until_account_deletion("Content-free managed-vault provisioning handle."),
    "vaultpipelinefollowup": until_account_deletion("Content-free scheduling marker."),
    "vaultpipelinerun": until_account_deletion("Content-free vault pipeline progress."),
    "vaultteardownreceipt": indefinite(
        "Detached, content-free Creek teardown receipt kept so operations can prove no "
        "billable allocation survived. No bound has been chosen.",
        ratified=False,
    ),
    "voicedraftretraction": until_account_deletion(
        "Content-free obligation to withdraw a mirrored essay from a vault. Erased with "
        "the account today; whether a pending obligation should outlive erasure, and "
        "what deadline it carries, is an owner decision (#3063 AC21-22). Never purged "
        "with a soft-deleted entry while unconfirmed.",
        ratified=False,
    ),
    "walletaudit": until_account_deletion("The account's wallet ledger."),
}


def retention_gaps(metadata: MetaData) -> tuple[str, ...]:
    """Report every table without a rule, and every rule without a table.

    An empty tuple is the only acceptable answer. Deliberately independent of
    the deletion policy: a table the policy erases still needs its own rule.
    """
    tables = set(metadata.tables)
    missing = [f"table {name!r} has no retention rule" for name in sorted(tables - set(RETENTION))]
    stale = [
        f"retention rule {name!r} names no table in the schema"
        for name in sorted(set(RETENTION) - tables)
    ]
    return tuple(missing + stale)


def _conflict(name: str, rule: RetentionRule, policy: TablePolicy) -> str | None:
    """Describe how one rule contradicts the deletion policy, if it does."""
    if policy.disposition is Disposition.ERASE:
        if rule.kind in {RetentionKind.INDEFINITE, RetentionKind.SHARED_CATALOGUE}:
            return (
                f"{name}: the deletion policy erases it, but its retention is "
                f"{rule.kind.value}, which would outlive the account"
            )
        return None
    if rule.kind is RetentionKind.UNTIL_ACCOUNT_DELETION:
        return (
            f"{name}: the deletion policy {policy.disposition.value}s it, so it outlives "
            "the account; 'until account deletion' cannot be its lifetime"
        )
    return None


def retention_conflicts(policy: Mapping[str, TablePolicy] | None = None) -> tuple[str, ...]:
    """Report rules that contradict the deletion policy.

    * An ERASE table cannot be ``indefinite`` or ``shared_catalogue``.
    * A RETAIN/ANONYMISE table survives the account, so it must declare a bound,
      a shared catalogue, or an explicit ``indefinite`` reason.
    """
    resolved = POLICY if policy is None else policy
    findings = (
        _conflict(name, RETENTION[name], resolved[name])
        for name in sorted(set(RETENTION) & set(resolved))
    )
    return tuple(finding for finding in findings if finding is not None)


def _rules_with_nested() -> list[tuple[str, RetentionRule]]:
    """Every rule, with nested soft-delete rules named ``table (soft-deleted)``."""
    rules: list[tuple[str, RetentionRule]] = []
    for name in sorted(RETENTION):
        rule = RETENTION[name]
        rules.append((name, rule))
        if rule.soft_deleted is not None:
            rules.append((f"{name} (soft-deleted)", rule.soft_deleted))
    return rules


def unratified_rules() -> tuple[str, ...]:
    """Tables (and soft-delete sub-rules) whose lifetime the owner has not decided."""
    return tuple(name for name, rule in _rules_with_nested() if not rule.ratified)


def _describe(rule: RetentionRule) -> str:
    """One rule as ``kind[, N days][, via route]``."""
    parts = [rule.kind.value]
    if rule.days is not None:
        parts.append(f"{rule.days} days")
    if rule.sweep_route is not None:
        parts.append(f"via {rule.sweep_route}")
    return ", ".join(parts)


def retention_report() -> str:
    """The whole registry, one line per rule, with unratified rules flagged.

    Generated on demand rather than committed, so it never reads as a
    published schedule (that is #3063 AC16, the owner's).
    """
    lines = []
    for name, rule in _rules_with_nested():
        flag = "ratified" if rule.ratified else "UNRATIFIED"
        lines.append(f"{name}: {_describe(rule)} [{flag}] -- trigger: {rule.trigger}")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Restore-suppression tombstones (#3063 AC9-10).
#
# Restoring a backup older than a deletion brings the deleted rows back, and
# the record of the deletion comes back without it. Every column that records a
# deletion is therefore either exported as a tombstone before a restore, or
# exempt with a written reason. :func:`tombstone_gaps` keeps that total.
# --------------------------------------------------------------------------

#: The column name every soft-delete stamp in this schema uses.
SOFT_DELETE_COLUMN = "deleted_at"


class TombstoneKind(enum.StrEnum):
    """Which deletion a tombstone source records."""

    ACCOUNT = "account"
    ENTRY = "entry"


@dataclass(frozen=True)
class TombstoneSource:
    """A table whose rows record deletions, and the content-free columns exported."""

    kind: TombstoneKind
    columns: tuple[str, ...]
    stamp: str = SOFT_DELETE_COLUMN


TOMBSTONE_SOURCES: Mapping[str, TombstoneSource] = {
    # The deletion receipt is the account tombstone: surrogate id and instant.
    "accountdeletionaudit": TombstoneSource(
        kind=TombstoneKind.ACCOUNT,
        columns=("user_id", SOFT_DELETE_COLUMN),
    ),
    # A soft-deleted entry: its id, owner and the instant of deletion.
    "journalentry": TombstoneSource(
        kind=TombstoneKind.ENTRY,
        columns=("id", "user_id", SOFT_DELETE_COLUMN),
    ),
}

TOMBSTONE_EXEMPT: Mapping[str, str] = {
    "user.deleted_at": "never written: account deletion hard-deletes the row, and the "
    "accountdeletionaudit receipt is the account tombstone",
}


def _stamp_columns(metadata: MetaData) -> set[str]:
    """Every ``table.deleted_at`` column present in ``metadata``."""
    return {
        f"{table.name}.{column.name}"
        for table in metadata.tables.values()
        for column in table.columns
        if column.name == SOFT_DELETE_COLUMN
    }


def _present(metadata: MetaData, qualified: str) -> bool:
    """Whether ``table.column`` exists in ``metadata``."""
    table_name, column = qualified.split(".", 1)
    table = metadata.tables.get(table_name)
    return table is not None and column in table.c


def _declared_columns(metadata: MetaData) -> list[tuple[str, bool]]:
    """``(table.column, present)`` for every column a source or exemption names."""
    named = [
        f"{name}.{column}"
        for name, source in TOMBSTONE_SOURCES.items()
        for column in source.columns
    ]
    named.extend(TOMBSTONE_EXEMPT)
    return [(qualified, _present(metadata, qualified)) for qualified in named]


def tombstone_gaps(metadata: MetaData) -> tuple[str, ...]:
    """Report deletion stamps no tombstone covers, and stale declarations.

    A ``deleted_at`` column that is neither a source's stamp nor exempt is a
    deletion a restore would silently undo.
    """
    covered = {f"{name}.{source.stamp}" for name, source in TOMBSTONE_SOURCES.items()}
    covered |= set(TOMBSTONE_EXEMPT)
    uncovered = [
        f"{qualified} records a deletion but is neither a tombstone source nor exempt"
        for qualified in sorted(_stamp_columns(metadata) - covered)
    ]
    stale = [
        f"{qualified} is declared for tombstones but is not in the schema"
        for qualified, present in _declared_columns(metadata)
        if not present
    ]
    return tuple(uncovered + stale)


# --------------------------------------------------------------------------
# What purging a soft-deleted entry must do to the rows that point at it
# (#3063 AC13).
#
# Derived from the schema's own foreign keys rather than hand-listed, so the
# next table that references an entry is a decision the purge is forced to
# make rather than a row it silently leaves dangling -- or, on Postgres, a row
# the database cascade silently deletes.
# --------------------------------------------------------------------------

ENTRY_TABLE = "journalentry"


class PurgeAction(enum.StrEnum):
    """What a purge does to one referencing column's rows."""

    DELETE = "delete"
    NULL = "null"


@dataclass(frozen=True)
class EntryDependant:
    """One foreign key that reaches a purged entry, directly or through a deleted child.

    ``parent`` is ``None`` for a column referencing the entry itself; otherwise
    it is the deleted dependant whose rows this column references.
    """

    table: str
    column: str
    action: PurgeAction
    referenced_column: str
    parent: EntryDependant | None = None


@dataclass(frozen=True)
class PurgeBlocker:
    """Rows of an obligation table that make their entry ineligible for a purge.

    An entry is skipped while any of its rows in ``table`` has a ``state_column``
    value outside ``cleared_states``: purging it would delete an obligation the
    system still owes somebody (a remote copy not yet withdrawn).
    """

    entry_column: str
    state_column: str
    cleared_states: tuple[str, ...]


#: Foreign keys into an entry that declare no ``ondelete``; the purge's action
#: for each is stated here instead.
ENTRY_FK_OVERRIDES: Mapping[str, PurgeAction] = {
    # The metering row outlives the writing it metered (BUG-JOURNAL-007).
    "llmusagelog.journal_entry_id": PurgeAction.NULL,
}

#: Obligation tables whose unsettled rows keep a soft-deleted entry out of the
#: purge. ``voicedraftretraction`` (B04, #3060): an essay offered to a vault
#: whose withdrawal is not confirmed -- ``mirror_intent`` or ``pending`` --
#: still has a remote copy, and purging the entry would cascade the only record
#: that a withdrawal is owed.
ENTRY_PURGE_BLOCKERS: Mapping[str, PurgeBlocker] = {
    "voicedraftretraction": PurgeBlocker(
        entry_column="journal_entry_id",
        state_column="state",
        cleared_states=("confirmed",),
    ),
}

_ONDELETE_ACTIONS: Mapping[str, PurgeAction] = {
    "CASCADE": PurgeAction.DELETE,
    "SET NULL": PurgeAction.NULL,
}


def _references_into(metadata: MetaData, target: str) -> list[tuple[str, str, str | None, str]]:
    """``(table, column, ondelete, referenced column)`` for every FK into ``target``."""
    return [
        (table.name, column.name, foreign_key.ondelete, foreign_key.column.name)
        for table in metadata.sorted_tables
        for column in table.columns
        for foreign_key in column.foreign_keys
        if foreign_key.column.table.name == target
    ]


def _action(table: str, column: str, ondelete: str | None) -> PurgeAction | None:
    """The purge action for one FK: an explicit override, else its declared cascade."""
    override = ENTRY_FK_OVERRIDES.get(f"{table}.{column}")
    if override is not None:
        return override
    return _ONDELETE_ACTIONS.get((ondelete or "").upper())


def _walk(
    metadata: MetaData, target: str, parent: EntryDependant | None, seen: frozenset[str]
) -> tuple[list[EntryDependant], list[str]]:
    """Dependants of ``target`` and, through every deleted one, theirs."""
    dependants: list[EntryDependant] = []
    gaps: list[str] = []
    for table, column, ondelete, referenced in _references_into(metadata, target):
        action = _action(table, column, ondelete)
        if action is None:
            gaps.append(
                f"{table}.{column} references {target} with ondelete={ondelete!r} and no "
                "purge override; decide whether a purge deletes or nulls it"
            )
            continue
        dependant = EntryDependant(table, column, action, referenced, parent)
        dependants.append(dependant)
        if action is PurgeAction.DELETE and table not in seen:
            deeper, deeper_gaps = _walk(metadata, table, dependant, seen | {table})
            dependants.extend(deeper)
            gaps.extend(deeper_gaps)
    return dependants, gaps


def entry_dependants(metadata: MetaData) -> tuple[EntryDependant, ...]:
    """Every column a purge of an entry must act on, parents before their children."""
    dependants, _ = _walk(metadata, ENTRY_TABLE, None, frozenset({ENTRY_TABLE}))
    return tuple(dependants)


def entry_dependant_gaps(metadata: MetaData) -> tuple[str, ...]:
    """Foreign keys reaching an entry that the purge has no stated action for.

    Also reports a blocker naming a table or column that no longer exists, so
    an obligation cannot quietly stop protecting its entry.
    """
    _, gaps = _walk(metadata, ENTRY_TABLE, None, frozenset({ENTRY_TABLE}))
    for name, blocker in ENTRY_PURGE_BLOCKERS.items():
        table = metadata.tables.get(name)
        columns = (blocker.entry_column, blocker.state_column)
        if table is None or any(column not in table.c for column in columns):
            gaps.append(f"purge blocker {name!r} names a table or column not in the schema")
    return tuple(gaps)
