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
  and :func:`unratified_rules` is the worklist;
* ``proposal``: on an unratified rule, the lifetime proposed for the owner to
  ratify -- a day count, the event it counts from, and a one-line rationale
  (:class:`RetentionProposal`). A proposal is a value for review, **never** a
  window: no sweep, purge or route reads it, and a test pins that. Ratifying a
  rule means writing its proposal into the rule itself and dropping the
  proposal. The owner reviews them in ``docs/privacy/retention-proposal.md``,
  and :func:`proposal_findings` keeps every unratified rule proposed.

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
from dataclasses import dataclass, replace

from sqlalchemy import MetaData

from domain.account_deletion import POLICY, Disposition, TablePolicy
from domain.retention_stores import OLDEST_LIVE_BACKUP_DAYS, TodayComparison

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

# Proposed lifetimes for the owner to ratify (#3063 AC15). Values for review
# only: nothing deletes on them (see RetentionProposal). Rationales live on the
# rules below and in docs/privacy/retention-proposal.md.
#: An erasure receipt must outlive every backup (it is the restore tombstone)
#: and still answer "did the erasure run?" for a year.
PROPOSED_ERASURE_RECEIPT_DAYS = 365
#: Energy plans are re-read for a retried request and included in the export.
PROPOSED_ENERGY_PLAN_DAYS = 7
#: A deleted account's buyer email outlives it by an assumed dispute window
#: (to confirm; a legal question).
PROPOSED_SALE_EMAIL_DAYS = 180
#: A soft-deleted page is kept exactly as long as some live backup may still
#: hold it undeleted -- the journal purge's own floor. That bound includes the
#: copies still held under a retention since lowered
#: (``retention_stores.HELD_BACKUP_BOUND_DAYS``), so ratifying a shorter backup
#: retention does not lower it until the old copies have aged out.
PROPOSED_SOFT_DELETED_ENTRY_DAYS = OLDEST_LIVE_BACKUP_DAYS
#: A confirmed withdrawal record is a short-lived receipt.
PROPOSED_CONFIRMED_OBLIGATION_DAYS = 30
#: Metering covers the cost-alert window plus provider invoice reconciliation.
PROPOSED_USAGE_LOG_DAYS = 90
#: Sign-in attempts serve lockout (15 minutes) and short abuse investigation.
PROPOSED_LOGIN_ATTEMPT_DAYS = 30
#: A share link that stopped working is kept briefly, then removed.
PROPOSED_DEAD_SHARE_LINK_DAYS = 30
#: A restore marker guards one restore's reapply.
PROPOSED_RESTORE_MARKER_DAYS = 365
#: A revoked token's row is useless once the token itself has expired.
PROPOSED_REVOKED_TOKEN_GRACE_DAYS = 1
#: A confirmed teardown receipt spans a few vendor billing cycles.
PROPOSED_TEARDOWN_RECEIPT_DAYS = 90

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


class ProposalClock(enum.StrEnum):
    """When a proposal's days start counting. Structured so it can be checked."""

    #: From the row's own creation.
    ROW_CREATED = "row_created"
    #: From an event in the row's life while its account lives (confirmation,
    #: soft delete, expiry); ``trigger`` names the event.
    ROW_EVENT = "row_event"
    #: From the owning account's erasure. For a table erased with its account
    #: that keeps the row *past* erasure, which is longer than today.
    AFTER_ACCOUNT_DELETION = "after_account_deletion"


@dataclass(frozen=True)
class RetentionProposal:
    """A lifetime proposed for the owner to ratify (#3063 AC15). Never a window.

    ``days`` counts from ``clock`` (``trigger`` names the event in words).
    ``compared_to_today`` is declared, and :func:`proposal_findings` checks it
    against what the rule implies, so a proposal that keeps a row longer than
    today -- including past its account's erasure -- must say ``LONGER``.

    A proposal can be *conditional*: rows in ``exempt_states`` are never eligible
    (an open obligation outlives the copy it tracks), and ``redact_columns``, when
    set, means those columns are blanked rather than the row deleted. A
    conditional proposal cannot be ratified as a plain ``fixed_days`` rule.
    ``requires_schema`` names a column the proposal needs that does not exist
    yet (proposed, not built).

    Nothing outside this module and :mod:`domain.retention_stores` may read one:
    a sweep that did would start deleting on a value nobody ratified.
    """

    days: int
    clock: ProposalClock
    trigger: str
    rationale: str
    compared_to_today: TodayComparison
    exempt_states: frozenset[str] = frozenset()
    redact_columns: tuple[str, ...] = ()
    requires_schema: str | None = None

    def __post_init__(self) -> None:
        """Refuse a proposal the owner could not review."""
        if self.days <= 0:
            msg = f"a proposed lifetime must be a positive number of days, got {self.days}"
            raise ValueError(msg)
        if not self.trigger.strip():
            msg = "a proposal must name the trigger its days count from"
            raise ValueError(msg)
        if not self.rationale.strip():
            msg = "a proposal must state its rationale"
            raise ValueError(msg)


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
    proposal: RetentionProposal | None = None
    #: A sweep's conditions, carried over from the proposal on ratification: rows
    #: in these states are never eligible, and when set, these columns are
    #: blanked instead of the row being deleted. Required on a sweeping rule for
    #: tables in :data:`NEVER_ELIGIBLE_STATES` / :data:`REDACT_INSTEAD_OF_DELETE`.
    exempt_states: frozenset[str] = frozenset()
    redact_columns: tuple[str, ...] = ()

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
    proposal: RetentionProposal | None = None,
) -> RetentionRule:
    """Rows live until their account is erased."""
    return RetentionRule(
        kind=RetentionKind.UNTIL_ACCOUNT_DELETION,
        trigger=_ACCOUNT_DELETION,
        rationale=rationale,
        soft_deleted=soft_deleted,
        ratified=ratified,
        proposal=proposal,
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


def proposed(rule: RetentionRule, proposal: RetentionProposal) -> RetentionRule:
    """``rule`` carrying ``proposal`` -- for constructors that take no ``proposal``."""
    return replace(rule, proposal=proposal)


def indefinite(
    reason: str, *, ratified: bool, proposal: RetentionProposal | None = None
) -> RetentionRule:
    """No bound exists. The reason is mandatory; ratification is the owner's."""
    if not reason.strip():
        msg = "an indefinite lifetime must state its reason"
        raise ValueError(msg)
    return RetentionRule(
        kind=RetentionKind.INDEFINITE,
        trigger="none",
        rationale=reason,
        ratified=ratified,
        proposal=proposal,
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
        proposal=RetentionProposal(
            days=PROPOSED_ERASURE_RECEIPT_DAYS,
            clock=ProposalClock.ROW_CREATED,
            compared_to_today=TodayComparison.SHORTER,
            trigger="the receipt's creation, at account deletion",
            rationale="Content-free and names nobody; as the restore tombstone it must "
            "outlive the oldest live backup copy, and a year still answers a support or "
            "regulator question about whether an erasure ran.",
        ),
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
    "energyplan": proposed(
        swept_by(
            ENERGY_PLAN_SWEEP,
            trigger="plan creation",
            days=ENERGY_PLAN_SWEEP_DAYS,
            rationale="Energy plans have no TTL; the operator sweep removes plans older than "
            "its window. The window is an internal default, not a published promise.",
            ratified=False,
        ),
        RetentionProposal(
            days=PROPOSED_ENERGY_PLAN_DAYS,
            clock=ProposalClock.ROW_CREATED,
            compared_to_today=TodayComparison.SHORTER,
            trigger="plan creation",
            rationale="A stored plan is re-read to answer a retried request with the same "
            "idempotency key, and it is included in the owner's export; a week covers any "
            "retry, and older plans would leave the export too (a plan is cheap to "
            "regenerate from the habits it was built from).",
        ),
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
        proposal=RetentionProposal(
            days=PROPOSED_SALE_EMAIL_DAYS,
            clock=ProposalClock.AFTER_ACCOUNT_DELETION,
            compared_to_today=TodayComparison.SHORTER,
            trigger="the sale's anonymisation at deletion of the account it was linked to",
            redact_columns=("email", "raw_payload"),
            requires_schema="gumroadsale.anonymised_at, stamped by account deletion on "
            "every sale linked to the account (token-pack credit or LicenseBinding); "
            "proposed, not built -- today the row records no deletion instant",
            rationale="Trade-off: after redaction a returning buyer can no longer be "
            "re-matched to the licence or pack they paid for. 180 days is assumed to "
            "cover typical refund and card-dispute windows (to confirm; some dispute "
            "codes run longer), and whether Gumroad's own record suffices, and how long "
            "the amounts must be kept for bookkeeping, are legal questions. A sale never "
            "linked to an account keeps its email, since that is its only claim path.",
        ),
    ),
    "habit": until_account_deletion("The account's habits."),
    "invitationsignal": until_account_deletion("Which invitations the account saw."),
    "journalentry": until_account_deletion(
        "The writing. A live entry lives until the account is erased.",
        soft_deleted=proposed(
            swept_by(
                JOURNAL_ENTRY_PURGE,
                trigger="soft delete",
                rationale="A soft-deleted entry (BUG-JOURNAL-007) is hidden from every read "
                "path but kept, with its derivatives, until account deletion or until an "
                "operator runs the purge. The purge refuses a window shorter than the "
                "age of the oldest live backup copy, has no default window, and nothing "
                "schedules it; both are owner decisions (#3063 AC15, AC18).",
                ratified=False,
            ),
            RetentionProposal(
                days=PROPOSED_SOFT_DELETED_ENTRY_DAYS,
                clock=ProposalClock.ROW_EVENT,
                compared_to_today=TodayComparison.SHORTER,
                trigger="soft delete",
                rationale="Kept only as the restore tombstone: purge (with its derivatives) "
                "as soon as no live backup copy can still hold the page undeleted -- "
                "exactly the purge's own floor, which falls only after copies kept under "
                "an older, longer backup retention have aged out.",
            ),
        ),
    ),
    "journalwithdrawalobligation": until_account_deletion(
        "Content-free obligation to withdraw a journal page's copy from a vault: "
        "``pending_delete`` while a requested deletion waits on the vault, "
        "``unconfirmed`` after the writer deleted the page here because the vault "
        "holding the copy was out of reach (#3094), ``confirmed`` once that vault "
        "confirmed absence. Not a foreign key into the entry, so a purge of the "
        "soft-deleted page never erases the record that a copy may remain. Erased "
        "with the account today; how long a confirmed or unconfirmed row is kept, and "
        "whether an unconfirmed one should outlive erasure, are owner decisions "
        "(#3063 AC21-22, #3094). Plan: docs/privacy/gdpr-erasure-unreachable-vaults.md.",
        ratified=False,
        proposal=RetentionProposal(
            days=PROPOSED_CONFIRMED_OBLIGATION_DAYS,
            clock=ProposalClock.ROW_EVENT,
            compared_to_today=TodayComparison.SHORTER,
            trigger="vault confirmation (confirmed rows only)",
            exempt_states=frozenset({"pending_delete", "unconfirmed"}),
            rationale="An open (pending_delete or unconfirmed) row is kept until its vault "
            "confirms the copy gone, because it must outlive the copy it tracks; once "
            "confirmed it is only a receipt, and 30 days answers a follow-up question.",
        ),
    ),
    "licensebinding": until_account_deletion("The claim tying a sale to this account."),
    "llmusagelog": until_account_deletion(
        "Per-request AI metering rows. Kept for the account's whole life; whether "
        "metering should expire sooner is an owner decision (#3063 AC15).",
        ratified=False,
        proposal=RetentionProposal(
            days=PROPOSED_USAGE_LOG_DAYS,
            clock=ProposalClock.ROW_CREATED,
            compared_to_today=TodayComparison.SHORTER,
            trigger="the metered call",
            rationale="Content-free cost rows; 90 days covers the 30-day cost-alert window "
            "and reconciliation against two monthly provider invoices. All-time admin "
            "totals would become 90-day totals.",
        ),
    ),
    "loginattempt": until_account_deletion(
        "Sign-in attempts with the typed address and IP. No expiry exists; a shorter "
        "lifetime is an owner decision (#3063 AC15). Attempts against an address that "
        "never had an account are swept by nothing.",
        ratified=False,
        proposal=RetentionProposal(
            days=PROPOSED_LOGIN_ATTEMPT_DAYS,
            clock=ProposalClock.ROW_CREATED,
            compared_to_today=TodayComparison.SHORTER,
            trigger="the attempt",
            rationale="A typed address and IP are personal data; lockout reads only the "
            "last 15 minutes, and 30 days is enough to investigate a credential-stuffing "
            "run (common security-log practice) -- for unknown addresses too.",
        ),
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
        proposal=RetentionProposal(
            days=PROPOSED_DEAD_SHARE_LINK_DAYS,
            clock=ProposalClock.ROW_EVENT,
            compared_to_today=TodayComparison.SHORTER,
            trigger="the link stopping working (expired, revoked or used up)",
            rationale="A dead link serves no recipient; 30 days lets the redeem endpoint "
            "keep saying 'expired' rather than 'not found' for a while. A live link with "
            "no expiry keeps working as today, because recipients may hold it.",
        ),
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
        proposal=RetentionProposal(
            days=PROPOSED_RESTORE_MARKER_DAYS,
            clock=ProposalClock.ROW_EVENT,
            compared_to_today=TodayComparison.SHORTER,
            trigger="the reapply completing (never while RESTORE_ID still names it)",
            exempt_states=frozenset({"in_progress"}),
            rationale="Names no person at all; it refuses a second reapply after cutover, "
            "a risk that does not fade with time, so a year covers any realistic "
            "follow-up and the startup gate must stop naming it first.",
        ),
    ),
    "revokedtoken": indefinite(
        "Opaque JWT ids and their expiry. Content-free, but nothing sweeps a row once "
        "its token has expired.",
        ratified=False,
        proposal=RetentionProposal(
            days=PROPOSED_REVOKED_TOKEN_GRACE_DAYS,
            clock=ProposalClock.ROW_EVENT,
            compared_to_today=TodayComparison.SHORTER,
            trigger="the revoked token's own expiry (expires_at)",
            rationale="Once a token has expired, decoding already rejects it on its expiry "
            "(exp) check, so the deny-list row protects nothing; one day absorbs clock skew.",
        ),
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
        proposal=RetentionProposal(
            days=PROPOSED_TEARDOWN_RECEIPT_DAYS,
            clock=ProposalClock.ROW_EVENT,
            compared_to_today=TodayComparison.SHORTER,
            trigger="teardown confirmation (an unconfirmed receipt stays until confirmed)",
            exempt_states=frozenset({"deleting", "failed"}),
            rationale="Content-free and names no account; once confirmed it only has to "
            "be reconciled against the vault vendor's invoices, which three monthly "
            "billing cycles cover.",
        ),
    ),
    "voicedraftretraction": until_account_deletion(
        "Content-free obligation to withdraw a mirrored essay from a vault. Erased with "
        "the account today; whether a pending obligation should outlive erasure, and "
        "what deadline it carries, is an owner decision (#3063 AC21-22). Never purged "
        "with a soft-deleted entry while unconfirmed.",
        ratified=False,
        proposal=RetentionProposal(
            days=PROPOSED_CONFIRMED_OBLIGATION_DAYS,
            clock=ProposalClock.ROW_EVENT,
            compared_to_today=TodayComparison.SHORTER,
            trigger="vault confirmation (confirmed rows only)",
            exempt_states=frozenset({"mirror_intent", "pending"}),
            rationale="As for journal pages: an unsettled row is kept until its vault "
            "confirms the essay gone, and it blocks the purge meanwhile; a confirmed row "
            "is only a receipt, kept 30 days.",
        ),
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


#: States whose rows a proposal must never make eligible, per table: an
#: unsettled obligation outlives the copy it tracks, an unconfirmed teardown may
#: still have a billable resource, an unfinished restore is still being guarded.
#: Literal strings because this module imports no model; a test pins each set
#: to its model's lifecycle.
NEVER_ELIGIBLE_STATES: Mapping[str, frozenset[str]] = {
    "journalwithdrawalobligation": frozenset({"pending_delete", "unconfirmed"}),
    "restoremarker": frozenset({"in_progress"}),
    "vaultteardownreceipt": frozenset({"deleting", "failed"}),
    "voicedraftretraction": frozenset({"mirror_intent", "pending"}),
}

#: Tables whose bounded lifetime blanks columns rather than deleting the row:
#: the purchase receipt stays, the buyer's identifiers go.
REDACT_INSTEAD_OF_DELETE: Mapping[str, tuple[str, ...]] = {
    "gumroadsale": ("email", "raw_payload"),
}

#: Every sweep window in this registry counts from row creation.
_WINDOW_CLOCK = ProposalClock.ROW_CREATED

#: Rule kinds under which something other than account deletion removes rows,
#: so a sweep's conditions must be stated on the rule itself.
_SWEEPING_KINDS = frozenset({RetentionKind.FIXED_DAYS, RetentionKind.SWEPT_BY})

_UNBOUNDED_TODAY = frozenset(
    {RetentionKind.UNTIL_ACCOUNT_DELETION, RetentionKind.INDEFINITE, RetentionKind.SWEPT_BY}
)


def _compare(proposed_days: int, today_days: int) -> TodayComparison:
    """How a proposed day count compares with a known one."""
    if proposed_days < today_days:
        return TodayComparison.SHORTER
    if proposed_days > today_days:
        return TodayComparison.LONGER
    return TodayComparison.SAME


def _compare_window(proposal: RetentionProposal, window_days: int) -> TodayComparison:
    """Compare with a creation-keyed window, or ``UNKNOWN`` on any other clock."""
    if proposal.clock is not _WINDOW_CLOCK:
        return TodayComparison.UNKNOWN
    return _compare(proposal.days, window_days)


def _dies_with_account(table: str, rule: RetentionRule) -> bool:
    """Whether today the rows go no later than their account's erasure."""
    if rule.kind is RetentionKind.UNTIL_ACCOUNT_DELETION:
        return True
    policy = POLICY.get(table)
    return policy is not None and policy.disposition is Disposition.ERASE


def implied_comparison(
    table: str, rule: RetentionRule, proposal: RetentionProposal
) -> TodayComparison:
    """What the rule and the proposal's clock imply about the comparison with today.

    * A clock that starts at account erasure, on rows that today die with their
      account, keeps them past erasure: longer -- whatever window applies today.
    * A known window (a sweep's days, counted from row creation) is compared
      number to number, but only with a proposal on the same clock; a proposal
      counted from another event cannot be compared and is unknown.
    * Any other finite proposal on a lifetime that is unbounded today (until
      account deletion, indefinite, or a sweep with no window) is shorter.
    """
    if proposal.clock is ProposalClock.AFTER_ACCOUNT_DELETION and _dies_with_account(table, rule):
        return TodayComparison.LONGER
    if rule.days is not None:
        return _compare_window(proposal, rule.days)
    if rule.kind in _UNBOUNDED_TODAY:
        return TodayComparison.SHORTER
    return TodayComparison.UNKNOWN


def _comparison_finding(name: str, table: str, rule: RetentionRule) -> str | None:
    """A finding when a proposal's declared comparison is not what the rule implies."""
    if rule.proposal is None:
        return None
    implied = implied_comparison(table, rule, rule.proposal)
    if implied is rule.proposal.compared_to_today:
        return None
    return (
        f"{name}: the proposal says it is {rule.proposal.compared_to_today.value} than "
        f"today, but the rule and its clock make it {implied.value}"
    )


def _exemption_finding(name: str, table: str, rule: RetentionRule) -> str | None:
    """A finding when a proposal would make a never-eligible state eligible."""
    required = NEVER_ELIGIBLE_STATES.get(table, frozenset())
    if rule.proposal is None or required <= rule.proposal.exempt_states:
        return None
    missing = sorted(required - rule.proposal.exempt_states)
    return f"{name}: the proposal would make rows in {missing} eligible; they must be exempt"


def _redaction_finding(name: str, table: str, rule: RetentionRule) -> str | None:
    """A finding when a proposal would delete rows that must only be redacted."""
    required = REDACT_INSTEAD_OF_DELETE.get(table)
    if rule.proposal is None or required is None or rule.proposal.redact_columns == required:
        return None
    return f"{name}: the proposal must redact {list(required)} rather than delete the row"


def _ratified_condition_findings(name: str, table: str, rule: RetentionRule) -> list[str]:
    """Findings when a sweeping rule lost the conditions its table requires.

    Ratification deletes the proposal, so the conditions must be carried into
    the rule itself; a plain ``fixed_days`` rule would expire open obligations
    or delete a receipt that should only be redacted.
    """
    if rule.kind not in _SWEEPING_KINDS:
        return []
    findings: list[str] = []
    required = NEVER_ELIGIBLE_STATES.get(table, frozenset())
    if not required <= rule.exempt_states:
        missing = sorted(required - rule.exempt_states)
        findings.append(f"{name}: the rule makes rows in {missing} eligible; they must be exempt")
    redact = REDACT_INSTEAD_OF_DELETE.get(table)
    if redact is not None and rule.redact_columns != redact:
        findings.append(f"{name}: the rule must redact {list(redact)} rather than delete the row")
    return findings


def _presence_finding(name: str, rule: RetentionRule) -> str | None:
    """A finding when an unratified rule lacks a proposal, or a ratified one keeps one."""
    if rule.proposal is None:
        return None if rule.ratified else f"{name} is unratified but carries no proposal"
    if rule.ratified:
        return f"{name} is ratified but still carries a proposal"
    return None


def _rule_findings(name: str, rule: RetentionRule) -> list[str]:
    """Every proposal finding for one rule (``name`` may carry a ``(soft-deleted)`` suffix)."""
    table = name.split(" ", 1)[0]
    found = (
        _presence_finding(name, rule),
        _comparison_finding(name, table, rule),
        _exemption_finding(name, table, rule),
        _redaction_finding(name, table, rule),
    )
    findings = [finding for finding in found if finding is not None]
    findings.extend(_ratified_condition_findings(name, table, rule))
    return findings


def proposal_findings() -> tuple[str, ...]:
    """Report proposals that are missing, stale, or misleading.

    * every rule the owner has not ratified carries a proposal, and a ratified
      rule keeps none;
    * each proposal's declared ``compared_to_today`` matches what the rule and
      the proposal's clock imply -- so one that keeps rows longer than today,
      including past their account's erasure, must say ``longer``;
    * no proposal, and no sweeping rule (ratified ones included), makes a
      never-eligible state (:data:`NEVER_ELIGIBLE_STATES`) eligible or deletes
      a row that must only be redacted (:data:`REDACT_INSTEAD_OF_DELETE`).
    """
    findings: list[str] = []
    for name, rule in _rules_with_nested():
        findings.extend(_rule_findings(name, rule))
    return tuple(findings)


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
        line = f"{name}: {_describe(rule)} [{flag}] -- trigger: {rule.trigger}"
        if rule.proposal is not None:
            unit = "day" if rule.proposal.days == 1 else "days"
            line += (
                f" -- proposed: {rule.proposal.days} {unit} after {rule.proposal.trigger}"
                f" [{rule.proposal.compared_to_today.value} than today]"
            )
        lines.append(line)
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
