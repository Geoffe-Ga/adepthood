"""The browser lane's review artifacts must be published whatever the verdict.

Two browser specs exist as much for what they leave behind as for what they
assert. The text census (#2948) and the action-row sweep (#2860) each walk
every route at two viewports and write a screenshot plus a JSON record per
screen under ``frontend/e2e/artifacts/``; a reviewer -- a maintainer, or a
computer-use session -- then goes through that folder screen by screen against
the rules in ``frontend/src/design/DESIGN.md``. The folder is gitignored, so
the only copy anyone can review without a local run is the one CI uploads.

The failure mode is quiet. An upload step conditioned on ``failure()`` -- the
shape the lane's trace upload rightly uses -- publishes nothing on a green run,
which is exactly the run a reviewer wants to read: green means geometry held,
not that the screens follow the rules. An upload whose ``uses:`` was commented
out, whose ``path:`` drifted from the folder the spec writes, or that moved to
a job which never runs the browser, all leave a workflow that still looks like
it publishes. So each is checked here as data, per step, in the browser job.

Parsed as plain text through ``tests.workflow_text``, like the other guards in
this directory: PyYAML is deliberately in no requirements file.

Every check takes the workflow text as an argument, so the code that grades
the real ``e2e.yml`` is also pointed at deliberately violating copies below. A
gate never observed to fail is not known to be a gate.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import pytest

from tests.workflow_text import jobs, step_body, step_inputs, step_uses, without_comment_lines

_REPO_ROOT = Path(__file__).resolve().parents[3]
_E2E_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "e2e.yml"
_E2E_DIR = _REPO_ROOT / "frontend" / "e2e"

# The job that boots the lane and runs the Playwright specs.
_BROWSER_JOB = "browser-journey"
_UPLOAD_ACTION = "actions/upload-artifact@"
_ALWAYS = "always()"

# A step-level ``if:`` key, captured with its indentation so a key nested under
# ``with:`` is not mistaken for the step's own condition.
_IF_KEY = re.compile(r"^(?P<indent>\s*)if:\s*(?P<condition>.+?)\s*$")


@dataclass(frozen=True)
class Publication:
    """One review folder a browser spec writes and CI must publish."""

    step: str
    artifact: str
    path: str
    spec: str
    folder: str


_PUBLICATIONS = (
    Publication(
        step="Upload the action-row sweep",
        artifact="action-row-sweep",
        path="frontend/e2e/artifacts/action-rows/**",
        spec="action-rows.browser.e2e.test.ts",
        folder="action-rows",
    ),
    Publication(
        step="Upload the text census",
        artifact="text-order-census",
        path="frontend/e2e/artifacts/text-order/**",
        spec="text-order.browser.e2e.test.ts",
        folder="text-order",
    ),
)


def _step_condition(workflow_text: str, step_name: str) -> str | None:
    """Return one step's own ``if:`` condition, or ``None`` when it has none.

    Args:
        workflow_text: The workflow, or one job's body, as text.
        step_name: The step's ``name:`` value.

    Returns:
        The condition as written, from the ``if:`` key at the step's own key
        indentation; commented-out lines never count.
    """
    body = [line for line in step_body(workflow_text, step_name) if line.strip()]
    live = [line for line in body if not line.strip().startswith("#")]
    if not live:
        return None
    key_indent = min(len(line) - len(line.lstrip(" ")) for line in live)
    for line in live:
        found = _IF_KEY.match(line)
        if found is not None and len(found.group("indent")) == key_indent:
            return found.group("condition")
    return None


def _upload_shortfall(workflow_text: str, publication: Publication) -> str | None:
    """Describe how the workflow fails to publish ``publication``, or ``None``.

    Args:
        workflow_text: The whole workflow file's contents.
        publication: The folder, artifact name and step expected to publish it.

    Returns:
        A sentence naming the first shortfall found, or ``None`` when the
        browser job uploads that folder on every outcome.
    """
    job = jobs(without_comment_lines(workflow_text)).get(_BROWSER_JOB)
    if job is None:
        return f"the workflow has no {_BROWSER_JOB} job"
    if f"- name: {publication.step}" not in job:
        return f"the {_BROWSER_JOB} job has no step named {publication.step!r}"
    if not step_uses(job, publication.step).startswith(_UPLOAD_ACTION):
        return f"{publication.step!r} does not run {_UPLOAD_ACTION}"
    condition = _step_condition(job, publication.step)
    if condition != _ALWAYS:
        return (
            f"{publication.step!r} runs on {condition or 'success() (no if:)'}, "
            f"not {_ALWAYS}, so some verdicts publish nothing to review"
        )
    inputs = step_inputs(job, publication.step)
    expected = {"name": publication.artifact, "path": publication.path}
    actual = {key: inputs.get(key) for key in expected}
    if actual != expected:
        return f"{publication.step!r} publishes {actual}, not {expected}"
    return None


_COMPLIANT = """\
name: E2E
on: pull_request
jobs:
  browser-journey:
    runs-on: ubuntu-latest
    steps:
      - name: Run the real-browser journey
        run: npm run test:e2e:web

      - name: Upload the action-row sweep
        if: always()
        uses: actions/upload-artifact@0123456789abcdef  # v7.0.1
        with:
          name: action-row-sweep
          path: frontend/e2e/artifacts/action-rows/**
          if-no-files-found: warn
"""

_SWEEP = _PUBLICATIONS[0]


# --- The real tree ---------------------------------------------------------


@pytest.mark.parametrize("publication", _PUBLICATIONS, ids=lambda p: p.artifact)
def test_the_browser_job_publishes_each_review_folder_on_every_outcome(
    publication: Publication,
) -> None:
    """Each review folder is uploaded by the browser job with ``if: always()``."""
    shortfall = _upload_shortfall(_E2E_WORKFLOW.read_text(encoding="utf-8"), publication)
    assert shortfall is None, shortfall


@pytest.mark.parametrize("publication", _PUBLICATIONS, ids=lambda p: p.artifact)
def test_the_spec_writes_the_folder_the_workflow_publishes(publication: Publication) -> None:
    """A path that drifted from the spec's own folder would upload an empty glob."""
    spec = (_E2E_DIR / publication.spec).read_text(encoding="utf-8")

    assert f"join(__dirname, 'artifacts', '{publication.folder}')" in spec


# --- Deliberately violating workflows --------------------------------------


def test_the_check_can_be_satisfied() -> None:
    """The compliant fixture passes, so every rejection below is for its stated reason."""
    assert _upload_shortfall(_COMPLIANT, _SWEEP) is None


def test_a_failure_only_upload_is_caught() -> None:
    """The trace upload's ``failure()`` publishes nothing on the green run a reviewer reads."""
    workflow = _COMPLIANT.replace("if: always()", "if: failure()")

    shortfall = _upload_shortfall(workflow, _SWEEP)

    assert shortfall is not None
    assert "failure()" in shortfall


def test_an_unconditioned_upload_is_caught() -> None:
    """No ``if:`` means ``success()``: a red run, the one with findings, publishes nothing."""
    workflow = _COMPLIANT.replace("        if: always()\n", "")

    shortfall = _upload_shortfall(workflow, _SWEEP)

    assert shortfall is not None
    assert "success()" in shortfall


def test_a_commented_out_condition_is_not_read_as_live() -> None:
    """A ``# if: always()`` is prose; the step then runs on success only."""
    workflow = _COMPLIANT.replace("        if: always()", "        # if: always()")

    assert _upload_shortfall(workflow, _SWEEP) is not None


def test_a_commented_out_upload_action_is_caught() -> None:
    """A step whose ``uses:`` is commented out still has a name and uploads nothing."""
    workflow = _COMPLIANT.replace(
        "        uses: actions/upload-artifact", "        # uses: actions/upload-artifact"
    )

    shortfall = _upload_shortfall(workflow, _SWEEP)

    assert shortfall is not None
    assert "upload-artifact" in shortfall


def test_a_drifted_path_is_caught() -> None:
    """Publishing the text-census folder under the sweep's name reviews the wrong screens."""
    workflow = _COMPLIANT.replace("artifacts/action-rows/**", "artifacts/text-order/**")

    shortfall = _upload_shortfall(workflow, _SWEEP)

    assert shortfall is not None
    assert "text-order" in shortfall


def test_an_upload_in_another_job_does_not_count() -> None:
    """Only the job that ran the browser has the folder to upload."""
    workflow = _COMPLIANT.replace("  browser-journey:", "  api-journey:")

    shortfall = _upload_shortfall(workflow, _SWEEP)

    assert shortfall is not None
    assert _BROWSER_JOB in shortfall


def test_a_missing_step_is_caught() -> None:
    """Renaming or deleting the step is caught by name, not by a stray substring."""
    workflow = _COMPLIANT.replace("Upload the action-row sweep", "Upload something else")

    shortfall = _upload_shortfall(workflow, _SWEEP)

    assert shortfall is not None
    assert "no step named" in shortfall


def test_a_condition_nested_under_with_is_not_the_steps_own() -> None:
    """An ``if:`` inside the action's inputs does not condition the step."""
    workflow = _COMPLIANT.replace("        if: always()\n", "").replace(
        "          if-no-files-found: warn", "          if: always()"
    )

    assert _step_condition(workflow, _SWEEP.step) is None
