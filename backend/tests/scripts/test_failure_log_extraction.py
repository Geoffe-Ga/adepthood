"""The shared failure reporter must not turn an unreadable log into a blank one.

``_report-failure.yml`` is the single failure path for eight workflows. Its
first act is to fetch the failing run's log:

    gh run view "$GITHUB_RUN_ID" --log-failed > "$log" 2>/dev/null || : > "$log"

Three things are discarded on that line: stderr, the exit code, and the
difference between them. Whatever went wrong, the reporter proceeds with an
empty file and files an issue reading "(step name unavailable)" and "(no failure
log was readable for this run)".

WHY THAT FIRES EVERY TIME RATHER THAN RARELY: ``report-failure`` is a job inside
the still-in-progress run it is reporting on, and GitHub's run-level log archive
404s until the run completes. So the fetch does not fail occasionally on a flaky
network -- it fails on every single invocation, for a reason that is not a
transport fault and that a maintainer reading the issue cannot guess. The log is
perfectly readable once the run finishes; nothing here is unknowable.

The repo's own playbook forbids exactly this shape: never swallow a command's
exit code with ``|| <default>``; branch on the code, so a transport failure stays
distinguishable from a substantive zero. An empty log and a failed fetch are the
two answers being collapsed, and the collapsed answer is the one printed in the
tracking issue.

WHAT "LOUD" MEANS HERE, and what it does not. The block's own comment is right
that an unreadable log must still produce a report -- the run failed, and that
fact reaching a human matters more than the detail attached to it. So the
requirement is not that the reporter abort. It is that a failed FETCH names
itself, in the material handed onward, instead of being rendered as a log that
was read and found empty.

The real ``run:`` block is extracted from the YAML and executed, under the same
``bash -e`` GitHub uses, against a stub ``gh`` and a stub reporter script. The
unit under test is that block; testing a copy of it would pass while the shipped
one stayed broken.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import textwrap
from dataclasses import dataclass, field
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_REPORTER_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "_report-failure.yml"

# The step whose script fetches the log. Named rather than indexed so a step
# inserted above it does not silently move this test onto a different script.
_STEP_NAME = "Open or update the tracking issue"

# The path the block invokes once it has a log, relative to the checkout.
_REPORTER_SCRIPT = Path("scripts") / "graph" / "report_workflow_failure.sh"

_RUN_BLOCK = re.compile(r"^(\s*)run:\s*[|>][-+]?\s*$")
_STEP_START = re.compile(r"^\s*-\s+\w[\w-]*:")

# What `gh run view --log-failed` really answers for a run that has not
# finished. Captured rather than invented: the exact wording is the thing a
# maintainer would need to see in the tracking issue to know that nothing is
# wrong with the log, only with when it was asked for.
_IN_PROGRESS_ERROR = "could not find any workflow run logs: HTTP 404 (Not Found)"

_NETWORK_ERROR = "error connecting to api.github.com: dial tcp: lookup failed"

# A plausible line of a real --log-failed answer: tab-separated job, step and
# message, which is the shape report_workflow_failure.sh parses with awk -F'\t'.
_REAL_LOG = (
    "Groom the Ralph backlog\tRun backlog grooming\t##[error]Process completed with exit code 1.\n"
)


def _extract_run_block(workflow: Path, step_name: str) -> str:
    """Return the inline script of the named step, dedented and ready to execute.

    Parsed as plain text on purpose: PyYAML is deliberately in no requirements
    file, and importing it here would turn this module into a collection error
    on the 3.11 and 3.12 compat jobs.
    """
    lines = workflow.read_text(encoding="utf-8").splitlines()
    inside = False
    index = 0
    while index < len(lines):
        line = lines[index]
        if _STEP_START.match(line) and f"name: {step_name}" in line:
            inside = True
        elif _STEP_START.match(line) and "name:" in line:
            inside = False
        block = _RUN_BLOCK.match(line)
        if inside and block is not None:
            indent = len(block.group(1))
            body: list[str] = []
            index += 1
            while index < len(lines):
                candidate = lines[index]
                if candidate.strip() and len(candidate) - len(candidate.lstrip()) <= indent:
                    break
                body.append(candidate)
                index += 1
            return textwrap.dedent("\n".join(body))
        index += 1
    pytest.fail(f"no `run:` block found under a step named {step_name!r} in {workflow.name}")


@dataclass(frozen=True)
class Reported:
    """Everything the block produced: its own output, and what it handed onward."""

    exit_code: int
    stdout: str
    stderr: str
    reporter_ran: bool
    reporter_args: str
    log_handed_on: str

    @property
    def everything_a_human_sees(self) -> str:
        """The block's output plus the material the tracking issue is built from."""
        return f"{self.stdout}\n{self.stderr}\n{self.reporter_args}\n{self.log_handed_on}"


@dataclass(frozen=True)
class Archive:
    """What ``gh run view --log-failed`` answers for the run being reported on."""

    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0


@dataclass(frozen=True)
class JobsApi:
    """What the per-job endpoints answer, which is where the fallback looks.

    ``jobs`` is the JSON body the run's jobs endpoint serves, or ``None`` for an
    endpoint that fails -- the default, so that a case saying nothing about the
    fallback exercises the path where the fallback comes back with nothing.
    ``logs`` maps a job id to the raw text that job's log endpoint serves; a job
    absent from it has no published log.
    """

    jobs: str | None = None
    logs: dict[str, str] = field(default_factory=dict)


def _run_reporter(
    tmp_path: Path,
    archive: Archive,
    jobs_api: JobsApi | None = None,
) -> Reported:
    """Execute the real block with ``gh`` and the reporter script stubbed out."""
    api = jobs_api if jobs_api is not None else JobsApi()
    gh_stdout, gh_stderr, gh_exit = archive.stdout, archive.stderr, archive.exit_code
    jobs, job_logs = api.jobs, api.logs
    sandbox = tmp_path / "sandbox"
    runner_temp = tmp_path / "runner-temp"
    stubs = tmp_path / "stubs"
    logs = tmp_path / "job-logs"
    for directory in (sandbox / _REPORTER_SCRIPT.parent, runner_temp, stubs, logs):
        directory.mkdir(parents=True, exist_ok=True)

    # The payloads go to files and the stub cats them. Interpolating them into
    # the stub's text instead would put the log's real tabs and newlines through
    # a round of shell quoting, and `printf '%s'` does not expand the `\t` that
    # comes back out -- which would hand the reporter a log that no longer has
    # the tab-separated shape its awk parses on.
    stdout_payload = stubs / "gh-stdout.txt"
    stderr_payload = stubs / "gh-stderr.txt"
    jobs_payload = stubs / "gh-jobs.json"
    stdout_payload.write_text(gh_stdout, encoding="utf-8")
    stderr_payload.write_text(gh_stderr, encoding="utf-8")
    if jobs is not None:
        jobs_payload.write_text(jobs, encoding="utf-8")
    for job_id, body in (job_logs or {}).items():
        (logs / f"{job_id}.txt").write_text(body, encoding="utf-8")

    # The stub dispatches on argv rather than answering everything the same way,
    # because the block asks `gh` three different questions and collapsing them
    # would let the two it asks only on the fallback path go unasked. The `--jq`
    # filter is handed to the real jq: the filter is part of the code under
    # test, and a stub that returned pre-shaped TSV would be testing nothing but
    # the stub.
    gh_stub = stubs / "gh"
    gh_stub.write_text(
        f"""\
#!/usr/bin/env bash
case "$1" in
  run)
    cat {str(stdout_payload)!r}
    cat {str(stderr_payload)!r} >&2
    exit {gh_exit}
    ;;
  api)
    shift
    endpoint=""
    filter=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --jq|-q) filter="$2"; shift 2 ;;
        -*) shift ;;
        *) [ -n "$endpoint" ] || endpoint="$1"; shift ;;
      esac
    done
    case "$endpoint" in
      */logs)
        job_id="${{endpoint%/logs}}"
        job_id="${{job_id##*/}}"
        if [ -r {str(logs)!r}/"$job_id".txt ]; then
          cat {str(logs)!r}/"$job_id".txt
        else
          echo "gh: no log published for job $job_id (HTTP 404)" >&2
          exit 1
        fi
        ;;
      *)
        if [ -r {str(jobs_payload)!r} ]; then
          jq -r "$filter" < {str(jobs_payload)!r}
        else
          echo "gh: the jobs endpoint is unreachable" >&2
          exit 1
        fi
        ;;
    esac
    ;;
  *)
    echo "gh: unstubbed subcommand $1" >&2
    exit 127
    ;;
esac
""",
        encoding="utf-8",
    )
    gh_stub.chmod(0o755)

    captured_args = tmp_path / "reporter-args.txt"
    captured_log = tmp_path / "reporter-log.txt"
    (sandbox / _REPORTER_SCRIPT).write_text(
        "#!/usr/bin/env bash\n"
        f'printf "%s\\n" "$@" > {str(captured_args)!r}\n'
        "log=''\n"
        "while [ $# -gt 0 ]; do\n"
        '  if [ "$1" = "--log-file" ]; then log="$2"; fi\n'
        "  shift\n"
        "done\n"
        f'if [ -n "$log" ] && [ -r "$log" ]; then cat "$log" > {str(captured_log)!r}; fi\n',
        encoding="utf-8",
    )

    script = sandbox / "step.sh"
    script.write_text(_extract_run_block(_REPORTER_WORKFLOW, _STEP_NAME), encoding="utf-8")

    completed = subprocess.run(
        # The shell GitHub uses for a `run:` block with no `shell:` of its own.
        ["/usr/bin/env", "bash", "-e", str(script)],
        cwd=sandbox,
        capture_output=True,
        text=True,
        check=False,
        env={
            "PATH": f"{stubs}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(tmp_path),
            "RUNNER_TEMP": str(runner_temp),
            "GITHUB_RUN_ID": "33304651747",
            # Actions always sets this. Omitting it here would leave the whole
            # per-job fallback behind a guard that is never true, so every case
            # below would pass with that block deleted.
            "GITHUB_REPOSITORY": "owner/repo",
            "GH_TOKEN": "stub-token",
            "RUN_URL": "https://github.com/owner/repo/actions/runs/33304651747",
            "WORKFLOW_FILE": "scan-groom.yml",
            "HEADLINE": "",
            "LABELS": "bug,infra",
        },
    )
    return Reported(
        exit_code=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
        reporter_ran=captured_args.exists(),
        reporter_args=captured_args.read_text(encoding="utf-8") if captured_args.exists() else "",
        log_handed_on=captured_log.read_text(encoding="utf-8") if captured_log.exists() else "",
    )


# --- The block is where it is expected to be -------------------------------


def test_the_reporter_workflow_still_fetches_the_log_in_that_step() -> None:
    """A guard whose subject moved silently would pass forever."""
    block = _extract_run_block(_REPORTER_WORKFLOW, _STEP_NAME)

    assert "gh run view" in block
    assert "--log-failed" in block


def test_the_shared_reporter_script_exists() -> None:
    """The block invokes it by path; the stub below stands in for a real file."""
    assert (_REPO_ROOT / _REPORTER_SCRIPT).is_file()


def test_bash_is_available_to_execute_the_block() -> None:
    """These cases prove nothing if the interpreter is missing."""
    assert shutil.which("bash")


# --- What the block does with each answer `gh` can give it -----------------


def test_a_readable_log_reaches_the_reporter_intact(tmp_path: Path) -> None:
    """The control. Whatever else changes, the working path must keep working."""
    result = _run_reporter(tmp_path, Archive(stdout=_REAL_LOG))

    assert result.reporter_ran, "the reporter was never invoked on a successful fetch"
    assert result.log_handed_on == _REAL_LOG


_FETCH_ERRORS = [
    pytest.param(_IN_PROGRESS_ERROR, id="in-progress-404"),
    pytest.param(_NETWORK_ERROR, id="network"),
]


@pytest.mark.parametrize("message", _FETCH_ERRORS)
def test_a_failed_fetch_is_not_handed_on_as_an_empty_log(tmp_path: Path, message: str) -> None:
    """An empty file says "the log was read and held nothing". That is a false statement.

    The reporter downstream renders it as "(no failure log was readable for this
    run)" beside "(step name unavailable)", which reads as a run that produced
    no diagnosable output -- when in fact nothing was ever fetched.
    """
    result = _run_reporter(tmp_path, Archive(stderr=message, exit_code=1))

    assert result.log_handed_on.strip() != "", (
        "the reporter was handed an empty log after the fetch failed, which is "
        "indistinguishable from a run whose log was genuinely empty"
    )


@pytest.mark.parametrize("message", _FETCH_ERRORS)
def test_a_failed_fetch_names_itself_somewhere_a_human_will_read(
    tmp_path: Path, message: str
) -> None:
    """The reason is knowable and must survive to the issue, the log, or the annotation.

    Discarding stderr is what makes the in-progress 404 unguessable. A
    maintainer who can see the words "HTTP 404" knows the log exists and was
    asked for too early; without them the tracking issue is a dead end.
    """
    result = _run_reporter(tmp_path, Archive(stderr=message, exit_code=1))
    seen = result.everything_a_human_sees

    assert message in seen or "::error::" in seen or "::warning::" in seen, (
        "the fetch failed and said why, and none of it reached the step output, "
        "the annotations, or the material the tracking issue is built from"
    )


def test_a_failed_fetch_still_reports_the_failure(tmp_path: Path) -> None:
    """Loud is not the same as fatal, and this is the half that must not regress.

    The run failed; that fact reaching a human outranks the detail attached to
    it. A fix that made a fetch error abort the reporter would trade a
    misleading issue for no issue at all, which is the silence the shared
    reporter exists to end.
    """
    result = _run_reporter(tmp_path, Archive(stderr=_IN_PROGRESS_ERROR, exit_code=1))

    assert result.reporter_ran, "a failed log fetch suppressed the tracking issue entirely"


def test_an_empty_log_from_a_successful_fetch_stays_distinguishable(tmp_path: Path) -> None:
    """The other side of the collapse: a genuine empty log is not an error.

    If the fix reported a fetch failure whenever the log was empty, it would
    swap one conflation for its mirror image. Exit zero means the question was
    answered, and the answer was "nothing".
    """
    result = _run_reporter(tmp_path, Archive())

    assert result.reporter_ran
    assert _IN_PROGRESS_ERROR not in result.everything_a_human_sees


# --- The per-job fallback, which is the half that recovers the log ---------
#
# The archive fetch failing is not the interesting case; it is the ONLY case.
# What decides whether a tracking issue is useful is what happens next, so the
# cases below drive the fallback rather than the branch that gives up.

_FAILED_JOB_ID = "94422031055"
_PASSING_JOB_ID = "94422031056"
_FAILED_JOB_NAME = "Groom the Ralph backlog"
_FAILED_STEP_NAME = "Run backlog grooming"

# What the jobs endpoint answers with. Shaped as the API really shapes it -- a
# `jobs` array inside an object, each job carrying its own `steps` -- because
# the block's jq filter walks exactly that shape and a flattened stand-in would
# let a wrong filter pass.
_JOBS_WITH_ONE_FAILURE = f"""\
{{
  "total_count": 2,
  "jobs": [
    {{
      "id": {_PASSING_JOB_ID},
      "name": "Check out and set up",
      "conclusion": "success",
      "steps": [{{"name": "Checkout repository", "conclusion": "success"}}]
    }},
    {{
      "id": {_FAILED_JOB_ID},
      "name": "{_FAILED_JOB_NAME}",
      "conclusion": "failure",
      "steps": [
        {{"name": "Checkout repository", "conclusion": "success"}},
        {{"name": "{_FAILED_STEP_NAME}", "conclusion": "failure"}}
      ]
    }}
  ]
}}
"""

_JOBS_WITH_NO_FAILURE = """\
{
  "total_count": 1,
  "jobs": [
    {
      "id": 94422031057,
      "name": "Check out and set up",
      "conclusion": "success",
      "steps": [{"name": "Checkout repository", "conclusion": "success"}]
    }
  ]
}
"""

# A job's raw log: mostly setup noise, with the failure marked. Keeping the
# noise in is the point -- an excerpt that led with "Runner name" would be as
# useless as no log at all.
_ERROR_LINE = "##[error]Process completed with exit code 1."
_JOB_LOG = (
    "2026-08-29T02:00:01.1Z Current runner version: '2.330.0'\n"
    "2026-08-29T02:00:01.2Z ##[group]Runner Image\n"
    "2026-08-29T02:00:41.9Z Traceback (most recent call last):\n"
    f"2026-08-29T02:00:42.0Z {_ERROR_LINE}\n"
)


def test_the_per_job_fallback_supplies_the_log_the_archive_cannot_yet_serve(
    tmp_path: Path,
) -> None:
    """The recovery this whole block exists for, and the case that makes it load-bearing.

    A job's log is published when that job ends, which is before the reporter
    job starts. So the log the run-level archive 404s on is sitting one endpoint
    over the entire time. Without this the reporter's best possible answer is a
    well-worded apology.
    """
    result = _run_reporter(
        tmp_path,
        Archive(stderr=_IN_PROGRESS_ERROR, exit_code=1),
        JobsApi(jobs=_JOBS_WITH_ONE_FAILURE, logs={_FAILED_JOB_ID: _JOB_LOG}),
    )

    assert result.reporter_ran
    assert _ERROR_LINE in result.log_handed_on, (
        "the archive 404'd and the failing job's log was never read, so the "
        "tracking issue still says nothing about why the run failed"
    )


def test_the_recovered_log_names_the_job_and_step_the_reporter_parses_on(
    tmp_path: Path,
) -> None:
    """Rebuilt in the shape the downstream script parses, not merely appended.

    ``report_workflow_failure.sh`` splits each record on tabs into job, step and
    message. A recovered log that arrived as bare log lines would render as
    "(step name unavailable)" -- the exact string this change exists to stop
    printing -- while technically containing the failure.
    """
    result = _run_reporter(
        tmp_path,
        Archive(stderr=_IN_PROGRESS_ERROR, exit_code=1),
        JobsApi(jobs=_JOBS_WITH_ONE_FAILURE, logs={_FAILED_JOB_ID: _JOB_LOG}),
    )
    records = [line.split("\t") for line in result.log_handed_on.splitlines() if line.strip()]

    assert records, "the recovered log has no records at all"
    for record in records:
        assert len(record) >= 3, f"not a tab-separated job/step/message record: {record}"
        assert record[0] == _FAILED_JOB_NAME
        assert record[1] == _FAILED_STEP_NAME


def test_the_fallback_reads_only_the_failing_job(tmp_path: Path) -> None:
    """A passing job's log is noise, and the reporter excerpts the first lines it gets.

    Reading every job would push the real failure below the excerpt, which is
    the same dead end as reading none of them.
    """
    result = _run_reporter(
        tmp_path,
        Archive(stderr=_IN_PROGRESS_ERROR, exit_code=1),
        JobsApi(
            jobs=_JOBS_WITH_ONE_FAILURE,
            logs={
                _FAILED_JOB_ID: _JOB_LOG,
                _PASSING_JOB_ID: (
                    "2026-08-29T02:00:01.1Z ##[error]this job passed and is irrelevant\n"
                ),
            },
        ),
    )

    assert "irrelevant" not in result.log_handed_on


def test_the_fallback_keeps_the_failure_lines_and_drops_the_setup_noise(
    tmp_path: Path,
) -> None:
    """An unfiltered job log buries the failure under forty minutes of timestamps."""
    result = _run_reporter(
        tmp_path,
        Archive(stderr=_IN_PROGRESS_ERROR, exit_code=1),
        JobsApi(jobs=_JOBS_WITH_ONE_FAILURE, logs={_FAILED_JOB_ID: _JOB_LOG}),
    )

    assert "Current runner version" not in result.log_handed_on
    assert _ERROR_LINE in result.log_handed_on


def test_a_recovered_log_is_not_announced_as_one_that_could_not_be_fetched(
    tmp_path: Path,
) -> None:
    """The annotation must describe what happened, not what the first fetch returned.

    The archive fetch fails on EVERY invocation, so a warning keyed on its exit
    code alone prints "the failure log could not be fetched" directly above a
    failure log that was. An annotation that is wrong on the ordinary path is
    one nobody reads on the extraordinary one.
    """
    result = _run_reporter(
        tmp_path,
        Archive(stderr=_IN_PROGRESS_ERROR, exit_code=1),
        JobsApi(jobs=_JOBS_WITH_ONE_FAILURE, logs={_FAILED_JOB_ID: _JOB_LOG}),
    )

    assert "::warning::" not in result.stdout, (
        "the log was recovered and the step still warned that it could not be "
        f"fetched: {result.stdout}"
    )
    assert "::notice::" in result.stdout, (
        "nothing recorded that the archive was unavailable and the per-job API "
        "answered instead, so the recovery is invisible in the run"
    )


def test_a_run_with_no_failing_job_still_produces_a_report(tmp_path: Path) -> None:
    """The fallback finding nothing is not the same as the fallback not running.

    A cancelled or timed-out run has no job whose conclusion is `failure`. The
    reporter must still file, and must still say the log is unavailable rather
    than handing on the empty file the loop produced.
    """
    result = _run_reporter(
        tmp_path,
        Archive(stderr=_IN_PROGRESS_ERROR, exit_code=1),
        JobsApi(jobs=_JOBS_WITH_NO_FAILURE),
    )

    assert result.reporter_ran
    assert result.log_handed_on.strip() != ""
    assert "::warning::" in result.stdout


def test_a_job_whose_log_is_also_unreadable_falls_through_to_the_last_resort(
    tmp_path: Path,
) -> None:
    """Two failed fetches must still leave a record, and must not leave a blank one."""
    result = _run_reporter(
        tmp_path,
        Archive(stderr=_IN_PROGRESS_ERROR, exit_code=1),
        JobsApi(jobs=_JOBS_WITH_ONE_FAILURE, logs={}),
    )

    assert result.reporter_ran
    assert "unavailable" in result.log_handed_on
    assert "::warning::" in result.stdout


def test_the_jobs_fetch_asks_for_every_page(tmp_path: Path) -> None:
    """A matrix run has more than one page of jobs, and the failing one may be on it.

    Asserted on the command rather than through the stub because paginating is
    ``gh``'s behaviour, not this block's; what this block owns is asking for it.
    A default read stops at thirty jobs, which loses the failure on exactly the
    largest runs -- the ones whose logs are hardest to read by hand.
    """
    del tmp_path
    block = _extract_run_block(_REPORTER_WORKFLOW, _STEP_NAME)
    fetch = [
        line
        for line in block.splitlines()
        if "actions/runs/" in line and not line.lstrip().startswith("#")
    ]

    assert fetch, "the jobs fetch is no longer a single line; re-point this check"
    assert "--paginate" in block
    assert "per_page=" in block


# --- The shape itself, so it cannot come back ------------------------------


def test_the_fetch_neither_discards_stderr_nor_swallows_its_exit_code() -> None:
    """The playbook rule this line breaks, stated as a check on the line.

    Branch on the code so a transport failure stays distinguishable from a
    substantive zero; never collapse it with ``|| <default>``.
    """
    fetch = [
        line
        for line in _extract_run_block(_REPORTER_WORKFLOW, _STEP_NAME).splitlines()
        if "gh run view" in line and not line.lstrip().startswith("#")
    ]

    assert fetch, "the log fetch is no longer a single line; re-point this check"
    for line in fetch:
        assert "2>/dev/null" not in line, (
            "stderr carries the only statement of why the fetch failed, and the "
            "in-progress 404 is unguessable without it"
        )
        assert "||" not in line, (
            "the exit code is being collapsed into a default; branch on it so a "
            "failed fetch stays distinguishable from an empty log"
        )
