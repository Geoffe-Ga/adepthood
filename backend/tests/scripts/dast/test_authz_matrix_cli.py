"""The CLI: four exit codes, two streams, and no silent defaults.

CI reads exactly one thing from this script — the number it returns — so each of
the four codes is driven in-process here and asserted directly, with the stream
split that ``check_dependency_drift`` established: a clean run reports on stdout,
every failure reports on stderr so a red job's output is unambiguous.

The matrix itself is replaced with a stub for these tests. That is deliberate:
what is under test is argument handling, wiring, and grading, and none of that
should need a socket to exercise. The thresholds the flags carry are asserted
where they land — inside the ``MatrixConfig`` the runner receives — because a
default that silently stops being applied is how a gate quietly loosens.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from httpx import AsyncClient

from scripts.dast import authz_matrix
from scripts.dast.discovery import RouteSpec
from scripts.dast.policy import DEFAULT_ALLOWLIST_PATH, AllowlistEntry, load_allowlist
from scripts.dast.references import REFERENCE_REGISTRY, ReferenceProbe, ReferenceRegistry
from scripts.dast.report import (
    EXIT_AUTHZ_FINDING,
    EXIT_CLEAN,
    EXIT_HARNESS_ERROR,
    EXIT_UNCOVERED,
    MatrixReport,
)
from scripts.dast.runner import (
    DEFAULT_BUDGET_SECONDS,
    DEFAULT_MAX_ALLOWLIST_FRACTION,
    DEFAULT_MIN_REFERENCES,
    DEFAULT_MIN_ROUTES,
    MatrixConfig,
)
from scripts.dast.seeds import SEED_REGISTRY
from scripts.dast.verdict import Cell, CellResult, GuardFailure, Verdict

BASE_URL = "http://127.0.0.1:9999"
# Never connected: ``run_matrix`` is stubbed out, so the engine the CLI builds
# is never asked for a session.
DATABASE_URL = "sqlite+aiosqlite:///:memory:"

DISCOVERED_ROUTES = 41
SEEDED_ROUTES = 37
ALLOWLISTED_ROUTES = 4
ELAPSED_SECONDS = 11.5

CUSTOM_MIN_ROUTES = 33
CUSTOM_MIN_REFERENCES = 9
CUSTOM_BUDGET_SECONDS = 45.0
CUSTOM_MAX_FRACTION = 0.25

# A probe table that is recognisably not the shipped one. It is never issued --
# the matrix is stubbed -- so it only has to be a distinct, well-formed entry.
INJECTED_REFERENCE_REGISTRY: ReferenceRegistry = {
    ("POST", "/widgets/"): ReferenceProbe(
        method="POST",
        path="/widgets/",
        body={"label": "probe"},
    ),
}

LEAKY_ROUTE = RouteSpec(
    method="GET",
    path="/widgets/{widget_id}",
    params=("widget_id",),
    requires_auth=True,
)
LEAK = CellResult(
    route=LEAKY_ROUTE,
    cell=Cell.CROSS_USER,
    resolved_path="/widgets/7",
    object_ids=(("widget_id", "7"),),
    status=200,
    verdict=Verdict.LEAK,
)
PASSING_CELL = CellResult(
    route=LEAKY_ROUTE,
    cell=Cell.CROSS_USER,
    resolved_path="/widgets/7",
    object_ids=(("widget_id", "7"),),
    status=404,
    verdict=Verdict.PASS,
)
GUARD_FAILURE = GuardFailure(guard="require_seeded_resources", detail="no objects were created")


def build_report(
    *,
    results: tuple[CellResult, ...] = (PASSING_CELL,),
    uncovered: tuple[str, ...] = (),
    guard_failures: tuple[GuardFailure, ...] = (),
) -> MatrixReport:
    """Assemble the report the stubbed matrix will hand back to the CLI."""
    return MatrixReport(
        base_url=BASE_URL,
        discovered=DISCOVERED_ROUTES,
        seeded=SEEDED_ROUTES,
        uncovered=uncovered,
        allowlisted=ALLOWLISTED_ROUTES,
        results=results,
        guard_failures=guard_failures,
        elapsed_seconds=ELAPSED_SECONDS,
    )


def install_stub_matrix(
    monkeypatch: pytest.MonkeyPatch,
    report: MatrixReport,
) -> list[tuple[AsyncClient, MatrixConfig]]:
    """Replace ``run_matrix`` with a recorder and return the list it appends to."""
    recorded: list[tuple[AsyncClient, MatrixConfig]] = []

    async def _stub_matrix(
        client: AsyncClient,
        *,
        bootstrap: object,
        config: MatrixConfig,
    ) -> MatrixReport:
        assert bootstrap is not None, "the CLI must supply an identity bootstrap"
        recorded.append((client, config))
        return report

    monkeypatch.setattr(authz_matrix, "run_matrix", _stub_matrix)
    return recorded


def run_cli(*extra: str, overrides: authz_matrix.HarnessOverrides | None = None) -> int:
    """Invoke ``main`` with the two required arguments plus ``extra``."""
    return authz_matrix.main(
        ["--base-url", BASE_URL, "--database-url", DATABASE_URL, *extra],
        overrides=overrides,
    )


def test_the_exit_codes_are_re_exported_unchanged_from_the_report_module() -> None:
    """One definition of each code; the CLI must not grow a second, drifting copy."""
    assert authz_matrix.EXIT_CLEAN == EXIT_CLEAN
    assert authz_matrix.EXIT_AUTHZ_FINDING == EXIT_AUTHZ_FINDING
    assert authz_matrix.EXIT_UNCOVERED == EXIT_UNCOVERED
    assert authz_matrix.EXIT_HARNESS_ERROR == EXIT_HARNESS_ERROR


def test_a_clean_matrix_exits_zero_and_reports_on_stdout(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A passing gate is ordinary output, and it still prints its coverage summary."""
    install_stub_matrix(monkeypatch, build_report())

    exit_code = run_cli()

    captured = capsys.readouterr()
    assert exit_code == EXIT_CLEAN, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert captured.err == ""
    assert "routes discovered from /openapi.json : 41 object-scoped" in captured.out


def test_a_leak_exits_one_and_reports_on_stderr(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Findings go to stderr so a red job's output is unambiguous in the log."""
    install_stub_matrix(monkeypatch, build_report(results=(LEAK,)))

    exit_code = run_cli()

    captured = capsys.readouterr()
    assert exit_code == EXIT_AUTHZ_FINDING, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert captured.out == ""
    assert "FAIL  GET    /widgets/{widget_id}" in captured.err


def test_an_uncovered_route_exits_two(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A route with no seed strategy and no allow-list entry has its own exit code."""
    install_stub_matrix(monkeypatch, build_report(uncovered=("GET /course/{slug}",)))

    exit_code = run_cli()

    captured = capsys.readouterr()
    assert exit_code == EXIT_UNCOVERED, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert captured.out == ""
    assert "UNCOVERED  GET    /course/{slug}" in captured.err


def test_a_tripped_guard_exits_three(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Nothing was proven, so the CLI must not borrow the clean exit code."""
    install_stub_matrix(monkeypatch, build_report(guard_failures=(GUARD_FAILURE,)))

    exit_code = run_cli()

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert exit_code != EXIT_CLEAN
    assert captured.out == ""
    assert "HARNESS ERROR  require_seeded_resources: no objects were created" in captured.err


def record_flagless_run(monkeypatch: pytest.MonkeyPatch) -> tuple[AsyncClient, MatrixConfig]:
    """Drive the CLI with no optional flags and return what the runner received.

    The scheduled job invokes the matrix exactly this way, so everything this
    returns was decided by a default rather than by a command line.
    """
    recorded = install_stub_matrix(monkeypatch, build_report())
    run_cli()
    return recorded[0]


def test_the_documented_default_thresholds_reach_the_runner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A threshold that stops being applied is how a gate loosens without a diff."""
    _, config = record_flagless_run(monkeypatch)

    assert config.min_routes == DEFAULT_MIN_ROUTES
    assert config.min_references == DEFAULT_MIN_REFERENCES
    assert config.budget_seconds == DEFAULT_BUDGET_SECONDS
    assert config.max_allowlist_fraction == DEFAULT_MAX_ALLOWLIST_FRACTION


def test_a_flagless_run_carries_a_non_zero_reference_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The scheduled job passes no flags, so this default is the whole gate.

    A floor of zero would let the reference dimension report green having probed
    nothing at all, which is the vacuous pass the guard exists to forbid.
    """
    _, config = record_flagless_run(monkeypatch)

    assert config.min_references > 0


def test_the_default_target_and_data_reach_the_runner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The registries are data, and swapping one silently is the other way to loosen."""
    client, config = record_flagless_run(monkeypatch)

    assert str(client.base_url) == BASE_URL
    assert config.seed_registry is SEED_REGISTRY
    assert config.reference_registry is REFERENCE_REGISTRY
    assert config.allowlist == load_allowlist(DEFAULT_ALLOWLIST_PATH)


def test_the_default_thresholds_are_the_documented_numbers() -> None:
    """These four numbers are the acceptance criteria, so they are pinned once."""
    assert DEFAULT_MIN_ROUTES == 20
    assert DEFAULT_MIN_REFERENCES == 5
    assert DEFAULT_BUDGET_SECONDS == 120.0
    assert DEFAULT_MAX_ALLOWLIST_FRACTION == 0.5


def test_every_threshold_flag_overrides_its_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tightening a threshold locally must be possible without editing the script."""
    recorded = install_stub_matrix(monkeypatch, build_report())

    run_cli(
        "--min-routes",
        str(CUSTOM_MIN_ROUTES),
        "--min-references",
        str(CUSTOM_MIN_REFERENCES),
        "--budget-seconds",
        str(CUSTOM_BUDGET_SECONDS),
        "--max-allowlist-fraction",
        str(CUSTOM_MAX_FRACTION),
    )

    _, config = recorded[0]
    assert config.min_routes == CUSTOM_MIN_ROUTES
    assert config.min_references == CUSTOM_MIN_REFERENCES
    assert config.budget_seconds == CUSTOM_BUDGET_SECONDS
    assert config.max_allowlist_fraction == CUSTOM_MAX_FRACTION


@pytest.mark.parametrize(
    "registry",
    [
        pytest.param(INJECTED_REFERENCE_REGISTRY, id="populated"),
        pytest.param({}, id="empty"),
    ],
)
def test_an_injected_reference_registry_replaces_the_shipped_one(
    registry: ReferenceRegistry,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stub target carries its own ids, so the probe table has to be a seam.

    The empty case is the one that matters: a stub with no references at all
    must be able to say so, and a fallback that treats "empty" as "unset" would
    quietly probe the production table against somebody else's application.
    """
    recorded = install_stub_matrix(monkeypatch, build_report())

    run_cli(overrides=authz_matrix.HarnessOverrides(reference_registry=registry))

    _, config = recorded[0]
    assert config.reference_registry == registry
    assert config.reference_registry is not REFERENCE_REGISTRY


def test_an_explicit_allowlist_path_is_loaded_instead_of_the_shipped_one(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The allow-list is data, so a run can be pointed at a different file."""
    path = tmp_path / "allowlist.toml"
    path.write_text(
        textwrap.dedent(
            """
            [[route]]
            method   = "GET"
            path     = "/widgets/{widget_id}"
            category = "admin_only"
            reason   = "covered by the in-process suite instead"
            """,
        ).lstrip("\n"),
        encoding="utf-8",
    )
    recorded = install_stub_matrix(monkeypatch, build_report())

    run_cli("--allowlist", str(path))

    _, config = recorded[0]
    assert config.allowlist == (
        AllowlistEntry(
            method="GET",
            path="/widgets/{widget_id}",
            category="admin_only",
            reason="covered by the in-process suite instead",
        ),
    )


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["--base-url", BASE_URL],
        ["--database-url", DATABASE_URL],
    ],
)
def test_both_targets_are_required_arguments(argv: list[str]) -> None:
    """Neither target has a default: guessing one would point the matrix somewhere real.

    A defaulted base URL is how a run silently probes localhost instead of the
    ephemeral instance the job started, and a defaulted database URL is how it
    seeds identities into the wrong place.
    """
    with pytest.raises(SystemExit):
        authz_matrix.main(argv)
