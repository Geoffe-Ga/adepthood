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

The scratch lane -- sanitised environment, repository, linked worktree,
installed hooks, config readers -- comes from ``tests.helpers.precommit_lane``,
shared with ``test_precommit_staged_file_gating``. What is NOT shared is the
stand-in hook, and that is deliberate rather than an oversight. The sibling's
stand-ins can only ever fail, which is exactly right for asking *which hooks a
staged diff selects* and structurally incapable of observing what a SUCCESSFUL
commit prints after its pre-commit stage. The stand-in here passes or fails on
the content of the staged file, so a clean commit gets far enough to reach the
commit-msg stage at all.

Nothing here is mocked: real pre-commit and commit-msg git hooks are installed
into the scratch repository and real ``git commit`` invocations are observed.
The hook's ``files:`` pattern, ``commitlint``'s ``stages:``, and the config's
``default_stages`` are read out of the repository's own config, so weakening any
of them breaks these tests instead of going unnoticed.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from tests.helpers.precommit_lane import (
    Lane,
    add_worktree,
    child_env,
    failing_hook_ids,
    field,
    git_try,
    global_exclude,
    head,
    hook_block,
    install_hooks,
    output,
    real_config_text,
    seed_repository,
    stage,
    yaml_scalar,
)

# The hook mirrored as the file-scoped stand-in. frontend-eslint is the one the
# issue was filed on; its ``files:`` pattern is read from the real config.
_MIRRORED_FILE_SCOPED_HOOK_ID = "frontend-eslint"
_MIRRORED_FILE_SCOPED_HOOK_NAME = "frontend eslint"

# The hook that legitimately belongs to the commit-msg stage. Without it armed,
# "no file-scoped hook ran at commit-msg" would also hold if the commit-msg
# hook were simply not installed, and this module would prove nothing.
_COMMIT_MSG_HOOK_ID = "commitlint"
_COMMIT_MSG_HOOK_NAME = "commitlint (conventional commits)"

# Both git hooks are armed, which is what makes a two-block transcript possible
# at all -- and therefore what makes its absence worth asserting.
_INSTALLED_HOOK_TYPES = ("pre-commit", "commit-msg")

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

_DEFAULT_STAGES_RE = re.compile(
    r"^default_stages:[ \t]*\[(?P<value>[^\]]*)\][ \t]*$",
    re.MULTILINE,
)


def _declared_default_stages() -> tuple[str, ...] | None:
    """Return the stages the real config makes hooks default to.

    Returns:
        The declared stage names, or None when the config declares no
        ``default_stages`` at all -- in which case pre-commit defaults every
        hook to every stage, which is the defect this module locks out.
    """
    match = _DEFAULT_STAGES_RE.search(real_config_text())
    if match is None:
        return None
    return tuple(part.strip() for part in match.group("value").split(",") if part.strip())


def _commit_msg_stages() -> str:
    """Return the stages the real commitlint hook declares.

    Returns:
        The comma-joined stage names, read from the real config so a commitlint
        that stopped declaring ``commit-msg`` breaks this fixture too.
    """
    declared = field(hook_block(_COMMIT_MSG_HOOK_ID), "stages")
    if declared is None:
        pytest.fail(f"{_COMMIT_MSG_HOOK_ID} declares no stages: in the real config")
    return declared.strip("[]")


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
    inherited_exclude = global_exclude()
    if inherited_exclude is not None:
        lines.append(f"exclude: {yaml_scalar(inherited_exclude)}")
    default_stages = _declared_default_stages()
    if default_stages is not None:
        lines.append(f"default_stages: [{', '.join(default_stages)}]")

    mirrored = hook_block(_MIRRORED_FILE_SCOPED_HOOK_ID)
    lines.extend(
        [
            "repos:",
            "  - repo: local",
            "    hooks:",
            f"      - id: {_MIRRORED_FILE_SCOPED_HOOK_ID}",
            f"        name: {yaml_scalar(_MIRRORED_FILE_SCOPED_HOOK_NAME)}",
            "        language: system",
            f"        entry: {yaml_scalar(_STAND_IN_ENTRY)}",
            "        pass_filenames: false",
        ],
    )
    for key in ("files", "exclude"):
        value = field(mirrored, key)
        if value is not None:
            lines.append(f"        {key}: {yaml_scalar(value)}")
    lines.extend(
        [
            f"      - id: {_COMMIT_MSG_HOOK_ID}",
            f"        name: {yaml_scalar(_COMMIT_MSG_HOOK_NAME)}",
            "        language: system",
            f"        entry: {yaml_scalar(_PASSING_ENTRY)}",
            "        pass_filenames: false",
            f"        stages: [{_commit_msg_stages()}]",
        ],
    )
    return "\n".join(lines) + "\n"


@pytest.fixture
def lane(tmp_path: Path) -> Lane:
    """Build a scratch repository, a linked worktree, and both installed hooks.

    Args:
        tmp_path: pytest's per-test scratch directory.

    Returns:
        The lane every behavioural assertion in this module commits from.
    """
    home = tmp_path / "home"
    home.mkdir()
    env = child_env(home, tmp_path / "pre-commit-store")
    repo = tmp_path / "repo"
    worktree = tmp_path / "lane"
    seed_repository(
        repo,
        env,
        config=_scratch_config(),
        files={_FRONTEND_FILE: _CLEAN_CONTENTS},
        author="Stage Selection Gate",
    )
    add_worktree(repo, worktree, env)
    install_hooks(repo, worktree, env, _INSTALLED_HOOK_TYPES)
    return Lane(repo=repo, worktree=worktree, env=env)


def _report_lines(transcript: str, hook_name: str) -> list[str]:
    """Return every result line a named hook contributed to a transcript.

    Args:
        transcript: A commit's combined output.
        hook_name: The hook's display name.

    Returns:
        The matching lines, one per stage that selected the hook.
    """
    prefix = f"{hook_name}."
    return [line for line in transcript.splitlines() if line.startswith(prefix)]


def _commit(lane: Lane, message: str) -> subprocess.CompletedProcess[str]:
    """Attempt a commit in the lane.

    Args:
        lane: The lane to commit from.
        message: The commit message.

    Returns:
        The completed process, whose exit code is part of what is asserted.
    """
    return git_try("commit", "-m", message, cwd=lane.worktree, env=lane.env)


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

    @pytest.mark.parametrize("stage_name", _REQUIRED_DEFAULT_STAGES)
    def test_default_stages_keeps_the_stage_ci_invokes_by_name(self, stage_name: str) -> None:
        """backend-ci.yml runs both by name; dropping one would weaken a live gate."""
        stages = _declared_default_stages() or ()
        assert stage_name in stages, stages

    def test_commitlint_still_owns_the_commit_msg_stage(self) -> None:
        """Otherwise nothing at all would gate the message, which is a real loss."""
        assert _FORBIDDEN_DEFAULT_STAGE in _commit_msg_stages()


class TestTheFileScopedGateIsNotVacuous:
    """The same fixture, violating and clean, must produce opposite verdicts."""

    def test_a_violating_staged_file_fails_the_hook_and_rejects_the_commit(
        self,
        lane: Lane,
    ) -> None:
        """A gate that cannot fail is not a gate; this is the half that proves it can."""
        stage(lane, _FRONTEND_FILE, _VIOLATING_CONTENTS)
        before = head(lane)

        result = _commit(lane, "feat: violating frontend change")

        transcript = output(result)
        assert result.returncode != 0, transcript
        assert _MIRRORED_FILE_SCOPED_HOOK_ID in failing_hook_ids(transcript), transcript
        assert head(lane) == before, "a failing gate still let the commit land"

    def test_the_identical_clean_file_passes_the_hook_and_lands(self, lane: Lane) -> None:
        """The control: without it, an always-failing stand-in would pass the test above."""
        stage(lane, _FRONTEND_FILE, _CLEAN_CONTENTS + "export const b = 2;\n")
        before = head(lane)

        result = _commit(lane, "feat: clean frontend change")

        transcript = output(result)
        assert result.returncode == 0, transcript
        assert failing_hook_ids(transcript) == set(), transcript
        assert head(lane) != before, transcript


class TestASuccessfulCommitReportsEachHookOnce:
    """The reported symptom itself: the second block, and its absence."""

    def test_the_file_scoped_hook_is_reported_exactly_once(self, lane: Lane) -> None:
        """Two lines for one hook is what sent five reporters after a phantom defect."""
        stage(lane, _FRONTEND_FILE, _CLEAN_CONTENTS + "export const c = 3;\n")

        transcript = output(_commit(lane, "feat: clean frontend change"))

        reported = _report_lines(transcript, _MIRRORED_FILE_SCOPED_HOOK_NAME)
        assert len(reported) == 1, f"expected one report line, got {reported}:\n{transcript}"

    def test_the_file_scoped_hook_never_reports_having_no_files(self, lane: Lane) -> None:
        """The exact string the issue was filed on, for a commit that staged a file."""
        stage(lane, _FRONTEND_FILE, _CLEAN_CONTENTS + "export const d = 4;\n")

        transcript = output(_commit(lane, "feat: clean frontend change"))

        reported = _report_lines(transcript, _MIRRORED_FILE_SCOPED_HOOK_NAME)
        assert all("no files to check" not in line for line in reported), transcript

    def test_the_commit_msg_stage_still_runs_its_own_hook(self, lane: Lane) -> None:
        """Without this, the two assertions above would also hold with no hook armed."""
        stage(lane, _FRONTEND_FILE, _CLEAN_CONTENTS + "export const e = 5;\n")

        transcript = output(_commit(lane, "feat: clean frontend change"))

        reported = _report_lines(transcript, _COMMIT_MSG_HOOK_NAME)
        assert len(reported) == 1, f"expected one report line, got {reported}:\n{transcript}"
        assert reported[0].endswith("Passed"), transcript
