"""A scan that never got past the front door has to be told apart from a clean one.

The nightly job mints a bearer token and refuses to continue unless that token
opens an authenticated route. That proves the *credential*. It proves nothing at
all about whether ZAP attached the credential to ZAP's own traffic, and those
two worlds produce identical artifacts: a report naming the site, a handful of
passive alerts raised on the 401 responses themselves, a valid SARIF file, a
green run and a Security tab with nothing in it.

The only place the difference is written down is the target's own request log,
which is what this module reads. Every test here is therefore about one
distinction: did any request reach a handler, or was the whole scan answered at
the door.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from scripts.dast.report import EXIT_CLEAN, EXIT_HARNESS_ERROR
from scripts.dast.runner import DEFAULT_AUTH_PROBE_PATH
from scripts.dast.scan_evidence import main, reached_handlers, requests_in

# Uvicorn's access line, as it is actually written at ``--log-level info``.
_LINE = 'INFO:     127.0.0.1:52012 - "{method} {path} HTTP/1.1" {status} {reason}'


def _log(*lines: str) -> str:
    """Return an access log built from the given already-formatted lines."""
    return "\n".join(["INFO:     Application startup complete.", *lines, ""])


def _access(path: str, status: int, method: str = "GET", reason: str = "OK") -> str:
    """Return one uvicorn access line."""
    return _LINE.format(method=method, path=path, status=status, reason=reason)


def _written(tmp_path: Path, text: str) -> Path:
    """Write an access log and return its path."""
    log = tmp_path / "uvicorn.log"
    log.write_text(text, encoding="utf-8")
    return log


def test_a_request_line_is_read_off_the_access_log() -> None:
    """The parser keys on the quoted request and the status, not on uvicorn's prefix."""
    parsed = requests_in(_log(_access("/habits/", 200)))

    assert parsed == [("GET", "/habits/", 200)]


def test_lines_that_are_not_requests_are_not_invented() -> None:
    """Startup banners and tracebacks share the file; neither is a request."""
    assert requests_in(_log("INFO:     Waiting for application startup.")) == []


def test_a_scan_answered_everywhere_at_the_door_reached_nothing() -> None:
    """Uniform 401 is the failure this module exists to name."""
    log = _log(_access("/habits/", 401), _access("/journal/", 401), _access("/openapi.json", 200))

    assert not reached_handlers(requests_in(log), DEFAULT_AUTH_PROBE_PATH)


def test_one_authenticated_success_on_the_probe_route_is_enough() -> None:
    """The question is binary: did the credential reach a handler even once."""
    log = _log(_access("/habits/", 401), _access("/habits/", 200))

    assert reached_handlers(requests_in(log), DEFAULT_AUTH_PROBE_PATH)


def test_success_somewhere_else_does_not_count_as_authentication() -> None:
    """``/openapi.json`` and ``/health/ready`` answer 200 with no credential at all.

    They are the two routes ZAP is guaranteed to hit, so a check that accepted
    any 2xx anywhere would pass on a scan that was rejected at every route that
    matters.
    """
    log = _log(_access("/openapi.json", 200), _access("/health/ready", 200))

    assert not reached_handlers(requests_in(log), DEFAULT_AUTH_PROBE_PATH)


def test_an_attacked_probe_route_still_counts_as_reached() -> None:
    """ZAP appends payloads to the path it attacks; the route is still that route."""
    log = _log(_access("/habits/?id=%27+OR+1%3D1", 422))

    assert reached_handlers(requests_in(log), DEFAULT_AUTH_PROBE_PATH)


def test_a_server_error_on_the_probe_route_is_not_the_door_turning_it_away() -> None:
    """A 500 means a handler ran and broke, which is a finding rather than a blind scan."""
    log = _log(_access("/habits/", 500, reason="Internal Server Error"))

    assert reached_handlers(requests_in(log), DEFAULT_AUTH_PROBE_PATH)


@pytest.mark.parametrize("status", [401, 403])
def test_a_denial_is_never_evidence_of_reaching_a_handler(status: int) -> None:
    """401 and 403 are the two answers the door gives; neither reached anything."""
    assert not reached_handlers(requests_in(_log(_access("/habits/", status))), "/habits/")


def test_a_clean_run_says_what_it_saw(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """The step summary is the only place a cron run can speak."""
    log = _written(tmp_path, _log(_access("/habits/", 200), _access("/journal/", 401)))

    code = main(["--log", str(log), "--probe-path", DEFAULT_AUTH_PROBE_PATH])

    out = capsys.readouterr().out
    assert code == EXIT_CLEAN
    assert "2" in out, out
    assert DEFAULT_AUTH_PROBE_PATH in out, out


def test_a_scan_that_reached_nothing_is_a_harness_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Same code the rest of this package uses: the run proved nothing."""
    log = _written(tmp_path, _log(_access("/habits/", 401), _access("/openapi.json", 200)))

    code = main(["--log", str(log), "--probe-path", DEFAULT_AUTH_PROBE_PATH])

    assert code == EXIT_HARNESS_ERROR
    assert "401" in capsys.readouterr().err


def test_a_target_that_logged_nothing_at_all_is_a_harness_error(tmp_path: Path) -> None:
    """An empty log means the scan never reached the instance, not that it found nothing."""
    log = _written(tmp_path, "")

    assert main(["--log", str(log), "--probe-path", DEFAULT_AUTH_PROBE_PATH]) == EXIT_HARNESS_ERROR


def test_an_absent_log_is_a_harness_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """No log is the loudest version of "nothing can be proved about this run"."""
    code = main(["--log", str(tmp_path / "missing.log"), "--probe-path", DEFAULT_AUTH_PROBE_PATH])

    assert code == EXIT_HARNESS_ERROR
    assert "could not be read" in capsys.readouterr().err


def test_the_probe_path_has_no_default(tmp_path: Path) -> None:
    """A defaulted route is how a check silently verifies a page nobody protects."""
    with pytest.raises(SystemExit):
        main(["--log", str(tmp_path / "uvicorn.log")])
