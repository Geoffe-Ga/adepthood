"""Tripwires for the nightly deep-scan job's CI wiring.

The failure mode of a DAST job is not a red build -- it is a green one that
attacked nothing. This job is more exposed to that than its two siblings,
because it is advisory by design: nothing about a nightly run's colour tells you
whether ZAP imported 128 operations or failed to parse the document and probed
the root path alone. So the wiring is graded here, and graded on the *code*: the
whole file is read with comments stripped, because the header argues at length
about the very things a substring search would then find.

Where a sibling suite could extract the command into a shell script and execute
it under a stub, this job cannot -- ZAP is invoked through a pinned action, and
an action is configured by data rather than by argv. The equivalent guard is to
parse the step's ``with:`` mapping and assert on the values, which is what
``step_inputs`` does; a commented-out ``uses:`` and a missing input both show up
as an absence rather than as a passing substring. The readers themselves are
meta-tested against deliberately violating fixtures at the bottom of this file.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from rate_limit import RATE_LIMIT_OVERRIDE_ENV_VAR
from tests.workflow_text import (
    comment_lines,
    jobs,
    step_body,
    step_inputs,
    step_run_command,
    step_uses,
    trigger_block,
    without_comment_lines,
)

_REPO_ROOT = Path(__file__).resolve().parents[4]
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "dast-deep.yml"
_RULES = _REPO_ROOT / ".zap" / "rules.tsv"

_SCAN_STEP = "ZAP API scan"
_SARIF_STEP = "Convert the ZAP report to SARIF"
_UPLOAD_SARIF_STEP = "Publish the findings to code scanning"
_ARTIFACT_STEP = "Upload the raw report"
_MINT_STEP = "Mint a bearer token and prove it works"
_EVIDENCE_STEP = "Prove the scan reached authenticated code"

_ARTIFACT_NAME = "dast-deep-report"
_RETENTION_DAYS = "30"
_RULES_FILE = ".zap/rules.tsv"

# The one origin this job is allowed to name. Held as a set and compared by
# containment of the *whole* origin rather than by substring: a lookalike host
# such as ``localhost.example.invalid`` contains ``localhost``, and
# ``127.0.0.1.example.invalid`` starts with the loopback address, so any check
# phrased as "does it mention the loopback" waves both of them through.
_TARGET_ORIGIN = "http://127.0.0.1:8000"
_ALLOWED_ORIGINS = frozenset({_TARGET_ORIGIN})
_ORIGIN = re.compile(r"https?://[\w.-]+(?::\d+)?")

# ZAP's ``-T`` is "max time to wait for ZAP to start and the *passive* scan to
# run"; it is consumed by ``wait_for_zap_start`` and ``zap_wait_for_passive_scan``
# and never by ``zap_active_scan``, which polls ``ascan.status`` to 100 with no
# deadline. The only thing that bounds the attack phase is this config key.
_ACTIVE_SCAN_DEADLINE = re.compile(r"-config\s+scanner\.maxScanDurationInMins=(?P<minutes>\d+)")
_SERVER_OVERRIDE = re.compile(rf"-O\s+{re.escape(_TARGET_ORIGIN)}(?:\s|$)")
_JOB_CEILING = re.compile(r"^\s*timeout-minutes:\s*(?P<minutes>\d+)\s*$", re.MULTILINE)

# The scan runs nightly and on demand and on nothing else. Held as one block and
# compared by equality, because every disarm here is a *narrowing* -- a dropped
# cron, an added branch filter, a ``pull_request`` that would point an attack
# scan at a fork's code -- and no containment check sees more than the one
# fragment it names.
_CANONICAL_TRIGGERS = """\
  schedule:
    - cron: "0 4 * * *"
  workflow_dispatch:"""

# Text that would leave the job structurally present while reporting a failed
# run as a passing one. ``|| true`` is here because it is the disarm this
# repository's playbook names by name: a gate whose exit code is swallowed reads
# in the run list exactly like a gate that passed.
_DISARMING_FRAGMENTS = ("continue-on-error", "if: false", "if: ${{ false }}", "|| true")

# The dispositions a ZAP rules file may express. ``IGNORE`` is the only one that
# removes a finding, and it is the only one this file is expected to use.
_DISPOSITIONS = frozenset({"IGNORE", "WARN", "FAIL"})

# A named suppression has to be defended; a list that grows without anyone
# noticing is a blanket ``-I`` spelled slowly. The cap is deliberately close to
# the current list.
_MAX_IGNORED_RULES = 8

_USES = re.compile(r"^\s*(?:- )?uses:\s*(?P<action>\S+)\s*(?P<comment>#.*)?$", re.MULTILINE)
_SHA_PINNED = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")

# ZAP's own "treat every warning as a pass" switch. The issue that commissioned
# this job forbids it by name: suppressions are per-rule and carry reasons.
_BLANKET_IGNORE = re.compile(r"(?:^|\s)-I(?:\s|$)")


@pytest.fixture(scope="module")
def workflow() -> str:
    """Return the deep-scan workflow as text."""
    assert _WORKFLOW.is_file(), f"{_WORKFLOW} does not exist"
    return _WORKFLOW.read_text(encoding="utf-8")


def test_the_scan_runs_nightly_and_on_demand_and_on_nothing_else(workflow: str) -> None:
    """An attack scan reachable from a pull request is an unauthorized-scan incident.

    Equality rather than containment: a ``pull_request`` trigger added beside the
    cron would let any fork aim this at code it wrote, a ``branches`` filter would
    silently stop the nightly, and both are one inequality here.
    """
    assert trigger_block(workflow) == _CANONICAL_TRIGGERS
    assert "pull_request" not in without_comment_lines(workflow)


def test_the_workflow_holds_exactly_the_two_scopes_it_needs(workflow: str) -> None:
    """``security-events: write`` publishes SARIF; anything beyond that is spare authority."""
    declared = re.search(r"^permissions:\n((?:  [a-z-]+: [a-z-]+.*\n)+)", workflow, re.MULTILINE)
    assert declared is not None, "the workflow declares no top-level permissions"
    scopes = dict(
        line.split("#")[0].strip().split(": ", 1) for line in declared.group(1).splitlines()
    )

    assert scopes == {"contents": "read", "security-events": "write"}


def test_overlapping_runs_are_prevented(workflow: str) -> None:
    """Two ZAP containers attacking one loopback instance report on each other's traffic."""
    live = without_comment_lines(workflow)

    assert re.search(r"^concurrency:\n  group: dast-deep\b", live, re.MULTILINE), live
    assert "cancel-in-progress: false" in live


def test_every_action_is_sha_pinned(workflow: str) -> None:
    """A floating tag is a supply-chain hole in a job that mints a credential."""
    actions = _USES.findall(workflow)
    assert actions, "the workflow uses no actions at all"
    for action, comment in actions:
        if action.startswith("./"):
            continue
        assert _SHA_PINNED.match(action), f"{action} is not pinned to a 40-character SHA"
        assert comment, f"{action} carries no version comment"


def test_the_job_stands_up_its_own_instance_against_postgres(workflow: str) -> None:
    """Never scan a host this job did not start; an ephemeral instance is the whole design."""
    live = without_comment_lines(workflow)

    assert "postgres:16" in live
    # Started the way the Dockerfile does -- module ``main`` with PYTHONPATH=src.
    assert "PYTHONPATH=src python -m uvicorn main:app" in live
    assert "src.main:app" not in live
    # ``/health/ready``, not ``/health``: the startup seeder must finish first.
    assert "/health/ready" in live
    # No host may be named that this job did not start.
    assert "127.0.0.1" in live


def test_the_scan_target_is_the_instance_this_job_started(workflow: str) -> None:
    """A hardcoded external host would make a nightly cron an unauthorized scan.

    Every origin in the live text is compared whole against the one allowed
    value. A containment test would not do: ``http://localhost.example.invalid``
    contains ``localhost`` and ``http://127.0.0.1.example.invalid`` starts with
    the loopback address, so both would read as the instance this job started
    while pointing twenty minutes of attack payloads at somebody else.
    """
    origins = set(_ORIGIN.findall(without_comment_lines(workflow)))
    external = sorted(origins - _ALLOWED_ORIGINS)

    assert not external, f"the workflow names a host it did not start: {external}"


def test_the_job_proves_its_credential_before_spending_it(workflow: str) -> None:
    """A scan holding a broken token is answered 401 everywhere and finds nothing."""
    minting = step_run_command(workflow, _MINT_STEP)

    assert "scripts.dast.tokens" in minting, minting
    assert "DAST_TOKEN=" in minting, minting


def test_the_scan_is_handed_that_credential(workflow: str) -> None:
    """Minting a token and not sending it is the same as never minting one."""
    body = "\n".join(step_body(workflow, _SCAN_STEP))

    assert "ZAP_AUTH_HEADER_VALUE" in body, body
    assert "DAST_TOKEN" in body, body
    # Scoped to the host under test, so the header cannot follow a redirect out.
    assert "ZAP_AUTH_HEADER_SITE" in body, body


def test_the_scan_imports_the_openapi_document_rather_than_spidering(workflow: str) -> None:
    """A spider against a JSON API with no HTML crawls nothing and reports on nothing."""
    inputs = step_inputs(workflow, _SCAN_STEP)

    assert inputs.get("format") == "openapi", inputs
    assert inputs.get("target", "").endswith("/openapi.json"), inputs


def test_the_scan_step_invokes_the_pinned_zap_action(workflow: str) -> None:
    """A commented-out ``uses:`` leaves a named step that runs nothing at all."""
    used = step_uses(workflow, _SCAN_STEP)

    assert used.startswith("zaproxy/action-api-scan@"), used
    assert _SHA_PINNED.match(used), used


def test_the_scan_reports_rather_than_blocks(workflow: str) -> None:
    """A flaky nightly gate gets muted, and a muted gate is worse than none."""
    inputs = step_inputs(workflow, _SCAN_STEP)

    assert inputs.get("fail_action") == "false", inputs


def test_the_scan_does_not_open_its_own_issues(workflow: str) -> None:
    """Findings land in the Security tab; a second, unmanaged issue stream is noise.

    This is also what keeps the permission set to two scopes: the action's issue
    writer is the only thing in the job that would need ``issues: write``.
    """
    inputs = step_inputs(workflow, _SCAN_STEP)

    assert inputs.get("allow_issue_writing") == "false", inputs


def test_the_scan_reads_the_checked_in_rule_dispositions(workflow: str) -> None:
    """Suppressions have to be reviewable, which means they live in the repository."""
    inputs = step_inputs(workflow, _SCAN_STEP)

    assert inputs.get("rules_file_name") == _RULES_FILE, inputs


def test_the_scan_never_blanket_ignores_warnings(workflow: str) -> None:
    """``-I`` passes every warning at once, which is every suppression un-reviewed."""
    options = step_inputs(workflow, _SCAN_STEP).get("cmd_options", "")

    assert not _BLANKET_IGNORE.search(options), options


def test_the_scan_is_told_which_server_the_document_never_names(workflow: str) -> None:
    """Without ``-O`` the scan attacks whatever host ZAP infers, which is nothing at all.

    FastAPI publishes no ``servers`` block, so the imported document says nothing
    about where the operations live. Drop this option and ZAP guesses, the guess
    does not resolve, and the run produces a report with no alerts in it -- which
    uploads cleanly and renders as a Security tab with nothing to say.
    """
    options = step_inputs(workflow, _SCAN_STEP).get("cmd_options", "")

    assert _SERVER_OVERRIDE.search(options), options


def test_the_active_scan_carries_a_deadline_that_actually_bounds_it(workflow: str) -> None:
    """``-T`` bounds ZAP's startup and its passive queue, and nothing else.

    In ZAP's own ``zap-api-scan.py`` the value of ``-T`` reaches exactly two
    calls -- ``wait_for_zap_start`` and ``zap_wait_for_passive_scan``. The attack
    phase runs in ``zap_active_scan``, which polls ``ascan.status`` until it
    reaches 100 with no deadline of any kind. So the only budget on the part of
    this job that takes the time is the config key asserted here, and it has to
    leave room under the job ceiling for the image pull, the boot and the
    conversion -- otherwise the job is cancelled mid-scan, no SARIF is ever
    written, and the nightly is red for a reason nobody chose.
    """
    options = step_inputs(workflow, _SCAN_STEP).get("cmd_options", "")
    deadline = _ACTIVE_SCAN_DEADLINE.search(options)
    ceiling = _JOB_CEILING.search(without_comment_lines(workflow))

    assert deadline is not None, options
    assert ceiling is not None, "the job declares no timeout-minutes"
    assert int(deadline["minutes"]) < int(ceiling["minutes"])


def test_the_scan_proves_it_got_past_the_front_door(workflow: str) -> None:
    """A scan answered 401 everywhere reaches no handler and reports perfectly clean.

    Minting a working token proves the credential; it says nothing about whether
    ZAP ever attached it to ZAP's own traffic. Those two states are
    indistinguishable in every other artifact this job produces -- the report
    still names a site, the SARIF still validates, ``fail_action: false`` still
    keeps ZAP quiet -- so the evidence has to be read off the target instead.
    """
    command = step_run_command(workflow, _EVIDENCE_STEP)

    assert "scripts.dast.scan_evidence" in command, command


def test_the_instance_records_the_traffic_that_evidence_is_read_from(workflow: str) -> None:
    """At ``warning`` uvicorn logs no request lines, and the evidence check reads nothing."""
    live = without_comment_lines(workflow)

    assert "--log-level info" in live, live
    assert "--log-level warning" not in live, live


def test_the_findings_are_converted_and_summarised_in_one_step(workflow: str) -> None:
    """Nobody watches a cron run; the summary is the only place this job can speak."""
    command = step_run_command(workflow, _SARIF_STEP)

    assert "scripts.dast.zap_sarif" in command, command
    assert '>> "$GITHUB_STEP_SUMMARY"' in command, command


def test_the_findings_are_published_to_code_scanning(workflow: str) -> None:
    """History and dismissal tracking are the reason to publish SARIF at all."""
    used = step_uses(workflow, _UPLOAD_SARIF_STEP)
    inputs = step_inputs(workflow, _UPLOAD_SARIF_STEP)

    assert used.startswith("github/codeql-action/upload-sarif@"), used
    assert inputs.get("sarif_file", "").endswith(".sarif"), inputs


def test_the_raw_report_is_kept_for_the_remediation_loop(workflow: str) -> None:
    """The remediation scan reads this artifact; an unnamed or unretained one is unreadable."""
    inputs = step_inputs(workflow, _ARTIFACT_STEP)
    body = "\n".join(step_body(workflow, _ARTIFACT_STEP))

    assert inputs.get("name") == _ARTIFACT_NAME, inputs
    assert inputs.get("retention-days") == _RETENTION_DAYS, inputs
    # Uploaded even when the conversion failed: that is exactly when it is needed.
    assert "if: always()" in body, body


def test_the_instance_is_started_with_the_dast_rate_limit_override(workflow: str) -> None:
    """Without it the global 60/minute limit answers most of an attack run with 429.

    Anchored to the start of the line: the variable is namespaced, and a plain
    containment check would be satisfied by any variable whose name merely ends
    with the one the application reads.
    """
    declared = rf"^\s*{re.escape(RATE_LIMIT_OVERRIDE_ENV_VAR)}: \S+$"
    live = without_comment_lines(workflow)

    assert re.search(declared, live, re.MULTILINE), live


def test_the_job_cannot_be_disarmed(workflow: str) -> None:
    """Each fragment below turns a failing run into a passing one."""
    live = without_comment_lines(workflow)

    for fragment in _DISARMING_FRAGMENTS:
        assert fragment not in live, f"{fragment!r} would disarm the job"


def test_a_failing_run_opens_a_tracking_issue(workflow: str) -> None:
    """A cron failure that notifies nobody looks like a run with nothing to do.

    ``test_scheduled_workflow_legibility`` holds every scheduled workflow to this;
    it is restated here so that a reader of this file learns the rule from the
    file it applies to.
    """
    reporting = [
        body
        for body in jobs(without_comment_lines(workflow)).values()
        if "if: failure()" in body and "./.github/workflows/_report-failure.yml" in body
    ]

    assert reporting, "no `if: failure()` job calls the shared failure reporter"


def test_the_header_does_not_claim_the_job_blocks_anything(workflow: str) -> None:
    """Prose that contradicts the YAML is believed over the YAML by the next reader."""
    prose = comment_lines(workflow).lower()

    assert "pull_request_target" not in without_comment_lines(workflow)
    assert "required check" not in prose


# --------------------------------------------------------------------------
# The checked-in rule dispositions.
# --------------------------------------------------------------------------


def _rule_lines() -> list[str]:
    """Return the live, non-comment lines of the ZAP rules file."""
    assert _RULES.is_file(), f"{_RULES} does not exist"
    return [
        line
        for line in _RULES.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def test_the_rules_file_is_well_formed_tab_separated_text() -> None:
    """ZAP reads this as TSV; a space-separated line is parsed as one field and ignored."""
    lines = _rule_lines()
    assert lines, "the rules file expresses no dispositions at all"

    for line in lines:
        fields = line.split("\t")
        assert len(fields) >= 3, f"{line!r} is not <id><TAB><disposition><TAB><reason>"
        assert fields[0].isdigit(), f"{line!r} does not start with a numeric rule id"
        assert fields[1] in _DISPOSITIONS, f"{line!r} names no known disposition"


def test_every_suppression_carries_its_reason() -> None:
    """A suppression whose reason nobody wrote down is one nobody can ever retire."""
    for line in _rule_lines():
        reason = line.split("\t")[2].strip()

        assert len(reason) > len("()"), f"{line!r} suppresses a rule without saying why"


def test_the_suppression_list_stays_a_short_defended_one() -> None:
    """An ignore list that grows quietly is a blanket ``-I`` spelled one line at a time."""
    ignored = [line for line in _rule_lines() if line.split("\t")[1] == "IGNORE"]

    assert len(ignored) <= _MAX_IGNORED_RULES, f"{len(ignored)} rules are ignored"


def test_no_rule_is_listed_twice() -> None:
    """Two dispositions for one rule means the file's meaning depends on ZAP's parser."""
    ids = [line.split("\t")[0] for line in _rule_lines()]

    assert len(ids) == len(set(ids)), ids


@pytest.mark.parametrize(
    "rule_id",
    ["10038", "10020", "10021", "10063", "10098"],
)
def test_the_header_rules_the_middleware_answers_are_left_armed(rule_id: str) -> None:
    """Those passive rules are what turn an asserted control into a verified one.

    CSP, X-Frame-Options, X-Content-Type-Options and Permissions-Policy are all
    set by ``backend/src/middleware/security_headers.py``, and CORS is configured
    in ``main``. Suppressing any of them would mean the scan can no longer notice
    the day one of them stops being emitted at the edge -- which is the single
    most valuable thing the passive half of this scan does.
    """
    suppressed = [line.split("\t")[0] for line in _rule_lines() if line.split("\t")[1] == "IGNORE"]

    assert rule_id not in suppressed


# --------------------------------------------------------------------------
# Meta-tests: the readers above, pointed at deliberately violating fixtures.
# --------------------------------------------------------------------------

_STEP_FIXTURE = """\
jobs:
  scan:
    steps:
      - name: ZAP API scan
{body}
      - name: Next step
        run: echo done
"""


def _fixture(*lines: str) -> str:
    """Build a miniature workflow whose scan step is the given lines, indented once."""
    body = "\n".join(f"        {line}" for line in lines)
    return _STEP_FIXTURE.format(body=body)


def test_the_uses_reader_sees_a_commented_out_action() -> None:
    """The disarm a substring search cannot see: the action is still named, in a comment."""
    commented = _fixture("# uses: zaproxy/action-api-scan@" + "0" * 40, "run: echo skipped")

    assert step_uses(commented, _SCAN_STEP) == ""


def test_the_uses_reader_stops_at_the_next_step() -> None:
    """A reader that ran on would read the next step's action as this step's."""
    live = _fixture("uses: zaproxy/action-api-scan@" + "1" * 40)

    assert step_uses(live, _SCAN_STEP).startswith("zaproxy/action-api-scan@")
    assert step_uses(live, "Next step") == ""


def test_the_input_reader_reads_the_values_and_not_the_file() -> None:
    """``fail_action: true`` beside a comment saying ``false`` must read as ``true``."""
    inputs = step_inputs(
        _fixture(
            "uses: zaproxy/action-api-scan@" + "2" * 40,
            "with:",
            "  # fail_action: false",
            "  fail_action: true",
            '  target: "http://127.0.0.1:8000/openapi.json"',
        ),
        _SCAN_STEP,
    )

    assert inputs == {"fail_action": "true", "target": "http://127.0.0.1:8000/openapi.json"}


def test_the_input_reader_does_not_run_past_the_with_block() -> None:
    """Keys that follow the mapping are the step's, not the action's inputs."""
    inputs = step_inputs(
        _fixture(
            "uses: zaproxy/action-api-scan@" + "3" * 40,
            "with:",
            "  fail_action: false",
            "env:",
            "  SECRET: value",
        ),
        _SCAN_STEP,
    )

    assert inputs == {"fail_action": "false"}


def test_the_input_reader_reports_a_step_that_declares_nothing() -> None:
    """An absent input must read as absent, not as whatever the last step declared."""
    assert step_inputs(_fixture("run: echo nothing"), _SCAN_STEP) == {}


def test_the_input_reader_refuses_a_step_that_is_not_there() -> None:
    """A renamed step must fail loudly, not silently assert about nothing."""
    with pytest.raises(AssertionError, match="no step named"):
        step_inputs(_fixture("run: echo nothing"), "Step that does not exist")


def test_the_trigger_comparison_sees_a_pull_request_added_beside_the_cron() -> None:
    """The one edit that would turn a nightly self-scan into a scan of a fork's code."""
    widened = f"{_CANONICAL_TRIGGERS}\n  pull_request:"
    fixture = f"name: Example\n\non:\n{widened}\n\njobs:\n  scan:\n"

    assert trigger_block(fixture) != _CANONICAL_TRIGGERS


def test_the_trigger_comparison_accepts_the_canonical_block() -> None:
    """Without this, a red equality test could mean a reader bug rather than a disarm."""
    fixture = f"name: Example\n\non:\n{_CANONICAL_TRIGGERS}\n\njobs:\n  scan:\n"

    assert trigger_block(fixture) == _CANONICAL_TRIGGERS
