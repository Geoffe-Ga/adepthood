"""Behavioural tests for the contract-fuzz command, run with a recording stub.

The failure mode of a DAST job is not a red build -- it is a green one that
fuzzed nothing. Guarding that by grepping a YAML file for strings does not work,
and this file exists because it was proven not to work: with the whole
``schemathesis run`` invocation commented out, every textual assertion still
passed, and with the exclusion list wired to no argument at all, the test named
"the identity-destroying operation is excluded" still passed. A substring search
cannot tell a live command from a commented-out one, nor a wired array from a
dead one.

So the command was moved out of the workflow into
``backend/scripts/dast/contract_fuzz.sh`` and is *executed* here, with a stub
named ``schemathesis`` first on ``PATH`` that records its own argv and exits
with whatever this file tells it to. Every assertion below is about the argument
list the script actually built, not about text somebody wrote in a file.

Two exclusions are load-bearing and are asserted by name. ``DELETE /users/me``
deletes the fuzzing identity; ``POST /auth/refresh`` revokes the presented
token's ``jti`` before minting its replacement. Either one kills the credential
partway through a run, and the loss is invisible: every later request answers
401, which is not a 5xx and is undeclared on every operation, so all three
enabled checks pass and the job reports success having reached no handler.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path

import pytest

from main import app

_BACKEND_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT = _BACKEND_ROOT / "scripts" / "dast" / "contract_fuzz.sh"

_HTTP_METHODS = ("get", "put", "post", "delete", "patch")

_SUBPROCESS_TIMEOUT_SECONDS = 60

# The environment the script contracts for. Fixed here rather than borrowed from
# the ambient shell so a test asserts against a value it chose.
_BASE_URL = "http://127.0.0.1:8123"
_TOKEN = "stub-bearer-token"  # pragma: allowlist secret

# Deletes the fuzzing identity outright.
_IDENTITY_DESTROYING_OPERATION = "DELETE /users/me"
# Revokes the *presented* token before minting the replacement, so the header
# the CLI sends for the whole run is dead from this operation onward.
_TOKEN_REVOKING_OPERATION = "POST /auth/refresh"

# ``--checks all`` would silently change meaning with every upgrade, so each
# check is named. ``status_code_conformance`` joined the list once every
# operation declared the refusals it can send; see the script's comment.
_REQUIRED_CHECKS = (
    "not_a_server_error",
    "content_type_conformance",
    "response_schema_conformance",
    "status_code_conformance",
)

_EXPECTED_PHASES = "examples,fuzzing"

# The one filter flag this gate is allowed to use. Every other member of
# schemathesis's ``--exclude-*`` / ``--include-*`` family selects a *class* of
# operations, which is how an exclusion list stays a defensible minority on
# paper while the run quietly skips half the API.
_ALLOWED_FILTER_FLAG = "--exclude-name"

# The script takes no arguments, so an argument is a usage error rather than a
# fuzzing verdict; conflating the two would let a mis-wired job read as a finding.
_USAGE_EXIT_CODE = 2

_EXCLUDED_BLOCK = re.compile(
    r"^\s*EXCLUDED=\(\s*$(?P<body>.*?)^\s*\)\s*$", re.MULTILINE | re.DOTALL
)
_EXCLUSION_LINE = re.compile(r"^\s*'(?P<label>[^']+)'\s*#\s*(?P<reason>\S.*?)\s*$")

# The stub stands in for schemathesis, which cannot be installed alongside the
# backend's own pins (see backend/requirements-dast.txt). It records its argv
# NUL-separated because operation names carry spaces, and exits with whatever
# the caller asked for so exit-code propagation is observable.
_STUB = """#!/usr/bin/env bash
printf '%s\\0' "$@" > "$SCHEMATHESIS_ARGV_FILE"
exit "${SCHEMATHESIS_EXIT_CODE:-0}"
"""


class FuzzRun:
    """One execution of the script under the recording stub.

    Attributes:
        returncode: The script's exit status.
        stderr: What the script wrote to stderr.
        argv: The arguments the stub was invoked with, or an empty list when the
            script exited before reaching it. That distinction is the point of
            several tests below: "refused to start" and "ran with bad arguments"
            must not look alike.
        report_dir: The directory this run told the script to report into, so a
            test can assert the argument against the value it chose.
    """

    def __init__(
        self, completed: subprocess.CompletedProcess[str], argv: list[str], report_dir: str
    ) -> None:
        """Record one run.

        Args:
            completed: The finished script process.
            argv: Arguments the stub recorded, if it ran at all.
            report_dir: Where this run asked for its report.
        """
        self.returncode = completed.returncode
        self.stderr = completed.stderr
        self.argv = argv
        self.report_dir = report_dir

    def values_for(self, flag: str) -> list[str]:
        """Return every value the recorded argv passed to ``flag``.

        Args:
            flag: The option to look up, e.g. ``--exclude-name``.

        Returns:
            One entry per occurrence, in order.
        """
        return [
            self.argv[index + 1]
            for index, token in enumerate(self.argv)
            if token == flag and index + 1 < len(self.argv)
        ]

    def value_for(self, flag: str) -> str:
        """Return the single value the recorded argv passed to ``flag``.

        Args:
            flag: The option to look up.

        Returns:
            The lone value.
        """
        values = self.values_for(flag)
        assert len(values) == 1, f"{flag} appears {len(values)} times: {self.argv}"
        return values[0]


def run_fuzz_script(
    tmp_path: Path,
    *,
    script: Path = _SCRIPT,
    stub_exit_code: int = 0,
    arguments: tuple[str, ...] = (),
    unset: str | None = None,
) -> FuzzRun:
    """Execute the fuzz script with a recording ``schemathesis`` stub on PATH.

    Args:
        tmp_path: Scratch directory for the stub and its recording.
        script: Which copy of the script to run, invoked directly through its
            own shebang the way the workflow invokes it. Tests that prove an
            assertion is non-vacuous point this at a deliberately broken copy.
        stub_exit_code: What the stub exits with, so exit-code propagation can
            be observed rather than assumed.
        arguments: Arguments to pass to the script itself.
        unset: Name of one required environment variable to withhold.

    Returns:
        The finished run, with whatever argv the stub recorded.
    """
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    stub = bin_dir / "schemathesis"
    stub.write_text(_STUB, encoding="utf-8")
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
    recording = tmp_path / "argv"
    report_dir = tmp_path / "report"

    environment = dict(os.environ)
    environment["PATH"] = f"{bin_dir}{os.pathsep}{environment.get('PATH', '')}"
    environment["SCHEMATHESIS_ARGV_FILE"] = str(recording)
    environment["SCHEMATHESIS_EXIT_CODE"] = str(stub_exit_code)
    environment["BASE_URL"] = _BASE_URL
    environment["DAST_TOKEN"] = _TOKEN
    environment["REPORT_DIR"] = str(report_dir)
    if unset is not None:
        del environment[unset]

    completed = subprocess.run(
        [str(script), *arguments],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
    )
    argv: list[str] = []
    if recording.is_file():
        argv = recording.read_text(encoding="utf-8").split("\0")[:-1]
    return FuzzRun(completed, argv, str(report_dir))


@pytest.fixture(scope="module")
def script_text() -> str:
    """Return the fuzz script's source."""
    assert _SCRIPT.is_file(), f"{_SCRIPT} does not exist"
    return _SCRIPT.read_text(encoding="utf-8")


@pytest.fixture
def fuzz_run(tmp_path: Path) -> FuzzRun:
    """Run the real script once under the stub and hand back what it built."""
    return run_fuzz_script(tmp_path)


def live_operation_labels() -> set[str]:
    """Return every operation the real application publishes, as ``METHOD /path``.

    Read from the application's own generated document rather than the
    checked-in export, so an exclusion cannot be validated against a stale copy.
    """
    document = app.openapi()
    return {
        f"{method.upper()} {path}"
        for path, operations in document["paths"].items()
        for method in operations
        if method in _HTTP_METHODS
    }


def excluded_operations(text: str) -> dict[str, str]:
    """Return the script's exclusion list, mapping each operation to its reason.

    Args:
        text: The script's source.

    Returns:
        One entry per line of the shell array the script builds its
        ``--exclude-name`` arguments from.
    """
    block = _EXCLUDED_BLOCK.search(text)
    assert block is not None, "the script declares no EXCLUDED=( ... ) array"
    entries: dict[str, str] = {}
    for line in block.group("body").splitlines():
        if not line.strip():
            continue
        match = _EXCLUSION_LINE.match(line)
        assert match is not None, f"exclusion carries no reason comment: {line!r}"
        entries[match.group("label")] = match.group("reason")
    return entries


def test_the_script_is_executable() -> None:
    """The workflow invokes it directly; a non-executable file is a red job."""
    assert os.access(_SCRIPT, os.X_OK), f"{_SCRIPT} is not executable"


def test_the_live_document_is_what_gets_fuzzed(fuzz_run: FuzzRun) -> None:
    """A checked-in spec can drift away from the app; a live one cannot."""
    assert fuzz_run.argv[:2] == ["run", f"{_BASE_URL}/openapi.json"], fuzz_run.argv
    assert fuzz_run.value_for("--url") == _BASE_URL
    assert not any("openapi.json" in token and "$" in token for token in fuzz_run.argv)


def test_the_enabled_checks_are_exactly_the_named_ones(fuzz_run: FuzzRun) -> None:
    """``--checks all`` would silently change meaning with every upgrade."""
    assert fuzz_run.value_for("--checks").split(",") == list(_REQUIRED_CHECKS)


def test_the_minted_token_is_sent_with_every_request(fuzz_run: FuzzRun) -> None:
    """Without the header the whole run is an anonymous caller collecting 401s."""
    assert fuzz_run.value_for("--header") == f"Authorization: Bearer {_TOKEN}"


def test_the_run_is_bounded_and_reproducible(fuzz_run: FuzzRun) -> None:
    """A gate that cannot be replayed cannot be trusted to have failed honestly."""
    assert fuzz_run.value_for("--seed").isdigit()
    assert int(fuzz_run.value_for("--max-examples")) > 0
    assert int(fuzz_run.value_for("--max-failures")) > 0
    assert fuzz_run.value_for("--phases") == _EXPECTED_PHASES


def test_the_report_is_written_where_the_job_collects_it(fuzz_run: FuzzRun) -> None:
    """The artifact is the only way to read a failure that happened on a runner."""
    assert fuzz_run.value_for("--report") == "junit"
    assert fuzz_run.value_for("--report-dir") == fuzz_run.report_dir


def test_every_named_exclusion_reaches_the_fuzzer(fuzz_run: FuzzRun, script_text: str) -> None:
    """The list is only a list; this proves each entry becomes an argument."""
    passed = fuzz_run.values_for(_ALLOWED_FILTER_FLAG)
    assert sorted(passed) == sorted(excluded_operations(script_text))


def test_the_identity_destroying_operation_is_excluded(fuzz_run: FuzzRun) -> None:
    """``DELETE /users/me`` deletes the fuzzing identity; every later call is vacuous."""
    assert _IDENTITY_DESTROYING_OPERATION in fuzz_run.values_for(_ALLOWED_FILTER_FLAG)


def test_the_token_revoking_operation_is_excluded(fuzz_run: FuzzRun) -> None:
    """``POST /auth/refresh`` revokes the header the whole run is authenticated by."""
    assert _TOKEN_REVOKING_OPERATION in fuzz_run.values_for(_ALLOWED_FILTER_FLAG)


def test_no_other_filter_flag_widens_the_exclusion(fuzz_run: FuzzRun) -> None:
    """A class filter is how the list stays small on paper while the run shrinks."""
    widening = [
        token
        for token in fuzz_run.argv
        if token.startswith(("--exclude", "--include")) and token != _ALLOWED_FILTER_FLAG
    ]
    assert not widening, f"these filters bypass the named exclusion list: {widening}"


def test_every_exclusion_names_a_live_operation(script_text: str) -> None:
    """A stale exclusion excuses nothing and hides that its route is being fuzzed."""
    excluded = excluded_operations(script_text)
    assert excluded, "the script excludes nothing at all"
    unknown = sorted(set(excluded) - live_operation_labels())
    assert not unknown, f"these exclusions match no live operation: {unknown}"


def test_the_exclusion_list_stays_a_minority_of_the_api(script_text: str) -> None:
    """An exclusion list that grows without limit is a blanket skip in slow motion."""
    excluded = excluded_operations(script_text)
    live = live_operation_labels()
    assert len(excluded) * 2 < len(live), (
        f"{len(excluded)} of {len(live)} operations are excluded; that is not a fuzz run"
    )


@pytest.mark.parametrize("stub_exit_code", [1, 2, 137])
def test_a_failing_fuzz_run_fails_the_script(tmp_path: Path, stub_exit_code: int) -> None:
    """A swallowed exit code is the whole disarming threat, in one assertion."""
    assert run_fuzz_script(tmp_path, stub_exit_code=stub_exit_code).returncode == stub_exit_code


@pytest.mark.parametrize("variable", ["BASE_URL", "DAST_TOKEN", "REPORT_DIR"])
def test_a_missing_requirement_refuses_to_fuzz(tmp_path: Path, variable: str) -> None:
    """Defaulting any of these is a way to fuzz the wrong thing and report success."""
    run = run_fuzz_script(tmp_path, unset=variable)
    assert run.returncode != 0
    assert variable in run.stderr, run.stderr
    assert run.argv == [], "the fuzzer ran without a complete environment"


def test_the_script_refuses_arguments(tmp_path: Path) -> None:
    """An argument would be a way to append a filter the named list cannot see."""
    run = run_fuzz_script(tmp_path, arguments=("--exclude-method", "GET"))
    assert run.returncode == _USAGE_EXIT_CODE
    assert run.argv == [], "an unrecognised argument still reached the fuzzer"


def test_the_recorded_argv_can_tell_a_wired_list_from_an_unwired_one(
    tmp_path: Path, script_text: str
) -> None:
    """Proof the exclusion assertions above are not vacuous.

    The textual guard this file replaced passed against a workflow whose
    exclusion array reached no argument at all. Deleting the same wiring here
    must be visible, or nothing above means anything.
    """
    unwired = tmp_path / "unwired.sh"
    unwired.write_text(script_text.replace('  "${exclusions[@]}"\n', ""), encoding="utf-8")
    unwired.chmod(unwired.stat().st_mode | stat.S_IXUSR)
    run = run_fuzz_script(tmp_path, script=unwired)
    assert run.returncode == 0, run.stderr
    assert run.values_for(_ALLOWED_FILTER_FLAG) == []
