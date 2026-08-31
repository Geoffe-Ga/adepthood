"""The turn cap on a scheduled Claude job must sit above the work the job does.

Classifying a truncated run correctly is worth doing and does not stop the
truncation. ``scan-groom.yml`` caps the nightly grooming at 40 turns, and the
four captured runs used 41, 44, 45 and 47 -- every one of them over the cap. The
job is being hard-stopped mid-work on most nights, its summary is never written,
and the grooming that was supposed to happen simply does not.

The cap is still worth having. It bounds a roughly three-dollar job that talks
to the GitHub API in a loop, and removing it would mean the next prompt that
fails to converge runs until the 30-minute job timeout. So the question is not
whether to cap but where: above what the work has been observed to need, with
enough headroom that a normal night's variance does not clip it, and far enough
below "unbounded" that a runaway still stops.

WHY THIS IS ASSERTED AS A FLOOR AND NOT AN EQUALITY: tuning the cap upward as
the grooming grows is a normal maintenance act, and a test that had to be edited
to do it is a test that gets edited to do the opposite. What must not happen
again is the cap drifting back down to where the observed work does not fit.

``_claude-scan.yml`` carries the same cap for every scan that reuses it, set by
the same reasoning, and is held to the same floor -- a cap fixed in one file and
left in the other is how half the fleet keeps the bug.

Parsed as plain text, following test_scheduled_workflow_legibility.py: PyYAML is
deliberately in no requirements file, and importing it here would turn this
module into a collection error on the 3.11 and 3.12 compat jobs.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"

# The most turns a captured run of the grooming has been observed to use. Run
# 33248402070 reached this and PASSED -- cap enforcement is inconsistent within
# one action version -- which is the run that says 47 is real work rather than a
# loop that should have been cut off.
OBSERVED_PEAK_TURNS = 47

# Headroom above the observed peak. A cap set AT the peak clips the first night
# that runs slightly long, which is the failure being fixed, one turn higher.
REQUIRED_HEADROOM_TURNS = 30

# Above this a cap has stopped bounding anything a runaway could do: at roughly
# three dollars for 47 turns, a job allowed into the hundreds outspends the
# 30-minute job timeout's protection before that timeout is reached.
MAX_DEFENSIBLE_TURNS = 200

# The workflows whose cap is READ TWICE -- once by the action and once by
# classify_claude_outcome.sh -- which is what makes drift between two literals a
# wrong verdict rather than only a wrong number. `deslop.yml` and
# `weekly-playbook.yml` also pass `--max-turns` (100 and 120), but neither
# invokes the classifier, so there is no second reader to disagree with and no
# `MAX_TURNS` variable for this check to read. They are out of scope here by
# that test, not by oversight; if either ever starts classifying its own
# outcome, it belongs in this tuple.
_CAPPED_WORKFLOWS = ("scan-groom.yml", "_claude-scan.yml")

_MAX_TURNS = re.compile(r'^\s*MAX_TURNS:\s*"?(?P<turns>\d+)"?\s*$', re.MULTILINE)


def _declared_cap(workflow: Path) -> int:
    """Return the ``MAX_TURNS`` a workflow declares, failing loudly if it declares none."""
    text = workflow.read_text(encoding="utf-8")
    matches = _MAX_TURNS.findall(text)
    if not matches:
        pytest.fail(f"{workflow.name} declares no MAX_TURNS; re-point this check")
    if len(set(matches)) > 1:
        pytest.fail(
            f"{workflow.name} declares MAX_TURNS more than once with different values "
            f"({sorted(set(matches))}); the classifier compares against one of them"
        )
    return int(matches[0])


@pytest.mark.parametrize("name", _CAPPED_WORKFLOWS)
def test_the_cap_leaves_room_for_the_work_that_has_been_observed(name: str) -> None:
    """A cap below the observed peak stops the job rather than bounding it."""
    cap = _declared_cap(_WORKFLOWS / name)
    floor = OBSERVED_PEAK_TURNS + REQUIRED_HEADROOM_TURNS

    assert cap >= floor, (
        f"{name} caps at {cap} turns; captured runs have used up to "
        f"{OBSERVED_PEAK_TURNS}, so the job is being cut off mid-work and its "
        f"summary never written. At least {floor} leaves a normal night room."
    )


@pytest.mark.parametrize("name", _CAPPED_WORKFLOWS)
def test_the_cap_still_bounds_a_runaway(name: str) -> None:
    """Raising the cap is the fix; removing it is not.

    The pressure after a truncation is always to go higher, and the ceiling is
    what keeps "higher" from arriving at "no cap at all" one increment at a
    time.
    """
    cap = _declared_cap(_WORKFLOWS / name)

    assert cap <= MAX_DEFENSIBLE_TURNS, (
        f"{name} caps at {cap} turns, which no longer bounds a prompt that fails "
        "to converge; the job timeout is not a cost control."
    )


@pytest.mark.parametrize("name", _CAPPED_WORKFLOWS)
def test_the_action_and_the_classifier_read_the_same_cap(name: str) -> None:
    """One cap, read twice. Two literals drift, and the classifier's copy decides verdicts.

    Both workflows already say so in a comment above ``MAX_TURNS``; this is that
    comment as a check, so raising the cap in the ``--max-turns`` flag while
    leaving the classifier comparing against the old number cannot ship.
    """
    text = (_WORKFLOWS / name).read_text(encoding="utf-8")
    # To end of line, not to the next space: the value is an Actions expression
    # (`${{ env.MAX_TURNS }}`) whose braces are separated by spaces, and a
    # whitespace-delimited capture reads it as the literal `${{`.
    uses = re.findall(r"--max-turns\s+(?P<value>.+)$", text, re.MULTILINE)

    assert uses, f"{name} passes no --max-turns anywhere"
    for value in uses:
        assert "MAX_TURNS" in value, (
            f"{name} passes a literal turn cap ({value}) instead of the MAX_TURNS "
            "variable, so the action and the classifier can disagree about it"
        )
