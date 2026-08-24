"""Tripwires for the weekly playbook's drain gate and its wiring.

``weekly-playbook.yml`` asked ``gh`` how many ``playbook`` issues were open and
wrote ``|| echo 0`` after it. That fused two unrelated facts — "there are none"
and "the API did not answer" — into the value that means *proceed*, so a rate
limit or an expired token read as a clear WIP limit and filed a duplicate issue
beside one that already existed. It fails in the harmless direction, which is
precisely why nothing would ever have reported it.

The decision now lives in ``scripts/ralph/playbook-wip-gate.sh`` so it can be
executed rather than eyeballed. Every case below **runs the real script** with a
stub ``gh`` first on ``PATH``: no network, no token, no GitHub. A truth table
asserted against a mocked-out helper would only prove the mock works, and the
whole bug was a shell fragment nobody could test.

The workflow itself is read as plain text (PyYAML is not in the backend
requirements, so ``import yaml`` here would turn this guard into a collection
error on the compat job). Those assertions cover the half the script cannot: a
correct token means nothing if the caller branches on only two of the four.
"""

from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_GATE = _REPO_ROOT / "scripts" / "ralph" / "playbook-wip-gate.sh"
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "weekly-playbook.yml"

CLEAR = "clear"
WIP_LIMIT_HIT = "wip-limit-hit"
TRANSPORT_ERROR = "transport-error"
AUTH_ERROR = "auth-error"

# Every token the workflow must recognise. Adding one here without teaching the
# `case` below about it fails `test_the_workflow_branches_on_every_token`.
TOKENS = (CLEAR, WIP_LIMIT_HIT, TRANSPORT_ERROR, AUTH_ERROR)

# ``gh``'s documented exit code for "authentication required".
GH_EXIT_AUTH = 4
EXIT_USAGE = 2


def _stub_gh(tmp_path: Path, *, stdout: str = "", stderr: str = "", exit_code: int = 0) -> Path:
    """Write an executable stub ``gh`` and return the directory to prepend to PATH.

    The stub also records that it was called, so a case can prove the script
    consulted ``gh`` at all rather than short-circuiting to a token.
    """
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    script = bin_dir / "gh"
    log = shlex.quote(str(tmp_path / "gh-argv.log"))
    script.write_text(
        "#!/usr/bin/env bash\n"
        f'printf "%s\\n" "$*" >> {log}\n'
        f"printf '%s' {shlex.quote(stdout)}\n"
        f"printf '%s' {shlex.quote(stderr)} >&2\n"
        f"exit {exit_code}\n"
    )
    script.chmod(0o755)
    return bin_dir


def _run_gate(bin_dir: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Run the real gate script with ``bin_dir`` first on PATH."""
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
    env.pop("GITHUB_REPOSITORY", None)
    return subprocess.run(
        [str(_GATE), *args],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


def _token(tmp_path: Path, *, stdout: str = "", stderr: str = "", exit_code: int = 0) -> str:
    """Return the single token the gate prints for one stubbed ``gh`` outcome."""
    bin_dir = _stub_gh(tmp_path, stdout=stdout, stderr=stderr, exit_code=exit_code)
    result = _run_gate(bin_dir, "--repo", "owner/repo")

    assert result.returncode == 0, f"the gate is a query and must exit 0: {result.stderr}"

    return result.stdout.strip()


# --- The four outcomes, each proven by running the script ------------------


def test_zero_open_issues_is_clear(tmp_path: Path) -> None:
    """The one state in which the workflow may spend tokens and file an issue."""
    assert _token(tmp_path, stdout="0\n") == CLEAR


@pytest.mark.parametrize("count", ["1", "2", "5"])
def test_any_open_playbook_issue_hits_the_limit(tmp_path: Path, count: str) -> None:
    """Last week's delta is undrained; a second issue would fork the playbook's state."""
    assert _token(tmp_path, stdout=f"{count}\n") == WIP_LIMIT_HIT


@pytest.mark.parametrize("exit_code", [1, 2, 3, 5, 8])
def test_a_failed_lookup_is_never_read_as_zero(tmp_path: Path, exit_code: int) -> None:
    """The regression itself: this is where ``|| echo 0`` said ``clear`` and filed a duplicate."""
    token = _token(tmp_path, stderr="gh: could not connect\n", exit_code=exit_code)

    assert token == TRANSPORT_ERROR
    assert token != CLEAR


def test_an_authentication_failure_is_its_own_token(tmp_path: Path) -> None:
    """A rejected credential does not heal by next Monday, so it must not fail soft.

    Folded into ``transport-error`` it would stand the workflow down every week
    behind a green check — the "skips forever while reporting success" state the
    live-model-check lane goes red for.
    """
    assert _token(tmp_path, stderr="gh: authentication required\n", exit_code=GH_EXIT_AUTH) == (
        AUTH_ERROR
    )


@pytest.mark.parametrize("stdout", ["", "\n", "null", "not a number", "0 0"])
def test_a_zero_exit_with_an_unreadable_count_is_not_an_answer(tmp_path: Path, stdout: str) -> None:
    """``gh`` exiting 0 while printing something that is not a count proves nothing."""
    assert _token(tmp_path, stdout=stdout) == TRANSPORT_ERROR


def test_the_gate_actually_consults_gh(tmp_path: Path) -> None:
    """Guards the stub: a script that never called ``gh`` could pass every case above."""
    bin_dir = _stub_gh(tmp_path, stdout="0\n")

    _run_gate(bin_dir, "--repo", "owner/repo")

    argv = (tmp_path / "gh-argv.log").read_text()
    assert "issue list" in argv
    assert "--label playbook" in argv
    assert "--state open" in argv
    assert "--repo owner/repo" in argv


def test_gh_stderr_is_not_swallowed(tmp_path: Path) -> None:
    """The narration of *why* the lookup failed is the only diagnosis a run gets."""
    bin_dir = _stub_gh(tmp_path, stderr="gh: API rate limit exceeded\n", exit_code=1)

    result = _run_gate(bin_dir, "--repo", "owner/repo")

    assert "rate limit exceeded" in result.stderr


# --- Usage faults are exits, not tokens ------------------------------------


@pytest.mark.parametrize("args", [("--bogus",), ("--limit", "many"), ("--repo",)])
def test_a_usage_fault_exits_nonzero_without_printing_a_token(
    tmp_path: Path, args: tuple[str, ...]
) -> None:
    """A tooling fault must never be mistaken for a verdict about the WIP state."""
    bin_dir = _stub_gh(tmp_path, stdout="0\n")

    result = _run_gate(bin_dir, *args)

    assert result.returncode == EXIT_USAGE
    assert result.stdout.strip() not in TOKENS


def test_a_missing_repository_is_refused_rather_than_guessed(tmp_path: Path) -> None:
    """Without ``--repo`` or ``GITHUB_REPOSITORY`` there is no question to ask."""
    bin_dir = _stub_gh(tmp_path, stdout="0\n")

    result = _run_gate(bin_dir)

    assert result.returncode == EXIT_USAGE


# --- The caller: a right answer branched on wrongly is still the old bug ---


def _workflow_text() -> str:
    """Return the weekly playbook workflow's source."""
    return _WORKFLOW.read_text(encoding="utf-8")


def _workflow_code() -> str:
    """Return the workflow with whole-line comments dropped.

    Both YAML and the shell in a ``run:`` block comment with ``#``, so one
    filter serves for both. The forbidden-shape assertions read this rather
    than the raw text: the fixed fragment is quoted in the comments that
    explain why it is forbidden, and a guard that cannot survive its own
    rationale being written down would just get the rationale deleted.
    """
    return "\n".join(
        line for line in _workflow_text().splitlines() if not line.lstrip().startswith("#")
    )


def test_the_workflow_calls_the_gate_instead_of_counting_inline() -> None:
    """The inline lookup is what could not be tested; it must not come back."""
    code = _workflow_code()

    assert "scripts/ralph/playbook-wip-gate.sh" in code
    assert "|| echo 0" not in code
    assert "--label playbook" not in code


@pytest.mark.parametrize("token", TOKENS)
def test_the_workflow_branches_on_every_token(token: str) -> None:
    """An unhandled token would fall through to whatever the next branch does."""
    assert f"{token})" in _workflow_code()


def test_an_unknown_token_is_refused_rather_than_treated_as_clear() -> None:
    """A future token must stop the run, not silently license one."""
    assert "unrecognised token" in _workflow_code()


def test_a_transport_stand_down_is_annotated_and_an_auth_failure_is_loud() -> None:
    """Two stand-downs that render identically in the run list are one stand-down.

    The transport case stays green (a blip is not a verdict) but must announce
    that no verdict was reached; the credential case must fail the job outright.
    """
    text = _workflow_text()

    assert "::warning::" in text
    assert "::error::" in text
    assert "GITHUB_STEP_SUMMARY" in text


def test_the_gate_script_is_executable() -> None:
    """The workflow invokes it directly; mode 100644 would exit 126."""
    assert os.access(_GATE, os.X_OK)
