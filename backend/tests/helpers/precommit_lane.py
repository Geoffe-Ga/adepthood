"""A scratch git repository with a linked worktree and real pre-commit hooks.

Two meta-tests observe how ``.pre-commit-config.yaml`` behaves during a real
``git commit``: ``tests/scripts/test_precommit_staged_file_gating`` asks *which
hooks a staged diff selects*, and ``tests/scripts/test_precommit_stage_selection``
asks *which stages each hook runs at*. They ask different questions and their
stand-in hooks are deliberately different -- one can only ever fail, the other
passes or fails on the staged file's content -- but the apparatus underneath is
the same: a sanitised environment, a scratch repository, a linked worktree,
installed hooks, and a handful of readers for the real config's text.

That apparatus lives here so it exists once. It was duplicated across those two
modules to the tune of 242 identical lines, including an 88-line verbatim run,
and the most load-bearing of those lines is the environment sanitisation. Safety
logic that exists twice is safety logic that gets fixed once.

The sanitisation itself is not reimplemented here either. ``child_env`` delegates
the ``GIT_*`` strip to ``tests.helpers.git_env.detached_git_env``, which is the
repository's single account of why it matters: a leaked ``GIT_DIR`` from a git
fixture once wrote commits onto a live feature branch and set ``core.bare=true``
on the shared checkout. Both meta-tests previously hand-rolled that strip, which
made three copies of one rule, and left them outside the invariant
``detached_git_env``'s own docstring states -- that every fixture in this
repository which shells out to git builds its environment there.

The config readers parse ``.pre-commit-config.yaml`` as plain text rather than
with PyYAML. PyYAML is absent from every requirements file on purpose, so
``import yaml`` would turn both meta-tests into a collection error on the
``backend-compat`` job instead of a passing check.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

from tests.helpers.git_env import detached_git_env

REPO_ROOT = Path(__file__).resolve().parents[3]
REAL_CONFIG = REPO_ROOT / ".pre-commit-config.yaml"

# Long enough for a real ``git commit`` that installs and runs hooks, short
# enough that a hung subprocess fails the suite instead of stalling CI.
SUBPROCESS_TIMEOUT_SECONDS = 180

# Environment keys dropped on top of the ``GIT_*`` strip. ``PRE_COMMIT_*`` would
# point the scratch lane at the developer's shared store; ``SKIP`` would make
# pre-commit skip a hook for a reason no caller here may confuse with "this
# stage did not select it" or "there were no files to check".
_PRE_COMMIT_ENV_PREFIX = "PRE_COMMIT_"
_SKIP_ENV = "SKIP"

# ``- id: x`` / ``- repo: y`` -- the two things that end a hook's block.
_HOOK_BOUNDARY_RE = re.compile(r"^[ \t]*- (?:id|repo):", re.MULTILINE)
_HOOK_ID_RE = re.compile(r"^[ \t]*- id:[ \t]*(?P<hook_id>\S+)[ \t]*$", re.MULTILINE)

# The top-level ``exclude:`` applying to every hook, anchored at column zero.
_GLOBAL_EXCLUDE_RE = re.compile(r"^exclude:[ \t]*(?P<value>[^\s#]+)[ \t]*$", re.MULTILINE)

# pre-commit prints this only for hooks that actually ran and failed.
_FAILING_ID_RE = re.compile(r"^- hook id:[ \t]*(?P<hook_id>\S+)[ \t]*$", re.MULTILINE)


@dataclass(frozen=True)
class Lane:
    """A scratch repository with a linked worktree and installed hooks.

    Subclass it to carry whatever else a particular meta-test needs alongside;
    the three fields here are what every helper below reads.

    Attributes:
        repo: The main checkout, holding the shared ``.git`` directory.
        worktree: The linked worktree every assertion commits from.
        env: The sanitised environment every subprocess is given.
    """

    repo: Path
    worktree: Path
    env: dict[str, str]


def real_config_text() -> str:
    """Return the repository's own pre-commit config as text.

    Returns:
        The raw contents of ``.pre-commit-config.yaml``.
    """
    return REAL_CONFIG.read_text(encoding="utf-8")


def global_exclude() -> str | None:
    """Return the top-level ``exclude:`` every hook in the real config inherits.

    Returns:
        The pattern, or None when the config declares none.
    """
    match = _GLOBAL_EXCLUDE_RE.search(real_config_text())
    return match.group("value") if match is not None else None


def hook_blocks() -> dict[str, str]:
    """Return every hook's config block, keyed by hook id.

    Returns:
        A mapping of hook id to the raw text from its ``- id:`` line up to the
        next hook or repo, which is what that hook's own keys live in.
    """
    text = real_config_text()
    boundaries = [match.start() for match in _HOOK_BOUNDARY_RE.finditer(text)]
    blocks: dict[str, str] = {}
    for match in _HOOK_ID_RE.finditer(text):
        following = [position for position in boundaries if position > match.start()]
        end = following[0] if following else len(text)
        blocks[match.group("hook_id")] = text[match.start() : end]
    return blocks


def hook_block(hook_id: str) -> str:
    """Return one hook's config block, failing the test when it is gone.

    Args:
        hook_id: The hook to look up.

    Returns:
        The raw text of that hook's block.
    """
    block = hook_blocks().get(hook_id)
    if block is None:
        pytest.fail(
            f"{hook_id} is no longer declared in .pre-commit-config.yaml, so the "
            f"meta-test asking for it is silently no longer covering it.",
        )
    return block


def field(block: str, key: str) -> str | None:
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


def yaml_scalar(value: str) -> str:
    """Quote a value as a YAML single-quoted scalar.

    Args:
        value: The raw value, typically a regex full of backslashes.

    Returns:
        The value quoted so YAML reads it literally.
    """
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def git_executable() -> str:
    """Return an absolute path to git, failing the test if there is none.

    Returns:
        The resolved path, so no subprocess relies on a partial executable name.
    """
    found = shutil.which("git")
    if found is None:
        pytest.fail("git is required to exercise pre-commit's hook selection")
    return found


def child_env(home: Path, store: Path) -> dict[str, str]:
    """Build the only environment a scratch lane's subprocesses may see.

    The ``GIT_*`` strip is delegated to ``detached_git_env`` rather than repeated
    here, so this repository keeps one account of why ambient git state must
    never reach a fixture. ``HOME`` and ``XDG_CONFIG_HOME`` are redirected on top
    of it so the developer's global git config cannot change an outcome, and
    ``PRE_COMMIT_HOME`` so the shared hook store is never touched.

    Args:
        home: A scratch directory to use as ``HOME``.
        store: A scratch directory for pre-commit's own store.

    Returns:
        The environment dict to pass to every subprocess in the lane.
    """
    env = {
        key: value
        for key, value in detached_git_env().items()
        if not key.startswith(_PRE_COMMIT_ENV_PREFIX) and key != _SKIP_ENV
    }
    env["HOME"] = str(home)
    env["XDG_CONFIG_HOME"] = str(home / "config")
    env["PRE_COMMIT_HOME"] = str(store)
    return env


def run(
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
        timeout=SUBPROCESS_TIMEOUT_SECONDS,
    )


def git_try(*args: str, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Run a git command whose exit code is part of what is being asserted.

    Args:
        *args: The git arguments.
        cwd: The directory to run in.
        env: The sanitised environment.

    Returns:
        The completed process.
    """
    return run([git_executable(), *args], cwd=cwd, env=env)


def git(*args: str, cwd: Path, env: dict[str, str]) -> str:
    """Run a git command that setup depends on, failing the test if it errors.

    Args:
        *args: The git arguments.
        cwd: The directory to run in.
        env: The sanitised environment.

    Returns:
        The command's stdout, stripped.
    """
    result = git_try(*args, cwd=cwd, env=env)
    if result.returncode != 0:
        pytest.fail(f"git {' '.join(args)} failed in {cwd}:\n{result.stdout}{result.stderr}")
    return result.stdout.strip()


def write(path: Path, text: str) -> None:
    """Write a file, creating its parent directories.

    Args:
        path: The file to write.
        text: Its contents.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def seed_repository(
    repo: Path,
    env: dict[str, str],
    *,
    config: str,
    files: Mapping[str, str],
    author: str,
) -> None:
    """Create the scratch repository and its base commit.

    Signing is disabled explicitly: the developer's global config may turn it on,
    and a scratch repository has no key.

    Args:
        repo: The directory to initialise.
        env: The sanitised environment.
        config: The scratch pre-commit config to commit.
        files: Paths relative to the repository root, mapped to their contents.
        author: The committer name, so a stray fixture commit names its origin.
    """
    repo.mkdir(parents=True)
    git("init", "-b", "main", cwd=repo, env=env)
    git("config", "user.email", "gate@example.invalid", cwd=repo, env=env)
    git("config", "user.name", author, cwd=repo, env=env)
    git("config", "commit.gpgsign", "false", cwd=repo, env=env)
    write(repo / ".pre-commit-config.yaml", config)
    for relative_path, contents in files.items():
        write(repo / relative_path, contents)
    git("add", "--all", cwd=repo, env=env)
    git("commit", "-m", "chore: base", cwd=repo, env=env)


def add_worktree(repo: Path, worktree: Path, env: dict[str, str]) -> None:
    """Attach a linked worktree, the layout both meta-tests are about.

    Args:
        repo: The main checkout.
        worktree: The path to create the lane at.
        env: The sanitised environment.
    """
    git("worktree", "add", "-b", "lane", str(worktree), "main", cwd=repo, env=env)


def install_hooks(
    repo: Path,
    worktree: Path,
    env: dict[str, str],
    hook_types: Sequence[str],
) -> None:
    """Install the named real git hooks, from inside the worktree.

    Which hooks are armed is the caller's decision and it changes what a
    transcript can show, so it is never defaulted here.

    Args:
        repo: The main checkout, whose shared hooks directory git actually uses.
        worktree: The linked worktree to run the installer from.
        env: The sanitised environment.
        hook_types: The git hook types to install, e.g. ``("pre-commit",)``.
    """
    argv = ["-m", "pre_commit", "install"]
    for hook_type in hook_types:
        argv.extend(["--hook-type", hook_type])
    result = run([sys.executable, *argv], cwd=worktree, env=env)
    if result.returncode != 0:
        pytest.fail(f"pre-commit install failed:\n{result.stdout}{result.stderr}")
    for hook_type in hook_types:
        hook = repo / ".git" / "hooks" / hook_type
        if not hook.is_file():
            pytest.fail(f"pre-commit installed no {hook_type} hook at {hook}")


def output(result: subprocess.CompletedProcess[str]) -> str:
    """Return both captured streams, since pre-commit's report spans them.

    Args:
        result: A completed process whose streams were captured.

    Returns:
        stdout followed by stderr.
    """
    return f"{result.stdout}{result.stderr}"


def failing_hook_ids(transcript: str) -> set[str]:
    """Return the ids of every hook that actually ran and failed.

    Args:
        transcript: A commit's combined output.

    Returns:
        The hook ids pre-commit attributed a failure to.
    """
    return {match.group("hook_id") for match in _FAILING_ID_RE.finditer(transcript)}


def head(lane: Lane) -> str:
    """Return the worktree's current commit.

    Args:
        lane: The lane to inspect.

    Returns:
        The full object name of HEAD.
    """
    return git("rev-parse", "HEAD", cwd=lane.worktree, env=lane.env)


def stage(lane: Lane, relative_path: str, contents: str) -> None:
    """Write a file in the worktree and stage exactly it.

    Args:
        lane: The lane to work in.
        relative_path: The path to write, relative to the worktree root.
        contents: The new contents.
    """
    write(lane.worktree / relative_path, contents)
    git("add", "--", relative_path, cwd=lane.worktree, env=lane.env)


def staged_paths(lane: Lane) -> set[str]:
    """Return the paths the next commit would carry.

    Args:
        lane: The lane to inspect.

    Returns:
        Every path in the index that differs from HEAD.
    """
    listing = git("diff", "--cached", "--name-only", cwd=lane.worktree, env=lane.env)
    return set(listing.split())
