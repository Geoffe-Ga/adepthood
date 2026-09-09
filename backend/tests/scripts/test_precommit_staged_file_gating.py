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

import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

from tests.helpers.precommit_lane import (
    Lane,
    add_worktree,
    child_env,
    failing_hook_ids,
    field,
    git,
    git_try,
    global_exclude,
    head,
    hook_blocks,
    install_hooks,
    output,
    seed_repository,
    stage,
    staged_paths,
    write,
    yaml_scalar,
)

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
_BACKEND_HOOK_IDS = ("ruff", "ruff-format", "mypy", "bandit")

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

# Only the pre-commit hook is armed. This module asks which hooks a staged diff
# selects; a second stage's block in the transcript would be noise here, and is
# the subject of test_precommit_stage_selection instead.
_INSTALLED_HOOK_TYPES = ("pre-commit",)

# ``name.........................Failed`` / ``name...(no files to check)Skipped``
# Local rather than shared: the sibling module reads a hook's report lines, this
# one reads the trailing status text, and neither parse serves the other.
_RESULT_LINE_RE = re.compile(r"^(?P<name>.+?)\.{3,}(?P<tail>.*)$", re.MULTILINE)


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
class _Lane(Lane):
    """A shared lane, plus the real hooks this module mirrored into its config.

    Attributes:
        specs: The mirrored hooks, by id, so an assertion can name a hook by the
            display name the real config gives it.
    """

    specs: dict[str, _HookSpec]


def _mirrored_specs() -> dict[str, _HookSpec]:
    """Read the selection patterns of every mirrored hook from the real config.

    Returns:
        A mapping of hook id to its spec, in the order the ids are declared.
    """
    blocks = hook_blocks()
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
            name=field(block, "name") or hook_id,
            files=field(block, "files"),
            exclude=field(block, "exclude"),
            types=_PYTHON_TYPES if hook_id in _TYPE_SELECTED_HOOK_IDS else None,
        )
    return specs


def _hook_yaml(spec: _HookSpec) -> list[str]:
    """Render one stand-in hook that fails loudly whenever it is selected.

    Args:
        spec: The real hook to mirror.

    Returns:
        The YAML lines declaring the stand-in.
    """
    lines = [
        f"      - id: {spec.hook_id}",
        f"        name: {yaml_scalar(spec.name)}",
        "        language: system",
        f"        entry: {yaml_scalar(_ALWAYS_FAILING_ENTRY)}",
        "        pass_filenames: false",
    ]
    if spec.files is not None:
        lines.append(f"        files: {yaml_scalar(spec.files)}")
    if spec.exclude is not None:
        lines.append(f"        exclude: {yaml_scalar(spec.exclude)}")
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
    inherited_exclude = global_exclude()
    if inherited_exclude is not None:
        lines.append(f"exclude: {yaml_scalar(inherited_exclude)}")
    lines.extend(["repos:", "  - repo: local", "    hooks:"])
    for spec in specs.values():
        lines.extend(_hook_yaml(spec))
    return "\n".join(lines) + "\n"


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
    write(worktree / _BACKEND_FILE, "VALUE = 3\n")
    git("add", _BACKEND_FILE, cwd=worktree, env=env)
    git("commit", "-m", "chore: lane edit", cwd=worktree, env=env)
    write(repo / _BACKEND_FILE, "VALUE = 2\n")
    write(repo / _FRONTEND_FILE, "export const a = 2;\n")
    git("add", "--all", cwd=repo, env=env)
    git("commit", "-m", "chore: main edit", cwd=repo, env=env)


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
    env = child_env(home, tmp_path / "pre-commit-store")
    specs = _mirrored_specs()
    repo = tmp_path / "repo"
    worktree = tmp_path / "lane"
    seed_repository(
        repo,
        env,
        config=_scratch_config(specs),
        files={
            _UNMATCHED_FILE: "scratch repository\n",
            _FRONTEND_FILE: "export const a = 1;\n",
            _BACKEND_FILE: "VALUE = 1\n",
        },
        author="Staged File Gate",
    )
    add_worktree(repo, worktree, env)
    _diverge(repo, worktree, env)
    install_hooks(repo, worktree, env, _INSTALLED_HOOK_TYPES)
    return _Lane(repo=repo, worktree=worktree, env=env, specs=specs)


def _result_tails(transcript: str) -> dict[str, str]:
    """Return each reported hook name mapped to its trailing status text.

    Args:
        transcript: A commit's combined transcript.

    Returns:
        A mapping such as ``{"frontend eslint": "(no files to check)Skipped"}``.
    """
    matches = _RESULT_LINE_RE.finditer(transcript)
    return {match.group("name"): match.group("tail") for match in matches}


def _assert_skipped_for_lack_of_files(
    lane: _Lane,
    transcript: str,
    hook_ids: Sequence[str],
) -> None:
    """Assert each named hook reported that the staged set gave it nothing to do.

    Args:
        lane: The lane whose specs supply each hook's display name.
        transcript: A commit's combined transcript.
        hook_ids: The hooks that must not have been selected.
    """
    tails = _result_tails(transcript)
    for hook_id in hook_ids:
        tail = tails.get(lane.specs[hook_id].name, "<hook not reported at all>")
        unselected = f"{hook_id} was not skipped for want of files:\n{transcript}"
        assert "no files to check" in tail, unselected
        assert tail.endswith("Skipped"), f"{hook_id} did not report Skipped:\n{transcript}"


class TestTheLaneIsALinkedWorktree:
    """The whole point is the worktree layout, so prove the fixture built one."""

    def test_the_lane_dot_git_is_a_file_not_a_directory(self, lane: _Lane) -> None:
        """A linked worktree's ``.git`` is a pointer file; a plain clone's is a dir."""
        assert (lane.worktree / ".git").is_file()

    def test_the_lane_git_dir_lives_under_the_shared_worktrees_directory(self, lane: _Lane) -> None:
        """This is the indirection the incident report blamed for the inversion."""
        git_dir = Path(git("rev-parse", "--git-dir", cwd=lane.worktree, env=lane.env))
        assert git_dir.parent.name == "worktrees"

    def test_the_lane_shares_the_hook_installed_in_the_main_checkout(self, lane: _Lane) -> None:
        """Hooks live in the common git dir, so installing from the lane arms both."""
        assert (lane.repo / ".git" / "hooks" / "pre-commit").is_file()


class TestStagedFilesDecideWhichHooksRun:
    """A commit's staged diff, and nothing wider, selects the hooks that run."""

    def test_a_frontend_only_commit_runs_only_the_frontend_hooks(self, lane: _Lane) -> None:
        """The inverse of the reported symptom: no Python staged, no Python hooks."""
        stage(lane, _FRONTEND_FILE, "export const a = 9;\n")
        before = head(lane)

        result = git_try("commit", "-m", "feat: frontend only", cwd=lane.worktree, env=lane.env)

        transcript = output(result)
        assert result.returncode != 0, transcript
        assert failing_hook_ids(transcript) == set(_FRONTEND_HOOK_IDS), transcript
        _assert_skipped_for_lack_of_files(
            lane,
            transcript,
            _BACKEND_HOOK_IDS + _TYPE_SELECTED_HOOK_IDS,
        )
        assert head(lane) == before, "a failing gate still let the commit land"

    def test_a_python_only_commit_runs_only_the_backend_hooks(self, lane: _Lane) -> None:
        """The reported symptom itself: no frontend staged, no frontend hooks."""
        stage(lane, _BACKEND_FILE, "VALUE = 9\n")
        before = head(lane)

        result = git_try("commit", "-m", "feat: backend only", cwd=lane.worktree, env=lane.env)

        transcript = output(result)
        assert result.returncode != 0, transcript
        expected = set(_BACKEND_HOOK_IDS) | set(_TYPE_SELECTED_HOOK_IDS)
        assert failing_hook_ids(transcript) == expected, transcript
        _assert_skipped_for_lack_of_files(lane, transcript, _FRONTEND_HOOK_IDS)
        assert head(lane) == before, "a failing gate still let the commit land"

    def test_a_commit_matching_no_hook_is_gated_by_nothing_and_lands(self, lane: _Lane) -> None:
        """The control: without this, a config that always failed would pass above."""
        stage(lane, _UNMATCHED_FILE, "scratch repository, edited\n")
        before = head(lane)

        result = git_try("commit", "-m", "docs: readme only", cwd=lane.worktree, env=lane.env)

        transcript = output(result)
        assert result.returncode == 0, transcript
        assert failing_hook_ids(transcript) == set(), transcript
        _assert_skipped_for_lack_of_files(lane, transcript, _MIRRORED_HOOK_IDS)
        assert head(lane) != before, "the commit did not land"


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
        merge = git_try("merge", "main", cwd=lane.worktree, env=lane.env)
        assert merge.returncode != 0, "the merge was expected to conflict"
        git_dir = Path(git("rev-parse", "--absolute-git-dir", cwd=lane.worktree, env=lane.env))
        assert (git_dir / "MERGE_HEAD").is_file()

        stage(lane, _BACKEND_FILE, "VALUE = 4\n")
        assert staged_paths(lane) == {_BACKEND_FILE, _FRONTEND_FILE}
        before = head(lane)

        result = git_try("commit", "--no-edit", cwd=lane.worktree, env=lane.env)

        transcript = output(result)
        assert result.returncode != 0, transcript
        expected = set(_BACKEND_HOOK_IDS) | set(_TYPE_SELECTED_HOOK_IDS)
        assert failing_hook_ids(transcript) == expected, transcript
        _assert_skipped_for_lack_of_files(lane, transcript, _FRONTEND_HOOK_IDS)
        assert head(lane) == before, "a failing gate still let the merge commit land"
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
