"""The harness must catch a real BOLA, not merely fail to find one.

This is the positive control for the whole check. Every other test in this
package could pass against a harness that quietly probes nothing; these cannot.
They drive the matrix at a genuine FastAPI app whose ``GET /widgets/{widget_id}``
and ``DELETE /widgets/{widget_id}`` authenticate the caller and then serve or
destroy rows belonging to somebody else, and they assert an explicit expected
verdict for every single matrix cell — never "no findings were reported", which
is exactly the sentence a vacuous pass would also satisfy.

Two properties are pinned here that nothing else pins:

* The cross-user cell on each leaky route is ``LEAK``, and the store proves it:
  the widget the intruder read still belongs to the owner, and the widget the
  intruder deleted is recorded as deleted *by the intruder*. A harness that
  merely sends requests without reaching the row cannot make those assertions
  true.
* The correct routes stay silent. ``GET /safeitems/{item_id}`` and the part
  routes deny cross-user access with 404 and 403, and every one of their cells
  must pass. A checker that cries wolf is discarded within a week, which is a
  slower path to the same false confidence.

The leaky ``DELETE`` also pins the seeding contract: because its cross-user cell
destroys the row, its positive control can only be 2xx if the harness seeded a
*fresh* object for that cell. Sharing one object across a route's four cells
would turn a genuine mutating leak into an inconclusive run.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
import pytest_asyncio
from httpx import AsyncClient

from scripts.dast.report import EXIT_AUTHZ_FINDING, MatrixReport
from scripts.dast.runner import run_matrix
from scripts.dast.verdict import CELL_ORDER, Cell, CellResult, Verdict
from tests.scripts.dast.conftest import (
    LEAKY_WIDGET_DELETE,
    LEAKY_WIDGET_GET,
    SAFE_ITEM_GET,
    SAFE_PART_GET,
    SAFE_PART_POST,
    STUB_BASE_URL,
    STUB_OBJECT_SCOPED_ROUTES,
    STUB_REPLAY_LABEL,
    StubDeployment,
    drive_main,
    make_stub_bootstrap,
    stub_config,
)

EXPECTED_FINDINGS = 2
NO_UNCOVERED_ROUTES: tuple[str, ...] = ()
NO_ALLOWLISTED_ROUTES = 0

CURL_REPRO_PREFIX = 'curl -H "Authorization: Bearer $B_TOKEN"'


@pytest_asyncio.fixture
async def leak_report(
    leaky_deployment: StubDeployment,
    leaky_client: AsyncClient,
) -> MatrixReport:
    """Run the full matrix once against the leaky stub."""
    return await run_matrix(
        leaky_client,
        bootstrap=make_stub_bootstrap(leaky_deployment),
        config=stub_config(),
    )


def cells_for(report: MatrixReport, route: tuple[str, str]) -> dict[Cell, CellResult]:
    """Return one route's four cells, keyed by cell, asserting none is missing."""
    method, path = route
    found = {
        result.cell: result
        for result in report.results
        if result.route.method == method and result.route.path == path
    }
    assert set(found) == set(CELL_ORDER), (
        f"{method} {path} was probed with cells {sorted(cell.name for cell in found)}; "
        f"every route needs all of {sorted(cell.name for cell in CELL_ORDER)}"
    )
    return found


def object_id(result: CellResult, param: str) -> int:
    """Return the integer id the harness sent for ``param`` on this cell."""
    sent = dict(result.object_ids)
    assert param in sent, f"{result.route.method} {result.route.path} sent ids {sent}"
    return int(sent[param])


@pytest.mark.asyncio
async def test_cross_user_read_of_another_users_widget_is_reported_as_a_leak(
    leak_report: MatrixReport,
    leaky_deployment: StubDeployment,
) -> None:
    """The intruder reads the owner's widget and the harness names it a LEAK.

    The store assertion is the part that cannot be faked: the id the harness
    sent still maps to the *owner's* email, so the 200 the intruder received was
    genuinely somebody else's row rather than one of their own.
    """
    cells = cells_for(leak_report, LEAKY_WIDGET_GET)
    leak = cells[Cell.CROSS_USER]

    assert leak.verdict is Verdict.LEAK
    assert leak.status == HTTPStatus.OK
    widget_id = object_id(leak, "widget_id")
    assert leak.resolved_path == f"/widgets/{widget_id}"
    assert leaky_deployment.store.widgets[widget_id] == leaky_deployment.owner.email


@pytest.mark.asyncio
async def test_the_leaky_read_still_denies_unauthenticated_and_forged_callers(
    leak_report: MatrixReport,
) -> None:
    """Only the cross-user cell fails; the token-less cells behave correctly.

    This keeps the finding above honest. If every cell on this route failed, the
    "leak" would be an artefact of a broken probe rather than a broken app.
    """
    cells = cells_for(leak_report, LEAKY_WIDGET_GET)

    assert cells[Cell.UNAUTH].status == HTTPStatus.UNAUTHORIZED
    assert cells[Cell.UNAUTH].verdict is Verdict.PASS
    assert cells[Cell.FORGED_JWT].status == HTTPStatus.UNAUTHORIZED
    assert cells[Cell.FORGED_JWT].verdict is Verdict.PASS
    assert cells[Cell.POSITIVE_CONTROL].status == HTTPStatus.OK
    assert cells[Cell.POSITIVE_CONTROL].verdict is Verdict.PASS


@pytest.mark.asyncio
async def test_cross_user_delete_of_another_users_widget_is_reported_as_a_leak(
    leak_report: MatrixReport,
    leaky_deployment: StubDeployment,
) -> None:
    """A mutating verb is caught too, and the row really is gone.

    ``deleted_by`` records the caller the handler saw, so asserting it holds the
    intruder's email proves the destructive request was executed on the owner's
    row — not merely sent at it.
    """
    cells = cells_for(leak_report, LEAKY_WIDGET_DELETE)
    leak = cells[Cell.CROSS_USER]
    store = leaky_deployment.store

    assert leak.verdict is Verdict.LEAK
    assert leak.status == HTTPStatus.NO_CONTENT
    widget_id = object_id(leak, "widget_id")
    assert widget_id not in store.widgets
    assert store.deleted_by[widget_id] == leaky_deployment.intruder.email


@pytest.mark.asyncio
async def test_the_leaky_delete_gets_its_own_object_for_the_positive_control(
    leak_report: MatrixReport,
) -> None:
    """A destructive cross-user cell must not poison its route's positive control.

    Seeding one object per route and deleting it in the cross-user cell would
    leave the owner's own delete returning 404, which reads as INCONCLUSIVE and
    would hide a genuine finding behind a harness error. A fresh object per cell
    is what keeps a mutating leak reportable, so the two cells must have sent
    different ids.
    """
    cells = cells_for(leak_report, LEAKY_WIDGET_DELETE)

    assert cells[Cell.POSITIVE_CONTROL].status == HTTPStatus.NO_CONTENT
    assert cells[Cell.POSITIVE_CONTROL].verdict is Verdict.PASS
    assert object_id(cells[Cell.POSITIVE_CONTROL], "widget_id") != object_id(
        cells[Cell.CROSS_USER],
        "widget_id",
    )


@pytest.mark.asyncio
async def test_the_correctly_guarded_item_route_produces_no_finding(
    leak_report: MatrixReport,
) -> None:
    """A route that 404s a foreign owner passes every cell — no crying wolf."""
    cells = cells_for(leak_report, SAFE_ITEM_GET)

    assert cells[Cell.CROSS_USER].status == HTTPStatus.NOT_FOUND
    assert cells[Cell.CROSS_USER].verdict is Verdict.PASS
    assert cells[Cell.UNAUTH].status == HTTPStatus.UNAUTHORIZED
    assert cells[Cell.UNAUTH].verdict is Verdict.PASS
    assert cells[Cell.FORGED_JWT].status == HTTPStatus.UNAUTHORIZED
    assert cells[Cell.FORGED_JWT].verdict is Verdict.PASS
    assert cells[Cell.POSITIVE_CONTROL].status == HTTPStatus.OK
    assert cells[Cell.POSITIVE_CONTROL].verdict is Verdict.PASS


@pytest.mark.asyncio
async def test_a_403_denial_counts_as_a_pass_on_the_two_parameter_route(
    leak_report: MatrixReport,
) -> None:
    """Ownership denials split 403/404 in this codebase; both are acceptable.

    The route also forces the seed resolver to fill ``part_id`` from a widget it
    seeded first, so a passing cell here means dependent seeding worked.
    """
    cells = cells_for(leak_report, SAFE_PART_GET)
    cross_user = cells[Cell.CROSS_USER]

    assert cross_user.status == HTTPStatus.FORBIDDEN
    assert cross_user.verdict is Verdict.PASS
    assert set(dict(cross_user.object_ids)) == {"widget_id", "part_id"}
    assert cells[Cell.POSITIVE_CONTROL].status == HTTPStatus.OK
    assert cells[Cell.POSITIVE_CONTROL].verdict is Verdict.PASS


@pytest.mark.asyncio
async def test_a_mutating_replay_uses_a_valid_body_so_it_reaches_the_owner_check(
    leak_report: MatrixReport,
    leaky_deployment: StubDeployment,
) -> None:
    """A replayed POST must 404 on ownership, not 422 on schema.

    An invalid body would be rejected before the ownership check ever ran, so a
    422 here would be a probe that proved nothing while looking like a denial.
    The label recorded by the handler proves the configured replay body is the
    one that actually went out.
    """
    cells = cells_for(leak_report, SAFE_PART_POST)

    assert cells[Cell.CROSS_USER].status == HTTPStatus.NOT_FOUND
    assert cells[Cell.CROSS_USER].verdict is Verdict.PASS
    assert cells[Cell.POSITIVE_CONTROL].status == HTTPStatus.CREATED
    assert cells[Cell.POSITIVE_CONTROL].verdict is Verdict.PASS
    assert STUB_REPLAY_LABEL in leaky_deployment.store.labels


@pytest.mark.asyncio
async def test_the_only_findings_are_the_two_planted_leaks(
    leak_report: MatrixReport,
) -> None:
    """Exactly two cells fail, and they are the two the stub was built to leak."""
    reported = {
        (finding.route.method, finding.route.path, finding.cell, finding.verdict)
        for finding in leak_report.findings
    }

    assert reported == {
        (*LEAKY_WIDGET_GET, Cell.CROSS_USER, Verdict.LEAK),
        (*LEAKY_WIDGET_DELETE, Cell.CROSS_USER, Verdict.LEAK),
    }
    assert len(leak_report.findings) == EXPECTED_FINDINGS


@pytest.mark.asyncio
async def test_every_route_is_probed_with_the_positive_control_last(
    leak_report: MatrixReport,
) -> None:
    """Cell order is part of the contract: the owner's own call runs after the probes.

    Running the positive control first would let a destructive cross-user cell
    inherit a still-valid object and let a later 404 read as a correct denial.
    """
    for route in (
        LEAKY_WIDGET_GET,
        LEAKY_WIDGET_DELETE,
        SAFE_ITEM_GET,
        SAFE_PART_GET,
        SAFE_PART_POST,
    ):
        method, path = route
        ordering = [
            result.cell
            for result in leak_report.results
            if result.route.method == method and result.route.path == path
        ]
        assert tuple(ordering) == CELL_ORDER, f"{method} {path} ran cells in {ordering}"


@pytest.mark.asyncio
async def test_the_run_is_graded_as_a_finding_with_no_guard_tripped(
    leak_report: MatrixReport,
) -> None:
    """Every stub route was covered, so the exit code is a finding, not a harness error."""
    assert leak_report.guard_failures == ()
    assert leak_report.discovered == STUB_OBJECT_SCOPED_ROUTES
    assert leak_report.seeded == STUB_OBJECT_SCOPED_ROUTES
    assert leak_report.uncovered == NO_UNCOVERED_ROUTES
    assert leak_report.allowlisted == NO_ALLOWLISTED_ROUTES
    assert leak_report.exit_code == EXIT_AUTHZ_FINDING


def test_main_driven_at_the_leaky_stub_exits_with_a_finding(
    leaky_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The CLI turns the two leaks into exit code 1 and writes them to stderr."""
    exit_code = drive_main(leaky_deployment, min_routes=STUB_OBJECT_SCOPED_ROUTES)

    captured = capsys.readouterr()
    assert exit_code == EXIT_AUTHZ_FINDING, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert captured.out == "", f"a failing run must not report on stdout: {captured.out!r}"
    assert "FAIL  GET    /widgets/{widget_id}" in captured.err, captured.err
    assert "FAIL  DELETE /widgets/{widget_id}" in captured.err, captured.err


def test_the_rendered_report_carries_a_pasteable_curl_repro(
    leaky_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A finding is only actionable if the reader can reproduce it in one paste."""
    drive_main(leaky_deployment, min_routes=STUB_OBJECT_SCOPED_ROUTES)

    captured = capsys.readouterr()
    assert CURL_REPRO_PREFIX in captured.err, captured.err
    assert f"{STUB_BASE_URL}/widgets/" in captured.err, captured.err
    assert "curl -X DELETE -H" in captured.err, captured.err
