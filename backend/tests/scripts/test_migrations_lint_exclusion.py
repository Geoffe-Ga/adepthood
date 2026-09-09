"""``backend/migrations`` is ungated on purpose, and the config must say so.

A cloned PyCQA/isort hook was removed from ``.pre-commit-config.yaml`` as a
redundant second import-sorter, and the note left in its place said ruff's
``I`` family "is already live under ``select = ["ALL"]``" -- an unqualified
equivalence. It holds for ``backend/src`` and ``backend/tests``. It is false for
``backend/migrations``, the one tree the deleted hook uniquely covered:
``[tool.ruff] extend-exclude`` lists ``migrations`` and the ruff hook passes
``--force-exclude``, which is what makes ruff honour that list even for paths
pre-commit hands it by name.

The functional loss is cosmetic -- these are Alembic-generated files that mypy
and bandit already skip. The false claim is the defect, and prose alone cannot
stay true on its own. This module is what keeps the two ends tied:

* the behavioural end -- ruff really does refuse those paths under
  ``--force-exclude``, and really would lint them without it, so neither half of
  the recorded reasoning is asserted from memory;
* the policy end -- ruff, mypy, bandit and the four tool tables the exclusion
  note names by hand all still skip the tree, so "excluded from every
  analyser" does not quietly become "excluded from one";
* the prose end -- the removal note names ``backend/migrations`` and the
  decision is recorded beside the exclusion that causes it, so a future edit
  cannot restore the unqualified claim without turning this suite red.

Ruff is invoked as a subprocess rather than described, because the property
under test is what the installed ruff does with these flags, not what the
config file says it should. It is pinned in ``backend/requirements-dev.txt``,
which every lane that runs this suite installs.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_PRECOMMIT_CONFIG = _REPO_ROOT / ".pre-commit-config.yaml"
_BACKEND_PYPROJECT = _REPO_ROOT / "backend" / "pyproject.toml"
_BANDIT_CONFIG = _REPO_ROOT / "backend" / ".bandit"

# A file that exists inside the excluded tree. Alembic's own environment module
# is the one path there guaranteed to survive any squash of the revision chain.
_MIGRATIONS_SENTINEL = "backend/migrations/env.py"

# Ruff's answer when every path it was handed was excluded. Matching on the
# warning rather than the exit code matters: an empty run and a clean run both
# exit 0, and only this line distinguishes "nothing was checked" from
# "everything checked was fine".
_NOTHING_CHECKED = "No Python files found under the given path(s)"

# The flag that makes `[tool.ruff] extend-exclude` bind for explicitly-passed
# paths. Without it pre-commit's filename arguments override the exclusion.
_FORCE_EXCLUDE = "--force-exclude"

# The prose that must name the tree it is making a claim about.
_MIGRATIONS_TREE = "backend/migrations"

# The other tables in backend/pyproject.toml that the exclusion note claims
# also skip the generated tree. Bandit and mypy are checked separately because
# their exclusions live in .bandit and .pre-commit-config.yaml, not here.
_OTHER_EXCLUDING_TABLES = (
    "[tool.coverage.run]",
    "[tool.radon]",
    "[tool.interrogate]",
    "[tool.vulture]",
)

# A phrase inside the isort-removal note, used to find that comment paragraph.
# The note is separated from the next hook by a blank line, so it cannot be
# located by anchoring on the code beneath it.
_REMOVAL_NOTE_ANCHOR = "There was a cloned PyCQA/isort hook here"

# A tracker reference in a code comment. The decision has to stand on its own
# for a reader who has only the file in front of them.
_ISSUE_REFERENCE_RE = re.compile(r"#\d{2,}")


def _ruff() -> str:
    """Locate the pinned ruff executable.

    Returns:
        The absolute path to ``ruff``.

    Raises:
        AssertionError: If ruff is absent, so a missing tool reports itself
            rather than being mistaken for a satisfied assertion.
    """
    resolved = shutil.which("ruff")
    if resolved is None:
        raise AssertionError(
            "ruff is not on PATH, so the exclusion behaviour cannot be measured. "
            "It is pinned in backend/requirements-dev.txt; install that first."
        )
    return resolved


def _run_ruff(*args: str) -> subprocess.CompletedProcess[str]:
    """Run ruff from the repository root, as pre-commit does.

    Args:
        *args: Arguments appended after ``check``.

    Returns:
        The completed process, with text streams captured.
    """
    # S603 is per-file-ignored for backend/tests/scripts/**: the external tool's
    # own behaviour is the unit under test, so there is no in-process seam.
    return subprocess.run(
        [_ruff(), "check", *args],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def _hook_entry(hook_id: str) -> str:
    """Return the raw ``entry:`` value of one pre-commit hook.

    The config is parsed as text rather than with PyYAML, which no requirements
    file in this repository installs; importing it would turn this module into
    a collection error on the 3.11 and 3.13 compat jobs.

    Args:
        hook_id: The hook's ``id:`` in ``.pre-commit-config.yaml``.

    Returns:
        The entry value with its key and surrounding whitespace stripped.

    Raises:
        AssertionError: If the hook or its ``entry:`` line is absent.
    """
    config = _PRECOMMIT_CONFIG.read_text(encoding="utf-8")
    marker = f"- id: {hook_id}"
    if marker not in config:
        raise AssertionError(f"no hook with id {hook_id!r} in {_PRECOMMIT_CONFIG}")
    for line in config.split(marker, 1)[1].splitlines():
        stripped = line.strip()
        if stripped.startswith("entry:"):
            return stripped[len("entry:") :].strip()
    raise AssertionError(f"hook {hook_id!r} has no entry: line")


def _sole_match(lines: list[str], anchor: str) -> int:
    """Return the index of the one line containing ``anchor``.

    Args:
        lines: The file's lines.
        anchor: A substring identifying the line.

    Returns:
        The zero-based index of the matching line.

    Raises:
        AssertionError: If the anchor is absent or appears more than once, so
            an ambiguous match never silently reads the wrong block.
    """
    matches = [index for index, line in enumerate(lines) if anchor in line]
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one line containing {anchor!r}, found {matches}")
    return matches[0]


def _comment_block_above(path: Path, anchor: str) -> str:
    """Return the unbroken run of ``#`` comment lines directly above a line.

    Args:
        path: The file to read.
        anchor: A substring identifying the anchored line.

    Returns:
        The comment block, newline-joined, in file order.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    index = _sole_match(lines, anchor)
    block: list[str] = []
    while index > 0 and lines[index - 1].lstrip().startswith("#"):
        index -= 1
        block.append(lines[index])
    return "\n".join(reversed(block))


def _toml_section(path: Path, header: str) -> str:
    """Return the body of one TOML table, up to the next table header.

    Args:
        path: The TOML file to read.
        header: The table header, e.g. ``[tool.vulture]``.

    Returns:
        The lines following the header, newline-joined.

    Raises:
        AssertionError: If the table is absent.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    # Matched at the start of the line: the comment above ``extend-exclude``
    # names these same tables in prose, so a substring search finds two.
    starts = [index for index, line in enumerate(lines) if line.startswith(header)]
    if len(starts) != 1:
        raise AssertionError(f"expected exactly one {header} table, found {starts}")
    index = starts[0]
    body: list[str] = []
    for line in lines[index + 1 :]:
        if line.startswith("["):
            break
        body.append(line)
    return "\n".join(body)


def _comment_block_containing(path: Path, anchor: str) -> str:
    """Return the whole comment paragraph one of whose lines contains ``anchor``.

    A paragraph is an unbroken run of ``#`` lines; a blank line or any code line
    ends it. Anchoring inside the block rather than on the code beneath it is
    what lets this find prose that is separated from the next hook by a blank
    line, as the isort-removal note is.

    Args:
        path: The file to read.
        anchor: A substring appearing on exactly one comment line of the block.

    Returns:
        The comment block, newline-joined, in file order.

    Raises:
        AssertionError: If the anchored line is not itself a comment.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    index = _sole_match(lines, anchor)
    if not lines[index].lstrip().startswith("#"):
        raise AssertionError(f"the line containing {anchor!r} is not a comment: {lines[index]!r}")
    start = index
    while start > 0 and lines[start - 1].lstrip().startswith("#"):
        start -= 1
    end = index
    while end + 1 < len(lines) and lines[end + 1].lstrip().startswith("#"):
        end += 1
    return "\n".join(lines[start : end + 1])


class TestRuffRefusesTheMigrationsTree:
    """The load-bearing measurement: ruff's `I` family cannot reach that tree."""

    def test_the_sentinel_file_exists(self) -> None:
        """A path that vanished would make every check below vacuously true."""
        assert (_REPO_ROOT / _MIGRATIONS_SENTINEL).is_file(), (
            f"{_MIGRATIONS_SENTINEL} is gone; pick another file inside the "
            f"excluded tree before trusting anything else in this module"
        )

    def test_force_exclude_makes_ruff_check_nothing(self) -> None:
        """Handed the path by name, ruff still declines to read it."""
        result = _run_ruff(
            _FORCE_EXCLUDE,
            "--config=backend/pyproject.toml",
            "--no-fix",
            _MIGRATIONS_SENTINEL,
        )

        assert _NOTHING_CHECKED in result.stderr, (
            f"ruff did not report the path as excluded, so the config no longer "
            f"means what .pre-commit-config.yaml and backend/pyproject.toml say "
            f"it means. stdout={result.stdout!r} stderr={result.stderr!r}"
        )
        assert result.returncode == 0, (
            f"expected a clean exit from an empty run; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )

    def test_without_force_exclude_ruff_would_read_the_file(self) -> None:
        """The control. Otherwise the check above could pass on a bad path."""
        result = _run_ruff(
            "--config=backend/pyproject.toml",
            "--no-fix",
            "--select=I",
            _MIGRATIONS_SENTINEL,
        )

        assert _NOTHING_CHECKED not in result.stderr, (
            f"ruff found no files even without {_FORCE_EXCLUDE}, so the previous "
            f"assertion proves nothing about the flag. "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )

    def test_the_ruff_hook_still_passes_the_flag(self) -> None:
        """Drop `--force-exclude` and pre-commit starts linting the whole tree."""
        assert _FORCE_EXCLUDE in _hook_entry("ruff"), (
            "the ruff hook no longer passes --force-exclude, so pre-commit's "
            "explicit filenames now override [tool.ruff] extend-exclude and the "
            "recorded exclusion policy is no longer the one in force"
        )


class TestEveryAnalyserStillExcludesTheTree:
    """The recorded reasoning rests on the exclusion being unanimous."""

    def test_ruff_excludes_it(self) -> None:
        """``extend-exclude`` is the line the decision is recorded beside."""
        body = _BACKEND_PYPROJECT.read_text(encoding="utf-8")
        assert re.search(r"^extend-exclude\s*=\s*\[[^\]]*\"migrations\"", body, re.MULTILINE), (
            "[tool.ruff] extend-exclude no longer lists migrations"
        )

    def test_mypy_excludes_it(self) -> None:
        """The mypy hook's own exclusion, quoted by both comment blocks."""
        assert "exclude: ^backend/migrations/" in _PRECOMMIT_CONFIG.read_text(encoding="utf-8"), (
            "the mypy hook no longer excludes backend/migrations, so the claim "
            "that the tree is outside every analyser has stopped being true"
        )

    def test_bandit_excludes_it(self) -> None:
        """backend/.bandit's ``exclude_dirs``, the third leg of the policy."""
        assert "backend/migrations" in _BANDIT_CONFIG.read_text(encoding="utf-8"), (
            "backend/.bandit no longer excludes backend/migrations"
        )

    @pytest.mark.parametrize("header", _OTHER_EXCLUDING_TABLES)
    def test_the_remaining_tool_tables_exclude_it(self, header: str) -> None:
        """The exclusion note names these by table; each has to still mean it."""
        assert "migrations" in _toml_section(_BACKEND_PYPROJECT, header), (
            f"{header} in backend/pyproject.toml no longer excludes migrations, "
            f"so the comment above extend-exclude overstates how unanimous the "
            f"repository-wide policy is"
        )


class TestTheProseCannotDriftBackIntoAFalseClaim:
    """An unqualified "ruff already does this" is what this module prevents."""

    def test_the_removal_note_names_the_tree_it_excepts(self) -> None:
        """The note has to scope its claim, not assert repo-wide equivalence."""
        note = _comment_block_containing(_PRECOMMIT_CONFIG, _REMOVAL_NOTE_ANCHOR)
        assert _MIGRATIONS_TREE in note, (
            f"the isort-removal note claims ruff's coverage without excepting "
            f"{_MIGRATIONS_TREE}, which is the one tree the deleted hook "
            f"uniquely covered: {note!r}"
        )

    @pytest.mark.parametrize(
        ("path", "anchor"),
        [
            (_BACKEND_PYPROJECT, "extend-exclude = ["),
            (_PRECOMMIT_CONFIG, _REMOVAL_NOTE_ANCHOR),
        ],
    )
    def test_the_decision_carries_no_tracker_reference(self, path: Path, anchor: str) -> None:
        """A comment that only makes sense with an issue tab open explains nothing."""
        block = (
            _comment_block_above(path, anchor)
            if anchor.startswith("extend-exclude")
            else _comment_block_containing(path, anchor)
        )
        references = _ISSUE_REFERENCE_RE.findall(block)
        assert not references, (
            f"the comment above {anchor!r} in {path.name} defers to a tracker "
            f"instead of standing on its own: {references}"
        )

    def test_the_exclusion_records_its_own_reasoning(self) -> None:
        """The decision lives where the exclusion lives, not only in a PR body."""
        block = _comment_block_above(_BACKEND_PYPROJECT, "extend-exclude = [")
        assert "Alembic" in block, (
            f"the comment above extend-exclude no longer says why the tree is "
            f"exempt -- that it is generated: {block!r}"
        )
        assert "isort" in block, (
            f"the comment above extend-exclude no longer says what lapsed here "
            f"when the standalone sorter went away: {block!r}"
        )
