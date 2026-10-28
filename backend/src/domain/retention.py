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
  and :func:`unratified_rules` is the worklist. On 2026-10-13 the owner
  ratified every lifetime that was open, so the worklist is empty;
* ``proposal``: on an unratified rule, the lifetime proposed for the owner to
  ratify -- a day count, the event it counts from, and a one-line rationale
  (:class:`RetentionProposal`). A proposal is a value for review, **never** a
  window: no sweep, purge or route reads it, and a test pins that. Ratifying a
  rule means writing its proposal into the rule itself, copying its
  conditions (``exempt_states``, ``redact_columns``) onto the rule, and
  dropping the proposal. :func:`proposal_findings` keeps every unratified rule
  proposed, and every sweeping rule carrying its table's conditions. The
  decision record is ``docs/privacy/retention-proposal.md``.

A ratified ``fixed_days`` period is the decided lifetime. A period an operator
sweep route also serves is ``swept_by`` that route, with the ratified window as
its default. Every bounded rule names what applies it on a schedule
(``applied_by``): the nightly retention sweep, ``backend/scripts/retention_sweep.py``,
run by a Railway cron service (#3266, #3063 AC18). :func:`nightly_rules` is the
list that sweep must cover, and a test holds the two equal.

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
#: Ratified 2026-10-13: a week covers any retried request (#3063 AC15).
ENERGY_PLAN_SWEEP_DAYS = 7
#: Mirrors ``models.feedback.FEEDBACK_RETENTION_DAYS``; pinned equal by test.
FEEDBACK_SWEEP_DAYS = 180

ENERGY_PLAN_SWEEP = "POST /admin/maintenance/energy-plans"
FEEDBACK_SWEEP = "POST /admin/maintenance/feedback-reports"
JOURNAL_ENTRY_PURGE = "POST /admin/maintenance/journal-entries"

#: What applies every bounded rule on a schedule (#3266): the one entrypoint a
#: Railway cron service runs nightly (DEPLOYMENT.md, "Nightly retention sweep").
NIGHTLY_RETENTION_SWEEP = "the nightly retention sweep (scripts.retention_sweep)"

# Lifetimes the owner ratified on 2026-10-13 (#3063 AC15; PR #3155, comment
# 6151018235), each as proposed. Rationales live on the rules below and in
# docs/privacy/retention-proposal.md.
#: An erasure receipt must outlive every backup (it is the restore tombstone)
#: and still answer "did the erasure run?" for a year.
ERASURE_RECEIPT_RETENTION_DAYS = 365
#: An anonymised purchase receipt is kept for an assumed dispute window after
#: its buyer's identifiers are blanked at account deletion.
ANONYMISED_SALE_RETENTION_DAYS = 180
#: A soft-deleted page is kept exactly as long as some live backup may still
#: hold it undeleted -- the journal purge's own floor. That bound includes the
#: copies that may still be held from the retired off-host leg
#: (``retention_stores.HELD_BACKUP_BOUND_DAYS``), so retiring that leg does not
#: lower it until no such copy is held.
SOFT_DELETED_ENTRY_RETENTION_DAYS = OLDEST_LIVE_BACKUP_DAYS
#: A confirmed withdrawal record is a short-lived receipt.
CONFIRMED_OBLIGATION_RETENTION_DAYS = 30
#: Metering covers the cost-alert window plus provider invoice reconciliation.
USAGE_LOG_RETENTION_DAYS = 90
#: Sign-in attempts serve lockout (15 minutes) and short abuse investigation.
LOGIN_ATTEMPT_RETENTION_DAYS = 30
#: A share link that stopped working is kept briefly, then removed.
DEAD_SHARE_LINK_RETENTION_DAYS = 30
#: A restore marker guards one restore's reapply.
RESTORE_MARKER_RETENTION_DAYS = 365
#: A revoked token's row is useless once the token itself has expired.
REVOKED_TOKEN_GRACE_DAYS = 1
#: A confirmed teardown receipt spans a few vendor billing cycles.
TEARDOWN_RECEIPT_RETENTION_DAYS = 90
#: A detached withdrawal note outlives its erased account until the vault
#: confirms the copy gone, and never longer than this. Owner decision
#: 2026-10-14 (#3267): "Keep a detached note (opaque vault fingerprint and entry
#: ID only) until the vault confirms, for at most 97 days." A literal on
#: purpose: it was ratified as a number, not as the backup bound, so lowering
#: that bound does not shorten it.
DETACHED_WITHDRAWAL_NOTE_RETENTION_DAYS = 97

_ACCOUNT_DELETION = "account deletion"
_SWEEP_ROUTE = re.compile(r"^(GET|POST|PUT|PATCH|DELETE) /\S+$")


class RetentionKind(enum.StrEnum):
    """The shape of one table's lifetime."""

    #: Rows live until the owning account is erased, and no longer.
    UNTIL_ACCOUNT_DELETION = "until_account_deletion"
    #: Rows live a fixed number of days after the trigger: a ratified period
    #: with no operator route of its own. ``applied_by`` names the scheduled
    #: sweep that applies it (#3266).
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
    #: The scheduled job that applies this lifetime, or ``None`` when nothing
    #: does yet. Set through :func:`nightly`.
    applied_by: str | None = None

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


def conditional(
    rule: RetentionRule,
    *,
    exempt_states: frozenset[str] = frozenset(),
    redact_columns: tuple[str, ...] = (),
) -> RetentionRule:
    """``rule`` under a sweep's conditions, copied from its proposal on ratification.

    Rows in ``exempt_states`` are never eligible; ``redact_columns``, when set,
    are blanked when the clock starts and the receipt itself kept for the period.
    """
    return replace(rule, exempt_states=exempt_states, redact_columns=redact_columns)


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


def nightly(rule: RetentionRule) -> RetentionRule:
    """``rule``, applied every night by :data:`NIGHTLY_RETENTION_SWEEP` (#3266)."""
    return replace(rule, applied_by=NIGHTLY_RETENTION_SWEEP)


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


_RATIFIED = " Ratified 2026-10-13 (#3063 AC15)."

_DERIVED_FROM_ENTRY = (
    " Rows anchored to a soft-deleted entry live as long as that entry does (see "
    "journalentry's soft-deleted rule): the soft delete hides them, and only the operator "
    "purge or account deletion removes them."
)

# --------------------------------------------------------------------------
# The registry. One explicit entry per table, alphabetical for review.
# --------------------------------------------------------------------------
RETENTION: Mapping[str, RetentionRule] = {
    "accountdeletionaudit": nightly(
        fixed_days(
            ERASURE_RECEIPT_RETENTION_DAYS,
            trigger="the receipt's creation, at account deletion",
            rationale="The content-free receipt that an erasure ran (surrogate id, instant, "
            "row counts). It names nobody; as the account tombstone a restore is suppressed "
            "with, it must outlive the oldest live backup copy, and a year still answers a "
            "support or regulator question about whether an erasure ran. Where the "
            "tombstone file itself is kept is still open (#3063 AC17)." + _RATIFIED,
            ratified=True,
        )
    ),
    "adminbalanceadjustment": until_account_deletion(
        "The operator paper trail for corrections to the account's wallet. If "
        "the operator leaves first, their identity and source address are "
        "cleared while the target's content-free financial trail survives.",
    ),
    "agent_grant": until_account_deletion(
        "Which vault agents the account approved, with their grants and the moment each "
        "was last used or revoked: the account's own standing decisions (#3532)."
    ),
    "authidentity": until_account_deletion("Social sign-in links of a live account."),
    "completionsuggestion": until_account_deletion(
        "Suggestions derived from the account's own entries." + _DERIVED_FROM_ENTRY,
    ),
    "contentcompletion": until_account_deletion("Which chapters the account marked read."),
    "corpusclassificationattempt": until_account_deletion(
        "Content-free counts of the classifications the app paid for on this account's "
        "behalf — an account and an instant, nothing from the writing. Kept for the "
        "account's life rather than swept on a clock: the daily bound only ever reads "
        "today's rows, but an operator asking what a deployment spent on somebody's "
        "behalf is asking across months, and a sweep would answer that question with a "
        "window instead of a number.",
    ),
    "corpusconsentevent": until_account_deletion("The account's ontology consent decisions."),
    "corpusfragment": until_account_deletion(
        "The account's ontologized corpus. A fragment is also withdrawn the moment its "
        "entry is deleted or made Intimate.",
    ),
    "corpusinvitationstate": until_account_deletion("Corpus invitation state."),
    "corpussweep": until_account_deletion("Content-free counts of corpus grants."),
    "coursestage": shared_catalogue("The shared 36-week curriculum."),
    "energyplan": nightly(
        swept_by(
            ENERGY_PLAN_SWEEP,
            trigger="plan creation",
            days=ENERGY_PLAN_SWEEP_DAYS,
            rationale="A stored plan is re-read to answer a retried request with the same "
            "idempotency key, and it is included in the owner's export; a week covers any "
            "retry, and older plans leave the export too (a plan is cheap to regenerate "
            "from the habits it was built from). The operator sweep's default window is "
            "the ratified week, and the nightly sweep runs it." + _RATIFIED,
        )
    ),
    "entitlement": until_account_deletion("The account's course access grant."),
    "feedbacknote": nightly(
        swept_by(
            FEEDBACK_SWEEP,
            trigger="report submission",
            days=FEEDBACK_SWEEP_DAYS,
            rationale="An operator note goes with the report it describes, in the same sweep.",
        )
    ),
    "feedbackreport": nightly(
        swept_by(
            FEEDBACK_SWEEP,
            trigger="report submission",
            days=FEEDBACK_SWEEP_DAYS,
            rationale="The published 180-day window, applied by the nightly sweep.",
        )
    ),
    "feedbacktriageevent": nightly(
        swept_by(
            FEEDBACK_SWEEP,
            trigger="report submission",
            days=FEEDBACK_SWEEP_DAYS,
            rationale="A report's triage trail goes with the report, in the same sweep.",
        )
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
    "goallogevent": until_account_deletion("Every timestamped unit change the account logged."),
    "gumroadsale": nightly(
        conditional(
            fixed_days(
                ANONYMISED_SALE_RETENTION_DAYS,
                trigger="gumroadsale.anonymised_at, stamped when account deletion blanks a sale "
                "linked to the deleted account (its licence binding or token-pack credit)",
                rationale="A purchase receipt. At account deletion the buyer's email and "
                "Gumroad's raw payload are blanked on every linked sale and the receipt kept, "
                "180 days from that instant. Trade-off: after redaction a returning buyer can "
                "no longer be re-matched by address to the licence or pack they paid for (the "
                "licence key still reclaims a licence). 180 days is assumed to cover typical "
                "refund and card-dispute windows; the owner ratified it with the legal and "
                "bookkeeping questions still to confirm. A sale never linked to an account "
                "keeps its email, since that is its only claim path, and is never stamped."
                + _RATIFIED,
                ratified=True,
            ),
            redact_columns=("email", "raw_payload"),
        )
    ),
    "habit": until_account_deletion("The account's habits."),
    "invitationsignal": until_account_deletion("Which invitations the account saw."),
    "journalentry": until_account_deletion(
        "The writing. A live entry lives until the account is erased.",
        soft_deleted=nightly(
            swept_by(
                JOURNAL_ENTRY_PURGE,
                trigger="soft delete",
                days=SOFT_DELETED_ENTRY_RETENTION_DAYS,
                rationale="A soft-deleted entry (BUG-JOURNAL-007) is hidden from every read "
                "path and kept only as the restore tombstone: the purge removes it, with its "
                "derivatives, once no live backup copy can still hold the page undeleted -- "
                "the purge's own floor, which falls only after copies kept under an older, "
                "longer backup retention have aged out. That window is the purge's default, "
                "and the nightly sweep runs the purge on it." + _RATIFIED,
            )
        ),
    ),
    "journalwithdrawalnote": nightly(
        fixed_days(
            DETACHED_WITHDRAWAL_NOTE_RETENTION_DAYS,
            trigger="detachment at account deletion (deleted sooner when its vault confirms)",
            rationale="Detached, content-free note that a deleted account's journal page "
            "still has an unconfirmed vault copy: the vault's opaque fingerprint, the entry id "
            "and the detachment instant; no account link and no content. Kept until that vault "
            "confirms the copy gone, for at most 97 days, confirmed or not. Longer than before "
            "on purpose: the obligation it replaces died with the account. Ratified 2026-10-14 "
            "(#3267); the nightly sweep applies the 97 days.",
            ratified=True,
        )
    ),
    "journalwithdrawalobligation": nightly(
        conditional(
            fixed_days(
                CONFIRMED_OBLIGATION_RETENTION_DAYS,
                trigger="vault confirmation (confirmed rows only)",
                rationale="Content-free obligation to withdraw a journal page's copy from a vault: "
                "``pending_delete`` while a requested deletion waits on the vault, "
                "``unconfirmed`` after the writer deleted the page here because the vault "
                "holding the copy was out of reach (#3094), ``confirmed`` once that vault "
                "confirmed absence. Not a foreign key into the entry, so a purge of the "
                "soft-deleted page never erases the record that a copy may remain. An open row "
                "is never eligible: it must outlive the copy it tracks. A confirmed row is only "
                "a receipt, kept 30 days. Every row is still erased with the account; an open one "
                "is first copied into a detached ``journalwithdrawalnote`` (#3267). Plan: "
                "docs/privacy/gdpr-erasure-unreachable-vaults.md." + _RATIFIED,
                ratified=True,
            ),
            exempt_states=frozenset({"pending_delete", "unconfirmed"}),
        )
    ),
    "licensebinding": until_account_deletion("The claim tying a sale to this account."),
    "llmusagelog": nightly(
        fixed_days(
            USAGE_LOG_RETENTION_DAYS,
            trigger="the metered call",
            rationale="Per-request AI metering rows, content-free; 90 days covers the 30-day "
            "cost-alert window and reconciliation against two monthly provider invoices. "
            "Accepted side effect: the all-time admin totals become 90-day totals." + _RATIFIED,
            ratified=True,
        )
    ),
    "loginattempt": nightly(
        fixed_days(
            LOGIN_ATTEMPT_RETENTION_DAYS,
            trigger="the attempt",
            rationale="Sign-in attempts with the typed address and IP, which are personal "
            "data. Lockout reads only the last 15 minutes, and 30 days is enough to "
            "investigate a credential-stuffing run (common security-log practice). Applies "
            "to attempts against an address that never had an account too." + _RATIFIED,
            ratified=True,
        )
    ),
    "marginalia": until_account_deletion(
        "Margin notes on the account's entries, encrypted at rest." + _DERIVED_FROM_ENTRY,
    ),
    "mettareturnarc": until_account_deletion("The account's return arcs."),
    "mettareturnhabitrelease": until_account_deletion("Habits released during an arc."),
    "mettareturnofferdismissal": until_account_deletion("Return offers waved away."),
    "oauth_authorization_code": until_account_deletion(
        "Digests of one-time codes, each spendable once and for sixty seconds, so a row "
        "outlives its use as a spent or expired receipt and nothing more (#3532). A "
        "sweep of spent and expired codes belongs with the token endpoint that spends "
        "them (#3533)."
    ),
    "oauth_client": shared_catalogue(
        "The anonymous registry of vault agents: what each said about itself when it "
        "registered or last published its metadata. No row names an account (#3532)."
    ),
    "oauth_refresh_token": until_account_deletion(
        "Digests of agents' refresh tokens, each live thirty days and rotated on use; a "
        "rotated or revoked row is kept so presenting it again is recognised as reuse "
        "(#3533). A nightly sweep of rows past their own expiry, like revokedtoken's, "
        "is an owner retention decision not yet taken."
    ),
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
    "practicesharelink": nightly(
        fixed_days(
            DEAD_SHARE_LINK_RETENTION_DAYS,
            trigger="the link stopping working (expired, revoked or used up)",
            rationale="A share link survives its creator's deletion, anonymised, because "
            "recipients may hold the URL. A dead link serves no recipient; 30 days lets the "
            "redeem endpoint keep saying 'expired' rather than 'not found' for a while. A "
            "live link with no expiry never stops working, so it is kept." + _RATIFIED,
            ratified=True,
        )
    ),
    "practicetag": until_account_deletion("Tags the account defined."),
    "promotedquote": until_account_deletion(
        "Passages promoted out of the account's entries, encrypted at rest." + _DERIVED_FROM_ENTRY,
    ),
    "promptdismissal": until_account_deletion("Prompts the account set aside."),
    "promptresponse": until_account_deletion("Answers to the weekly prompts."),
    "resourcecompletion": until_account_deletion(
        "Which Start Here resources the account marked read."
    ),
    "restoremarker": nightly(
        conditional(
            fixed_days(
                RESTORE_MARKER_RETENTION_DAYS,
                trigger="the reapply completing (never while RESTORE_ID still names it)",
                rationale="Content-free operator record of each restore's reapply; it names no "
                "person at all. It refuses a second reapply after cutover, a risk that does not "
                "fade with time, so a year covers any realistic follow-up. An in_progress marker "
                "is never eligible, and nor is one the startup gate's RESTORE_ID still names."
                + _RATIFIED,
                ratified=True,
            ),
            exempt_states=frozenset({"in_progress"}),
        )
    ),
    "revokedtoken": nightly(
        fixed_days(
            REVOKED_TOKEN_GRACE_DAYS,
            trigger="the revoked token's own expiry (expires_at)",
            rationale="Opaque JWT ids and their expiry, content-free. Once a token has "
            "expired, decoding already rejects it on its expiry (exp) check, so the "
            "deny-list row protects nothing; one day absorbs clock skew." + _RATIFIED,
            ratified=True,
        )
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
    "vaultteardownreceipt": nightly(
        conditional(
            fixed_days(
                TEARDOWN_RECEIPT_RETENTION_DAYS,
                trigger="teardown confirmation (an unconfirmed receipt stays until confirmed)",
                rationale="Detached, content-free Creek teardown receipt kept so operations can "
                "prove no billable allocation survived; it names no account. Once confirmed it "
                "only has to be reconciled against the vault vendor's invoices, which three "
                "monthly billing cycles cover. A deleting or failed receipt is never eligible."
                + _RATIFIED,
                ratified=True,
            ),
            exempt_states=frozenset({"deleting", "failed"}),
        )
    ),
    "voicedraftretraction": nightly(
        conditional(
            fixed_days(
                CONFIRMED_OBLIGATION_RETENTION_DAYS,
                trigger="vault confirmation (confirmed rows only)",
                rationale="Content-free obligation to withdraw a mirrored essay from a vault. As "
                "for journal pages: an unsettled row is kept until its vault confirms the essay "
                "gone, and it blocks the purge meanwhile; a confirmed row is only a receipt, kept "
                "30 days. Every row is still erased with the account; whether a pending one "
                "should outlive erasure is open (#3063 AC21-22)." + _RATIFIED,
                ratified=True,
            ),
            exempt_states=frozenset({"mirror_intent", "pending"}),
        )
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


def nightly_rules() -> Mapping[str, RetentionRule]:
    """Every rule (soft-delete sub-rules included) the nightly sweep must apply."""
    return {
        name: rule
        for name, rule in _rules_with_nested()
        if rule.applied_by == NIGHTLY_RETENTION_SWEEP
    }


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

#: Tables whose identifying columns are blanked when the lifetime's clock starts,
#: rather than the row deleted then: the purchase receipt stays, the buyer's
#: identifiers go (``services.account_deletion`` blanks them at erasure).
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
    """One rule as ``kind[, N days][, via route][, applied by job]``.

    A bounded period that nothing applies on a schedule is flagged as such.
    """
    parts = [rule.kind.value]
    if rule.days is not None:
        parts.append(f"{rule.days} days")
    if rule.sweep_route is not None:
        parts.append(f"via {rule.sweep_route}")
    if rule.applied_by is not None:
        parts.append(f"applied by {rule.applied_by}")
    elif rule.is_bounded():
        parts.append("no sweep applies it yet (#3063 AC18)")
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
# Restore-suppression tombstones (#3063 AC9-10, #3214).
#
# Restoring a backup older than a deletion brings the deleted rows back, and
# the record of the deletion comes back without it. Every column that records a
# deletion is therefore either exported as a tombstone before a restore, or
# exempt with a written reason. :func:`tombstone_gaps` keeps that total.
#
# Two requests a restore would also forget are not deletion stamps, and are
# exported the same way: an Intimate reclassification (the page's tier) and a
# withdrawal still owed to a vault (an open ``journalwithdrawalobligation``
# row). Either, lost, lets a page the writer withdrew circulate again (#3214).
# --------------------------------------------------------------------------

#: The column name every soft-delete stamp in this schema uses.
SOFT_DELETE_COLUMN = "deleted_at"


class TombstoneKind(enum.StrEnum):
    """Which request a tombstone source records."""

    ACCOUNT = "account"
    ENTRY = "entry"
    INTIMATE = "intimate"
    OBLIGATION = "obligation"


@dataclass(frozen=True)
class TombstoneSource:
    """A table whose rows record a request, the column that records it, and what is exported.

    ``stamp`` is the column whose value *is* the request: a ``deleted_at``
    instant, the Intimate tier, an obligation's open state. ``columns`` are the
    other content-free columns the tombstone carries.
    """

    table: str
    columns: tuple[str, ...]
    stamp: str = SOFT_DELETE_COLUMN


TOMBSTONE_SOURCES: Mapping[TombstoneKind, TombstoneSource] = {
    # The deletion receipt is the account tombstone: surrogate id and instant.
    TombstoneKind.ACCOUNT: TombstoneSource(
        table="accountdeletionaudit",
        columns=("user_id",),
    ),
    # A soft-deleted entry: its id, owner, creation stamp and instant of deletion.
    TombstoneKind.ENTRY: TombstoneSource(
        table="journalentry",
        columns=("id", "user_id", "timestamp"),
    ),
    # A live Intimate entry: its id, owner and creation stamp; the tier is the request.
    TombstoneKind.INTIMATE: TombstoneSource(
        table="journalentry",
        columns=("id", "user_id", "timestamp"),
        stamp="classification",
    ),
    # An owed vault withdrawal: the entry, its owner, and the opaque fingerprint
    # of the vault holding the copy (never its URL); the open state is the
    # request. The entry's creation stamp is joined from ``journalentry``.
    TombstoneKind.OBLIGATION: TombstoneSource(
        table="journalwithdrawalobligation",
        columns=("journal_entry_id", "user_id", "destination"),
        stamp="state",
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
        f"{source.table}.{column}"
        for source in TOMBSTONE_SOURCES.values()
        for column in (*source.columns, source.stamp)
    ]
    named.extend(TOMBSTONE_EXEMPT)
    return [(qualified, _present(metadata, qualified)) for qualified in dict.fromkeys(named)]


def tombstone_gaps(metadata: MetaData) -> tuple[str, ...]:
    """Report requests no tombstone covers, and stale declarations.

    A ``deleted_at`` column that is neither a source's stamp nor exempt is a
    deletion a restore would silently undo. A kind with no source is a request
    the export would forget (#3214). A declared column missing from the schema
    means the export would read something that is not there.
    """
    return _uncovered_stamps(metadata) + _unsourced_kinds() + _stale_declarations(metadata)


def _uncovered_stamps(metadata: MetaData) -> tuple[str, ...]:
    """``deleted_at`` columns that are neither a source's stamp nor exempt."""
    covered = {f"{source.table}.{source.stamp}" for source in TOMBSTONE_SOURCES.values()}
    covered |= set(TOMBSTONE_EXEMPT)
    return tuple(
        f"{qualified} records a deletion but is neither a tombstone source nor exempt"
        for qualified in sorted(_stamp_columns(metadata) - covered)
    )


def _unsourced_kinds() -> tuple[str, ...]:
    """Tombstone kinds the registry gives no source."""
    return tuple(
        f"tombstone kind {kind.value} has no source"
        for kind in TombstoneKind
        if kind not in TOMBSTONE_SOURCES
    )


def _stale_declarations(metadata: MetaData) -> tuple[str, ...]:
    """Declared columns the schema no longer has."""
    return tuple(
        f"{qualified} is declared for tombstones but is not in the schema"
        for qualified, present in _declared_columns(metadata)
        if not present
    )


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
