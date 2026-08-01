"""The guards that make "no findings" mean something, each proven to actually trip.

A DAST check that cannot authenticate sees every request answered 401, finds no
IDOR anywhere, and reports clean. That is the failure this whole harness is
built around, and a guard nobody has watched fire is indistinguishable from no
guard at all. So every test below drives its guard into the tripped state and
asserts the failure it produces, then drives it into the healthy state and
asserts silence — a guard that always trips is as useless as one that never
does.

The end-to-end tests at the bottom are the ones that matter most. A stub that
mints tokens and then answers 401 to everything must exit ``EXIT_HARNESS_ERROR``
and not ``EXIT_CLEAN``; and a run that probed five routes when it was told to
expect twenty must fail on that basis even though it did find two real leaks,
because a matrix that shrank without anybody noticing cannot be trusted with the
"clean" it would otherwise report.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient

from scripts.dast.discovery import RouteSpec
from scripts.dast.policy import AllowlistEntry
from scripts.dast.report import EXIT_CLEAN, EXIT_HARNESS_ERROR
from scripts.dast.runner import (
    DEFAULT_BUDGET_SECONDS,
    DEFAULT_MAX_ALLOWLIST_FRACTION,
    DEFAULT_MIN_ROUTES,
    run_matrix,
)
from scripts.dast.verdict import (
    Cell,
    CellResult,
    Verdict,
    require_allowlist_bounded,
    require_allowlist_is_live,
    require_auth_established,
    require_minimum_coverage,
    require_no_throttling,
    require_positive_controls,
    require_seeded_resources,
    require_within_budget,
)
from tests.scripts.dast.conftest import (
    STUB_OBJECT_SCOPED_ROUTES,
    StubDeployment,
    drive_main,
    make_stub_bootstrap,
    stub_config,
)

BLIND_STUB_MIN_ROUTES = 1

PROBED_TOO_FEW = 5
ALLOWLISTED_MAJORITY = 3
ALLOWLISTED_MINORITY = 2
DISCOVERED_ROUTES = 4
OVER_BUDGET_SECONDS = 130.0
WITHIN_BUDGET_SECONDS = 42.0

WIDGET_ROUTE = RouteSpec(
    method="GET",
    path="/widgets/{widget_id}",
    params=("widget_id",),
    requires_auth=True,
)

RENAMED_ROUTE_ENTRY = AllowlistEntry(
    method="GET",
    path="/course/content/{content_id}",
    category="shared_catalog",
    reason="global course catalog; no per-user owner",
)
LIVE_ENTRY = AllowlistEntry(
    method="GET",
    path="/widgets/{widget_id}",
    category="admin_only",
    reason="covered by the in-process suite instead",
)


def cell_result(cell: Cell, status: int, verdict: Verdict) -> CellResult:
    """Build one graded cell for the guards that read a run's results."""
    return CellResult(
        route=WIDGET_ROUTE,
        cell=cell,
        resolved_path="/widgets/7",
        object_ids=(("widget_id", "7"),),
        status=status,
        verdict=verdict,
    )


def test_auth_established_trips_when_the_credential_does_not_work() -> None:
    """A token that is refused makes every later denial meaningless."""
    failure = require_auth_established(
        authenticated_status=HTTPStatus.UNAUTHORIZED,
        unauthenticated_status=HTTPStatus.UNAUTHORIZED,
    )

    assert failure is not None
    assert failure.guard == "require_auth_established"
    assert "401" in failure.detail


def test_auth_established_trips_when_the_auth_layer_is_not_engaged_at_all() -> None:
    """The other half: an open endpoint answers 200 without a token.

    Without this branch the guard would pass against an app whose auth was
    entirely bypassed, which is the worst possible thing to call "clean".
    """
    failure = require_auth_established(
        authenticated_status=HTTPStatus.OK,
        unauthenticated_status=HTTPStatus.OK,
    )

    assert failure is not None
    assert failure.guard == "require_auth_established"


def test_auth_established_is_silent_when_both_halves_hold() -> None:
    """200 with the credential and 401 without it is the only healthy combination."""
    assert (
        require_auth_established(
            authenticated_status=HTTPStatus.OK,
            unauthenticated_status=HTTPStatus.UNAUTHORIZED,
        )
        is None
    )


def test_positive_controls_trip_when_the_owner_cannot_reach_their_own_object() -> None:
    """If the owner's own call fails, the intruder's denial proves nothing.

    A route whose object was never really created, or whose replay body was
    rejected as invalid, denies everybody equally — which reads exactly like a
    correctly guarded route.
    """
    failure = require_positive_controls(
        (
            cell_result(Cell.CROSS_USER, HTTPStatus.NOT_FOUND, Verdict.PASS),
            cell_result(Cell.POSITIVE_CONTROL, HTTPStatus.NOT_FOUND, Verdict.INCONCLUSIVE),
        ),
    )

    assert failure is not None
    assert failure.guard == "require_positive_controls"
    assert "/widgets/{widget_id}" in failure.detail


def test_positive_controls_are_silent_when_every_owner_call_succeeded() -> None:
    """Each probed route proved it could succeed before its denial was believed."""
    assert (
        require_positive_controls(
            (
                cell_result(Cell.CROSS_USER, HTTPStatus.NOT_FOUND, Verdict.PASS),
                cell_result(Cell.POSITIVE_CONTROL, HTTPStatus.OK, Verdict.PASS),
            ),
        )
        is None
    )


def test_minimum_coverage_trips_when_nothing_at_all_was_probed() -> None:
    """An empty or garbled OpenAPI document yields zero routes and a perfect score."""
    failure = require_minimum_coverage(0, minimum=DEFAULT_MIN_ROUTES)

    assert failure is not None
    assert failure.guard == "require_minimum_coverage"
    assert "0" in failure.detail


def test_minimum_coverage_trips_when_the_matrix_quietly_shrank() -> None:
    """Five probed routes where twenty were expected is a regression, not a pass."""
    failure = require_minimum_coverage(PROBED_TOO_FEW, minimum=DEFAULT_MIN_ROUTES)

    assert failure is not None
    assert str(PROBED_TOO_FEW) in failure.detail
    assert str(DEFAULT_MIN_ROUTES) in failure.detail


def test_minimum_coverage_is_silent_at_exactly_the_threshold() -> None:
    """The floor is inclusive, so hitting it exactly is not a failure."""
    assert require_minimum_coverage(DEFAULT_MIN_ROUTES, minimum=DEFAULT_MIN_ROUTES) is None


def test_seeded_resources_trips_when_no_object_was_created() -> None:
    """With nothing seeded, every probe addresses an id that never existed."""
    failure = require_seeded_resources(0)

    assert failure is not None
    assert failure.guard == "require_seeded_resources"


def test_seeded_resources_is_silent_once_anything_was_seeded() -> None:
    """One real object is enough to make the probes address something."""
    assert require_seeded_resources(1) is None


def test_no_throttling_trips_on_a_single_429() -> None:
    """The rate limiter can turn a whole matrix into uniform, meaningless denials.

    One 429 anywhere is enough: the harness spreads requests across forwarded
    client keys precisely so this never happens, and a single throttled response
    means that mechanism stopped working.
    """
    failure = require_no_throttling(
        (HTTPStatus.OK, HTTPStatus.FORBIDDEN, HTTPStatus.TOO_MANY_REQUESTS),
    )

    assert failure is not None
    assert failure.guard == "require_no_throttling"
    assert "429" in failure.detail


def test_no_throttling_is_silent_when_no_response_was_throttled() -> None:
    """Ordinary denials and successes are exactly what the matrix expects to see."""
    healthy = (HTTPStatus.OK, HTTPStatus.FORBIDDEN, HTTPStatus.NOT_FOUND)

    assert require_no_throttling(healthy) is None


def test_allowlist_liveness_trips_on_an_entry_that_no_longer_matches_a_route() -> None:
    """A renamed route leaves its excuse behind, and the excuse keeps excusing nothing.

    Left unchecked the allow-list becomes a graveyard: entries accumulate, none
    can be shown to still apply, and the bounded-size guard eventually fires for
    reasons nobody can reconstruct.
    """
    failure = require_allowlist_is_live((RENAMED_ROUTE_ENTRY,), (WIDGET_ROUTE,))

    assert failure is not None
    assert failure.guard == "require_allowlist_is_live"
    assert "/course/content/{content_id}" in failure.detail


def test_allowlist_liveness_is_silent_when_every_entry_matches_a_live_route() -> None:
    """An entry that still names a real route is doing its job."""
    assert require_allowlist_is_live((LIVE_ENTRY,), (WIDGET_ROUTE,)) is None


def test_allowlist_bounded_trips_when_most_of_the_app_is_excused() -> None:
    """Excusing the majority of routes turns the gate into decoration."""
    failure = require_allowlist_bounded(
        ALLOWLISTED_MAJORITY,
        DISCOVERED_ROUTES,
        max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION,
    )

    assert failure is not None
    assert failure.guard == "require_allowlist_bounded"


def test_allowlist_bounded_is_silent_at_the_permitted_fraction() -> None:
    """Half is the documented ceiling, so exactly half still passes."""
    assert (
        require_allowlist_bounded(
            ALLOWLISTED_MINORITY,
            DISCOVERED_ROUTES,
            max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION,
        )
        is None
    )


def test_within_budget_trips_when_the_matrix_outran_its_time_box() -> None:
    """The two-minute acceptance criterion is machine-checked, not aspirational."""
    failure = require_within_budget(
        OVER_BUDGET_SECONDS,
        budget_seconds=DEFAULT_BUDGET_SECONDS,
    )

    assert failure is not None
    assert failure.guard == "require_within_budget"


def test_within_budget_is_silent_for_a_run_inside_its_time_box() -> None:
    """A fast run says nothing; only an overrun is worth a line of output."""
    assert (
        require_within_budget(WITHIN_BUDGET_SECONDS, budget_seconds=DEFAULT_BUDGET_SECONDS) is None
    )


@pytest.mark.asyncio
async def test_a_server_that_401s_everything_is_a_harness_error_not_a_clean_run(
    blind_deployment: StubDeployment,
    blind_client: AsyncClient,
) -> None:
    """The canonical false pass, refused outright.

    This app logs both identities in and then answers 401 to every other
    request, so no ownership check is ever reached and no IDOR can possibly be
    observed. Reporting that as clean is the exact outcome the whole design
    exists to make impossible.
    """
    report = await run_matrix(
        blind_client,
        bootstrap=make_stub_bootstrap(blind_deployment),
        config=stub_config(min_routes=BLIND_STUB_MIN_ROUTES),
    )

    assert report.exit_code == EXIT_HARNESS_ERROR
    assert report.exit_code != EXIT_CLEAN
    tripped = {failure.guard for failure in report.guard_failures}
    assert "require_auth_established" in tripped, f"guards tripped: {sorted(tripped)}"
    assert blind_deployment.store.rejected, "the harness never sent a credential at all"


def test_the_cli_exits_three_against_a_server_that_401s_everything(
    blind_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """End to end, the false pass surfaces as a harness error on stderr."""
    exit_code = drive_main(blind_deployment, min_routes=BLIND_STUB_MIN_ROUTES)

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert exit_code != EXIT_CLEAN
    assert captured.out == "", f"a harness error must not report on stdout: {captured.out!r}"
    assert "HARNESS ERROR  require_auth_established" in captured.err, captured.err


def test_a_run_that_probed_too_few_routes_fails_even_though_it_found_leaks(
    leaky_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Coverage collapse outranks the findings it happened to produce.

    The leaky stub exposes five object-scoped routes; asked for the production
    default of twenty, the run has demonstrably lost most of the application and
    cannot be trusted to have found everything, so the coverage guard decides
    the exit code rather than the two genuine leaks.
    """
    assert STUB_OBJECT_SCOPED_ROUTES < DEFAULT_MIN_ROUTES

    exit_code = drive_main(leaky_deployment, min_routes=DEFAULT_MIN_ROUTES)

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert "HARNESS ERROR  require_minimum_coverage" in captured.err, captured.err
