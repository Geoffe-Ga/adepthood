"""What account deletion does to every table in the schema, stated once.

Apple App Store Review 5.1.1(v) and GDPR Art. 17 both ask the same question of
a deletion feature: *did it actually reach everything?* The failure mode is not
a broken endpoint, it is a table somebody added six months later that nobody
remembered to sweep. A hand-maintained list of tables answers the question on
the day it is written and quietly stops being true afterwards.

So the policy here is **total by construction**: every table in the ORM
metadata must carry an entry, and :func:`policy_gaps` reports the ones that do
not. A new model is a failing test, not a silent leak. Each entry says which of
three things happens to that table, and *why*:

* :attr:`Disposition.ERASE` — the account's rows are deleted outright.
* :attr:`Disposition.ANONYMISE` — the rows survive with the reference to the
  account cleared, because something other than the account depends on them
  (a financial record, a catalogue entry other users already assigned).
* :attr:`Disposition.RETAIN` — the table holds nothing that names the account.

This module is pure: it imports no model, no session, and no FastAPI. It reads
a :class:`sqlalchemy.MetaData` and returns findings; :mod:`services.account_deletion`
is what executes them.
"""

from __future__ import annotations

import enum
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from sqlalchemy import MetaData, Table

# The table the account itself lives in — the anchor every ownership predicate
# eventually resolves against.
USER_TABLE = "user"


class Disposition(enum.StrEnum):
    """What deletion does to one table's rows."""

    ERASE = "erase"
    ANONYMISE = "anonymise"
    RETAIN = "retain"


class OwnerKey(enum.StrEnum):
    """Which attribute of the account a table's ownership column carries.

    Almost everything carries the surrogate ``user.id``. ``login_attempt`` is
    the exception: it is written before any account is resolved, so it can only
    key off the address that was typed.
    """

    ID = "id"
    EMAIL = "email"


@dataclass(frozen=True)
class OwnedBy:
    """How to find the rows in a table that belong to one account.

    ``through`` names a parent table when a table has no direct reference to
    the account and is reached via its owner instead (``goal`` through
    ``habit``). Resolution recurses, so the parent's own policy decides how the
    parent's rows are found.
    """

    column: str
    key: OwnerKey = OwnerKey.ID
    through: str | None = None


@dataclass(frozen=True)
class TablePolicy:
    """The deletion decision for one table, with the reason it was made."""

    disposition: Disposition
    rationale: str
    owned_by: OwnedBy | None = None
    clear_columns: tuple[str, ...] = ()
    ondelete_deviation: str | None = None

    def user_columns(self) -> frozenset[str]:
        """Columns of this table that this policy claims to handle.

        Used to prove that every declared foreign key onto ``user`` is
        accounted for. An ownership column reached ``through`` a parent is not
        one of them — that column points at the parent, not at the account.
        """
        named = set(self.clear_columns)
        if self.owned_by is not None and self.owned_by.through is None:
            named.add(self.owned_by.column)
        return frozenset(named)


def _erase(
    column: str,
    rationale: str,
    *,
    clear_columns: tuple[str, ...] = (),
    ondelete_deviation: str | None = None,
) -> TablePolicy:
    """Shorthand for the common case: rows keyed directly on ``user.id``."""
    return TablePolicy(
        disposition=Disposition.ERASE,
        rationale=rationale,
        owned_by=OwnedBy(column),
        clear_columns=clear_columns,
        ondelete_deviation=ondelete_deviation,
    )


def _retain(rationale: str) -> TablePolicy:
    """Shorthand for a table that holds nothing naming any account."""
    return TablePolicy(disposition=Disposition.RETAIN, rationale=rationale)


# --------------------------------------------------------------------------
# The policy itself. Ordering is alphabetical for review, not for execution --
# execution order is derived from the schema's own dependency graph.
# --------------------------------------------------------------------------
POLICY: Mapping[str, TablePolicy] = {
    "accountdeletionaudit": _retain(
        "The receipt of the deletion itself: surrogate id, timestamp and row "
        "counts. Erasing it would erase the evidence that erasure happened.",
    ),
    "authidentity": _erase(
        "user_id",
        "The links to Google / Apple sign-in. Removed, so the same social "
        "identity can start a fresh account rather than resurrect this one.",
    ),
    "completionsuggestion": _erase(
        "user_id",
        "Suggestions derived from the account's own journal entries.",
    ),
    "contentcompletion": _erase("user_id", "Which chapters the account marked read."),
    "coursestage": _retain("The shared 36-week curriculum. Identical for every account."),
    "energyplan": _erase("user_id", "The account's energy budget and its history."),
    "entitlement": _erase(
        "user_id",
        "The account's course access grant. The Gumroad sale that paid for it "
        "survives separately as the financial record.",
    ),
    "goal": TablePolicy(
        disposition=Disposition.ERASE,
        rationale="Goals belong to a habit, and every habit belongs to one account.",
        owned_by=OwnedBy("habit_id", through="habit"),
    ),
    "goalcompletion": _erase("user_id", "Every check-in the account logged."),
    "goalgroup": _erase(
        "user_id",
        "The account's own goal groupings. Shared community templates are a "
        "different thing entirely: they carry no user_id at all, so scoping by "
        "user_id cannot touch one.",
        ondelete_deviation=(
            "The column declares ON DELETE SET NULL, but nulling it is "
            "impossible for a personal group: ck_goalgroup_shared_template_user_id "
            "requires user_id IS NULL to mean shared_template, and a database-level "
            "SET NULL would either abort the delete or promote a private grouping "
            "into a community template. Deleting the rows here keeps that "
            "invariant true and never reaches the SET NULL."
        ),
    ),
    "gumroadsale": TablePolicy(
        disposition=Disposition.ANONYMISE,
        rationale=(
            "A purchase receipt. The link to the account is cleared, but the "
            "row itself stays and so does the buyer's address on it — this is "
            "the one identifier that deliberately survives a deletion. It has "
            "to: the address is how a paid-for licence or token pack is "
            "matched to whoever bought it (services.token_packs), so erasing "
            "it would silently confiscate something the person paid for if "
            "they ever came back. Retention of a payment record is also the "
            "ordinary GDPR Art. 17(3) carve-out. Nothing in the row points at "
            "an account any more."
        ),
        clear_columns=("token_pack_credited_user_id",),
    ),
    "habit": _erase("user_id", "Every habit the account created, and its goals with it."),
    "invitationsignal": _erase("user_id", "Which invitations the account was shown or declined."),
    "journalentry": _erase(
        "user_id",
        "The writing. Encrypted at rest and erased outright — this is the "
        "single most important row in the sweep.",
    ),
    "llmusagelog": _erase(
        "user_id",
        "Per-request AI metering rows, each one tied to the account that spent it.",
    ),
    "loginattempt": TablePolicy(
        disposition=Disposition.ERASE,
        rationale=(
            "Failed and successful sign-in attempts, holding the address typed "
            "and the IP it came from. Keyed on the email rather than on user.id "
            "because rows are written before any account is resolved — which is "
            "exactly why a foreign-key-driven sweep would miss them."
        ),
        owned_by=OwnedBy("email", key=OwnerKey.EMAIL),
    ),
    "marginalia": _erase("user_id", "Margin notes the account wrote against the reading."),
    "mettareturnarc": _erase("user_id", "The account's return arcs."),
    "mettareturnhabitrelease": _erase("user_id", "Habits the account released during an arc."),
    "mettareturnofferdismissal": _erase("user_id", "Return offers the account waved away."),
    "passwordresettoken": _erase(
        "user_id",
        "Outstanding recovery tokens. Erased with the account so none can be "
        "redeemed against an address that is now free to re-register.",
    ),
    "practice": TablePolicy(
        disposition=Disposition.ANONYMISE,
        rationale=(
            "A practice this account contributed to the shared catalogue. "
            "Other accounts may already have it assigned, so the entry stays "
            "and its attribution becomes anonymous."
        ),
        clear_columns=("submitted_by_user_id",),
    ),
    "practicerecipe": _erase(
        "owner_user_id",
        "Recipes the account authored. System recipes carry no owner and are untouched.",
    ),
    "practicerecipestep": TablePolicy(
        disposition=Disposition.ERASE,
        rationale="The steps of the account's own recipes; meaningless without them.",
        owned_by=OwnedBy("recipe_id", through="practicerecipe"),
    ),
    "practicesession": _erase("user_id", "Every sit the account logged."),
    "practicesessionspend": _erase("user_id", "Wallet spend records for the account's sessions."),
    "practicesharelink": TablePolicy(
        disposition=Disposition.ANONYMISE,
        rationale=(
            "A share link the account minted. Recipients may already hold the "
            "URL, so the link keeps working and stops naming its creator."
        ),
        clear_columns=("created_by_user_id",),
    ),
    "practicetag": _erase(
        "owner_user_id",
        "Tags the account defined. System tags carry no owner and are untouched.",
    ),
    "promotedquote": _erase("user_id", "Passages the account promoted out of its own entries."),
    "promptresponse": _erase("user_id", "Answers to the weekly prompts."),
    "revokedtoken": _retain(
        "Opaque JWT ids with an expiry and nothing else — no account column "
        "exists to sweep on, and the rows age out on their own.",
    ),
    "stagecontent": _retain("Shared curriculum chapters."),
    "stageprogress": _erase("user_id", "Where the account had reached in the 36 weeks."),
    "user": TablePolicy(
        disposition=Disposition.ERASE,
        rationale=(
            "The account row itself: email, password hash, display name, "
            "wallet balances. Deleted last, once nothing references it."
        ),
        owned_by=OwnedBy("id"),
    ),
    "userdepthpreferences": _erase("user_id", "Which optional depths the account had chosen."),
    "userpractice": _erase("user_id", "The account's assigned practices and its customisations."),
    "useruiflags": _erase("user_id", "One-time interface state."),
    "walletaudit": _erase(
        "user_id",
        "The account's own wallet ledger goes with the wallet. Rows recording "
        "what this account did to somebody ELSE's wallet stay, with the actor "
        "cleared, because that trail outlives the actor.",
        clear_columns=("actor_user_id",),
    ),
}


def _user_foreign_keys(metadata: MetaData) -> Iterable[tuple[str, str, str | None]]:
    """Yield ``(table, column, declared ondelete)`` for every FK onto ``user``."""
    for table in metadata.sorted_tables:
        for column in table.columns:
            for foreign_key in column.foreign_keys:
                if foreign_key.column.table.name == USER_TABLE:
                    yield table.name, column.name, foreign_key.ondelete


def _unpoliced_tables(metadata: MetaData) -> list[str]:
    """Findings for tables the policy has never heard of."""
    return [
        f"table {name!r} has no deletion policy"
        for name in sorted(metadata.tables)
        if name not in POLICY
    ]


def _unnamed_user_columns(metadata: MetaData) -> list[str]:
    """Findings for user references a policed table does not claim to handle."""
    return [
        f"{table}.{column} references {USER_TABLE} but no policy names it"
        for table, column, _ in _user_foreign_keys(metadata)
        if table in POLICY and column not in POLICY[table].user_columns()
    ]


def policy_gaps(metadata: MetaData) -> tuple[str, ...]:
    """Report every table or user reference the policy fails to account for.

    An empty tuple is the only acceptable answer, and the reason this function
    exists is that it stops being empty on its own: adding a model, or adding a
    second user column to a model that already has one, produces a finding
    without anyone remembering to come back here.
    """
    return tuple(_unpoliced_tables(metadata) + _unnamed_user_columns(metadata))


def _expected_ondelete(policy: TablePolicy, column: str) -> str | None:
    """The ``ondelete`` a column should declare, given what the policy does to it."""
    if column in policy.clear_columns:
        return "SET NULL"
    if policy.disposition is Disposition.ERASE:
        return "CASCADE"
    return None


def _ondelete_finding(table: str, column: str, declared: str | None) -> str | None:
    """Describe how one column's declared cascade contradicts the policy, if it does."""
    policy = POLICY.get(table)
    if policy is None or policy.ondelete_deviation is not None:
        return None
    expected = _expected_ondelete(policy, column)
    if expected is None or declared == expected:
        return None
    return (
        f"{table}.{column} declares ondelete={declared!r} "
        f"but the policy would {policy.disposition.value} it "
        f"(expected {expected!r})"
    )


def ondelete_disagreements(metadata: MetaData) -> tuple[str, ...]:
    """Report user foreign keys whose schema and policy tell different stories.

    The application never relies on the database's own ``ON DELETE`` behaviour
    — it issues the statements itself, so the two agree by choice rather than
    by necessity. That is precisely why they are worth checking: a column whose
    declared cascade contradicts the policy is a sign that one of the two was
    changed without the other, and an operator running a manual ``DELETE`` in
    psql would get the schema's answer, not this module's.

    A policy may opt out by supplying ``ondelete_deviation`` — a written reason
    the two must differ.
    """
    findings = (
        _ondelete_finding(table, column, declared)
        for table, column, declared in _user_foreign_keys(metadata)
    )
    return tuple(finding for finding in findings if finding is not None)


def erasure_order(metadata: MetaData) -> tuple[Table, ...]:
    """Tables to act on, children before parents.

    ``sorted_tables`` is SQLAlchemy's topological order — a table always
    follows the tables it references — so reversing it visits dependants first.
    That ordering is what lets the sweep delete rows one table at a time
    without tripping a restricting foreign key, and it puts ``user`` itself
    last without the policy having to say so.
    """
    return tuple(
        table
        for table in reversed(metadata.sorted_tables)
        if table.name in POLICY and POLICY[table.name].disposition is not Disposition.RETAIN
    )
