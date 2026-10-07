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

Data only: no I/O, no model, no session.
"""

from __future__ import annotations

import enum
import re
from dataclasses import dataclass
from typing import Final

#: Railway's Daily platform backup keeps each snapshot this long (DEPLOYMENT.md).
RAILWAY_PLATFORM_BACKUP_DAYS: Final = 6
#: The encrypted off-host ``pg_dump`` is kept this long (DEPLOYMENT.md).
OFFHOST_DUMP_RETENTION_DAYS: Final = 90

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
        evidence="DEPLOYMENT.md 'What is backed up': Off-host, Weekly, 90 days; pruned "
        "by hand on each weekly run ('Taking an off-host dump', DRAFT prune step)",
    ),
)

#: The oldest any live backup copy can be, provided each leg is pruned as
#: DEPLOYMENT.md says. Anything soft-deleted longer ago than this is held
#: *deleted* by every backup still alive.
OLDEST_LIVE_BACKUP_DAYS: Final = max(leg.oldest_live_copy_days for leg in BACKUP_LEGS)

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


@dataclass(frozen=True)
class Store:
    """One non-database place a copy of user data can live."""

    key: str
    description: str
    controller: Controller
    deadline: Deadline
    evidence: str


STORES: tuple[Store, ...] = (
    Store(
        key="railway_platform_backup",
        description="Railway's Daily volume backup of the whole Postgres database, "
        "including deleted accounts and soft-deleted entries as of the snapshot.",
        controller=Controller.RAILWAY,
        deadline=Days(RAILWAY_PLATFORM_BACKUP_DAYS),
        evidence="DEPLOYMENT.md 'What is backed up' (platform leg; enabling it is #3058)",
    ),
    Store(
        key="offhost_pg_dump",
        description="Encrypted off-host pg_dump of the whole database, taken manually.",
        controller=Controller.ADEPTHOOD,
        deadline=Days(OFFHOST_DUMP_RETENTION_DAYS),
        evidence="DEPLOYMENT.md 'What is backed up' (off-host leg)",
    ),
    Store(
        key="application_logs",
        description="Railway service logs and the error-monitoring inbox. Content-free "
        "by invariant (ids, counts, codes), but they name account ids.",
        controller=Controller.RAILWAY,
        deadline=Unknown("Railway log retention and Sentry retention unverified (#3064)"),
        evidence="backend/src/observability.py; DEPLOYMENT.md 'Logs'",
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
    ),
    Store(
        key="creek_vault_volume",
        description="The managed Creek vault volume holding mirrored entries and essays.",
        controller=Controller.CREEK,
        deadline=Unknown("withdrawn per entry; account-wide teardown via #3063 AC21-22"),
        evidence="backend/src/services/account_deletion.py vault guidance",
    ),
    Store(
        key="fly_volume_snapshots",
        description="Fly volume snapshots of the managed vault volume; whether they "
        "survive volume destroy is unverified vendor behaviour.",
        controller=Controller.FLY,
        deadline=Unknown("#3063 AC19: verify Fly snapshot survival after volume destroy"),
        evidence="Creek creek_mcp/provisioning/fly_pilot_config.py (snapshot_retention: 7)",
    ),
    Store(
        key="creek_embeddings_cache",
        description="Creek's embedding vectors derived from mirrored entries.",
        controller=Controller.CREEK,
        deadline=Unknown("verified absent per withdrawal; no account deadline (#3063)"),
        evidence="Creek creek_mcp/httpapi/journal.py _verified_absent",
    ),
    Store(
        key="creek_ledger",
        description="Creek's ingest ledger recording which entries reached the vault.",
        controller=Controller.CREEK,
        deadline=Unknown("verified absent per withdrawal; no account deadline (#3063)"),
        evidence="Creek creek_mcp/httpapi/journal.py _verified_absent",
    ),
    Store(
        key="model_vendor_copies",
        description="Prompts and completions held by the language-model provider.",
        controller=Controller.MODEL_VENDOR,
        deadline=Unknown("vendor retention to be established by #3065 (B11)"),
        evidence="docs/legal/privacy-policy.md model-provider section",
    ),
    Store(
        key="manual_vaults",
        description="A vault the user connected and operates themselves.",
        controller=Controller.USER,
        deadline=Unknown("user-controlled; Adepthood cannot purge it (#3063 AC24)"),
        evidence="backend/src/services/account_deletion.py VAULT_GUIDANCE_CONFIGURED",
    ),
)


def _store_findings(store: Store) -> list[str]:
    """Findings for a single store's own fields."""
    findings: list[str] = []
    if not store.evidence.strip():
        findings.append(f"store {store.key!r} cites no evidence")
    deadline = store.deadline
    if isinstance(deadline, Unknown) and not _ISSUE_MARKER.search(deadline.open_question):
        findings.append(f"store {store.key!r} has an unknown deadline with no tracked question")
    return findings


def inventory_findings() -> tuple[str, ...]:
    """Report duplicated keys, evidence-free stores, and untracked unknowns."""
    findings: list[str] = []
    seen: set[str] = set()
    for store in STORES:
        if store.key in seen:
            findings.append(f"duplicate store key {store.key!r}")
        seen.add(store.key)
        findings.extend(_store_findings(store))
    return tuple(findings)
