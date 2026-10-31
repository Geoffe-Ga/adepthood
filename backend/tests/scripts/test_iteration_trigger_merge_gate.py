"""iteration-trigger.yml clears a merge on a CONFLICT check, never a freshness check.

Owner rule (2026-10-31): "PRs don't need to be brought up to the current main
before merging. If there are no merge conflicts then it is fine to merge a pr
that passed all other gates." The workflow's summary comment is the message the
loop acts on, so its "cleared to merge" line has to say exactly that:

* a green, reviewed PR that is BEHIND its base but conflict-free is cleared;
* a green, reviewed PR GitHub reports as conflicting (``mergeable: false`` /
  ``mergeable_state: dirty``) is refused, with an instruction to merge the base
  in and resolve;
* a PR whose mergeability GitHub has not finished computing
  (``mergeable: null``) is "not yet known" -- refused, never read as clear;
* nothing asks the compare API how far behind the head is.

These run the workflow's REAL ``run:`` block -- read out of the YAML with the
shared :mod:`tests.workflow_text` reader, comment lines dropped -- under bash
with a stub ``gh`` on ``PATH`` answering from fixtures, then read back the body
it POSTs. A rule this module only grepped for could be spelled right and wired
wrong; one it has watched refuse a conflicted PR is known to be a gate.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from tests.workflow_text import step_run_command

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "iteration-trigger.yml"
_STEP = "Compose and post summary"

_REPO = "Geoffe-Ga/adepthood"
_PR = "4242"
_SHA = "a" * 40  # a well-formed but obviously fake head commit
_MARKER = "<!-- iteration-trigger -->"

# Ceiling for one run of the step. It makes only stubbed calls and its sleeps are
# stubbed out, so anything near this means it hung.
_STEP_TIMEOUT_SECONDS = 30

_CLEARED = "You are cleared to squash merge"
_REFUSED = "NOT cleared to merge"

# The stub `gh`. It answers each endpoint the step calls from a fixture file,
# records every call, and writes the POSTed comment body to `posted.txt`. The
# pulls endpoint can be scripted as a sequence (pulls.1.json, pulls.2.json, ...)
# so the "mergeability still computing" poll is exercised; the last file repeats.
_GH_STUB = r"""#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$FIXTURES/calls.log"
args="$*"
case "$args" in
  *"-X POST"*"/comments"*)
    for a in "$@"; do
      case "$a" in body=*) printf '%s' "${a#body=}" > "$FIXTURES/posted.txt" ;; esac
    done
    exit 0 ;;
  *"/issues/"*"/comments"*) cat "$FIXTURES/comments.json" ;;
  *"/check-runs"*) cat "$FIXTURES/runs.json" ;;
  *"/compare/"*)
    : > "$FIXTURES/compare-called"
    echo '{"behind_by": 0}' ;;
  *"/pulls/"*)
    if [ -f "$FIXTURES/pulls.fail" ]; then
      echo "gh: HTTP 502: Bad Gateway" >&2
      exit 1
    fi
    n=$(( $(cat "$FIXTURES/pulls.count" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$n" > "$FIXTURES/pulls.count"
    f="$FIXTURES/pulls.$n.json"
    [ -f "$f" ] || f=$(ls "$FIXTURES"/pulls.*.json | sort -t. -k2 -n | tail -1)
    cat "$f" ;;
  *) echo "unexpected gh call: $args" >&2; exit 97 ;;
esac
"""


def _executable(name: str) -> str:
    """Return the absolute path of a required command, failing if it is absent.

    Args:
        name: The command to resolve.

    Returns:
        Its resolved path.
    """
    found = shutil.which(name)
    if found is None:
        pytest.fail(f"{name} is required to exercise the iteration-trigger step")
    return found


def _pull(*, mergeable: bool | None, state: str, labels: list[str] | None = None) -> dict[str, Any]:
    """Build a REST ``GET /pulls/{n}`` answer carrying the fields the step reads.

    Args:
        mergeable: GitHub's ``mergeable`` (``None`` while still computing).
        state: GitHub's ``mergeable_state``.
        labels: Label names on the PR.

    Returns:
        The PR object.
    """
    return {
        "number": int(_PR),
        "base": {"ref": "main"},
        "labels": [{"name": name} for name in (labels or [])],
        "mergeable": mergeable,
        "mergeable_state": state,
    }


def _run_step(
    tmp_path: Path,
    pulls: list[dict[str, Any]],
    *,
    verdict: str = "LGTM",
    pulls_fail: bool = False,
) -> tuple[str, Path]:
    """Run the workflow step against fixtures and return what it posted.

    Args:
        tmp_path: Scratch directory for fixtures and stubs.
        pulls: Successive answers from the pulls endpoint (the last repeats).
        verdict: The Claude review verdict on the PR.
        pulls_fail: Make the pulls endpoint fail as a transport error would.

    Returns:
        The posted comment body, and the fixtures directory for further checks.
    """
    fixtures = tmp_path / "fixtures"
    stubs = tmp_path / "bin"
    # The step writes comments.json/runs.json into its working directory, so it
    # runs in its own -- in the fixtures directory it would truncate them.
    workdir = tmp_path / "work"
    for directory in (fixtures, stubs, workdir):
        directory.mkdir()
    review = {"id": 77, "body": f"## Summary\nok\n\n## Verdict: {verdict}\n"}
    (fixtures / "comments.json").write_text(json.dumps([review]))
    runs = {"check_runs": [{"conclusion": "success"}, {"conclusion": "skipped"}]}
    (fixtures / "runs.json").write_text(json.dumps(runs))
    for index, answer in enumerate(pulls, start=1):
        (fixtures / f"pulls.{index}.json").write_text(json.dumps(answer))
    if pulls_fail:
        (fixtures / "pulls.fail").touch()
    gh = stubs / "gh"
    gh.write_text(_GH_STUB)
    gh.chmod(0o755)
    sleep = stubs / "sleep"
    sleep.write_text("#!/usr/bin/env bash\nexit 0\n")
    sleep.chmod(0o755)

    script = step_run_command(_WORKFLOW.read_text(encoding="utf-8"), _STEP)
    env = {
        "PATH": f"{stubs}{os.pathsep}{os.environ.get('PATH', '')}",
        "HOME": str(tmp_path),
        "FIXTURES": str(fixtures),
        "REPO": _REPO,
        "PR": _PR,
        "SHA": _SHA,
        "MARKER": _MARKER,
    }
    # GitHub runs an unadorned `run:` block as `bash -e {0}`; so does this.
    subprocess.run(
        [_executable("bash"), "-e", "-c", script],
        cwd=workdir,
        env=env,
        check=True,
        capture_output=True,
        text=True,
        timeout=_STEP_TIMEOUT_SECONDS,
    )
    return (fixtures / "posted.txt").read_text(encoding="utf-8"), fixtures


@pytest.fixture(autouse=True)
def _needs_jq() -> None:
    """Fail loudly, rather than skip, where the step's own `jq` is missing."""
    _executable("jq")


def test_behind_but_conflict_free_pr_is_cleared(tmp_path: Path) -> None:
    """GitHub's ``behind`` state is no longer a blocker: no conflict, so cleared."""
    posted, fixtures = _run_step(tmp_path, [_pull(mergeable=True, state="behind")])
    assert _CLEARED in posted
    assert _REFUSED not in posted
    assert not (fixtures / "compare-called").exists(), "the compare API must not be consulted"


def test_clean_pr_is_cleared(tmp_path: Path) -> None:
    """A ``clean`` PR -- behind or not, GitHub reports no conflict -- is cleared."""
    posted, _ = _run_step(tmp_path, [_pull(mergeable=True, state="clean")])
    assert _CLEARED in posted


def test_comments_verdict_behind_but_conflict_free_is_cleared_after_followups(
    tmp_path: Path,
) -> None:
    """COMMENTS keeps its file-follow-ups instruction and is cleared when behind."""
    posted, _ = _run_step(tmp_path, [_pull(mergeable=True, state="behind")], verdict="COMMENTS")
    assert "Do NOT iterate on this review" in posted
    assert "you are cleared to squash merge" in posted
    assert _REFUSED not in posted


@pytest.mark.parametrize(
    ("mergeable", "state"),
    [(False, "dirty"), (False, "unknown"), (True, "dirty")],
)
def test_conflicted_pr_is_refused(tmp_path: Path, mergeable: bool, state: str) -> None:
    """Either spelling of a conflict refuses the merge and says how to fix it."""
    posted, _ = _run_step(tmp_path, [_pull(mergeable=mergeable, state=state)])
    assert _REFUSED in posted
    assert "merge conflict" in posted
    assert _CLEARED not in posted


def test_uncomputed_mergeability_is_not_yet_known_never_clear(tmp_path: Path) -> None:
    """``mergeable: null`` on every poll is refused as not-yet-known."""
    posted, fixtures = _run_step(tmp_path, [_pull(mergeable=None, state="unknown")])
    assert _REFUSED in posted
    assert "not finished computing" in posted
    assert _CLEARED not in posted
    polls = int((fixtures / "pulls.count").read_text(encoding="utf-8"))
    assert polls > 1, "a null mergeable must be re-polled before giving up"


def test_mergeability_that_resolves_while_polling_is_used(tmp_path: Path) -> None:
    """A null that resolves to conflict-free on a re-poll clears the merge."""
    pulls = [_pull(mergeable=None, state="unknown"), _pull(mergeable=True, state="behind")]
    posted, _ = _run_step(tmp_path, pulls)
    assert _CLEARED in posted


def test_mergeability_that_resolves_to_a_conflict_is_refused(tmp_path: Path) -> None:
    """A null that resolves to a conflict on a re-poll refuses the merge."""
    pulls = [_pull(mergeable=None, state="unknown"), _pull(mergeable=False, state="dirty")]
    posted, _ = _run_step(tmp_path, pulls)
    assert "merge conflict" in posted
    assert _CLEARED not in posted


def test_unreadable_pr_is_refused(tmp_path: Path) -> None:
    """A PR the API cannot return is never cleared (fail closed)."""
    posted, _ = _run_step(tmp_path, [_pull(mergeable=True, state="clean")], pulls_fail=True)
    assert _REFUSED in posted
    assert _CLEARED not in posted


def test_hold_label_still_outranks_a_clean_merge(tmp_path: Path) -> None:
    """The do-not-auto-merge hold is unchanged: it refuses even a clean PR."""
    pull = _pull(mergeable=True, state="clean", labels=["do-not-auto-merge"])
    posted, _ = _run_step(tmp_path, [pull])
    assert "do-not-auto-merge hold" in posted
    assert _CLEARED not in posted


def test_changes_requested_is_never_cleared(tmp_path: Path) -> None:
    """The review gate is unchanged: a conflict-free CHANGES_REQUESTED PR iterates."""
    posted, _ = _run_step(
        tmp_path, [_pull(mergeable=True, state="behind")], verdict="CHANGES_REQUESTED"
    )
    assert "continue iterating" in posted
    assert _CLEARED not in posted
