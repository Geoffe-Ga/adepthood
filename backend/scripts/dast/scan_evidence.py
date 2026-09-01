"""Prove the nightly scan got past the front door before publishing what it found.

The deep-scan job mints a bearer token and refuses to continue unless that token
opens an authenticated route. That proves the *credential*, which is not the
question. The question is whether OWASP ZAP attached the credential to ZAP's own
traffic -- and if it did not, every request in the run was answered 401 before it
reached a handler, no active rule attacked anything, and the report at the end
says so in no way at all.

That failure is invisible everywhere else in the job. The report still names the
scanned site. The passive rules still fire, on the 401 responses themselves. The
SARIF still validates and uploads. ``fail_action: false`` keeps ZAP quiet either
way. What comes out is a green nightly run and a Security tab with nothing in it,
which is bit-for-bit what a genuinely clean scan looks like.

The one place the difference is written down is the target's own request log, so
that is what this module reads. It asks a single binary question -- did any
request to a route that requires a credential get an answer other than a denial
-- and exits with the harness-error code the rest of this package uses when the
answer is no. A run that proved nothing must never be mistaken for a run that
found nothing.

Usage:

    python -m scripts.dast.scan_evidence --log uvicorn.log --probe-path /habits/

Stdout carries a Markdown line for the run summary and nothing else -- the
workflow appends it straight to ``$GITHUB_STEP_SUMMARY`` -- so every diagnostic
goes to stderr.

Exit codes:
    0 — the scanner reached application code behind the credential.
    3 — it did not, or the log could not be read. Deliberately the same "harness
        error" code the rest of this package uses.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Sequence
from pathlib import Path

from scripts.dast.report import EXIT_CLEAN, EXIT_HARNESS_ERROR

# Uvicorn's access line, e.g.::
#
#     INFO:     127.0.0.1:52012 - "GET /habits/ HTTP/1.1" 200 OK
#
# Anchored on the quoted request and the status that follows it rather than on
# the prefix, which carries a level, an address and a port that all vary.
_ACCESS_LINE = re.compile(r'"(?P<method>[A-Z]+) (?P<path>\S+) HTTP/[\d.]+" (?P<status>\d{3})')

# The two answers the door gives. Every other status -- including a 500 -- means
# a handler ran, which is the thing being proved here.
DENIAL_STATUSES = frozenset({401, 403})

# One parsed access line: method, path, status.
Request = tuple[str, str, int]


class UnreadableLogError(Exception):
    """The target's request log is not there, or cannot be read."""


def requests_in(log_text: str) -> list[Request]:
    """Return every request the target logged.

    Args:
        log_text: The contents of the target's uvicorn log.

    Returns:
        One ``(method, path, status)`` triple per access line, in log order.
        Startup banners, tracebacks and anything else in the file are skipped
        rather than guessed at.
    """
    return [
        (match["method"], match["path"], int(match["status"]))
        for match in _ACCESS_LINE.finditer(log_text)
    ]


def _on_probe_route(path: str, probe_path: str) -> bool:
    """Return whether one logged path is the credential-gated route.

    Args:
        path: The path as the target logged it.
        probe_path: The route known to require a credential.

    Returns:
        ``True`` when the request was aimed at that route. Matched by prefix,
        because an active scan appends its payloads to the path it attacks and
        those requests are still requests to that route.
    """
    return path.startswith(probe_path)


def reached_handlers(requests: Sequence[Request], probe_path: str) -> bool:
    """Return whether the scanner ever got an answer from behind the credential.

    Args:
        requests: Every request the target logged.
        probe_path: A route that requires a credential -- the same one the token
            helper spends its minted token on.

    Returns:
        ``True`` when at least one request to that route was answered with
        anything other than a denial. Success on some *other* route proves
        nothing: ``/openapi.json`` and ``/health/ready`` answer 200 to anybody,
        and they are the two routes this scan is guaranteed to hit.
    """
    return any(
        _on_probe_route(path, probe_path) and status not in DENIAL_STATUSES
        for _, path, status in requests
    )


def _summarise(requests: Sequence[Request], probe_path: str) -> str:
    """Return the Markdown line a reader of the Actions run list gets.

    Args:
        requests: Every request the target logged.
        probe_path: The credential-gated route.

    Returns:
        One line naming how much traffic the target saw and how much of it
        reached the gated route.
    """
    on_route = [status for _, path, status in requests if _on_probe_route(path, probe_path)]
    answered = len([status for status in on_route if status not in DENIAL_STATUSES])
    return (
        f"The target answered {len(requests)} requests, {len(on_route)} of them on "
        f"`{probe_path}`, {answered} of those from behind the credential."
    )


def _load(log: Path) -> str:
    """Read the target's request log.

    Args:
        log: Path the workflow told the target to write.

    Returns:
        The log's contents.

    Raises:
        UnreadableLogError: If the file is absent or unreadable. That means the
            target was never running, which is not a clean scan either.
    """
    try:
        return log.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        raise UnreadableLogError(f"{log} could not be read: {error}") from error


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the command line.

    Neither argument has a default: a defaulted probe path is how a check ends up
    proving that an unauthenticated route answered, which every scan achieves.

    Args:
        argv: The argument vector, or ``None`` to read ``sys.argv``.

    Returns:
        The parsed arguments.
    """
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--log", required=True, type=Path, help="the target's request log")
    parser.add_argument(
        "--probe-path", required=True, help="a route that requires a credential, e.g. /habits/"
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """Read the request log and report whether the scan reached anything.

    Args:
        argv: The argument vector, or ``None`` to read ``sys.argv``.

    Returns:
        ``0`` when the scanner was answered from behind the credential at least
        once; ``3`` when it never was, or when the log could not be read.
    """
    args = _parse_args(argv)
    try:
        requests = requests_in(_load(args.log))
    except UnreadableLogError as error:
        sys.stderr.write(f"the scan cannot be shown to have reached anything: {error}\n")
        return EXIT_HARNESS_ERROR
    summary = _summarise(requests, args.probe_path)
    if not reached_handlers(requests, args.probe_path):
        sys.stderr.write(
            f"the scan never got past the front door: {summary} Every request to "
            f"{args.probe_path} was answered "
            f"{' or '.join(str(status) for status in sorted(DENIAL_STATUSES))}, so no "
            "handler ran and no active rule attacked anything.\n"
        )
        return EXIT_HARNESS_ERROR
    sys.stdout.write(f"{summary}\n")
    return EXIT_CLEAN


if __name__ == "__main__":
    raise SystemExit(main())
