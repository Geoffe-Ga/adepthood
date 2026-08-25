"""End-to-end proof that the contract-fuzz gate can actually catch a violation.

Everything else in this directory proves the *command* is built correctly: the
argv tests in ``test_contract_fuzz_script.py`` run the script under a recording
stub and assert on the arguments it produced. None of that proves the fuzzer,
once it really runs, fails on anything. A job that fuzzes zero operations -- a
schema read that returns nothing, a version bump that changes what a flag means,
a check name that quietly stops resolving -- would look exactly like a healthy
gate: exit 0, no findings, nobody looks again.

So this module runs the real ``contract_fuzz.sh``, with the real pinned
Schemathesis, against a real ``FastAPI`` application served over a real socket,
and plants two bugs in it: a handler that raises (``GET /boom``, a 500) and a
handler that returns a body contradicting the schema it declares (``GET /liar``,
``{"count": "not-a-number"}`` where ``{"count": integer}`` is published). The
run must fail and must name both. Then the same harness serves an application
with the bugs removed, and that run must pass -- with the operation counts
asserted, because "passed" and "fuzzed nothing" are the two things this whole
gate exists to tell apart. Only the pair means anything: the failing half alone
could be failing for an unrelated reason, and the passing half alone is the
vacuity it is guarding against.

Absence of Schemathesis is deliberately *not* an ``importorskip``. Nothing here
imports it; the script invokes the CLI, which is also how CI invokes it, so
mypy never has to resolve a package that is pinned in ``requirements-dast.txt``
and installed by one workflow. When the executable is missing, this module
skips with a reason that names the file to install and the variable that turns
the skip into a failure -- and ``.github/workflows/dast-contract.yml`` sets that
variable, so in the one environment that is supposed to have the tool, a missing
tool is a red job rather than a quiet pass. ``test_contract_workflow.py``
asserts that step exists and is armed.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT = _BACKEND_ROOT / "scripts" / "dast" / "contract_fuzz.sh"
_REQUIREMENTS = "backend/requirements-dast.txt"

# Set by the DAST workflow, which installs the tool. There, a missing executable
# means the install step silently did nothing, which must be loud.
REQUIRE_ENV_VAR = "DAST_LANE_REQUIRE_SCHEMATHESIS"
_TRUTHY = frozenset({"1", "true", "yes", "on"})

_EXECUTABLE = "schemathesis"

# What the CLI prints for the two checks this test plants a violation of. The
# ``--checks`` flag takes the machine names (asserted on the argv in
# ``test_contract_fuzz_script.py``); the report renders these titles.
_SERVER_ERROR_TITLE = "Server error"
_SCHEMA_VIOLATION_TITLE = "Response violates schema"

_BOOM = "GET /boom"
_LIAR = "GET /liar"
_HEALTHY = "GET /healthy"

# The planted application publishes exactly these three operations, and the
# passing half asserts the run reached all of them. A green run that selected or
# tested fewer is the vacuity this gate exists to prevent, not a clean bill.
_PUBLISHED_OPERATIONS = 3

_BOOT_TIMEOUT_SECONDS = 30
_BOOT_POLL_SECONDS = 0.2
_FUZZ_TIMEOUT_SECONDS = 180
_SHUTDOWN_TIMEOUT_SECONDS = 10

# A token is required by the script and irrelevant to the planted app, which
# authenticates nothing: what is under test is whether a violation is caught.
_UNUSED_TOKEN = "unused-by-the-planted-app"  # pragma: allowlist secret

_SHARED_ROUTES = '''
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class Counted(BaseModel):
    """A body of one integer, so a violation of it is unambiguous."""

    count: int


@app.get("/healthy", response_model=Counted)
def healthy() -> Counted:
    """Answer exactly what the document promises."""
    return Counted(count=1)
'''

# ``GET /boom`` raises, which uvicorn turns into a 500: not_a_server_error.
# ``GET /liar`` returns an explicit response, which FastAPI does not validate
# against ``response_model``, so the published schema and the body disagree:
# response_schema_conformance.
_PLANTED_BUGS = '''

@app.get("/boom", response_model=Counted)
def boom() -> Counted:
    """Fail the way an unhandled exception fails."""
    message = "planted server error"
    raise RuntimeError(message)


@app.get("/liar", response_model=Counted)
def liar() -> JSONResponse:
    """Contradict the schema this very route publishes."""
    return JSONResponse({"count": "not-a-number"})
'''

# The repaired application keeps the same two operations so that the two halves
# differ in behaviour alone; a different *shape* would not isolate the cause.
_REPAIRS = '''

@app.get("/boom", response_model=Counted)
def boom() -> Counted:
    """The repaired twin of the raising handler."""
    return Counted(count=2)


@app.get("/liar", response_model=Counted)
def liar() -> Counted:
    """The repaired twin of the schema-violating handler."""
    return Counted(count=3)
'''

BROKEN_APP = _SHARED_ROUTES + _PLANTED_BUGS
REPAIRED_APP = _SHARED_ROUTES + _REPAIRS


@dataclass(frozen=True)
class FuzzResult:
    """One real run of the fuzz script against a served application.

    Attributes:
        returncode: The script's exit status, which is the fuzzer's own.
        output: Everything the run wrote, stdout and stderr combined.
        report: The JUnit report the run left in its report directory.
    """

    returncode: int
    output: str
    report: str


def schemathesis_executable() -> str:
    """Return the pinned fuzzer's path, or decide what its absence means.

    Returns:
        The resolved executable.
    """
    found = shutil.which(_EXECUTABLE)
    if found is not None:
        return found
    remedy = (
        f"{_EXECUTABLE} is not on PATH. Install it with "
        f"`pip install -r {_REQUIREMENTS}` from the repository root."
    )
    if os.getenv(REQUIRE_ENV_VAR, "").strip().lower() in _TRUTHY:
        pytest.fail(f"{REQUIRE_ENV_VAR} is set, so this lane must not skip. {remedy}")
    pytest.skip(f"{remedy} Set {REQUIRE_ENV_VAR}=1 to make this a failure instead of a skip.")


def _free_port() -> int:
    """Return a port the loopback interface is currently willing to hand out.

    Returns:
        A port number.
    """
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _await_document(base_url: str, server: subprocess.Popen[str]) -> None:
    """Block until the served application publishes its document.

    Args:
        base_url: Where the application is being served.
        server: The uvicorn process, so a boot failure is reported as one.

    Raises:
        RuntimeError: When the application never published a document.
    """
    deadline = time.monotonic() + _BOOT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if server.poll() is not None:
            message = f"the planted application exited during boot: {server.communicate()[0]}"
            raise RuntimeError(message)
        try:
            if httpx.get(f"{base_url}/openapi.json", timeout=1).status_code == httpx.codes.OK:
                return
        except httpx.HTTPError:
            pass
        time.sleep(_BOOT_POLL_SECONDS)
    message = f"the planted application never became ready at {base_url}"
    raise RuntimeError(message)


@contextmanager
def serve(source: str, tmp_path: Path) -> Iterator[str]:
    """Serve one throwaway application over a real socket.

    A real socket rather than an in-process transport because the thing under
    test is a command-line fuzzer: it speaks HTTP to a URL, and an ASGI shortcut
    would prove something the gate does not do.

    Args:
        source: The application module's source.
        tmp_path: Where to write it.

    Yields:
        The base URL the application is served from.
    """
    module = tmp_path / "planted_app.py"
    module.write_text(source, encoding="utf-8")
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "planted_app:app",
            "--app-dir",
            str(tmp_path),
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        _await_document(base_url, server)
        yield base_url
    finally:
        server.terminate()
        try:
            server.wait(timeout=_SHUTDOWN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            server.kill()


def fuzz(source: str, tmp_path: Path) -> FuzzResult:
    """Run the real fuzz script against one throwaway application.

    Args:
        source: The application module's source.
        tmp_path: Scratch directory for the module and the report.

    Returns:
        What the run did.
    """
    schemathesis_executable()
    report_dir = tmp_path / "report"
    with serve(source, tmp_path) as base_url:
        completed = subprocess.run(
            [str(_SCRIPT)],
            check=False,
            capture_output=True,
            text=True,
            timeout=_FUZZ_TIMEOUT_SECONDS,
            env={
                **os.environ,
                "BASE_URL": base_url,
                "DAST_TOKEN": _UNUSED_TOKEN,
                "REPORT_DIR": str(report_dir),
            },
        )
    reports = sorted(report_dir.glob("*.xml")) if report_dir.is_dir() else []
    return FuzzResult(
        returncode=completed.returncode,
        output=completed.stdout + completed.stderr,
        report="\n".join(path.read_text(encoding="utf-8") for path in reports),
    )


@pytest.fixture(scope="module")
def planted(tmp_path_factory: pytest.TempPathFactory) -> FuzzResult:
    """Fuzz the application with both bugs planted in it."""
    return fuzz(BROKEN_APP, tmp_path_factory.mktemp("planted"))


@pytest.fixture(scope="module")
def repaired(tmp_path_factory: pytest.TempPathFactory) -> FuzzResult:
    """Fuzz the same application with both bugs removed."""
    return fuzz(REPAIRED_APP, tmp_path_factory.mktemp("repaired"))


def test_a_planted_server_error_fails_the_run(planted: FuzzResult) -> None:
    """``not_a_server_error`` fires, and the run's exit code carries it."""
    assert planted.returncode != 0, planted.output
    assert _BOOM in planted.output, planted.output
    assert _SERVER_ERROR_TITLE in planted.output, planted.output


def test_a_planted_schema_violation_fails_the_run(planted: FuzzResult) -> None:
    """``response_schema_conformance`` fires on a body its own document forbids."""
    assert planted.returncode != 0, planted.output
    assert _LIAR in planted.output, planted.output
    assert _SCHEMA_VIOLATION_TITLE in planted.output, planted.output


def test_both_findings_reach_the_uploaded_report(planted: FuzzResult) -> None:
    """A finding nobody can read from the artifact is a finding nobody acts on."""
    assert _BOOM in planted.report, planted.report
    assert _SERVER_ERROR_TITLE in planted.report, planted.report
    assert _LIAR in planted.report, planted.report
    assert _SCHEMA_VIOLATION_TITLE in planted.report, planted.report


def test_the_healthy_twin_passes(repaired: FuzzResult) -> None:
    """Without the pair, a red run proves nothing about what turned it red."""
    assert repaired.returncode == 0, repaired.output
    assert _SERVER_ERROR_TITLE not in repaired.output, repaired.output
    assert _SCHEMA_VIOLATION_TITLE not in repaired.output, repaired.output


def test_the_passing_run_actually_reached_every_operation(repaired: FuzzResult) -> None:
    """A green run and a run that fuzzed nothing must never look alike."""
    assert f"Selected: {_PUBLISHED_OPERATIONS}/{_PUBLISHED_OPERATIONS}" in repaired.output
    assert f"Tested: {_PUBLISHED_OPERATIONS}" in repaired.output
    assert _HEALTHY in repaired.report, repaired.report
