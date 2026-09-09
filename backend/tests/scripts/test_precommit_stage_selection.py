"""Each git stage runs the hooks that belong to it, and reports only those.

Issue #2567 was filed five separate times in effect: a lane would commit with
frontend or backend files staged, read ``frontend eslint ... (no files to
check) Skipped`` in the output, and conclude the local lint gate had gone
vacuous. Two follow-up reports widened the claim to "every file-scoped hook",
then to "every lane in the fleet is committing unlinted".

The gate was never vacuous. Direct reproduction, inside a linked worktree and
in a plain checkout, staging one frontend file carrying a real
``@typescript-eslint/no-unused-vars`` violation, produced ``frontend
eslint...Failed`` and a rejected commit in every arm -- ordinary commit and
conflict-resolution merge commit alike.

What the reporters saw was a SECOND hook block. Nearly every hook in
``.pre-commit-config.yaml`` used to omit ``stages:``, and pre-commit's default
is *every* stage, so the whole set ran again at the commit-msg stage, where the
only file in play is ``.git/COMMIT_EDITMSG``. That matches no ``files:``
pattern, so every file-scoped hook printed ``(no files to check) Skipped``
below its own earlier ``Passed`` -- and grepping a transcript for a hook name
returns the last match, which is the misleading one.

The remedy is the top-level ``default_stages`` this module locks down. It is a
legibility fix, not a coverage change: the two stages a hook can now default to
are exactly the two ``.github/workflows/backend-ci.yml`` invokes by name, so
nothing that used to run has stopped running.

This module does not reuse the fixture in ``test_precommit_staged_file_gating``
because that one's stand-in hooks can only ever fail -- which is the right
stand-in for asking *which hooks were selected*, and structurally incapable of
observing what a SUCCESSFUL commit prints after its pre-commit stage. The
stand-in here passes or fails on the content of the staged file, so a clean
commit gets far enough to reach the commit-msg stage at all.

Nothing here is mocked: a scratch repository with a linked worktree is built in
``tmp_path``, real pre-commit and commit-msg hooks are installed into it, and
real ``git commit`` invocations are observed. The hook's ``files:`` pattern and
the config's ``default_stages`` are read out of the repository's own config, so
weakening either one breaks these tests instead of going unnoticed.

The config is parsed as plain text rather than with PyYAML, matching the
sibling modules: PyYAML is absent from every requirements file on purpose, so
``import yaml`` would turn this guard into a collection error on the
``backend-compat`` job instead of a passing check.

Every subprocess is given an explicit environment with all ``GIT_*`` variables
stripped and an explicit ``cwd``; nothing here may inherit git's ambient state.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_REAL_CONFIG = _REPO_ROOT / ".pre-commit-config.yaml"

_SUBPROCESS_TIMEOUT_SECONDS = 180

# The hook mirrored as the file-scoped stand-in. frontend-eslint is the one the
# issue was filed on; its ``files:`` pattern is read from the real config.
_MIRRORED_FILE_SCOPED_HOOK_ID = "frontend-eslint"
_MIRRORED_FILE_SCOPED_HOOK_NAME = "frontend eslint"

# The hook that legitimately belongs to the commit-msg stage. Without it armed,
# "no file-scoped hook ran at commit-msg" would also hold if the commit-msg
# hook were simply not installed, and this module would prove nothing.
_COMMIT_MSG_HOOK_ID = "commitlint"
_COMMIT_MSG_HOOK_NAME = "commitlint (conventional commits)"

# The two stages a hook may default to. They are exactly the two that
# .github/workflows/backend-ci.yml invokes by name, so a default_stages missing
# either one would silently stop gating something CI still expects.
_REQUIRED_DEFAULT_STAGES = ("pre-commit", "pre-push")
_FORBIDDEN_DEFAULT_STAGE = "commit-msg"

# The marker the stand-in treats as a lint violation. A file carrying it fails
# the hook; the identical file without it passes.
_VIOLATION_MARKER = "LINT_VIOLATION"

_FRONTEND_FILE = "frontend/src/app.ts"
_CLEAN_CONTENTS = "export const a = 1;\n"
_VIOLATING_CONTENTS = f"export const a = 1; // {_VIOLATION_MARKER}\n"

# Fails when any file under frontend/ carries the marker, passes otherwise --
# the same shape as the real hook, which lints the tree rather than its argv.
_STAND_IN_ENTRY = f"bash -c 'if grep -rqF {_VIOLATION_MARKER} frontend; then exit 1; fi'"
_PASSING_ENTRY = "bash -c 'exit 0'"

_HOOK_BOUNDARY_RE = re.compile(r"^[ \t]*- (?:id|repo):", re.MULTILINE)
_HOOK_ID_RE = re.compile(r"^[ \t]*- id:[ \t]*(?P<hook_id>\S+)[ \t]*$", re.MULTILINE)
_GLOBAL_EXCLUDE_RE = re.compile(r"^exclude:[ \t]*(?P<value>[^\s#]+)[ \t]*$", re.MULTILINE)
_DEFAULT_STAGES_RE = re.compile(
    r"^default_stages:[ \t]*\[(?P<value>[^\]]*)\][ \t]*$",
    re.MULTILINE,
)
_FAILING_ID_RE = re.compile(r"^- hook id:[ \t]*(?P<hook_id>\S+)[ \t]*$", re.MULTILINE)


@dataclass(frozen=True)
class _Lane:
    """A scratch repository with a linked worktree and both git hooks installed.

    Attributes:
        repo: The main checkout, holding the shared ``.git`` directory.
        worktree: The linked worktree every assertion commits from.
        env: The sanitised environment every subprocess is given.
    """

    repo: Path
    worktree: Path
    env: dict[str, str]


def _real_config_text() -> str:
    """Return the repository's own pre-commit config as text.

    Returns:
        The raw contents of ``.pre-commit-config.yaml``.
    """
    return _REAL_CONFIG.read_text(encoding="utf-8")


def _declared_default_stages() -> tuple[str, ...] | None:
    """Return the stages the real config makes hooks default to.

    Returns:
        The declared stage names, or None when the config declares no
        ``default_stages`` at all -- in which case pre-commit defaults every
        hook to every stage, which is the defect this module locks out.
    """
    match = _DEFAULT_STAGES_RE.search(_real_config_text())
    if match is None:
        return None
    return tuple(part.strip() for part in match.group("value").split(",") if part.strip())


def _hook_blocks() -> dict[str, str]:
    """Return every hook's config block, keyed by hook id.

    Returns:
        A mapping of hook id to the raw text from its ``- id:`` line up to the
        next hook or repo, which is what that hook's own keys live in.
    """
    text = _real_config_text()
    boundaries = [match.start() for match in _HOOK_BOUNDARY_RE.finditer(text)]
    blocks: dict[str, str] = {}
    for match in _HOOK_ID_RE.finditer(text):
        following = [position for position in boundaries if position > match.start()]
        end = following[0] if following else len(text)
        blocks[match.group("hook_id")] = text[match.start() : end]
    return blocks


def _hook_block(hook_id: str) -> str:
    """Return one hook's config block, failing the test when it is gone.

    Args:
        hook_id: The hook to look up.

    Returns:
        The raw text of that hook's block.
    """
    block = _hook_blocks().get(hook_id)
    if block is None:
        pytest.fail(
            f"{hook_id} is no longer declared in .pre-commit-config.yaml, so this "
            f"module is silently no longer covering it.",
        )
    return block


def _field(block: str, key: str) -> str | None:
    """Return one single-line scalar field from a hook's config block.

    Args:
        block: The text of a single hook's YAML block.
        key: The field name to read.

    Returns:
        The field's value with surrounding quotes stripped, or None if absent.
    """
    pattern = rf"^[ \t]+{re.escape(key)}:[ \t]*(?P<value>[^\n#]+?)[ \t]*$"
    match = re.search(pattern, block, re.MULTILINE)
    return match.group("value").strip("\"'") if match else None


def _yaml_scalar(value: str) -> str:
    """Quote a value as a YAML single-quoted scalar.

    Args:
        value: The raw value, typically a regex full of backslashes.

    Returns:
        The value quoted so YAML reads it literally.
    """
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _scratch_config() -> str:
    """Build a config that mirrors the real one's stage and file selection.

    The ``default_stages`` line and the mirrored hook's ``files:`` / ``exclude:``
    patterns are copied out of the repository's own config, so this fixture
    tracks it rather than restating it. A real config that declares no
    ``default_stages`` produces a scratch config that declares none either, and
    the behavioural tests below then fail exactly as the real repository did.

    Returns:
        A complete ``.pre-commit-config.yaml`` for the scratch repository.
    """
    lines: list[str] = []
    global_exclude = _GLOBAL_EXCLUDE_RE.search(_real_config_text())
    if global_exclude is not None:
        lines.append(f"exclude: {_yaml_scalar(global_exclude.group('value'))}")
    default_stages = _declared_default_stages()
    if default_stages is not None:
        lines.append(f"default_stages: [{', '.join(default_stages)}]")

    mirrored = _hook_block(_MIRRORED_FILE_SCOPED_HOOK_ID)
    lines.extend(
        [
            "repos:",
            "  - repo: local",
            "    hooks:",
            f"      - id: {_MIRRORED_FILE_SCOPED_HOOK_ID}",
            f"        name: {_yaml_scalar(_MIRRORED_FILE_SCOPED_HOOK_NAME)}",
            "        language: system",
            f"        entry: {_yaml_scalar(_STAND_IN_ENTRY)}",
            "        pass_filenames: false",
        ],
    )
    for key in ("files", "exclude"):
        value = _field(mirrored, key)
        if value is not None:
            lines.append(f"        {key}: {_yaml_scalar(value)}")
    lines.extend(
        [
            f"      - id: {_COMMIT_MSG_HOOK_ID}",
            f"        name: {_yaml_scalar(_COMMIT_MSG_HOOK_NAME)}",
            "        language: system",
            f"        entry: {_yaml_scalar(_PASSING_ENTRY)}",
            "        pass_filenames: false",
            f"        stages: [{_commit_msg_stages()}]",
        ],
    )
    return "\n".join(lines) + "\n"


def _commit_msg_stages() -> str:
    """Return the stages the real commitlint hook declares.

    Returns:
        The comma-joined stage names, read from the real config so a commitlint
        that stopped declaring ``commit-msg`` breaks this fixture too.
    """
    declared = _field(_hook_block(_COMMIT_MSG_HOOK_ID), "stages")
    if declared is None:
        pytest.fail(f"{_COMMIT_MSG_HOOK_ID} declares no stages: in the real config")
    return declared.strip("[]")


def _git_executable() -> str:
    """Return an absolute path to git, failing the test if there is none.

    Returns:
        The resolved path, so no subprocess relies on a partial executable name.
    """
    found = shutil.which("git")
    if found is None:
        pytest.fail("git is required to exercise pre-commit's stage selection")
    return found


def _child_env(home: Path, store: Path) -> dict[str, str]:
    """Build the only environment any subprocess in this module may see.

    Every ``GIT_*`` variable is stripped so no ambient git state -- a leaked
    ``GIT_DIR`` above all -- can redirect a command at the real repository.
    ``HOME`` and ``XDG_CONFIG_HOME`` are redirected so the developer's global
    git config cannot change the outcome, ``PRE_COMMIT_HOME`` so the shared
    store is never touched, and ``SKIP`` is dropped because it would make
    pre-commit skip a hook for a reason these tests must not confuse with a
    stage that did not select it.

    Args:
        home: A scratch directory to use as ``HOME``.
        store: A scratch directory for pre-commit's own store.

    Returns:
        The environment dict to pass to every subprocess.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("GIT_", "PRE_COMMIT_")) and key != "SKIP"
    }
    env["HOME"] = str(home)
    env["XDG_CONFIG_HOME"] = str(home / "config")
    env["PRE_COMMIT_HOME"] = str(store)
    return env


def _run(
    argv: Sequence[str],
    *,
    cwd: Path,
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    """Run a command with an explicit cwd and environment.

    Args:
        argv: The full argument vector, starting with an absolute executable.
        cwd: The directory to run in; never the ambient process cwd.
        env: The sanitised environment.

    Returns:
        The completed process, never raising on a non-zero exit code.
    """
    return subprocess.run(
        list(argv),
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
    )


def _git_try(*args: str, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Run a git command whose exit code is part of what is being asserted.

    Args:
        *args: The git arguments.
        cwd: The directory to run in.
        env: The sanitised environment.

    Returns:
        The completed process.
    """
    return _run([_git_executable(), *args], cwd=cwd, env=env)


def _git(*args: str, cwd: Path, env: dict[str, str]) -> str:
    """Run a git command that setup depends on, failing the test if it errors.

    Args:
        *args: The git arguments.
        cwd: The directory to run in.
        env: The sanitised environment.

    Returns:
        The command's stdout, stripped.
    """
    result = _git_try(*args, cwd=cwd, env=env)
    if result.returncode != 0:
        pytest.fail(f"git {' '.join(args)} failed in {cwd}:\n{result.stdout}{result.stderr}")
    return result.stdout.strip()


def _write(path: Path, text: str) -> None:
    """Write a file, creating its parent directories.

    Args:
        path: The file to write.
        text: Its contents.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _seed_repository(repo: Path, env: dict[str, str]) -> None:
    """Create the scratch repository and its base commit.

    Args:
        repo: The directory to initialise.
        env: The sanitised environment.
    """
    repo.mkdir(parents=True)
    _git("init", "-b", "main", cwd=repo, env=env)
    _git("config", "user.email", "gate@example.invalid", cwd=repo, env=env)
    _git("config", "user.name", "Stage Selection Gate", cwd=repo, env=env)
    _git("config", "commit.gpgsign", "false", cwd=repo, env=env)
    _write(repo / ".pre-commit-config.yaml", _scratch_config())
    _write(repo / _FRONTEND_FILE, _CLEAN_CONTENTS)
    _git("add", "--all", cwd=repo, env=env)
    _git("commit", "-m", "chore: base", cwd=repo, env=env)


def _install_hooks(repo: Path, worktree: Path, env: dict[str, str]) -> None:
    """Install both the pre-commit and the commit-msg git hook.

    Installing both is what makes a two-block transcript possible at all; with
    only the pre-commit hook armed, the assertion that no file-scoped hook runs
    at commit-msg would hold for the wrong reason.

    Args:
        repo: The main checkout, whose shared hooks directory git actually uses.
        worktree: The linked worktree to run the installer from.
        env: The sanitised environment.
    """
    result = _run(
        [
            sys.executable,
            "-m",
            "pre_commit",
            "install",
            "--hook-type",
            "pre-commit",
            "--hook-type",
            "commit-msg",
        ],
        cwd=worktree,
        env=env,
    )
    if result.returncode != 0:
        pytest.fail(f"pre-commit install failed:\n{result.stdout}{result.stderr}")
    for hook_type in ("pre-commit", "commit-msg"):
        hook = repo / ".git" / "hooks" / hook_type
        if not hook.is_file():
            pytest.fail(f"pre-commit installed no {hook_type} hook at {hook}")


@pytest.fixture
def lane(tmp_path: Path) -> _Lane:
    """Build a scratch repository, a linked worktree, and both installed hooks.

    Args:
        tmp_path: pytest's per-test scratch directory.

    Returns:
        The lane every behavioural assertion in this module commits from.
    """
    home = tmp_path / "home"
    home.mkdir()
    env = _child_env(home, tmp_path / "pre-commit-store")
    repo = tmp_path / "repo"
    worktree = tmp_path / "lane"
    _seed_repository(repo, env)
    _git("worktree", "add", "-b", "lane", str(worktree), "main", cwd=repo, env=env)
    _install_hooks(repo, worktree, env)
    return _Lane(repo=repo, worktree=worktree, env=env)


def _output(result: subprocess.CompletedProcess[str]) -> str:
    """Return both captured streams, since pre-commit's report spans them.

    Args:
        result: A completed process whose streams were captured.

    Returns:
        stdout followed by stderr.
    """
    return f"{result.stdout}{result.stderr}"


def _report_lines(output: str, hook_name: str) -> list[str]:
    """Return every result line a named hook contributed to a transcript.

    Args:
        output: A commit's combined output.
        hook_name: The hook's display name.

    Returns:
        The matching lines, one per stage that selected the hook.
    """
    prefix = f"{hook_name}."
    return [line for line in output.splitlines() if line.startswith(prefix)]


def _head(lane: _Lane) -> str:
    """Return the worktree's current commit.

    Args:
        lane: The lane to inspect.

    Returns:
        The full object name of HEAD.
    """
    return _git("rev-parse", "HEAD", cwd=lane.worktree, env=lane.env)


def _stage(lane: _Lane, contents: str) -> None:
    """Write the mirrored frontend file in the worktree and stage exactly it.

    Args:
        lane: The lane to work in.
        contents: The new contents.
    """
    _write(lane.worktree / _FRONTEND_FILE, contents)
    _git("add", "--", _FRONTEND_FILE, cwd=lane.worktree, env=lane.env)


def _commit(lane: _Lane, message: str) -> subprocess.CompletedProcess[str]:
    """Attempt a commit in the lane.

    Args:
        lane: The lane to commit from.
        message: The commit message.

    Returns:
        The completed process, whose exit code is part of what is asserted.
    """
    return _git_try("commit", "-m", message, cwd=lane.worktree, env=lane.env)


class TestTheRealConfigKeepsCommitMsgToTheCommitMsgHooks:
    """The config lock. Delete ``default_stages`` and the misleading block returns."""

    def test_the_config_declares_default_stages(self) -> None:
        """Without it pre-commit defaults every hook to every stage, which is the bug."""
        assert _declared_default_stages() is not None, (
            ".pre-commit-config.yaml declares no default_stages, so every hook that "
            "omits stages: runs at the commit-msg stage too and reports "
            "'(no files to check) Skipped' there on every successful commit."
        )

    def test_default_stages_excludes_the_commit_msg_stage(self) -> None:
        """A hook with nothing to say about a commit message must not be asked."""
        stages = _declared_default_stages() or ()
        assert _FORBIDDEN_DEFAULT_STAGE not in stages, stages

    @pytest.mark.parametrize("stage", _REQUIRED_DEFAULT_STAGES)
    def test_default_stages_keeps_the_stage_ci_invokes_by_name(self, stage: str) -> None:
        """backend-ci.yml runs both by name; dropping one would weaken a live gate."""
        stages = _declared_default_stages() or ()
        assert stage in stages, stages

    def test_commitlint_still_owns_the_commit_msg_stage(self) -> None:
        """Otherwise nothing at all would gate the message, which is a real loss."""
        assert _FORBIDDEN_DEFAULT_STAGE in _commit_msg_stages()


class TestTheFileScopedGateIsNotVacuous:
    """The same fixture, violating and clean, must produce opposite verdicts."""

    def test_a_violating_staged_file_fails_the_hook_and_rejects_the_commit(
        self,
        lane: _Lane,
    ) -> None:
        """A gate that cannot fail is not a gate; this is the half that proves it can."""
        _stage(lane, _VIOLATING_CONTENTS)
        before = _head(lane)

        result = _commit(lane, "feat: violating frontend change")

        output = _output(result)
        assert result.returncode != 0, output
        failing = {match.group("hook_id") for match in _FAILING_ID_RE.finditer(output)}
        assert _MIRRORED_FILE_SCOPED_HOOK_ID in failing, output
        assert _head(lane) == before, "a failing gate still let the commit land"

    def test_the_identical_clean_file_passes_the_hook_and_lands(self, lane: _Lane) -> None:
        """The control: without it, an always-failing stand-in would pass the test above."""
        _stage(lane, _CLEAN_CONTENTS + "export const b = 2;\n")
        before = _head(lane)

        result = _commit(lane, "feat: clean frontend change")

        output = _output(result)
        assert result.returncode == 0, output
        assert _head(lane) != before, output


class TestASuccessfulCommitReportsEachHookOnce:
    """The reported symptom itself: the second block, and its absence."""

    def test_the_file_scoped_hook_is_reported_exactly_once(self, lane: _Lane) -> None:
        """Two lines for one hook is what sent five reporters after a phantom defect."""
        _stage(lane, _CLEAN_CONTENTS + "export const c = 3;\n")

        output = _output(_commit(lane, "feat: clean frontend change"))

        reported = _report_lines(output, _MIRRORED_FILE_SCOPED_HOOK_NAME)
        assert len(reported) == 1, f"expected one report line, got {reported}:\n{output}"

    def test_the_file_scoped_hook_never_reports_having_no_files(self, lane: _Lane) -> None:
        """The exact string the issue was filed on, for a commit that staged a file."""
        _stage(lane, _CLEAN_CONTENTS + "export const d = 4;\n")

        output = _output(_commit(lane, "feat: clean frontend change"))

        reported = _report_lines(output, _MIRRORED_FILE_SCOPED_HOOK_NAME)
        assert all("no files to check" not in line for line in reported), output

    def test_the_commit_msg_stage_still_runs_its_own_hook(self, lane: _Lane) -> None:
        """Without this, the two assertions above would also hold with no hook armed."""
        _stage(lane, _CLEAN_CONTENTS + "export const e = 5;\n")

        output = _output(_commit(lane, "feat: clean frontend change"))

        reported = _report_lines(output, _COMMIT_MSG_HOOK_NAME)
        assert len(reported) == 1, f"expected one report line, got {reported}:\n{output}"
        assert reported[0].endswith("Passed"), output
