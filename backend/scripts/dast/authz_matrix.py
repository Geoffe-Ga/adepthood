"""Run the authenticated BOLA/IDOR authorization matrix against a live instance.

Two identities are created, and the check asks one question of every route that
addresses an object by id in its path: can identity B reach identity A's object?
A denial only counts once the same route has answered A herself, which is what
keeps "everything was refused" from passing as "nothing was wrong".

Signup cannot be used to make those identities -- it is gated on a live license
verification that cannot be satisfied across a socket -- so the two user rows are
inserted through the application's own ORM and both tokens are then minted over
the real login route. The real auth stack still mints and verifies every
credential the matrix sends; only the row creation is bypassed.

Usage:

    python -m scripts.dast.authz_matrix --base-url URL --database-url URL
    python -m scripts.dast.authz_matrix --base-url URL --database-url URL \
        --allowlist path/to/allowlist.toml --min-routes 20 \
        --budget-seconds 120 --max-allowlist-fraction 0.5

Run it from ``backend/`` with ``PYTHONPATH=src``, the way the other repository
scripts are invoked, so both the harness package and the application's own
modules are importable.

Exit codes:
    0 — the matrix ran, every cell passed, and nothing was left uncovered.
    1 — an authorization finding: a foreign object was reached, or a probe
        returned a status that is not a denial.
    2 — at least one route has neither a seed strategy nor an allow-list entry,
        so the matrix does not cover the application it claims to.
    3 — a vacuity guard tripped: the run proved nothing, which outranks both of
        the above because its "clean" would have been meaningless. A target that
        could not be reached at all lands here too, deliberately: an uncaught
        exception would exit 1, and a consumer keying off the exit code cannot
        tell that apart from a real finding.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path

from httpx import AsyncClient

from scripts.dast.policy import DEFAULT_ALLOWLIST_PATH, load_allowlist
from scripts.dast.report import (
    EXIT_AUTHZ_FINDING,
    EXIT_CLEAN,
    EXIT_HARNESS_ERROR,
    EXIT_UNCOVERED,
    MatrixReport,
    render_report,
)
from scripts.dast.runner import (
    DEFAULT_AUTH_PROBE_PATH,
    DEFAULT_BUDGET_SECONDS,
    DEFAULT_MAX_ALLOWLIST_FRACTION,
    DEFAULT_MIN_ROUTES,
    Bootstrap,
    Identity,
    MatrixConfig,
    ReplayBodies,
    run_matrix,
)
from scripts.dast.seeds import REPLAY_BODIES, SEED_REGISTRY, SeedSpec
from scripts.dast.tokens import mint_identities

# The exit codes are defined once, in the report module, and re-exported here
# because this script is the only thing CI actually reads them from.
__all__ = [
    "EXIT_AUTHZ_FINDING",
    "EXIT_CLEAN",
    "EXIT_HARNESS_ERROR",
    "EXIT_UNCOVERED",
    "HarnessOverrides",
    "main",
]

_REQUEST_TIMEOUT_SECONDS = 30.0

# The matrix always wants exactly two actors, and the report names them by these
# labels, so the order they are minted in is contractual.
_MATRIX_LABELS = ("A", "B")


@dataclass(frozen=True)
class HarnessOverrides:
    """Seams a test may replace, defaulting to the production wiring.

    Attributes:
        client: An HTTP client to use instead of dialling ``--base-url``.
        bootstrap: An identity bootstrap to use instead of the ORM insert plus
            real login.
        seed_registry: Seed strategies for the target application.
        replay_bodies: Valid request bodies for the mutating replays.
        auth_probe_path: The route used to prove authentication works.
    """

    client: AsyncClient | None = None
    bootstrap: Bootstrap | None = None
    # Both constants are ``MappingProxyType``, which Python 3.11 rejects as a
    # dataclass default; the factories hand back those same shared objects.
    seed_registry: Mapping[str, SeedSpec] = field(default_factory=lambda: SEED_REGISTRY)
    replay_bodies: ReplayBodies = field(default_factory=lambda: REPLAY_BODIES)
    auth_probe_path: str = DEFAULT_AUTH_PROBE_PATH


async def _bootstrap_identities(
    client: AsyncClient,
    *,
    database_url: str,
) -> tuple[Identity, Identity]:
    """Create the owner and the intruder, and log them both in.

    Args:
        client: A client pointed at the target instance.
        database_url: The database that instance is serving from.

    Returns:
        The owner first, then the intruder.
    """
    owner, intruder = await mint_identities(
        client,
        database_url=database_url,
        labels=_MATRIX_LABELS,
    )
    return owner, intruder


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the command line.

    Neither target has a default on purpose: a defaulted base URL is how a run
    silently probes localhost instead of the ephemeral instance the job started,
    and a defaulted database URL is how it seeds identities into the wrong place.
    """
    parser = argparse.ArgumentParser(
        prog="authz_matrix",
        description="Probe every object-scoped route for cross-user access.",
    )
    parser.add_argument("--base-url", required=True, help="Base URL of the running instance.")
    parser.add_argument(
        "--database-url",
        required=True,
        help="Async database URL that instance is serving from.",
    )
    parser.add_argument(
        "--allowlist",
        type=Path,
        default=DEFAULT_ALLOWLIST_PATH,
        help="Opt-out list to load instead of the shipped one.",
    )
    parser.add_argument(
        "--min-routes",
        type=int,
        default=DEFAULT_MIN_ROUTES,
        help="Fail unless at least this many routes were probed.",
    )
    parser.add_argument(
        "--budget-seconds",
        type=float,
        default=DEFAULT_BUDGET_SECONDS,
        help="Fail if the matrix takes longer than this.",
    )
    parser.add_argument(
        "--max-allowlist-fraction",
        type=float,
        default=DEFAULT_MAX_ALLOWLIST_FRACTION,
        help="Fail if the allow-list excuses more than this share of routes.",
    )
    return parser.parse_args(argv)


def _build_config(args: argparse.Namespace, overrides: HarnessOverrides) -> MatrixConfig:
    """Fold the command line and the injected seams into one run configuration."""
    return MatrixConfig(
        seed_registry=overrides.seed_registry,
        replay_bodies=overrides.replay_bodies,
        allowlist=load_allowlist(args.allowlist),
        auth_probe_path=overrides.auth_probe_path,
        min_routes=args.min_routes,
        budget_seconds=args.budget_seconds,
        max_allowlist_fraction=args.max_allowlist_fraction,
    )


async def _execute(
    args: argparse.Namespace,
    config: MatrixConfig,
    overrides: HarnessOverrides,
) -> MatrixReport:
    """Run the matrix, owning the client's lifetime only when it created one."""
    bootstrap = overrides.bootstrap or partial(
        _bootstrap_identities,
        database_url=args.database_url,
    )
    if overrides.client is not None:
        return await run_matrix(overrides.client, bootstrap=bootstrap, config=config)
    async with AsyncClient(base_url=args.base_url, timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        return await run_matrix(client, bootstrap=bootstrap, config=config)


def main(argv: Sequence[str] | None = None, *, overrides: HarnessOverrides | None = None) -> int:
    """Run the matrix and report it.

    Args:
        argv: The command line, without the program name.
        overrides: Seams a test replaces; production passes nothing.

    Returns:
        The report's exit code. A clean run reports on stdout and every failure
        reports on stderr, so a red job's output is unambiguous in the log.
    """
    args = _parse_args(argv)
    settings = overrides if overrides is not None else HarnessOverrides()
    report = asyncio.run(_execute(args, _build_config(args, settings), settings))
    stream = sys.stdout if report.exit_code == EXIT_CLEAN else sys.stderr
    stream.write(render_report(report))
    return report.exit_code


if __name__ == "__main__":  # pragma: no cover — exercised via tests/CLI
    sys.exit(main(sys.argv[1:]))
