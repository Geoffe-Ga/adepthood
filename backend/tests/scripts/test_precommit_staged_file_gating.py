"""The pre-commit stage gates the staged diff of the commit being made.

The fleet commits from linked worktrees under ``.ralph/worktrees/``, whose
``.git`` is a *file* pointing into the main checkout's ``.git/worktrees/<name>``
rather than a directory. An incident report claimed that in exactly that layout
hook selection had inverted: the Python hooks were said to have run against a
commit containing no Python at all, while the frontend hooks reported "no files
to check". Hand testing showed selection was correct in both directions. This
module is the regression lock, so it cannot invert silently later.

Nothing here is mocked. A scratch repository is built in ``tmp_path``, a linked
worktree is added to it, the real ``pre-commit`` is installed into it, and real
``git commit`` invocations are observed. The scratch hooks are stand-ins whose
only job is to announce that they were selected -- each fails immediately, so a
selected hook fails the commit and names itself, and an unselected one reports
that it found no files. Their ``files:`` / ``exclude:`` patterns, though, are
read out of the repository's own ``.pre-commit-config.yaml``, so weakening a
real pattern breaks these tests instead of going unnoticed.

The config is parsed as plain text rather than with PyYAML, matching
``test_pre_push_hook_installation``: PyYAML is absent from every requirements
file on purpose, so ``import yaml`` would turn this guard into a collection
error on the ``backend-compat`` job instead of a passing check.

Every subprocess is given an explicit environment with all ``GIT_*`` variables
stripped and an explicit ``cwd``. A leaked ``GIT_DIR`` from a git fixture has
already once written into the real repository here and set ``core.bare=true``;
nothing in this module may inherit git's ambient state.
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

# Stand-in entry for every mirrored hook: it can only ever report "I was
# selected", which is the single fact these tests are about.
_ALWAYS_FAILING_ENTRY = "bash -c 'exit 1'"

# Hooks scoped to the frontend tree by a ``files:`` pattern in the real config.
_FRONTEND_HOOK_IDS = (
    "frontend-eslint",
    "frontend-prettier",
    "frontend-typecheck",
    "frontend-tests",
)

# Hooks scoped to the backend tree by a ``files:`` pattern in the real config.
_BACKEND_HOOK_IDS = ("ruff", "ruff-format", "mypy", "isort", "bandit")

# check-ast carries no ``files:`` at all: it selects on the identified file
# type, which is a different selection path through pre-commit and so needs its
# own coverage. The type comes from the upstream hook definition rather than
# from this repository's config, so it is the one value stated here.
_TYPE_SELECTED_HOOK_IDS = ("check-ast",)
_PYTHON_TYPES = ("python",)

_MIRRORED_HOOK_IDS = _FRONTEND_HOOK_IDS + _BACKEND_HOOK_IDS + _TYPE_SELECTED_HOOK_IDS

_FRONTEND_FILE = "frontend/src/app.ts"
_BACKEND_FILE = "backend/src/thing.py"
_UNMATCHED_FILE = "README.md"

# ``- id: x`` / ``- repo: y`` -- the two things that end a hook's block.
_HOOK_BOUNDARY_RE = re.compile(r"^[ \t]*- (?:id|repo):", re.MULTILINE)
_HOOK_ID_RE = re.compile(r"^[ \t]*- id:[ \t]*(?P<hook_id>\S+)[ \t]*$", re.MULTILINE)

# The top-level ``exclude:`` applying to every hook, anchored at column zero.
_GLOBAL_EXCLUDE_RE = re.compile(r"^exclude:[ \t]*(?P<value>[^\s#]+)[ \t]*$", re.MULTILINE)

# ``name.........................Failed`` / ``name...(no files to check)Skipped``
_RESULT_LINE_RE = re.compile(r"^(?P<name>.+?)\.{3,}(?P<tail>.*)$", re.MULTILINE)

# pre-commit prints this only for hooks that actually ran and failed.
_FAILING_ID_RE = re.compile(r"^- hook id:[ \t]*(?P<hook_id>\S+)[ \t]*$", re.MULTILINE)


@dataclass(frozen=True)
class _HookSpec:
    """One real hook's identity and file-selection patterns.

    Attributes:
        hook_id: The hook's id, as pre-commit reports it when a hook fails.
        name: The hook's display name, as pre-commit reports it on every line.
        files: The hook's ``files:`` pattern, or None when it declares none.
        exclude: The hook's ``exclude:`` pattern, or None when it declares none.
        types: The file types the hook selects on, for type-selected hooks.
    """

    hook_id: str
    name: str
    files: str | None
    exclude: str | None
    types: tuple[str, ...] | None


@dataclass(frozen=True)
class _Lane:
    """A scratch repository with a linked worktree and installed hooks.

    Attributes:
        repo: The main checkout, holding the shared ``.git`` directory.
        worktree: The linked worktree every assertion commits from.
        env: The sanitised environment every subprocess is given.
        specs: The real hooks mirrored into the scratch config, by id.
    """

    repo: Path
    worktree: Path
    env: dict[str, str]
    specs: dict[str, _HookSpec]


def _real_config_text() -> str:
    """Return the repository's own pre-commit config as text.

    Returns:
        The raw contents of ``.pre-commit-config.yaml``.
    """
    return _REAL_CONFIG.read_text(encoding="utf-8")


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


def _mirrored_specs() -> dict[str, _HookSpec]:
    """Read the selection patterns of every mirrored hook from the real config.

    Returns:
        A mapping of hook id to its spec, in the order the ids are declared.
    """
    blocks = _hook_blocks()
    specs: dict[str, _HookSpec] = {}
    for hook_id in _MIRRORED_HOOK_IDS:
        block = blocks.get(hook_id)
        if block is None:
            pytest.fail(
                f"{hook_id} is no longer declared in .pre-commit-config.yaml, so "
                f"this module is silently no longer covering it.",
            )
        specs[hook_id] = _HookSpec(
            hook_id=hook_id,
            name=_field(block, "name") or hook_id,
            files=_field(block, "files"),
            exclude=_field(block, "exclude"),
            types=_PYTHON_TYPES if hook_id in _TYPE_SELECTED_HOOK_IDS else None,
        )
    return specs


def _yaml_scalar(value: str) -> str:
    """Quote a value as a YAML single-quoted scalar.

    Args:
        value: The raw value, typically a regex full of backslashes.

    Returns:
        The value quoted so YAML reads it literally.
    """
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _hook_yaml(spec: _HookSpec) -> list[str]:
    """Render one stand-in hook that fails loudly whenever it is selected.

    Args:
        spec: The real hook to mirror.

    Returns:
        The YAML lines declaring the stand-in.
    """
    lines = [
        f"      - id: {spec.hook_id}",
        f"        name: {_yaml_scalar(spec.name)}",
        "        language: system",
        f"        entry: {_yaml_scalar(_ALWAYS_FAILING_ENTRY)}",
        "        pass_filenames: false",
    ]
    if spec.files is not None:
        lines.append(f"        files: {_yaml_scalar(spec.files)}")
    if spec.exclude is not None:
        lines.append(f"        exclude: {_yaml_scalar(spec.exclude)}")
    if spec.types is not None:
        joined = ", ".join(spec.types)
        lines.append(f"        types: [{joined}]")
    return lines


def _scratch_config(specs: dict[str, _HookSpec]) -> str:
    """Build a config whose hooks select exactly as the real ones do.

    Args:
        specs: The mirrored hooks, by id.

    Returns:
        A complete ``.pre-commit-config.yaml`` for the scratch repository.
    """
    lines: list[str] = []
    global_exclude = _GLOBAL_EXCLUDE_RE.search(_real_config_text())
    if global_exclude is not None:
        lines.append(f"exclude: {_yaml_scalar(global_exclude.group('value'))}")
    lines.extend(["repos:", "  - repo: local", "    hooks:"])
    for spec in specs.values():
        lines.extend(_hook_yaml(spec))
    return "\n".join(lines) + "\n"


def _git_executable() -> str:
    """Return an absolute path to git, failing the test if there is none.

    Returns:
        The resolved path, so no subprocess relies on a partial executable name.
    """
    found = shutil.which("git")
    if found is None:
        pytest.fail("git is required to exercise pre-commit's file selection")
    return found


def _child_env(home: Path, store: Path) -> dict[str, str]:
    """Build the only environment any subprocess in this module may see.

    Every ``GIT_*`` variable is stripped so no ambient git state -- a leaked
    ``GIT_DIR`` above all -- can redirect a command at the real repository.
    ``HOME`` and ``XDG_CONFIG_HOME`` are redirected so the developer's global
    git config cannot change the outcome, ``PRE_COMMIT_HOME`` so the shared
    store is never touched, and ``SKIP`` is dropped because it would make
    pre-commit skip hooks for a reason these tests must not confuse with
    "no files to check".

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


def _seed_repository(repo: Path, env: dict[str, str], config: str) -> None:
    """Create the scratch repository and its base commit.

    Args:
        repo: The directory to initialise.
        env: The sanitised environment.
        config: The scratch pre-commit config to commit.
    """
    repo.mkdir(parents=True)
    _git("init", "-b", "main", cwd=repo, env=env)
    _git("config", "user.email", "gate@example.invalid", cwd=repo, env=env)
    _git("config", "user.name", "Staged File Gate", cwd=repo, env=env)
    _git("config", "commit.gpgsign", "false", cwd=repo, env=env)
    _write(repo / ".pre-commit-config.yaml", config)
    _write(repo / _UNMATCHED_FILE, "scratch repository\n")
    _write(repo / _FRONTEND_FILE, "export const a = 1;\n")
    _write(repo / _BACKEND_FILE, "VALUE = 1\n")
    _git("add", "--all", cwd=repo, env=env)
    _git("commit", "-m", "chore: base", cwd=repo, env=env)


def _diverge(repo: Path, worktree: Path, env: dict[str, str]) -> None:
    """Give main and the lane conflicting histories, before hooks are installed.

    main advances both a backend and a frontend file; the lane advances only the
    backend one, and differently. Merging main into the lane therefore conflicts
    on the backend file while fast-forwarding the frontend file, which is the
    shape ``scripts/ralph/fleet.sh sync`` produces.

    Args:
        repo: The main checkout.
        worktree: The linked worktree.
        env: The sanitised environment.
    """
    _write(worktree / _BACKEND_FILE, "VALUE = 3\n")
    _git("add", _BACKEND_FILE, cwd=worktree, env=env)
    _git("commit", "-m", "chore: lane edit", cwd=worktree, env=env)
    _write(repo / _BACKEND_FILE, "VALUE = 2\n")
    _write(repo / _FRONTEND_FILE, "export const a = 2;\n")
    _git("add", "--all", cwd=repo, env=env)
    _git("commit", "-m", "chore: main edit", cwd=repo, env=env)


def _install_hooks(repo: Path, worktree: Path, env: dict[str, str]) -> None:
    """Install the real pre-commit hook from inside the worktree.

    Args:
        repo: The main checkout, whose shared hooks directory git actually uses.
        worktree: The linked worktree to run the installer from.
        env: The sanitised environment.
    """
    result = _run(
        [sys.executable, "-m", "pre_commit", "install", "--hook-type", "pre-commit"],
        cwd=worktree,
        env=env,
    )
    if result.returncode != 0:
        pytest.fail(f"pre-commit install failed:\n{result.stdout}{result.stderr}")
    hook = repo / ".git" / "hooks" / "pre-commit"
    if not hook.is_file():
        pytest.fail(f"pre-commit installed no hook at {hook}; nothing would gate a commit")


@pytest.fixture
def lane(tmp_path: Path) -> _Lane:
    """Build a scratch repository, a linked worktree, and installed hooks.

    Args:
        tmp_path: pytest's per-test scratch directory.

    Returns:
        The lane every assertion in this module commits from.
    """
    home = tmp_path / "home"
    home.mkdir()
    env = _child_env(home, tmp_path / "pre-commit-store")
    specs = _mirrored_specs()
    repo = tmp_path / "repo"
    worktree = tmp_path / "lane"
    _seed_repository(repo, env, _scratch_config(specs))
    _git("worktree", "add", "-b", "lane", str(worktree), "main", cwd=repo, env=env)
    _diverge(repo, worktree, env)
    _install_hooks(repo, worktree, env)
    return _Lane(repo=repo, worktree=worktree, env=env, specs=specs)


def _output(result: subprocess.CompletedProcess[str]) -> str:
    """Return both captured streams, since pre-commit's report spans them.

    Args:
        result: A completed process whose streams were captured.

    Returns:
        stdout followed by stderr.
    """
    return f"{result.stdout}{result.stderr}"


def _failing_hook_ids(output: str) -> set[str]:
    """Return the ids of every hook that actually ran and failed.

    Args:
        output: A commit's combined output.

    Returns:
        The hook ids pre-commit attributed a failure to.
    """
    return {match.group("hook_id") for match in _FAILING_ID_RE.finditer(output)}


def _result_tails(output: str) -> dict[str, str]:
    """Return each reported hook name mapped to its trailing status text.

    Args:
        output: A commit's combined output.

    Returns:
        A mapping such as ``{"frontend eslint": "(no files to check)Skipped"}``.
    """
    return {match.group("name"): match.group("tail") for match in _RESULT_LINE_RE.finditer(output)}


def _assert_skipped_for_lack_of_files(lane: _Lane, output: str, hook_ids: Sequence[str]) -> None:
    """Assert each named hook reported that the staged set gave it nothing to do.

    Args:
        lane: The lane whose specs supply each hook's display name.
        output: A commit's combined output.
        hook_ids: The hooks that must not have been selected.
    """
    tails = _result_tails(output)
    for hook_id in hook_ids:
        tail = tails.get(lane.specs[hook_id].name, "<hook not reported at all>")
        unselected = f"{hook_id} was not skipped for want of files:\n{output}"
        assert "no files to check" in tail, unselected
        assert tail.endswith("Skipped"), f"{hook_id} did not report Skipped:\n{output}"


def _head(lane: _Lane) -> str:
    """Return the worktree's current commit.

    Args:
        lane: The lane to inspect.

    Returns:
        The full object name of HEAD.
    """
    return _git("rev-parse", "HEAD", cwd=lane.worktree, env=lane.env)


def _stage(lane: _Lane, relative_path: str, contents: str) -> None:
    """Write a file in the worktree and stage exactly it.

    Args:
        lane: The lane to work in.
        relative_path: The path to write, relative to the worktree root.
        contents: The new contents.
    """
    _write(lane.worktree / relative_path, contents)
    _git("add", "--", relative_path, cwd=lane.worktree, env=lane.env)


def _staged_paths(lane: _Lane) -> set[str]:
    """Return the paths the next commit would carry.

    Args:
        lane: The lane to inspect.

    Returns:
        Every path in the index that differs from HEAD.
    """
    listing = _git("diff", "--cached", "--name-only", cwd=lane.worktree, env=lane.env)
    return set(listing.split())


class TestTheLaneIsALinkedWorktree:
    """The whole point is the worktree layout, so prove the fixture built one."""

    def test_the_lane_dot_git_is_a_file_not_a_directory(self, lane: _Lane) -> None:
        """A linked worktree's ``.git`` is a pointer file; a plain clone's is a dir."""
        assert (lane.worktree / ".git").is_file()

    def test_the_lane_git_dir_lives_under_the_shared_worktrees_directory(self, lane: _Lane) -> None:
        """This is the indirection the incident report blamed for the inversion."""
        git_dir = Path(_git("rev-parse", "--git-dir", cwd=lane.worktree, env=lane.env))
        assert git_dir.parent.name == "worktrees"

    def test_the_lane_shares_the_hook_installed_in_the_main_checkout(self, lane: _Lane) -> None:
        """Hooks live in the common git dir, so installing from the lane arms both."""
        assert (lane.repo / ".git" / "hooks" / "pre-commit").is_file()


class TestStagedFilesDecideWhichHooksRun:
    """A commit's staged diff, and nothing wider, selects the hooks that run."""

    def test_a_frontend_only_commit_runs_only_the_frontend_hooks(self, lane: _Lane) -> None:
        """The inverse of the reported symptom: no Python staged, no Python hooks."""
        _stage(lane, _FRONTEND_FILE, "export const a = 9;\n")
        before = _head(lane)

        result = _git_try("commit", "-m", "feat: frontend only", cwd=lane.worktree, env=lane.env)

        output = _output(result)
        assert result.returncode != 0, output
        assert _failing_hook_ids(output) == set(_FRONTEND_HOOK_IDS), output
        _assert_skipped_for_lack_of_files(
            lane,
            output,
            _BACKEND_HOOK_IDS + _TYPE_SELECTED_HOOK_IDS,
        )
        assert _head(lane) == before, "a failing gate still let the commit land"

    def test_a_python_only_commit_runs_only_the_backend_hooks(self, lane: _Lane) -> None:
        """The reported symptom itself: no frontend staged, no frontend hooks."""
        _stage(lane, _BACKEND_FILE, "VALUE = 9\n")
        before = _head(lane)

        result = _git_try("commit", "-m", "feat: backend only", cwd=lane.worktree, env=lane.env)

        output = _output(result)
        assert result.returncode != 0, output
        expected = set(_BACKEND_HOOK_IDS) | set(_TYPE_SELECTED_HOOK_IDS)
        assert _failing_hook_ids(output) == expected, output
        _assert_skipped_for_lack_of_files(lane, output, _FRONTEND_HOOK_IDS)
        assert _head(lane) == before, "a failing gate still let the commit land"

    def test_a_commit_matching_no_hook_is_gated_by_nothing_and_lands(self, lane: _Lane) -> None:
        """The control: without this, a config that always failed would pass above."""
        _stage(lane, _UNMATCHED_FILE, "scratch repository, edited\n")
        before = _head(lane)

        result = _git_try("commit", "-m", "docs: readme only", cwd=lane.worktree, env=lane.env)

        output = _output(result)
        assert result.returncode == 0, output
        assert _failing_hook_ids(output) == set(), output
        _assert_skipped_for_lack_of_files(lane, output, _MIRRORED_HOOK_IDS)
        assert _head(lane) != before, "the commit did not land"


class TestAConflictedMergeSubstitutesTheGatedSet:
    """Characterization: mid-merge, pre-commit gates the conflict, not the diff.

    This is upstream pre-commit behaviour, not a defect and not something this
    repository configures. When ``MERGE_HEAD`` and ``MERGE_MSG`` are present,
    ``pre_commit.git.get_conflicted_files()`` replaces the staged file list with
    the conflicted files plus whatever differs from *both* parents. Everything
    the merge brought in unchanged from the incoming branch matches one parent
    and so is never gated, even though it is unambiguously part of the commit.

    ``scripts/ralph/fleet.sh sync`` merges, so every lane meets this. The fleet
    has to know that a sync commit can carry frontend changes past the frontend
    hooks. Pinned here so a change in either direction -- upstream widening the
    gated set, or narrowing it further -- shows up as a failure with a name on
    it rather than as a quietly different amount of checking.
    """

    def test_a_sync_merge_gates_the_conflicted_file_and_not_the_rest(self, lane: _Lane) -> None:
        """The incoming frontend file is staged, is not gated, and nobody says so."""
        merge = _git_try("merge", "main", cwd=lane.worktree, env=lane.env)
        assert merge.returncode != 0, "the merge was expected to conflict"
        git_dir = Path(_git("rev-parse", "--absolute-git-dir", cwd=lane.worktree, env=lane.env))
        assert (git_dir / "MERGE_HEAD").is_file()

        _stage(lane, _BACKEND_FILE, "VALUE = 4\n")
        assert _staged_paths(lane) == {_BACKEND_FILE, _FRONTEND_FILE}
        before = _head(lane)

        result = _git_try("commit", "--no-edit", cwd=lane.worktree, env=lane.env)

        output = _output(result)
        assert result.returncode != 0, output
        expected = set(_BACKEND_HOOK_IDS) | set(_TYPE_SELECTED_HOOK_IDS)
        assert _failing_hook_ids(output) == expected, output
        _assert_skipped_for_lack_of_files(lane, output, _FRONTEND_HOOK_IDS)
        assert _head(lane) == before, "a failing gate still let the merge commit land"
        assert (git_dir / "MERGE_HEAD").is_file(), "the merge was resolved by a blocked commit"


class TestTheMirroredHooksStillExist:
    """The behavioural tests only cover hooks the real config still declares."""

    @pytest.mark.parametrize("hook_id", _FRONTEND_HOOK_IDS)
    def test_each_frontend_hook_is_scoped_to_the_frontend_tree(self, hook_id: str) -> None:
        """A frontend hook without a frontend-anchored pattern would run on everything."""
        files = _mirrored_specs()[hook_id].files
        assert files is not None, f"{hook_id} declares no files: pattern"
        assert files.startswith("^frontend/"), files

    @pytest.mark.parametrize("hook_id", _BACKEND_HOOK_IDS)
    def test_each_backend_hook_is_scoped_to_the_backend_tree(self, hook_id: str) -> None:
        """Likewise: this is the pattern the frontend-only commit proves is honoured."""
        files = _mirrored_specs()[hook_id].files
        assert files is not None, f"{hook_id} declares no files: pattern"
        assert files.startswith("^backend/"), files

    @pytest.mark.parametrize("hook_id", _TYPE_SELECTED_HOOK_IDS)
    def test_each_type_selected_hook_declares_no_files_pattern(self, hook_id: str) -> None:
        """Adding one would move it off the type-selection path these tests cover."""
        assert _mirrored_specs()[hook_id].files is None
