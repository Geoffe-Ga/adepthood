"""The deletion copy states the backup window ``DEPLOYMENT.md`` documents (#3057, #3063 AC16).

Deleting an account removes it from the live database at once, but every
backup taken before the deletion still holds a copy until that backup ages out.
The user-facing copy used to call deletion "immediate and irreversible" and
"total" with no word about backups. It now says how long the last copy can
survive, and that number is derived here from the backup table in
``DEPLOYMENT.md`` rather than transcribed:

* each leg's oldest live copy is its retention plus the gap between runs,
  since a copy is pruned only on a run after it expires -- Daily 6 days gives
  7, Weekly 90 days gives 97;
* the copy names the larger of the two, so lengthening either leg's retention
  or slowing its schedule fails here until the copy is rewritten with it.

B08's ``domain.retention_stores`` (#3063) carries the same figures as
``RAILWAY_PLATFORM_BACKUP_DAYS = 6``, ``OFFHOST_DUMP_RETENTION_DAYS = 90`` and
``OLDEST_LIVE_BACKUP_DAYS = 97``, each pinned to this same table by its own
drift test, so the copy and those constants read one source.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Final

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEPLOYMENT_DOC = _REPO_ROOT / "DEPLOYMENT.md"
_PRIVACY_POLICY = _REPO_ROOT / "docs" / "legal" / "privacy-policy.md"
_TERMS_OF_SERVICE = _REPO_ROOT / "docs" / "legal" / "terms-of-service.md"
_YOUR_DATA = _REPO_ROOT / "docs" / "your-data.md"
_DELETE_ACCOUNT_SCREEN = (
    _REPO_ROOT / "frontend" / "src" / "features" / "Settings" / "DeleteAccountScreen.tsx"
)

# Every surface that tells a person what deleting their account reaches.
_DELETION_SURFACES: Final[tuple[Path, ...]] = (
    _PRIVACY_POLICY,
    _TERMS_OF_SERVICE,
    _YOUR_DATA,
    _DELETE_ACCOUNT_SCREEN,
)

# The two legs of the backup table, by the name its first column gives them.
_PLATFORM_LEG: Final = "Platform"
_OFFHOST_LEG: Final = "Off-host"

# Days between runs for each schedule word the table uses.
_SCHEDULE_INTERVAL_DAYS: Final[Mapping[str, int]] = MappingProxyType({"Daily": 1, "Weekly": 7})

# ``| Leg | Mechanism | Schedule | Retention | Survives |``
_BACKUP_ROW = re.compile(
    r"^\| (?P<leg>[\w-]+) \|[^|]*\| (?P<schedule>\w+) \| (?P<days>\d+) days \|",
    re.MULTILINE,
)

# What the copy said before it named the backup window. Each tells a reader
# that nothing of theirs remains anywhere the moment they confirm.
_OVERCLAIMS: Final[tuple[str, ...]] = (
    "immediate and irreversible",
    "immediate and total",
    "everything of yours goes",
    "nothing left to restore",
)


def _prose(document: Path) -> str:
    """Return one document as lowercase prose with its line wrapping collapsed."""
    return " ".join(document.read_text(encoding="utf-8").lower().split())


def _backup_legs() -> dict[str, tuple[str, int]]:
    """Map each backup leg in ``DEPLOYMENT.md`` to its schedule and retention days."""
    text = _DEPLOYMENT_DOC.read_text(encoding="utf-8")
    return {
        match["leg"]: (match["schedule"], int(match["days"]))
        for match in _BACKUP_ROW.finditer(text)
    }


def _oldest_backup_days() -> int:
    """The greatest age any backup copy can reach before it is pruned."""
    return max(
        days + _SCHEDULE_INTERVAL_DAYS[schedule] for schedule, days in _backup_legs().values()
    )


def test_the_backup_table_has_both_legs_the_copy_describes() -> None:
    """The parse finds exactly the two legs, so the derived figure is not vacuous."""
    legs = _backup_legs()

    assert set(legs) == {_PLATFORM_LEG, _OFFHOST_LEG}, legs
    assert all(schedule in _SCHEDULE_INTERVAL_DAYS for schedule, _ in legs.values()), legs


@pytest.mark.parametrize("surface", _DELETION_SURFACES, ids=lambda path: path.name)
def test_deletion_copy_names_the_backup_window(surface: Path) -> None:
    """Each deletion surface says backups age out, within the table's own bound."""
    copy = _prose(surface)

    assert f"about {_oldest_backup_days()} days" in copy, (
        f"{surface.name} does not say backups age out within about "
        f"{_oldest_backup_days()} days, the bound DEPLOYMENT.md's backup table implies"
    )


@pytest.mark.parametrize("surface", _DELETION_SURFACES, ids=lambda path: path.name)
def test_deletion_copy_drops_the_overclaims(surface: Path) -> None:
    """No deletion surface tells a reader nothing of theirs survives anywhere."""
    copy = _prose(surface)

    restated = [claim for claim in _OVERCLAIMS if claim in copy]
    assert not restated, f"{surface.name} still overclaims deletion: {restated}"


def test_the_policy_names_each_legs_retention() -> None:
    """The policy names both retentions, so a reader can see where the bound comes from."""
    policy = _prose(_PRIVACY_POLICY)

    for _, days in _backup_legs().values():
        assert f"{days} days" in policy, f"the policy does not name the {days}-day retention"
