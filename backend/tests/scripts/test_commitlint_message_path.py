"""The commit-msg gate lints the message file it was handed, not another one.

pre-commit appends the matched filenames to the argv of ``bash -c <script>``,
where the FIRST one binds to ``$0`` and not to ``$1``. The commitlint hook entry
shipped as ``--edit "$1"``, so the argument was always the empty string, and
``--edit ""`` makes commitlint fall back to the git directory's
``COMMIT_EDITMSG`` -- resolved through git rather than through the cwd, so it
survives the entry's ``cd frontend``.

The consequence is asymmetric, which is why it survived. A real ``git commit``
is still gated, because git writes the message the developer typed into exactly
that fallback file. But ``pre-commit run --hook-stage commit-msg
--commit-msg-filename X`` silently lints ``COMMIT_EDITMSG`` instead of ``X``:
measured at the broken revision, an unconventional message in a file outside the
repository reported ``Passed`` while a good ambient message sat in
``COMMIT_EDITMSG``, and a good message file reported ``Failed`` while echoing
the ambient text back. A gate that reads a different file than the one it was
handed is worse than no gate, because it returns a verdict about the wrong
input.

``pre_commit.main._adjust_args_and_chdir`` chdirs to the git toplevel and then
relativises the commit-msg filename, so what arrives in ``$0`` is relative to
the toplevel -- a ``../..`` chain for a file outside the repository. It has to be
made absolute BEFORE the ``cd frontend``, which is what the static tier below
pins and what the behavioural tier proves, by naming a message file that lives
outside the scratch repository entirely.

Two tiers, because the two halves have different reach:

* The static tier reads the real ``entry:`` scalar and asserts its shape. It
  runs everywhere, including the backend jobs that have no node at all, so the
  module is never vacuous.
* The behavioural tier builds a scratch repository whose config carries that
  same ``entry:`` scalar byte for byte, and runs the real commitlint through the
  real pre-commit against it. Nothing is mocked: a stand-in commitlint would be
  a re-implementation of the very fallback semantics in dispute, and would
  prove nothing about them.

The config is parsed as plain text rather than with PyYAML, matching
``test_pre_push_hook_installation`` and ``test_precommit_staged_file_gating``.
PyYAML is named in no requirements file: it is installed only as a transitive of
bandit, pre-commit, schemathesis and xenon, so a guard that imported it would
rest on something nothing here pins, and any bump that dropped it would turn
this module into a collection error rather than a failing check. Reading the
entry as text is also closer to what is being asserted, since what pre-commit
runs is the scalar's literal bytes.

Every subprocess is given an explicit ``cwd`` and an explicit environment with
all ``GIT_*`` and ``PRE_COMMIT_*`` variables stripped. A leaked ``GIT_DIR`` from
a git fixture has already once written into the real repository here and set
``core.bare=true``; nothing in this module may inherit git's ambient state.
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
_GUARD_SCRIPT = _REPO_ROOT / "scripts" / "frontend" / "require-node-modules.sh"
_REAL_NODE_MODULES = _REPO_ROOT / "frontend" / "node_modules"
_COMMITLINT_BIN = _REAL_NODE_MODULES / ".bin" / "commitlint"

_SUBPROCESS_TIMEOUT_SECONDS = 180
_EXECUTABLE_BITS = 0o755

_HOOK_ID = "commitlint"

# The guard every frontend hook entry runs first, spelled repo-root-relative
# because pre-commit runs hooks with the repo root as cwd.
_GUARD_ENTRY = "scripts/frontend/require-node-modules.sh"

# The point in the entry after which a relative message path no longer resolves.
_CD_FRONTEND = "cd frontend"

# commitlint prints this immediately before the message text it actually read,
# which is how the behavioural tier tells which file was linted.
_INPUT_MARKER = "--- input ---"

_BAD_MESSAGE = "totally unconventional message"
_GOOD_MESSAGE = "chore: a good one"
_BAD_AMBIENT = "totally unconventional ambient"
_GOOD_AMBIENT = "chore: a good ambient one"

# The entry exactly as it shipped while the defect was live, and one shape that
# fixes it. Both exist only to prove the detectors below are not vacuous.
_SHIPPING_BROKEN_ENTRY = (
    "bash -c 'scripts/frontend/require-node-modules.sh && cd frontend && "
    "./node_modules/.bin/commitlint --extends @commitlint/config-conventional "
    '--edit "$1"\''
)
_A_FIXED_ENTRY = (
    "bash -c 'scripts/frontend/require-node-modules.sh && "
    'message_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" && '
    "cd frontend && ./node_modules/.bin/commitlint "
    '--extends @commitlint/config-conventional --edit "$message_path"\''
)
# The half-fix: it reaches for $0, but only after the cwd has already moved, so
# the relative path pre-commit hands over no longer resolves.
_A_HALF_FIXED_ENTRY = (
    "bash -c 'scripts/frontend/require-node-modules.sh && cd frontend && "
    "./node_modules/.bin/commitlint --extends @commitlint/config-conventional "
    '--edit "$0"\''
)

# ``- id: x`` / ``- repo: y`` -- the two things that end a hook's block.
_HOOK_BOUNDARY_RE = re.compile(r"^[ \t]*- (?:id|repo):", re.MULTILINE)
_HOOK_ID_RE = re.compile(r"^[ \t]*- id:[ \t]*(?P<hook_id>\S+)[ \t]*$", re.MULTILINE)

# ``entry:`` carries a plain YAML scalar here, so the text after the key is the
# value verbatim -- which is what makes reusing it downstream a regression lock
# rather than a re-implementation.
_ENTRY_RE = re.compile(r"^[ \t]+entry:[ \t]*(?P<entry>.+?)[ \t]*$", re.MULTILINE)

# The argument handed to ``--edit``: a double-quoted word if there is one, so
# the closing quote of the surrounding ``bash -c '...'`` is not swept in.
_EDIT_ARGUMENT_RE = re.compile(r"--edit[ \t]+(?P<argument>\"[^\"]*\"|\S+)")

# ``$1`` .. ``$9``, in either brace form. pre-commit binds the first filename to
# $0, so every one of these is empty in a ``bash -c`` entry.
_UNBOUND_POSITIONAL_RE = re.compile(r"\$\{?[1-9]")

# ``$0``, in either brace form: the argument that does carry the message path.
_FIRST_ARGUMENT_RE = re.compile(r"\$\{?0")

# A NAMED variable reference, quoted or bare. Deliberately excludes the
# positionals: ``"$1"`` is a syntactically valid non-empty reference and was the
# defect, and a bare ``$0`` is still the toplevel-relative path, so a detector
# that accepted either could not tell the broken entry from a fixed one.
_VARIABLE_REFERENCE_RE = re.compile(r"^\"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\"?$")

# ``npx`` in command position, which resolves a tool off the network.
_BARE_NPX_RE = re.compile(r"(?:^|[\s;&|(`])npx\s")

# ``pass_filenames: false`` on a hook. A commit-msg hook that opts out of
# filenames is handed no message path at all, which is the same silence the
# defect produced by another route.
_PASS_FILENAMES_OFF_RE = re.compile(r"^[ \t]+pass_filenames:[ \t]*false[ \t]*$", re.MULTILINE)

_NO_COMMITLINT_REASON = (
    "frontend/node_modules/.bin/commitlint is absent. The backend-quality job "
    "installs no node, and the commit-msg stage never runs in CI at all, so this "
    "gate's only enforcement surfaces are the local git commit and the pre-push "
    "suite. The static tier in this module still runs everywhere."
)

_requires_commitlint = pytest.mark.skipif(
    not _COMMITLINT_BIN.exists(),
    reason=_NO_COMMITLINT_REASON,
)


@dataclass(frozen=True)
class _Scratch:
    """A throwaway repository carrying the real hook entry.

    Attributes:
        repo: The scratch repository, with the commit-msg hook installed.
        git_dir: Its git directory, which holds the ambient COMMIT_EDITMSG.
        messages: A directory OUTSIDE the repository holding message files.
        env: The sanitised environment every subprocess is given.
    """

    repo: Path
    git_dir: Path
    messages: Path
    env: dict[str, str]


def _real_config_text() -> str:
    """Return the repository's own pre-commit config as text.

    Returns:
        The raw contents of ``.pre-commit-config.yaml``.
    """
    return _REAL_CONFIG.read_text(encoding="utf-8")


def _block_end(text: str, start: int) -> int:
    """Return where the hook block beginning at ``start`` ends.

    Args:
        text: The whole config.
        start: The offset of the block's ``- id:`` line.

    Returns:
        The offset of the next hook or repo, or the end of the config.
    """
    boundary = _HOOK_BOUNDARY_RE.search(text, start + 1)
    return boundary.start() if boundary is not None else len(text)


def _hook_blocks() -> dict[str, str]:
    """Return every hook's config block, keyed by hook id.

    Returns:
        A mapping of hook id to the raw text from its ``- id:`` line up to the
        next hook or repo, which is what that hook's own keys live in.
    """
    text = _real_config_text()
    return {
        match.group("hook_id"): text[match.start() : _block_end(text, match.start())]
        for match in _HOOK_ID_RE.finditer(text)
    }


def _hook_block(hook_id: str) -> str:
    """Return one hook's config block, failing the test when it is gone.

    Args:
        hook_id: The hook to locate.

    Returns:
        The raw text of that hook's block.
    """
    block = _hook_blocks().get(hook_id)
    if block is None:
        pytest.fail(f"{hook_id} is no longer declared in .pre-commit-config.yaml")
    return block


def _commitlint_entry() -> str:
    """Return the commitlint hook's ``entry:`` scalar, verbatim.

    Returns:
        The command line pre-commit runs for the commit-msg stage.
    """
    match = _ENTRY_RE.search(_hook_block(_HOOK_ID))
    if match is None:
        pytest.fail(f"the {_HOOK_ID} hook declares no entry:, so nothing gates a message")
    return match.group("entry")


def _edit_argument(entry: str) -> str:
    """Return the argument an entry hands to commitlint's ``--edit``.

    Args:
        entry: A hook entry command line.

    Returns:
        The argument as written, quotes included.
    """
    match = _EDIT_ARGUMENT_RE.search(entry)
    if match is None:
        pytest.fail(f"no --edit argument in the entry, so no message file is named: {entry}")
    return match.group("argument")


def _hands_a_positional_pre_commit_never_binds(entry: str) -> bool:
    """Report whether ``--edit`` is given a positional that is always empty.

    Args:
        entry: A hook entry command line.

    Returns:
        True when the argument reads $1..$9, which no filename ever binds to.
    """
    return bool(_UNBOUND_POSITIONAL_RE.search(_edit_argument(entry)))


def _absolutises_before_entering_frontend(entry: str) -> bool:
    """Report whether the message path is resolved while the cwd still fits it.

    Args:
        entry: A hook entry command line.

    Returns:
        True when $0 is reached before the ``cd frontend`` and never after it.
    """
    head, separator, tail = entry.partition(_CD_FRONTEND)
    if not separator:
        return False
    return bool(_FIRST_ARGUMENT_RE.search(head)) and not _FIRST_ARGUMENT_RE.search(tail)


def _edit_argument_is_a_variable_reference(entry: str) -> bool:
    """Report whether ``--edit`` is given a named variable holding the path.

    Args:
        entry: A hook entry command line.

    Returns:
        True when the argument is a named variable -- not an empty word, and
        not a positional, which is either empty or still relative.
    """
    return bool(_VARIABLE_REFERENCE_RE.match(_edit_argument(entry)))


def _scratch_config(entry: str) -> str:
    """Render a one-hook config carrying the real entry byte for byte.

    Args:
        entry: The commitlint entry read out of the real config.

    Returns:
        A complete ``.pre-commit-config.yaml`` for the scratch repository.
    """
    return (
        "\n".join(
            [
                "repos:",
                "  - repo: local",
                "    hooks:",
                f"      - id: {_HOOK_ID}",
                "        name: commitlint (conventional commits)",
                "        language: system",
                f"        entry: {entry}",
                "        stages: [commit-msg]",
            ],
        )
        + "\n"
    )


def _git_executable() -> str:
    """Return an absolute path to git, failing the test if there is none.

    Returns:
        The resolved path, so no subprocess relies on a partial executable name.
    """
    found = shutil.which("git")
    if found is None:
        pytest.fail("git is required to exercise the commit-msg gate")
    return found


def _child_env(home: Path, store: Path) -> dict[str, str]:
    """Build the only environment any subprocess in this module may see.

    Every ``GIT_*`` variable is stripped so no ambient git state -- a leaked
    ``GIT_DIR`` above all -- can redirect a command at the real repository.
    ``HOME`` and ``XDG_CONFIG_HOME`` are redirected so a global git config
    cannot change the outcome, ``PRE_COMMIT_HOME`` so the shared store is never
    touched, and ``SKIP`` is dropped because it would make pre-commit skip the
    one hook these tests exist to run.

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
        text: Its contents, to which a trailing newline is added.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{text}\n", encoding="utf-8")


def _install_frontend_tree(repo: Path) -> None:
    """Give the scratch repository the two things the real entry reaches for.

    The guard script is copied rather than reimplemented, and it derives the
    frontend directory from its own location, so it checks the scratch tree.
    ``node_modules`` is symlinked to the real one: this is the real commitlint
    running, and its config is resolved out of that same tree.

    Args:
        repo: The scratch repository root.
    """
    guard = repo / "scripts" / "frontend" / _GUARD_SCRIPT.name
    guard.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(_GUARD_SCRIPT, guard)
    guard.chmod(_EXECUTABLE_BITS)
    frontend = repo / "frontend"
    frontend.mkdir(parents=True, exist_ok=True)
    (frontend / "node_modules").symlink_to(_REAL_NODE_MODULES)


def _seed_repository(repo: Path, env: dict[str, str]) -> None:
    """Create the scratch repository and commit its config.

    pre-commit refuses to run at all against an unstaged config, so the config
    and the guard script are committed. The ``node_modules`` symlink is
    deliberately left untracked -- it points outside the repository.

    Args:
        repo: The directory to initialise.
        env: The sanitised environment.
    """
    repo.mkdir(parents=True)
    _git("init", "-b", "main", cwd=repo, env=env)
    _git("config", "user.email", "gate@example.invalid", cwd=repo, env=env)
    _git("config", "user.name", "Commit Message Gate", cwd=repo, env=env)
    _git("config", "commit.gpgsign", "false", cwd=repo, env=env)
    _install_frontend_tree(repo)
    (repo / ".pre-commit-config.yaml").write_text(
        _scratch_config(_commitlint_entry()),
        encoding="utf-8",
    )
    _git("add", "--", ".pre-commit-config.yaml", "scripts", cwd=repo, env=env)
    _git("commit", "-m", "chore: base", cwd=repo, env=env)


def _install_commit_msg_hook(repo: Path, env: dict[str, str]) -> None:
    """Arm the scratch repository's commit-msg hook.

    Args:
        repo: The scratch repository.
        env: The sanitised environment.
    """
    result = _run(
        [sys.executable, "-m", "pre_commit", "install", "--hook-type", "commit-msg"],
        cwd=repo,
        env=env,
    )
    if result.returncode != 0:
        pytest.fail(f"pre-commit install failed:\n{result.stdout}{result.stderr}")
    hook = repo / ".git" / "hooks" / "commit-msg"
    if not hook.is_file():
        pytest.fail(f"no hook at {hook}; a real commit would be gated by nothing")


@pytest.fixture(scope="module")
def scratch(tmp_path_factory: pytest.TempPathFactory) -> _Scratch:
    """Build the scratch repository once; real commitlint is slow to start.

    Args:
        tmp_path_factory: pytest's session-scoped scratch directory factory.

    Returns:
        The repository every behavioural assertion runs against.
    """
    base = tmp_path_factory.mktemp("commitlint-message-path")
    home = base / "home"
    home.mkdir()
    messages = base / "messages"
    messages.mkdir()
    env = _child_env(home, base / "pre-commit-store")
    repo = base / "repo"
    _seed_repository(repo, env)
    _install_commit_msg_hook(repo, env)
    git_dir = Path(_git("rev-parse", "--absolute-git-dir", cwd=repo, env=env))
    return _Scratch(repo=repo, git_dir=git_dir, messages=messages, env=env)


def _output(result: subprocess.CompletedProcess[str]) -> str:
    """Return both captured streams, since the hook report spans them.

    Args:
        result: A completed process whose streams were captured.

    Returns:
        stdout followed by stderr.
    """
    return f"{result.stdout}{result.stderr}"


def _linted_input(output: str) -> str:
    """Return the message text commitlint reported it had actually read.

    Args:
        output: A hook run's combined output.

    Returns:
        Everything after commitlint's input marker, or "" when it printed none.
    """
    _, separator, tail = output.partition(_INPUT_MARKER)
    return tail if separator else ""


def _set_ambient(scratch: _Scratch, message: str) -> None:
    """Plant the message commitlint falls back to when it is given no file.

    Args:
        scratch: The scratch repository.
        message: The text to write to the git directory's COMMIT_EDITMSG.
    """
    _write(scratch.git_dir / "COMMIT_EDITMSG", message)


def _message_file(scratch: _Scratch, name: str, message: str) -> Path:
    """Write a message file outside the repository and return its path.

    Outside is the point: pre-commit relativises the commit-msg filename against
    the git toplevel, so a path outside arrives as a ``../`` chain that only
    resolves before the entry's ``cd frontend``.

    Args:
        scratch: The scratch repository.
        name: The file name, unique per test so the tests stay independent.
        message: The commit message to write.

    Returns:
        The absolute path to the written file.
    """
    path = scratch.messages / name
    _write(path, message)
    return path


def _lint(scratch: _Scratch, message_path: Path) -> subprocess.CompletedProcess[str]:
    """Run the commit-msg stage against one named message file.

    Args:
        scratch: The scratch repository.
        message_path: The file the hook is being told to lint.

    Returns:
        The completed pre-commit run.
    """
    return _run(
        [
            sys.executable,
            "-m",
            "pre_commit",
            "run",
            _HOOK_ID,
            "--hook-stage",
            "commit-msg",
            "--commit-msg-filename",
            str(message_path),
        ],
        cwd=scratch.repo,
        env=scratch.env,
    )


def _head(scratch: _Scratch) -> str:
    """Return the scratch repository's current commit.

    Args:
        scratch: The scratch repository.

    Returns:
        The full object name of HEAD.
    """
    return _git("rev-parse", "HEAD", cwd=scratch.repo, env=scratch.env)


def _commit(scratch: _Scratch, name: str, message: str) -> subprocess.CompletedProcess[str]:
    """Stage one file and commit it through the installed hook.

    The index is emptied afterwards whatever the verdict, so a rejected commit
    cannot leave its file staged for whichever test runs next against this
    module-scoped repository.

    Args:
        scratch: The scratch repository.
        name: A file name unique to the calling test.
        message: The commit message to submit.

    Returns:
        The completed git commit, whose exit code is the gate's verdict.
    """
    _write(scratch.repo / name, "content")
    _git("add", "--", name, cwd=scratch.repo, env=scratch.env)
    result = _git_try("commit", "-m", message, cwd=scratch.repo, env=scratch.env)
    _git("reset", "--quiet", cwd=scratch.repo, env=scratch.env)
    return result


class TestTheDetectorsAreNonVacuous:
    """A shape check that cannot tell the broken shape from the fixed one is noise."""

    def test_the_edit_argument_is_read_off_the_broken_entry_exactly(self) -> None:
        """The trailing quote of the surrounding bash -c must not be swept in."""
        assert _edit_argument(_SHIPPING_BROKEN_ENTRY) == '"$1"'

    def test_the_edit_argument_is_read_off_a_fixed_entry_exactly(self) -> None:
        """A named variable is the shape a fix reaches for."""
        assert _edit_argument(_A_FIXED_ENTRY) == '"$message_path"'

    def test_the_unbound_positional_detector_fires_on_the_shape_that_shipped(self) -> None:
        """``--edit "$1"`` is the defect, spelled exactly as it was live."""
        assert _hands_a_positional_pre_commit_never_binds(_SHIPPING_BROKEN_ENTRY)

    def test_the_unbound_positional_detector_accepts_a_fixed_entry(self) -> None:
        """Otherwise the guard would reject every possible repair."""
        assert not _hands_a_positional_pre_commit_never_binds(_A_FIXED_ENTRY)

    def test_the_ordering_detector_rejects_the_shape_that_shipped(self) -> None:
        """The broken entry never reads $0 at all, so it cannot have absolutised it."""
        assert not _absolutises_before_entering_frontend(_SHIPPING_BROKEN_ENTRY)

    def test_the_ordering_detector_rejects_absolutising_after_the_cd(self) -> None:
        """The half-fix: $0 is a relative path, and the cwd it was relative to is gone."""
        assert not _absolutises_before_entering_frontend(_A_HALF_FIXED_ENTRY)

    def test_the_ordering_detector_accepts_a_fixed_entry(self) -> None:
        """Resolved first, then the cd -- which is the only order that works."""
        assert _absolutises_before_entering_frontend(_A_FIXED_ENTRY)

    def test_the_variable_reference_detector_rejects_an_empty_argument(self) -> None:
        """``--edit ""`` is the fallback trigger, written out in full."""
        assert not _edit_argument_is_a_variable_reference('cmd --edit "" --extends x')

    def test_the_variable_reference_detector_rejects_the_shape_that_shipped(self) -> None:
        """``"$1"`` is a valid reference and still the defect, so it must not pass."""
        assert not _edit_argument_is_a_variable_reference(_SHIPPING_BROKEN_ENTRY)

    def test_the_variable_reference_detector_rejects_a_raw_positional(self) -> None:
        """Handing $0 straight through leaves a toplevel-relative path after the cd."""
        assert not _edit_argument_is_a_variable_reference(_A_HALF_FIXED_ENTRY)

    def test_the_variable_reference_detector_accepts_a_fixed_entry(self) -> None:
        """A named variable holding the absolutised path is what should be there."""
        assert _edit_argument_is_a_variable_reference(_A_FIXED_ENTRY)


class TestTheEntryNamesTheMessageFileItWasGiven:
    """The static tier: the shape of the real entry, wherever this suite runs."""

    def test_the_entry_does_not_hand_edit_a_positional_that_is_never_bound(self) -> None:
        """pre-commit binds the first filename to $0, so $1 is the empty string."""
        entry = _commitlint_entry()
        assert not _hands_a_positional_pre_commit_never_binds(entry), (
            f"the commitlint entry hands --edit {_edit_argument(entry)}, which pre-commit "
            f"never binds. commitlint then falls back to COMMIT_EDITMSG and reports a "
            f"verdict about a file nobody named: {entry}"
        )

    def test_the_entry_reaches_for_the_argument_the_message_path_arrives_in(self) -> None:
        """$0, and nothing else, carries the commit-msg filename into a bash -c entry."""
        entry = _commitlint_entry()
        assert _FIRST_ARGUMENT_RE.search(entry), (
            f"the commitlint entry never reads $0, so the message path pre-commit "
            f"passed it is discarded: {entry}"
        )

    def test_the_message_path_is_absolutised_before_the_hook_enters_frontend(self) -> None:
        """pre-commit relativises the path against the toplevel; the cd invalidates it."""
        entry = _commitlint_entry()
        assert _absolutises_before_entering_frontend(entry), (
            f"$0 must be resolved to an absolute path before `{_CD_FRONTEND}`, since "
            f"pre-commit hands it over relative to the git toplevel: {entry}"
        )

    def test_the_edit_argument_is_a_non_empty_variable_reference(self) -> None:
        """An empty argument is exactly what triggers the COMMIT_EDITMSG fallback."""
        entry = _commitlint_entry()
        assert _edit_argument_is_a_variable_reference(entry), (
            f"--edit must be given a variable holding the message path, never an "
            f"empty word: {entry}"
        )


class TestTheEntryKeepsItsOtherGuarantees:
    """A fix to the message path must not quietly undo the rest of the entry."""

    def test_the_entry_still_clears_the_node_modules_guard_first(self) -> None:
        """Without it the hook dies as `command not found` and names the wrong thing."""
        assert _commitlint_entry().startswith(f"bash -c '{_GUARD_ENTRY}")

    def test_the_entry_still_runs_commitlint_from_inside_frontend(self) -> None:
        """That is where the pinned binary and its config both resolve from."""
        entry = _commitlint_entry()
        assert _CD_FRONTEND in entry
        assert "./node_modules/.bin/commitlint" in entry

    def test_the_entry_never_resolves_its_tool_through_npx(self) -> None:
        """A bare npx downloads and runs whatever the registry serves for that name."""
        assert not _BARE_NPX_RE.search(_commitlint_entry())

    def test_the_entry_is_a_single_line(self) -> None:
        """A folded scalar would change the argv, and every check above reads one line."""
        assert "\n" not in _commitlint_entry()

    def test_the_hook_is_still_handed_the_message_filename(self) -> None:
        """Turning filenames off would leave $0 empty again, by a different route."""
        assert not _PASS_FILENAMES_OFF_RE.search(_hook_block(_HOOK_ID)), (
            "the commitlint hook sets pass_filenames: false, so pre-commit passes it "
            "no message path at all and the entry has nothing to absolutise"
        )


class TestTheScratchConfigReusesTheRealEntry:
    """Reuse is what makes the behavioural tier a lock rather than a re-write."""

    def test_the_rendered_config_carries_the_entry_byte_for_byte(self) -> None:
        """Re-quoting or normalising it would test a command nobody ships."""
        entry = _commitlint_entry()
        assert f"        entry: {entry}\n" in _scratch_config(entry)

    def test_the_rendered_config_declares_the_commit_msg_stage(self) -> None:
        """A hook on another stage would never be reached by the runs below."""
        assert "stages: [commit-msg]" in _scratch_config(_commitlint_entry())


@_requires_commitlint
class TestTheScratchRepositoryIsHermetic:
    """The behavioural tier's conclusions rest on these four facts."""

    def test_the_message_files_live_outside_the_repository(self, scratch: _Scratch) -> None:
        """Inside the repo a relative path would survive the cd by accident."""
        path = _message_file(scratch, "hermetic.txt", _GOOD_MESSAGE)
        assert scratch.repo not in path.parents

    def test_the_committed_config_carries_the_real_entry(self, scratch: _Scratch) -> None:
        """Read back off disk, after git round-tripped it."""
        config = (scratch.repo / ".pre-commit-config.yaml").read_text(encoding="utf-8")
        assert _commitlint_entry() in config

    def test_the_node_modules_symlink_is_not_tracked(self, scratch: _Scratch) -> None:
        """Committing a link out of the tree would make the fixture unreproducible."""
        tracked = _git("ls-files", cwd=scratch.repo, env=scratch.env).split()
        assert "frontend/node_modules" not in tracked

    def test_the_real_commitlint_binary_is_the_one_reached(self, scratch: _Scratch) -> None:
        """Nothing is mocked here; the fallback semantics under test are commitlint's."""
        linked = (scratch.repo / "frontend" / "node_modules").resolve()
        assert linked == _REAL_NODE_MODULES.resolve()


@_requires_commitlint
class TestTheHookLintsTheFileItWasNamed:
    """The defect: the verdict described COMMIT_EDITMSG, whatever file was named."""

    def test_a_bad_message_is_rejected_even_when_the_ambient_message_is_good(
        self,
        scratch: _Scratch,
    ) -> None:
        """Measured at the broken revision: this reported Passed."""
        _set_ambient(scratch, _GOOD_AMBIENT)
        path = _message_file(scratch, "direction-a.txt", _BAD_MESSAGE)

        result = _lint(scratch, path)

        output = _output(result)
        assert result.returncode != 0, (
            f"the hook passed an unconventional message it was handed at {path}; it "
            f"linted the ambient COMMIT_EDITMSG instead:\n{output}"
        )
        linted = _linted_input(output)
        assert _BAD_MESSAGE in linted, f"the rejection is about some other text:\n{output}"
        assert _GOOD_AMBIENT not in linted, f"the ambient message was linted:\n{output}"

    def test_a_good_message_passes_even_when_the_ambient_message_is_bad(
        self,
        scratch: _Scratch,
    ) -> None:
        """The same defect from the other side: this reported Failed, and said why."""
        _set_ambient(scratch, _BAD_AMBIENT)
        path = _message_file(scratch, "direction-b.txt", _GOOD_MESSAGE)

        result = _lint(scratch, path)

        output = _output(result)
        assert _BAD_AMBIENT not in output, (
            f"the hook was handed {path} and echoed the ambient COMMIT_EDITMSG back "
            f"instead, naming the wrong file it read:\n{output}"
        )
        assert result.returncode == 0, f"a conventional message at {path} was rejected:\n{output}"


@_requires_commitlint
class TestARealCommitIsStillGated:
    """The surface developers depend on, and the one a careless fix breaks."""

    def test_an_unconventional_commit_message_is_rejected(self, scratch: _Scratch) -> None:
        """Committing writes the typed message to COMMIT_EDITMSG and hands over that path."""
        before = _head(scratch)

        result = _commit(scratch, "rejected.txt", _BAD_MESSAGE)

        output = _output(result)
        assert result.returncode != 0, f"an unconventional message landed:\n{output}"
        assert _BAD_MESSAGE in _linted_input(output), output
        assert _head(scratch) == before, "a failing gate still let the commit land"

    def test_a_conventional_commit_message_lands(self, scratch: _Scratch) -> None:
        """The control: without it, an always-failing hook would satisfy the test above."""
        before = _head(scratch)
        staged = _git("diff", "--cached", "--name-only", cwd=scratch.repo, env=scratch.env)
        assert not staged, f"an earlier test left {staged} staged, so this one is not isolated"

        result = _commit(scratch, "accepted.txt", _GOOD_MESSAGE)

        output = _output(result)
        assert result.returncode == 0, f"a conventional message was rejected:\n{output}"
        assert _head(scratch) != before, f"the commit did not land:\n{output}"
