"""Every place user data lives that is not a table in this database (#3063).

:mod:`domain.retention` covers the ORM schema, but a deleted account's writing
can also survive in a backup, a log line, a device cache, the Creek vault, or a
vendor's snapshot of that vault. None of those can be enumerated from a
``MetaData``, so they are listed here as data.

Each :class:`Store` names who controls the copy, how long it lives, and the
evidence for that claim. A deadline nobody has established is an
:class:`Unknown` carrying an *open question* that points at an issue, never a
blank: :func:`inventory_findings` reports an unknown without one.

The two backup legs' day counts are the constants
:data:`RAILWAY_PLATFORM_BACKUP_DAYS` and :data:`OFFHOST_DUMP_RETENTION_DAYS`,
pinned equal to the values ``DEPLOYMENT.md`` states by a drift test. Changing
either is a change to a retention promise and belongs to the owner (#3063 AC15).

A store whose deadline is unknown, and each backup leg (whose retention is
itself an owner decision, #3063 AC15), must carry a decision: a
:class:`RatifiedPeriod` the owner ratified, or none where no period is ours to
set; or, while undecided, a :class:`StoreProposal` for review (never both). On
2026-10-13 the owner ratified every proposed store period, so each such store
now carries a ratified period. A backup leg's ratified period is the runbook's
own retention, pinned by :func:`inventory_findings`; any other store's is the
decided target, which takes effect only once something applies it (a vendor
setting, a scheduled prune; #3063 AC18, AC19). The decision record is
``docs/privacy/retention-proposal.md``.

Data only: no I/O, no model, no session.
"""

from __future__ import annotations

import enum
import re
from dataclasses import dataclass
from typing import Final

#: Railway's Daily platform backup keeps each snapshot this long (DEPLOYMENT.md).
RAILWAY_PLATFORM_BACKUP_DAYS: Final = 6
#: The encrypted off-host ``pg_dump`` is kept this long (DEPLOYMENT.md). The owner
#: ratified 30 days on 2026-10-13 (#3063 AC15); it was 90.
OFFHOST_DUMP_RETENTION_DAYS: Final = 30

#: Railway's platform backup runs Daily (DEPLOYMENT.md).
RAILWAY_PLATFORM_BACKUP_INTERVAL_DAYS: Final = 1
#: The off-host dump is taken Weekly, by hand (DEPLOYMENT.md).
OFFHOST_DUMP_INTERVAL_DAYS: Final = 7


@dataclass(frozen=True)
class BackupLeg:
    """One leg of the database backup: how long a copy is kept, and how often one is made.

    A copy is pruned only on a run after it passes its retention, so the
    oldest copy alive can be up to ``retention_days + interval_days`` old.
    """

    key: str
    retention_days: int
    interval_days: int
    evidence: str

    @property
    def oldest_live_copy_days(self) -> int:
        """The greatest age a copy of this leg can reach before it is pruned."""
        return self.retention_days + self.interval_days


BACKUP_LEGS: tuple[BackupLeg, ...] = (
    BackupLeg(
        key="railway_platform_backup",
        retention_days=RAILWAY_PLATFORM_BACKUP_DAYS,
        interval_days=RAILWAY_PLATFORM_BACKUP_INTERVAL_DAYS,
        evidence="DEPLOYMENT.md 'What is backed up': Platform, Daily, 6 days; "
        "Railway expires its own backups",
    ),
    BackupLeg(
        key="offhost_pg_dump",
        retention_days=OFFHOST_DUMP_RETENTION_DAYS,
        interval_days=OFFHOST_DUMP_INTERVAL_DAYS,
        evidence="DEPLOYMENT.md 'What is backed up': Off-host, Weekly, 30 days; pruned "
        "by hand on each weekly run ('Taking an off-host dump', DRAFT prune step)",
    ),
)

#: The off-host retention the oldest dumps *still held* were written under.
#: Lowering :data:`OFFHOST_DUMP_RETENTION_DAYS` to the ratified 30 days did not
#: delete the dumps already kept for longer, so this stays at the old 90. It may
#: only be lowered -- in a separate, later change, the owner's -- once every dump
#: older than the new bound (new retention plus one interval, 37 days) has been
#: pruned. It is never below :data:`OFFHOST_DUMP_RETENTION_DAYS`.
HELD_OFFHOST_DUMP_RETENTION_DAYS: Final = 90
#: The age the oldest still-held copy can reach under that older retention.
HELD_BACKUP_BOUND_DAYS: Final = HELD_OFFHOST_DUMP_RETENTION_DAYS + OFFHOST_DUMP_INTERVAL_DAYS


def oldest_live_backup_days(legs: tuple[BackupLeg, ...], held_bound_days: int) -> int:
    """The oldest a live backup copy can be: today's legs, or copies held from before.

    Taking the maximum with ``held_bound_days`` is what keeps a ratified,
    shorter backup retention from lowering the journal purge floor while dumps
    kept under the longer one still exist.
    """
    return max(held_bound_days, *(leg.oldest_live_copy_days for leg in legs))


#: The oldest any live backup copy can be, provided each leg is pruned as
#: DEPLOYMENT.md says. Anything soft-deleted longer ago than this is held
#: *deleted* by every backup still alive.
OLDEST_LIVE_BACKUP_DAYS: Final = oldest_live_backup_days(BACKUP_LEGS, HELD_BACKUP_BOUND_DAYS)

#: The invalid-licence throttle evicts a key once its hourly window rolls off.
INVALID_LICENSE_THROTTLE_HOURS: Final = 1

# An open question must point somewhere a human tracks it.
_ISSUE_MARKER = re.compile(r"#\d+")


class Controller(enum.StrEnum):
    """Who can actually delete the copy."""

    ADEPTHOOD = "adepthood"
    RAILWAY = "railway"
    CREEK = "creek"
    FLY = "fly"
    MODEL_VENDOR = "model_vendor"
    USER = "user"


@dataclass(frozen=True)
class Days:
    """A known deadline, in days after the copy was made."""

    count: int

    def __post_init__(self) -> None:
        """Refuse a non-positive day count: it is a typo, not instant deletion."""
        if self.count <= 0:
            msg = f"a deadline must be a positive number of days, got {self.count}"
            raise ValueError(msg)


@dataclass(frozen=True)
class Hours:
    """A known sub-day deadline, in hours after the last write."""

    count: int

    def __post_init__(self) -> None:
        """Refuse a non-positive hour count."""
        if self.count <= 0:
            msg = f"a deadline must be a positive number of hours, got {self.count}"
            raise ValueError(msg)


@dataclass(frozen=True)
class Unknown:
    """No deadline is established; ``open_question`` says where that is tracked."""

    open_question: str


Deadline = Days | Hours | Unknown

#: A proposed store deadline; ``None`` where no period is ours to set.
ProposedDeadline = Days | Hours | None


class TodayComparison(enum.StrEnum):
    """How a proposal compares with what happens today."""

    SHORTER = "shorter"
    SAME = "same"
    LONGER = "longer"
    #: Today's period is not known (an unverified vendor default), so the
    #: proposal cannot be compared; the review table says so.
    UNKNOWN = "unknown"


# Store periods the owner ratified on 2026-10-13 (#3063 AC15; PR #3155, comment
# 6151018235). The two backup legs' are the constants above.
#: Content-free logs: at most this, or the vendor's current setting if shorter.
APPLICATION_LOG_RETENTION_DAYS: Final = 30
#: The vault is a mirror of the journal; a snapshot bridges one day.
FLY_SNAPSHOT_RETENTION_DAYS: Final = 1


@dataclass(frozen=True)
class RatifiedPeriod:
    """A store period the owner ratified (#3063 AC15).

    ``deadline`` is ``None`` where no time period is ours to set (the device, the
    user's own vault, a vendor's copy, or a copy that lives exactly until a
    verified withdrawal). On a backup leg it is the runbook's retention itself;
    elsewhere it is the decided target, which takes effect only once something
    applies it.
    """

    deadline: ProposedDeadline
    rationale: str

    def __post_init__(self) -> None:
        """Refuse a ratified period with no recorded reason."""
        if not self.rationale.strip():
            msg = "a ratified period must state its rationale"
            raise ValueError(msg)


@dataclass(frozen=True)
class StoreProposal:
    """A store deadline proposed for the owner to ratify (#3063 AC15). Never a deadline.

    ``deadline`` is ``None`` where no time period is ours to set (the device, the
    user's own vault, or a copy that lives exactly until a verified withdrawal).
    ``compared_to_today`` is declared and checked against the store's deadline
    today; an unknown deadline today makes a proposed period ``UNKNOWN``.
    """

    deadline: ProposedDeadline
    rationale: str
    compared_to_today: TodayComparison

    def __post_init__(self) -> None:
        """Refuse a proposal the owner could not review."""
        if not self.rationale.strip():
            msg = "a store proposal must state its rationale"
            raise ValueError(msg)


@dataclass(frozen=True)
class Store:
    """One non-database place a copy of user data can live."""

    key: str
    description: str
    controller: Controller
    deadline: Deadline
    evidence: str
    ratified: RatifiedPeriod | None = None
    proposal: StoreProposal | None = None


STORES: tuple[Store, ...] = (
    Store(
        key="railway_platform_backup",
        description="Railway's Daily volume backup of the whole Postgres database, "
        "including deleted accounts and soft-deleted entries as of the snapshot.",
        controller=Controller.RAILWAY,
        deadline=Days(RAILWAY_PLATFORM_BACKUP_DAYS),
        evidence="DEPLOYMENT.md 'What is backed up' (platform leg; enabling it is #3058)",
        ratified=RatifiedPeriod(
            deadline=Days(RAILWAY_PLATFORM_BACKUP_DAYS),
            rationale="Keep: Daily kept 6 days is already Railway's shortest schedule, and "
            "it is the leg that recovers from everyday mistakes.",
        ),
    ),
    Store(
        key="offhost_pg_dump",
        description="Encrypted off-host pg_dump of the whole database, taken manually.",
        controller=Controller.ADEPTHOOD,
        deadline=Days(OFFHOST_DUMP_RETENTION_DAYS),
        evidence="DEPLOYMENT.md 'What is backed up' (off-host leg)",
        ratified=RatifiedPeriod(
            deadline=Days(OFFHOST_DUMP_RETENTION_DAYS),
            rationale="Four weekly copies still cover a month of late-found damage or "
            "platform loss. Transition: the purge floor stays at the held 97-day bound "
            "until every dump kept under the 90-day retention has aged out and been "
            "pruned; only a later change lowers it, to 37.",
        ),
    ),
    Store(
        key="application_logs",
        description="Railway service logs and the error-monitoring inbox. Content-free "
        "by invariant (ids, counts, codes), but they name account ids.",
        controller=Controller.RAILWAY,
        deadline=Unknown("Railway log retention and Sentry retention unverified (#3064)"),
        evidence="backend/src/observability.py; DEPLOYMENT.md 'Logs'",
        ratified=RatifiedPeriod(
            deadline=Days(APPLICATION_LOG_RETENTION_DAYS),
            rationale="30 days or the vendor's current setting, whichever is shorter: "
            "content-free by invariant but names account ids, and 30 days is common "
            "security-log practice. Today's vendor retention is unverified, so this is "
            "the target until the vendor setting is checked and applied (#3064).",
        ),
    ),
    Store(
        key="invalid_license_throttle",
        description="In-memory rate-limit keys for invalid licence attempts, evicted "
        "once their last attempt rolls off the hourly window, and lost on restart.",
        controller=Controller.ADEPTHOOD,
        deadline=Hours(INVALID_LICENSE_THROTTLE_HOURS),
        evidence="backend/src/rate_limit.py; tests/test_invalid_license_retention.py",
    ),
    Store(
        key="client_device_cache",
        description="AsyncStorage / localStorage caches on the user's device, wiped "
        "when a different account signs in.",
        controller=Controller.USER,
        deadline=Unknown("device-controlled; no server-side deadline possible (#3063)"),
        evidence="frontend/src/storage/userScope.ts; frontend/src/context/AuthContext.tsx",
        ratified=RatifiedPeriod(
            deadline=None,
            rationale="Not ours to set: the device holds it, and it is wiped when another "
            "account signs in.",
        ),
    ),
    Store(
        key="creek_vault_volume",
        description="The managed Creek vault volume holding mirrored entries and essays.",
        controller=Controller.CREEK,
        deadline=Unknown("withdrawn per entry; account-wide teardown via #3063 AC21-22"),
        evidence="backend/src/services/account_deletion.py vault guidance",
        ratified=RatifiedPeriod(
            deadline=None,
            rationale="Event-bound, not time-bound: a copy lives until its verified "
            "withdrawal or the vault's teardown at account deletion.",
        ),
    ),
    Store(
        key="fly_volume_snapshots",
        description="Fly volume snapshots of the managed vault volume; whether they "
        "survive volume destroy is unverified vendor behaviour.",
        controller=Controller.FLY,
        deadline=Unknown("#3063 AC19: verify Fly snapshot survival after volume destroy"),
        evidence="Creek creek_mcp/provisioning/fly_pilot_config.py (snapshot_retention: 7)",
        ratified=RatifiedPeriod(
            deadline=Days(FLY_SNAPSHOT_RETENTION_DAYS),
            rationale="The vault mirrors the journal, so a snapshot only bridges a day; "
            "set the vendor's minimum (the pilot keeps 7) and destroy snapshots at "
            "teardown, subject to the AC19 vendor check (#3063).",
        ),
    ),
    Store(
        key="creek_embeddings_cache",
        description="Creek's embedding vectors derived from mirrored entries.",
        controller=Controller.CREEK,
        deadline=Unknown("verified absent per withdrawal; no account deadline (#3063)"),
        evidence="Creek creek_mcp/httpapi/journal.py _verified_absent",
        ratified=RatifiedPeriod(
            deadline=None,
            rationale="Event-bound: vectors go with their entry's verified withdrawal.",
        ),
    ),
    Store(
        key="creek_ledger",
        description="Creek's ingest ledger recording which entries reached the vault.",
        controller=Controller.CREEK,
        deadline=Unknown("verified absent per withdrawal; no account deadline (#3063)"),
        evidence="Creek creek_mcp/httpapi/journal.py _verified_absent",
        ratified=RatifiedPeriod(
            deadline=None,
            rationale="Event-bound: ledger rows go with their entry's verified withdrawal.",
        ),
    ),
    Store(
        key="model_vendor_copies",
        description="Prompts and completions held by the language-model provider.",
        controller=Controller.MODEL_VENDOR,
        deadline=Unknown("vendor retention to be established by #3065 (B11)"),
        evidence="docs/legal/privacy-policy.md model-provider section",
        ratified=RatifiedPeriod(
            deadline=None,
            rationale="The vendor's period, not ours; the owner deferred vendor fields to "
            "B11 (#3065).",
        ),
    ),
    Store(
        key="manual_vaults",
        description="A vault the user connected and operates themselves.",
        controller=Controller.USER,
        deadline=Unknown("user-controlled; Adepthood cannot purge it (#3063 AC24)"),
        evidence="backend/src/services/account_deletion.py VAULT_GUIDANCE_CONFIGURED",
        ratified=RatifiedPeriod(
            deadline=None,
            rationale="Not ours to set: the user operates the vault and decides.",
        ),
    ),
)


_BACKUP_KEYS = frozenset(leg.key for leg in BACKUP_LEGS)


def _count_comparison(today: int, proposed: int) -> TodayComparison:
    """How a proposed count compares with today's, in the same unit."""
    if proposed < today:
        return TodayComparison.SHORTER
    if proposed > today:
        return TodayComparison.LONGER
    return TodayComparison.SAME


def _same_unit_counts(today: Deadline, proposed: Days | Hours) -> tuple[int, int] | None:
    """``(today, proposed)`` counts when both deadlines share a unit, else None."""
    if type(today) is type(proposed) and isinstance(today, Days | Hours):
        return today.count, proposed.count
    return None


def implied_store_comparison(today: Deadline, proposed: ProposedDeadline) -> TodayComparison:
    """What today's deadline implies about a proposed one.

    No proposed period changes nothing (``SAME``); a period of the same unit is
    compared; anything against an unknown deadline cannot be compared.
    """
    if proposed is None:
        return TodayComparison.SAME
    counts = _same_unit_counts(today, proposed)
    if counts is None:
        return TodayComparison.UNKNOWN
    return _count_comparison(*counts)


def _missing_decision(store: Store) -> list[str]:
    """A finding when a store owes a decision: a backup leg, or an undecided deadline."""
    if store.key in _BACKUP_KEYS:
        return [
            (
                f"backup leg {store.key!r} carries neither a ratified period nor a proposal "
                "(its retention is AC15's)"
            )
        ]
    if isinstance(store.deadline, Unknown):
        return [
            (
                f"store {store.key!r} has an undecided deadline but neither a ratified "
                "period nor a proposal"
            )
        ]
    return []


def _ratified_findings(store: Store, ratified: RatifiedPeriod) -> list[str]:
    """Findings for a ratified store: a leftover proposal, or a leg the runbook disagrees with."""
    findings: list[str] = []
    if store.proposal is not None:
        findings.append(f"store {store.key!r} is ratified but still carries a proposal")
    if store.key in _BACKUP_KEYS and ratified.deadline != store.deadline:
        findings.append(
            f"backup leg {store.key!r} is ratified at {ratified.deadline} but the runbook "
            f"retention is {store.deadline}"
        )
    return findings


def _proposal_findings(store: Store) -> list[str]:
    """Findings for a store's decision: missing where owed, stale, or misdeclared."""
    if store.ratified is not None:
        return _ratified_findings(store, store.ratified)
    proposal = store.proposal
    if proposal is None:
        return _missing_decision(store)
    implied = implied_store_comparison(store.deadline, proposal.deadline)
    if implied is proposal.compared_to_today:
        return []
    declared = proposal.compared_to_today.value
    finding = (
        f"store {store.key!r} proposal says {declared} than today, but its deadlines "
        f"make it {implied.value}"
    )
    return [finding]


def _store_findings(store: Store) -> list[str]:
    """Findings for a single store's own fields."""
    findings: list[str] = []
    if not store.evidence.strip():
        findings.append(f"store {store.key!r} cites no evidence")
    deadline = store.deadline
    if isinstance(deadline, Unknown) and not _ISSUE_MARKER.search(deadline.open_question):
        findings.append(f"store {store.key!r} has an unknown deadline with no tracked question")
    findings.extend(_proposal_findings(store))
    return findings


def inventory_findings() -> tuple[str, ...]:
    """Report duplicated keys, evidence-free stores, untracked unknowns, and proposal gaps."""
    findings: list[str] = []
    seen: set[str] = set()
    for store in STORES:
        if store.key in seen:
            findings.append(f"duplicate store key {store.key!r}")
        seen.add(store.key)
        findings.extend(_store_findings(store))
    return tuple(findings)
