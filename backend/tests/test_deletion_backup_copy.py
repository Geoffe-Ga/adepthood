"""The deletion copy states the backup schedule B08 records, as a schedule (#3057, #3063 AC16).

Deleting an account removes it from the live database at once, but every
backup taken before the deletion still holds a copy until that backup ages
out. The copy says how long that can be, and the number is read from
:mod:`domain.retention_stores` -- the constants the journal-purge floor is
built on, themselves pinned to ``DEPLOYMENT.md``'s backup table by
``tests/domain/test_retention_store_inventory.py`` -- rather than transcribed.

The bound is only as good as the schedule behind it: the off-platform copies
are made and pruned by the operator by hand. So the copy presents it as the
schedule's figure, never as an enforced guarantee, and says who keeps that leg.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final

import pytest

from domain.retention_stores import (
    OFFHOST_DUMP_RETENTION_DAYS,
    OLDEST_LIVE_BACKUP_DAYS,
    RAILWAY_PLATFORM_BACKUP_DAYS,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
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

# The two documents that spell the schedule out leg by leg.
_SCHEDULE_DOCUMENTS: Final[tuple[Path, ...]] = (_PRIVACY_POLICY, _YOUR_DATA)

# Words that present the bound as the schedule's, not as a guarantee.
_SCHEDULE_FRAMING: Final = "backup schedule"
# The off-platform leg is the operator's manual work, and the copy says so.
_MANUAL_LEG: Final = "by the operator by hand"

# What the copy once said: deletion as total and instant, or the backup bound
# as something enforced.
_OVERCLAIMS: Final[tuple[str, ...]] = (
    "immediate and irreversible",
    "immediate and total",
    "everything of yours goes",
    "nothing left to restore",
    "each is deleted when its retention runs out",
    "is gone within about",
)


def _prose(document: Path) -> str:
    """Return one document as lowercase prose with its line wrapping collapsed."""
    return " ".join(document.read_text(encoding="utf-8").lower().split())


@pytest.mark.parametrize("surface", _DELETION_SURFACES, ids=lambda path: path.name)
def test_deletion_copy_names_the_backup_bound_as_a_schedule(surface: Path) -> None:
    """Each deletion surface gives B08's bound, framed as the backup schedule's."""
    copy = _prose(surface)

    assert f"about {OLDEST_LIVE_BACKUP_DAYS} days" in copy, (
        f"{surface.name} does not say backups age out within about "
        f"{OLDEST_LIVE_BACKUP_DAYS} days (domain.retention_stores.OLDEST_LIVE_BACKUP_DAYS)"
    )
    assert _SCHEDULE_FRAMING in copy, f"{surface.name} states the bound as a guarantee"


@pytest.mark.parametrize("surface", _DELETION_SURFACES, ids=lambda path: path.name)
def test_deletion_copy_drops_the_overclaims(surface: Path) -> None:
    """No deletion surface calls deletion total or the backup bound enforced."""
    copy = _prose(surface)

    restated = [claim for claim in _OVERCLAIMS if claim in copy]
    assert not restated, f"{surface.name} still overclaims deletion: {restated}"


@pytest.mark.parametrize("document", _SCHEDULE_DOCUMENTS, ids=lambda path: path.name)
def test_schedule_documents_name_each_leg_and_who_keeps_the_manual_one(document: Path) -> None:
    """Both legs' retentions appear, and the off-platform leg is the operator's, by hand."""
    copy = _prose(document)

    for days in (RAILWAY_PLATFORM_BACKUP_DAYS, OFFHOST_DUMP_RETENTION_DAYS):
        assert f"{days} days" in copy, f"{document.name} does not name the {days}-day retention"
    assert _MANUAL_LEG in copy, f"{document.name} does not say the off-platform leg is manual"


# The restore step B08 added to DEPLOYMENT.md, and the marker that says it is
# not yet ratified (tombstone custody is undecided, #3063 AC17).
_DEPLOYMENT_DOC: Final = _REPO_ROOT / "DEPLOYMENT.md"
_RESTORE_SUPPRESSION_SCRIPT: Final = _REPO_ROOT / "backend" / "scripts" / "restore_suppression.py"
_RESTORE_STEP_HEADING: Final = "**Suppress resurrected deletions.**"
_RESTORE_STEP_DRAFT: Final = "*DRAFT for owner review (#3063); not yet"

# What the copy may say about a restore, depending on whether that step is ratified.
_RESTORE_PROMISE: Final = (
    "we re-apply deletions made since that backup before the service goes back online"
)
_RESTORE_CAVEAT: Final = "a restore could bring your data back"

_HTML_COMMENT: Final = re.compile(r"<!--.*?-->", re.DOTALL)


def _reader_prose(document: Path) -> str:
    """Return a document as a reader sees it: comments (draft markers) removed."""
    text = _HTML_COMMENT.sub("", document.read_text(encoding="utf-8"))
    return " ".join(text.lower().split())


@pytest.mark.parametrize("document", _SCHEDULE_DOCUMENTS, ids=lambda path: path.name)
def test_restore_copy_promises_only_what_the_ratified_procedure_does(document: Path) -> None:
    """A restore can bring deleted data back; the copy says so until suppression is ratified.

    B08's restore step re-applies deletions after a restore, but it is a draft
    and needs a record of deletions whose custody is undecided. While that
    holds, the copy carries the weaker true statement and keeps the stronger
    one only as an owner-facing draft comment; once the step is ratified, the
    copy must make the stronger promise instead.
    """
    deployment = _DEPLOYMENT_DOC.read_text(encoding="utf-8")
    step_at = deployment.index(_RESTORE_STEP_HEADING)
    still_draft = _RESTORE_STEP_DRAFT in deployment[step_at : step_at + 200]
    copy = _reader_prose(document)
    raw = document.read_text(encoding="utf-8")

    assert _RESTORE_SUPPRESSION_SCRIPT.is_file()
    if still_draft:
        assert _RESTORE_CAVEAT in copy, f"{document.name} implies a restore cannot resurrect data"
        assert _RESTORE_PROMISE not in copy, f"{document.name} promises an unratified procedure"
        assert "draft for owner" in raw.lower(), f"{document.name} carries no draft marker"
    else:
        assert _RESTORE_PROMISE in copy, (
            f"{document.name} still carries the pre-ratification caveat"
        )
