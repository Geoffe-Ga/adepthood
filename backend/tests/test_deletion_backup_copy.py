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

# The frontend's copy of the bound. The Jest suite that holds the screen to
# these rules reads them, and the backend figure, from this repo's Python
# through ``@/testing/backendSource``, so it runs on either side's change (#3115).
_FRONTEND_BACKUP_SCHEDULE: Final = (
    _REPO_ROOT / "frontend" / "src" / "constants" / "backupSchedule.ts"
)
_FRONTEND_BOUND_DECLARATION: Final = re.compile(
    r"^export const OLDEST_LIVE_BACKUP_DAYS = (\d+);$", re.MULTILINE
)
# How the screen interpolates the frontend constant into its copy.
_FRONTEND_BOUND_PLACEHOLDER: Final = "${OLDEST_LIVE_BACKUP_DAYS}"

# Every surface that tells a person what deleting their account reaches.
_DELETION_SURFACES: Final[tuple[Path, ...]] = (
    _PRIVACY_POLICY,
    _TERMS_OF_SERVICE,
    _YOUR_DATA,
    _DELETE_ACCOUNT_SCREEN,
)

# The two documents that spell the schedule out leg by leg.
_SCHEDULE_DOCUMENTS: Final[tuple[Path, ...]] = (_PRIVACY_POLICY, _YOUR_DATA)

# Words that present the bound as the schedule's, not as a guarantee. One of
# them must govern each statement of the bound: same sentence, and no further
# back than :data:`_FRAMING_WINDOW_CHARS`.
_SCHEDULE_FRAMINGS: Final[tuple[str, ...]] = ("on our backup schedule", "on that schedule")
_FRAMING_WINDOW_CHARS: Final = 160
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
    "we guarantee",
    "guaranteed",
    "is deleted within",
    "are deleted within",
)


def _frontend_literal(document: Path, declaration: re.Pattern[str]) -> int:
    """Return the one integer ``declaration`` captures in a frontend file."""
    found = declaration.findall(document.read_text(encoding="utf-8"))
    assert len(found) == 1, f"{document.name}: expected one {declaration.pattern!r}, got {found}"
    return int(found[0])


def _prose(document: Path) -> str:
    """Return one document as lowercase prose with its line wrapping collapsed.

    The delete-account screen interpolates the frontend's copy of the bound;
    the number that constant holds (pinned below to the backend's) is put in
    its place, so the screen is read as it renders.
    """
    text = document.read_text(encoding="utf-8")
    if _FRONTEND_BOUND_PLACEHOLDER in text:
        bound = _frontend_literal(_FRONTEND_BACKUP_SCHEDULE, _FRONTEND_BOUND_DECLARATION)
        text = text.replace(_FRONTEND_BOUND_PLACEHOLDER, str(bound))
    return " ".join(text.lower().split())


def test_frontend_bound_is_the_backend_bound() -> None:
    """The frontend constant the screen renders holds ``OLDEST_LIVE_BACKUP_DAYS``.

    The delete-account Jest suite derives the same figure from
    ``domain.retention_stores`` and holds the constant to it, so the pin fails
    on whichever side's CI the change runs in.
    """
    declared = _frontend_literal(_FRONTEND_BACKUP_SCHEDULE, _FRONTEND_BOUND_DECLARATION)

    assert declared == OLDEST_LIVE_BACKUP_DAYS


def test_the_screen_renders_the_shared_bound_not_a_transcribed_one() -> None:
    """The screen's copy takes the number from the shared constant, never a literal."""
    source = _DELETE_ACCOUNT_SCREEN.read_text(encoding="utf-8")

    assert f"about {_FRONTEND_BOUND_PLACEHOLDER} days" in source
    assert f"{OLDEST_LIVE_BACKUP_DAYS} days" not in source


def _unframed_bound_offsets(copy: str) -> list[int]:
    """Offsets of each statement of the bound that no schedule phrase governs.

    A phrase governs the bound when it sits in the same sentence, before it,
    within :data:`_FRAMING_WINDOW_CHARS` -- so a schedule phrase elsewhere in
    the document cannot vouch for a sentence that states the bound as fact.
    """
    bound = f"about {OLDEST_LIVE_BACKUP_DAYS} days"
    offsets = [match.start() for match in re.finditer(re.escape(bound), copy)]
    unframed: list[int] = []
    for offset in offsets:
        window = copy[max(0, offset - _FRAMING_WINDOW_CHARS) : offset]
        sentence = window[window.rfind(". ") + 1 :]
        if not any(phrase in sentence for phrase in _SCHEDULE_FRAMINGS):
            unframed.append(offset)
    return unframed


def test_a_bound_far_from_its_schedule_phrase_is_unframed() -> None:
    """The window check is local: a framing in another sentence does not count."""
    bound = f"about {OLDEST_LIVE_BACKUP_DAYS} days"
    framed = f"on our backup schedule, backups age out within {bound}."
    elsewhere = f"on our backup schedule, we copy weekly. backups are gone in {bound}."

    assert _unframed_bound_offsets(framed) == []
    assert len(_unframed_bound_offsets(elsewhere)) == 1


@pytest.mark.parametrize("surface", _DELETION_SURFACES, ids=lambda path: path.name)
def test_deletion_copy_names_the_backup_bound_as_a_schedule(surface: Path) -> None:
    """Each deletion surface gives B08's bound, framed as the backup schedule's."""
    copy = _prose(surface)

    assert f"about {OLDEST_LIVE_BACKUP_DAYS} days" in copy, (
        f"{surface.name} does not say backups age out within about "
        f"{OLDEST_LIVE_BACKUP_DAYS} days (domain.retention_stores.OLDEST_LIVE_BACKUP_DAYS)"
    )
    unframed = _unframed_bound_offsets(copy)
    assert not unframed, f"{surface.name} states the bound as a guarantee at {unframed}"


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
# How far past the step's heading its draft marker may sit.
_RESTORE_MARKER_WINDOW_CHARS: Final = 200

# What the copy may say about a restore, depending on whether that step is ratified.
_RESTORE_PROMISE: Final = (
    "we re-apply deletions made since that backup before the service goes back online"
)
_RESTORE_CAVEAT: Final = "a restore could bring your data back"
# Any wording of the promise: "re-apply", "reapplied", ... in a sentence about
# deletions. While the step is a draft, such a sentence must say so.
_REAPPLY: Final = re.compile(r"\bre-?appl")
_DELETION: Final = "deletion"
_DRAFT_QUALIFIER: Final = "draft"
_SENTENCE_BREAK: Final = re.compile(r"(?<=[.!?])\s+")

_HTML_COMMENT: Final = re.compile(r"<!--.*?-->", re.DOTALL)


def _reader_prose(document: Path) -> str:
    """Return a document as a reader sees it: comments (draft markers) removed."""
    text = _HTML_COMMENT.sub("", document.read_text(encoding="utf-8"))
    return " ".join(text.lower().split())


def _restore_step_is_draft(deployment: str) -> bool:
    """Whether DEPLOYMENT.md's restore-suppression step still carries its draft marker."""
    step_at = deployment.index(_RESTORE_STEP_HEADING)
    return _RESTORE_STEP_DRAFT in deployment[step_at : step_at + _RESTORE_MARKER_WINDOW_CHARS]


def _unqualified_reapply_sentences(copy: str) -> list[str]:
    """Sentences that say deletions are re-applied without calling that step a draft."""
    return [
        sentence
        for sentence in _SENTENCE_BREAK.split(copy)
        if _REAPPLY.search(sentence) and _DELETION in sentence and _DRAFT_QUALIFIER not in sentence
    ]


def _restore_copy_problems(copy: str, *, still_draft: bool) -> list[str]:
    """What a document's restore copy gets wrong for the step's current state.

    While the step is a draft: the caveat must be there, and no sentence may
    promise re-applied deletions, however worded, unless it names the step a
    draft. Once ratified: the promise must be there and the caveat gone, so the
    copy never says both.
    """
    if still_draft:
        problems = [] if _RESTORE_CAVEAT in copy else ["implies a restore cannot resurrect data"]
        problems += [
            f"promises an unratified procedure: {sentence!r}"
            for sentence in _unqualified_reapply_sentences(copy)
        ]
        return problems
    problems = [] if _RESTORE_PROMISE in copy else ["does not make the ratified promise"]
    if _RESTORE_CAVEAT in copy:
        problems.append("still carries the pre-ratification caveat")
    return problems


_DRAFT_STEP: Final = f"8. {_RESTORE_STEP_HEADING} {_RESTORE_STEP_DRAFT} a ratified step.*"
_RATIFIED_STEP: Final = f"8. {_RESTORE_STEP_HEADING} Before cutting over, reapply tombstones."
_FAR_MARKER_STEP: Final = (
    f"8. {_RESTORE_STEP_HEADING} {'x' * _RESTORE_MARKER_WINDOW_CHARS} {_RESTORE_STEP_DRAFT}"
)


@pytest.mark.parametrize(
    ("deployment", "expected"),
    [(_DRAFT_STEP, True), (_RATIFIED_STEP, False), (_FAR_MARKER_STEP, False)],
    ids=["marker-on-step", "no-marker", "marker-past-the-step"],
)
def test_restore_step_draft_state_is_read_from_its_marker(
    deployment: str, *, expected: bool
) -> None:
    """The draft state is the marker right under the step's heading, nothing else."""
    assert _restore_step_is_draft(deployment) is expected


_DRAFT_COPY: Final = (
    f"so {_RESTORE_CAVEAT}. the restore procedure has a step that re-applies deletions "
    "made since the backup, but that step is still a draft."
)
_RATIFIED_COPY: Final = f"if we ever have to restore from a backup, {_RESTORE_PROMISE}."


@pytest.mark.parametrize(
    ("still_draft", "copy", "expected_problems"),
    [
        (True, _DRAFT_COPY, []),
        (True, "deleted data stays deleted.", ["implies a restore cannot resurrect data"]),
        (True, f"{_DRAFT_COPY} {_RATIFIED_COPY}", ["promises an unratified procedure"]),
        (
            True,
            f"{_DRAFT_COPY} deletions made since the backup are re-applied.",
            ["promises an unratified procedure"],
        ),
        (True, f"{_DRAFT_COPY} we reapply every deletion.", ["promises an unratified procedure"]),
        (False, _RATIFIED_COPY, []),
        (False, _DRAFT_COPY, ["does not make the ratified promise", "still carries the"]),
        (False, f"so {_RESTORE_CAVEAT}, and {_RESTORE_PROMISE}.", ["still carries the"]),
    ],
    ids=[
        "draft-caveat-only",
        "draft-no-caveat",
        "draft-exact-promise",
        "draft-reworded-promise",
        "draft-reapply-unhyphenated",
        "ratified-promise-only",
        "ratified-caveat-only",
        "ratified-promise-and-caveat",
    ],
)
def test_restore_copy_rules_hold_in_both_marker_states(
    copy: str, expected_problems: list[str], *, still_draft: bool
) -> None:
    """Each marker state's rule rejects the copy the other state would need."""
    problems = _restore_copy_problems(copy, still_draft=still_draft)

    assert len(problems) == len(expected_problems), problems
    for problem, expected in zip(problems, expected_problems, strict=True):
        assert problem.startswith(expected), problems


@pytest.mark.parametrize("document", _SCHEDULE_DOCUMENTS, ids=lambda path: path.name)
def test_restore_copy_promises_only_what_the_ratified_procedure_does(document: Path) -> None:
    """A restore can bring deleted data back; the copy says so until suppression is ratified.

    B08's restore step re-applies deletions after a restore, but it is a draft
    and needs a record of deletions whose custody is undecided. While that
    holds, the copy carries the weaker true statement and keeps the stronger
    one only as an owner-facing draft comment; once the step is ratified, the
    copy must make the stronger promise instead, and drop the caveat.
    """
    still_draft = _restore_step_is_draft(_DEPLOYMENT_DOC.read_text(encoding="utf-8"))

    assert _RESTORE_SUPPRESSION_SCRIPT.is_file()
    problems = _restore_copy_problems(_reader_prose(document), still_draft=still_draft)
    assert not problems, f"{document.name}: {problems}"
    if still_draft:
        raw = document.read_text(encoding="utf-8").lower()
        assert "draft for owner" in raw, f"{document.name} carries no draft marker"


# The bound covers Adepthood's own backups; recipients keep what they received
# under their own retention, and the copy must not read as "no copy anywhere".
_OWN_BACKUPS_SCOPE: Final = "adepthood's own backups"
_RECIPIENT_RETENTION: Final = "under its own retention"


@pytest.mark.parametrize("document", _SCHEDULE_DOCUMENTS, ids=lambda path: path.name)
def test_backup_bound_is_scoped_to_adepthoods_own_backups(document: Path) -> None:
    """The bound is Adepthood's; each recipient's own retention is pointed to, not covered."""
    copy = _prose(document)

    assert _OWN_BACKUPS_SCOPE in copy, f"{document.name} reads as 'no copy anywhere'"
    assert _RECIPIENT_RETENTION in copy, f"{document.name} does not point to recipients' retention"
