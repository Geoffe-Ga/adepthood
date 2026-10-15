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

The same job must also be given the time to produce them. The browser job was
already at its 15-minute cap on ``main`` before the sweep joined it -- E2E run
36363745320 was cancelled at that cap mid-way through the text census, and the
run before it took 14m20s -- so the job's ``timeout-minutes`` is pinned at a
floor too: a cap that cancels the run publishes a folder with half the screens
in it, which is the silent partial review this module exists to prevent.

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
_BROWSER_JOB = "browser-journey-shards"
_UPLOAD_ACTION = "actions/upload-artifact@"
_ALWAYS = "always()"
_AGGREGATE_CONDITION = (
    "${{ always() && (needs.changes.result != 'success' || needs.changes.outputs.e2e != 'false') }}"
)

# The browser job's own ``timeout-minutes``, at the job's key indentation.
_JOB_TIMEOUT = re.compile(r"^    timeout-minutes:\s*(?P<minutes>\d+)\s*(?:#.*)?$", re.MULTILINE)

# The least the browser job may be given. 14m20s for the lane without the
# sweep, plus the sweep's own 2.3 minutes (measured locally), was ~17 minutes, so
# 25 was the floor -- until E2E run 36912604466 was cancelled at 25 just after
# its 87 specs passed: ~6 minutes of setup plus 19.0 minutes of Playwright. 35
# was the next floor. Run 38637231314 then passed all 175 tests in 33.7
# minutes but exhausted that 35-minute whole-job cap before artifact upload.
# Setup, the complete suite and publication now receive a 60-minute envelope;
# individual test/action limits remain unchanged.
_BROWSER_TIMEOUT_FLOOR_MINUTES = 60

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


def _timeout_shortfall(workflow_text: str) -> str | None:
    """Describe how the browser job's time cap falls short, or ``None``.

    Args:
        workflow_text: The whole workflow file's contents.

    Returns:
        A sentence naming the shortfall, or ``None`` when the job declares a
        ``timeout-minutes`` of at least the floor.
    """
    job = jobs(without_comment_lines(workflow_text)).get(_BROWSER_JOB)
    if job is None:
        return f"the workflow has no {_BROWSER_JOB} job"
    found = _JOB_TIMEOUT.search(job)
    if found is None:
        return f"the {_BROWSER_JOB} job declares no timeout-minutes of its own"
    minutes = int(found.group("minutes"))
    if minutes < _BROWSER_TIMEOUT_FLOOR_MINUTES:
        return (
            f"the {_BROWSER_JOB} job is capped at {minutes} minutes, under the "
            f"{_BROWSER_TIMEOUT_FLOOR_MINUTES}-minute floor the census and sweep need"
        )
    return None


_COMPLIANT = """\
name: E2E
on: pull_request
jobs:
  browser-journey-shards:
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - name: Run the real-browser journey
        run: npm run test:e2e:web -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}

      - name: Upload failed-test traces
        if: failure()
        uses: actions/upload-artifact@0123456789abcdef
        with:
          name: browser-journey-test-results-${{ matrix.shard }}
          path: frontend/test-results

      - name: Upload browser timing report
        if: always()
        uses: actions/upload-artifact@0123456789abcdef
        with:
          name: browser-journey-report-${{ matrix.shard }}
          path: frontend/playwright-report/results.json

      - name: Upload the action-row sweep
        if: always()
        uses: actions/upload-artifact@0123456789abcdef  # v7.0.1
        with:
          name: action-row-sweep
          path: frontend/e2e/artifacts/action-rows/**
          if-no-files-found: warn

  browser-journey:
    needs: [changes, browser-journey-shards]
    if: SELECTED_LANE
    runs-on: ubuntu-latest
    steps:
      - name: Require every browser shard to pass
        env:
          SHARD_RESULT: ${{ needs.browser-journey-shards.result }}
        run: test "$SHARD_RESULT" = success
""".replace("SELECTED_LANE", _AGGREGATE_CONDITION)

_COMPLIANT_CONFIG = """\
  fullyParallel: false,
  workers: 1,
  reporter: [['line'], ['json', { outputFile: 'playwright-report/results.json' }]],
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


def test_the_browser_job_has_time_to_publish_every_screen() -> None:
    """The job's cap covers the census and the sweep with headroom."""
    shortfall = _timeout_shortfall(_E2E_WORKFLOW.read_text(encoding="utf-8"))
    assert shortfall is None, shortfall


def _assert_isolated_sharding(workflow: str, config: str) -> None:
    """Shared ports/state require runner isolation; every shard must finish its review."""
    job = jobs(without_comment_lines(workflow)).get(_BROWSER_JOB, "")
    assert "shard: [1, 2, 3, 4]" in job
    assert "fail-fast: false" in job
    command = "\n".join(step_body(job, "Run the real-browser journey"))
    expected = "npm run test:e2e:web -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}"
    assert expected in command
    assert "continue-on-error" not in job
    assert re.search(r"^\s*fullyParallel: false,", config, re.MULTILINE)
    assert re.search(r"^\s*workers: 1,", config, re.MULTILINE)


def _assert_shard_diagnostics(workflow: str, config: str) -> None:
    """Artifact v4+ refuses two runners uploading to the same artifact name."""
    job = jobs(without_comment_lines(workflow)).get(_BROWSER_JOB, "")
    assert step_uses(job, "Upload failed-test traces").startswith(_UPLOAD_ACTION)
    traces = step_inputs(job, "Upload failed-test traces")
    assert traces["name"] == "browser-journey-test-results-${{ matrix.shard }}"
    report_step = "Upload browser timing report"
    assert _step_condition(job, report_step) == _ALWAYS
    assert step_uses(job, report_step).startswith(_UPLOAD_ACTION)
    report = step_inputs(job, report_step)
    assert report["name"] == "browser-journey-report-${{ matrix.shard }}"
    assert report["path"] == "frontend/playwright-report/results.json"
    assert "['json', { outputFile: 'playwright-report/results.json' }]" in config


def _assert_stable_browser_check(workflow: str) -> None:
    """Keep the pre-matrix required check, failing on any unsuccessful shard."""
    job = jobs(without_comment_lines(workflow)).get("browser-journey", "")
    assert "    needs: [changes, browser-journey-shards]" in job
    assert f"    if: {_AGGREGATE_CONDITION}" in job
    assert "continue-on-error" not in job
    step = "\n".join(step_body(job, "Require every browser shard to pass"))
    assert "SHARD_RESULT: ${{ needs.browser-journey-shards.result }}" in step
    assert 'run: test "$SHARD_RESULT" = success' in step


def test_browser_sharding_and_diagnostics_in_the_real_tree() -> None:
    """Exercise the same validators used by the deliberately broken fixtures below."""
    workflow = _E2E_WORKFLOW.read_text()
    config = (_REPO_ROOT / "frontend" / "playwright.config.ts").read_text()
    _assert_isolated_sharding(workflow, config)
    _assert_shard_diagnostics(workflow, config)
    _assert_stable_browser_check(workflow)


# --- Deliberately violating workflows --------------------------------------


def test_sharding_and_diagnostics_accept_a_compliant_fixture() -> None:
    """Negative cases must reject their mutation rather than an incomplete fixture."""
    _assert_isolated_sharding(_COMPLIANT, _COMPLIANT_CONFIG)
    _assert_shard_diagnostics(_COMPLIANT, _COMPLIANT_CONFIG)
    _assert_stable_browser_check(_COMPLIANT)


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ("shard: [1, 2, 3, 4]", "shard: [1]"),
        ("fail-fast: false", "fail-fast: true"),
        (" --shard=${{ matrix.shard }}/${{ strategy.job-total }}", ""),
        ("    strategy:", "    continue-on-error: true\n    strategy:"),
    ],
)
def test_sharding_rejects_broken_workflow_fixtures(before: str, after: str) -> None:
    """Losing parallelism, shard selection or failure visibility must trip the guard."""
    with pytest.raises(AssertionError):
        _assert_isolated_sharding(_COMPLIANT.replace(before, after), _COMPLIANT_CONFIG)


@pytest.mark.parametrize(
    ("before", "after"),
    [("workers: 1", "workers: 2"), ("fullyParallel: false", "fullyParallel: true")],
)
def test_sharding_rejects_shared_worker_and_split_file_fixtures(before: str, after: str) -> None:
    """File-level fixture/artifact ownership must hold as the suite grows."""
    with pytest.raises(AssertionError):
        _assert_isolated_sharding(_COMPLIANT, _COMPLIANT_CONFIG.replace(before, after))


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ("browser-journey-test-results-${{ matrix.shard }}", "browser-journey-test-results"),
        ("browser-journey-report-${{ matrix.shard }}", "browser-journey-report"),
        ("if: always()", "if: failure()"),
        ("path: frontend/playwright-report/results.json", "path: frontend/missing.json"),
        ("uses: actions/upload-artifact@", "# uses: actions/upload-artifact@"),
    ],
)
def test_diagnostics_reject_collisions_and_missing_publication(before: str, after: str) -> None:
    """Both unqualified artifact names and failure-only timing uploads are rejected."""
    with pytest.raises(AssertionError):
        _assert_shard_diagnostics(_COMPLIANT.replace(before, after), _COMPLIANT_CONFIG)


def test_diagnostics_reject_a_missing_json_reporter() -> None:
    """An upload path cannot compensate for a reporter that never writes it."""
    with pytest.raises(AssertionError):
        _assert_shard_diagnostics(_COMPLIANT, "reporter: [['line']]")


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ("  browser-journey:\n", "  renamed-browser-check:\n"),
        ("needs: [changes, browser-journey-shards]", "needs: changes"),
        ('test "$SHARD_RESULT" = success', "true"),
        ("needs.browser-journey-shards.result", "needs.changes.result"),
        ("always() &&", "success() &&"),
    ],
)
def test_required_check_rejects_renaming_and_masked_shard_failures(before: str, after: str) -> None:
    """The stable check must wait for the matrix and propagate its result after failure."""
    with pytest.raises(AssertionError):
        _assert_stable_browser_check(_COMPLIANT.replace(before, after))


def test_cancelled_dependencies_cannot_skip_the_required_check() -> None:
    """A skipped required job passes protection, so the aggregate must survive cancellation."""
    workflow = _COMPLIANT.replace("always() &&", "!cancelled() &&")
    with pytest.raises(AssertionError):
        _assert_stable_browser_check(workflow)


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
    workflow = _COMPLIANT.replace(f"  {_BROWSER_JOB}:", "  api-journey:")

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


def test_the_timeout_check_can_be_satisfied() -> None:
    """The compliant fixture's 60 minutes meets the justified floor exactly."""
    assert _timeout_shortfall(_COMPLIANT) is None


def test_the_old_fifteen_minute_cap_is_caught() -> None:
    """The cap that cancelled run 36363745320 mid-census."""
    shortfall = _timeout_shortfall(_COMPLIANT.replace("timeout-minutes: 60", "timeout-minutes: 15"))

    assert shortfall is not None
    assert "15 minutes" in shortfall


def test_the_twenty_five_minute_cap_is_caught() -> None:
    """The cap that cancelled run 36912604466 just after its specs passed."""
    shortfall = _timeout_shortfall(_COMPLIANT.replace("timeout-minutes: 60", "timeout-minutes: 25"))

    assert shortfall is not None
    assert "25 minutes" in shortfall


def test_the_demonstrated_thirty_five_minute_cap_is_caught() -> None:
    """Run 38637231314 passed 175 tests, then lost artifact publication to this cap."""
    actual = _E2E_WORKFLOW.read_text()
    job = jobs(actual)[_BROWSER_JOB]
    insufficient, replaced = _JOB_TIMEOUT.subn("    timeout-minutes: 35", job, count=1)
    assert replaced == 1

    shortfall = _timeout_shortfall(actual.replace(job, insufficient, 1))

    assert shortfall is not None
    assert "35 minutes" in shortfall


def test_a_cap_one_minute_under_the_floor_is_caught() -> None:
    """The floor is a floor: 59 is under it."""
    workflow = _COMPLIANT.replace("timeout-minutes: 60", "timeout-minutes: 59")

    assert _timeout_shortfall(workflow) is not None


def test_a_missing_or_commented_out_cap_is_caught() -> None:
    """No cap is GitHub's 360-minute default, not a deliberate floor; a comment is not a cap."""
    removed = _COMPLIANT.replace("    timeout-minutes: 60\n", "")
    commented = _COMPLIANT.replace("    timeout-minutes: 60", "    # timeout-minutes: 60")

    assert _timeout_shortfall(removed) is not None
    assert _timeout_shortfall(commented) is not None


def test_a_step_level_cap_is_not_the_jobs() -> None:
    """A step's ``timeout-minutes`` sits deeper and caps that step alone."""
    workflow = _COMPLIANT.replace("    timeout-minutes: 60\n", "").replace(
        "        run: npm run test:e2e:web",
        "        run: npm run test:e2e:web\n        timeout-minutes: 40",
    )

    assert _timeout_shortfall(workflow) is not None
