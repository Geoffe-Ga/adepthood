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
from scripts.dast.policy import AllowlistEntry, ReferenceTarget, classify_routes
from scripts.dast.references import (
    EvidenceStrategy,
    ObjectReference,
    ReferenceLocation,
    ReferenceProbe,
)
from scripts.dast.report import EXIT_CLEAN, EXIT_HARNESS_ERROR
from scripts.dast.runner import (
    DEFAULT_BUDGET_SECONDS,
    DEFAULT_MAX_ALLOWLIST_FRACTION,
    DEFAULT_MIN_REFERENCES,
    DEFAULT_MIN_ROUTES,
    run_matrix,
)
from scripts.dast.verdict import (
    Cell,
    CellResult,
    ReferenceCellResult,
    Verdict,
    require_allowlist_bounded,
    require_allowlist_is_live,
    require_auth_established,
    require_declared_references_classified,
    require_minimum_coverage,
    require_minimum_reference_coverage,
    require_no_throttling,
    require_positive_controls,
    require_reference_allowlist_bounded,
    require_reference_positive_controls,
    require_seeded_resources,
    require_within_budget,
)
from tests.scripts.dast.conftest import (
    REFERENCE_GUARDED_NOTE_POST,
    REFERENCE_LEAKY_ATTACHMENT_POST,
    REFERENCE_LEAKY_FOLD_POST,
    REFERENCE_LEAKY_NOTE_POST,
    REFERENCE_STUB_REFERENCES,
    STUB_OBJECT_SCOPED_ROUTES,
    STUB_REFERENCE_REGISTRY,
    StubDeployment,
    drive_main,
    make_stub_bootstrap,
    reference_stub_config,
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

# A route that publishes one id in its body, and two entries scoped to a single
# field of it: one naming the field it still declares, one naming a property
# that has since been renamed away.
NOTE_ROUTE = RouteSpec(
    method="POST",
    path="/notes/",
    params=(),
    requires_auth=True,
    body_id_refs=("gadget_id",),
)
LIVE_FIELD_ENTRY = AllowlistEntry(
    method="POST",
    path="/notes/",
    category="shared_catalog",
    reason="any authenticated user may attach a note to any approved gadget",
    field="gadget_id",
)
RENAMED_FIELD_ENTRY = AllowlistEntry(
    method="POST",
    path="/notes/",
    category="shared_catalog",
    reason="the property this excused has since been renamed",
    field="widget_id",
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


def test_allowlist_liveness_trips_on_an_entry_scoped_to_a_field_nobody_publishes() -> None:
    """A field-scoped excuse outliving its field excuses nothing and says nothing.

    The classifier already refuses to let such an entry excuse whatever
    property replaced it, so without this guard the entry would simply stop
    doing anything -- silently, and forever. Reporting it is what makes the
    narrow excuse as reviewable as the broad one.
    """
    failure = require_allowlist_is_live((RENAMED_FIELD_ENTRY,), (NOTE_ROUTE,))

    assert failure is not None
    assert failure.guard == "require_allowlist_is_live"
    assert "widget_id" in failure.detail


def test_allowlist_liveness_is_silent_when_a_field_scoped_entry_names_a_live_field() -> None:
    """A narrow excuse for a property the route still publishes is doing its job."""
    assert require_allowlist_is_live((LIVE_FIELD_ENTRY,), (NOTE_ROUTE,)) is None


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


# --- The two guards that keep the reference dimension from proving nothing ----
#
# The reference matrix can go vacuous in the same two ways the path matrix can,
# plus one of its own. It can shrink until it probes almost nothing, and its
# controls can "succeed" against a route that never echoes anything back -- at
# which point the absence of a foreign id in a cross response means nothing at
# all, and every ambiguous 2xx would be graded as if it did.

PROBED_TOO_FEW_REFERENCES = 4
REFERENCE_STUB_MIN_REFERENCES = 1

JOURNAL_ROUTE = RouteSpec(
    method="POST",
    path="/journal/",
    params=(),
    requires_auth=True,
    body_id_refs=("practice_session_id",),
)

JOURNAL_REFERENCE = ObjectReference(
    field="practice_session_id",
    location=ReferenceLocation.BODY,
    seed_key="practice_session_id",
    evidence=EvidenceStrategy.ECHO,
)


def reference_cell_result(
    cell: Cell,
    status: int,
    *,
    evidence: bool,
    verdict: Verdict,
) -> ReferenceCellResult:
    """Build one graded reference cell for the guards that read a run's results."""
    return ReferenceCellResult(
        route=JOURNAL_ROUTE,
        reference=JOURNAL_REFERENCE,
        cell=cell,
        resolved_path="/journal/",
        object_id="31",
        status=status,
        object_was_reached=evidence,
        verdict=verdict,
    )


def test_minimum_reference_coverage_trips_when_nothing_was_probed() -> None:
    """Zero references probed is the garbled-document case, and it scores perfectly."""
    failure = require_minimum_reference_coverage(0, minimum=DEFAULT_MIN_REFERENCES)

    assert failure is not None
    assert failure.guard == "require_minimum_reference_coverage"
    assert "0" in failure.detail


def test_minimum_reference_coverage_trips_one_short_of_the_floor() -> None:
    """A dimension that quietly shrank by one route is still a dimension that shrank."""
    failure = require_minimum_reference_coverage(
        PROBED_TOO_FEW_REFERENCES,
        minimum=DEFAULT_MIN_REFERENCES,
    )

    assert failure is not None
    assert failure.guard == "require_minimum_reference_coverage"
    assert str(PROBED_TOO_FEW_REFERENCES) in failure.detail
    assert str(DEFAULT_MIN_REFERENCES) in failure.detail


def test_minimum_reference_coverage_is_silent_at_exactly_the_floor() -> None:
    """The floor is inclusive, matching the path dimension's."""
    assert (
        require_minimum_reference_coverage(
            DEFAULT_MIN_REFERENCES,
            minimum=DEFAULT_MIN_REFERENCES,
        )
        is None
    )


def test_the_reference_floor_is_five() -> None:
    """The default is a number, not a mood; lowering it is a decision made here."""
    assert DEFAULT_MIN_REFERENCES == 5


def test_reference_positive_controls_trip_when_a_control_succeeded_without_evidence() -> None:
    """The keystone of the whole dimension, asserted on its own.

    A control that answers 2xx while surfacing nothing has demonstrated that
    this route's responses say nothing about which object was reached. Every
    cross-user 2xx on it is then unfalsifiable, so grading its silence as a pass
    would be exactly the vacuous green this harness exists to forbid.
    """
    failure = require_reference_positive_controls(
        (
            reference_cell_result(
                Cell.CROSS_REFERENCE,
                HTTPStatus.OK,
                evidence=False,
                verdict=Verdict.INCONCLUSIVE,
            ),
            reference_cell_result(
                Cell.REFERENCE_CONTROL,
                HTTPStatus.CREATED,
                evidence=False,
                verdict=Verdict.INCONCLUSIVE,
            ),
        ),
    )

    assert failure is not None
    assert failure.guard == "require_reference_positive_controls"
    assert "/journal/" in failure.detail
    assert "practice_session_id" in failure.detail


def test_reference_positive_controls_trip_when_the_control_could_not_succeed() -> None:
    """A control rejected outright denies everybody equally, which proves nothing either."""
    failure = require_reference_positive_controls(
        (
            reference_cell_result(
                Cell.REFERENCE_CONTROL,
                HTTPStatus.UNPROCESSABLE_ENTITY,
                evidence=False,
                verdict=Verdict.INCONCLUSIVE,
            ),
        ),
    )

    assert failure is not None
    assert failure.guard == "require_reference_positive_controls"


def test_reference_positive_controls_are_silent_when_every_control_showed_its_own_id() -> None:
    """A control that both succeeded and echoed its own id makes the cross cell readable."""
    assert (
        require_reference_positive_controls(
            (
                reference_cell_result(
                    Cell.CROSS_REFERENCE,
                    HTTPStatus.FORBIDDEN,
                    evidence=False,
                    verdict=Verdict.PASS,
                ),
                reference_cell_result(
                    Cell.REFERENCE_CONTROL,
                    HTTPStatus.CREATED,
                    evidence=True,
                    verdict=Verdict.PASS,
                ),
            ),
        )
        is None
    )


def test_the_reference_guard_ignores_cross_cells_with_no_evidence() -> None:
    """Only controls are asked to prove the mechanism; a silent cross cell is the finding."""
    assert (
        require_reference_positive_controls(
            (
                reference_cell_result(
                    Cell.CROSS_REFERENCE,
                    HTTPStatus.OK,
                    evidence=False,
                    verdict=Verdict.INCONCLUSIVE,
                ),
            ),
        )
        is None
    )


def test_the_cli_never_reports_clean_against_a_server_that_401s_every_reference(
    blind_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The false pass has to stay closed in the new dimension too.

    The blind stub answers 401 to everything, so no reference is ever probed.
    Asked for even one, the run must report a tripped reference guard rather
    than a clean sweep of a dimension it never entered.
    """
    exit_code = drive_main(
        blind_deployment,
        min_routes=BLIND_STUB_MIN_ROUTES,
        min_references=REFERENCE_STUB_MIN_REFERENCES,
    )

    captured = capsys.readouterr()
    assert exit_code == EXIT_HARNESS_ERROR, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert exit_code != EXIT_CLEAN
    assert captured.out == "", f"a harness error must not report on stdout: {captured.out!r}"
    assert "require_minimum_reference_coverage" in captured.err, captured.err


# --- The reference dimension's own ceiling, and its own liveness check --------
#
# Both guards above measure the path dimension only. ``classify_routes`` counts
# a field-scoped entry as excusing nothing, so a file that excused every body id
# in the application would leave ``require_allowlist_bounded`` exactly where it
# started: the reference dimension had a floor and no ceiling. And
# ``classify_references`` walks the *discovered* fields, so a declared reference
# whose route or property has vanished lands in no bucket at all and simply
# stops being counted -- a matrix that shrinks down to its floor without one
# line of output saying so.

ALLOWLISTED_REFERENCE_MAJORITY = 3
ALLOWLISTED_REFERENCE_MINORITY = 2
DISCOVERED_REFERENCES = 4

EXCUSED_STUB_REFERENCE_ROUTES = (
    REFERENCE_LEAKY_NOTE_POST,
    REFERENCE_GUARDED_NOTE_POST,
    REFERENCE_LEAKY_ATTACHMENT_POST,
    REFERENCE_LEAKY_FOLD_POST,
)
STUB_REFERENCES_LEFT_PROBED = REFERENCE_STUB_REFERENCES - len(EXCUSED_STUB_REFERENCE_ROUTES)
VANISHED_REFERENCE_ROUTE = ("POST", "/vanished/")

GADGET_REFERENCE = ObjectReference(
    field="gadget_id",
    location=ReferenceLocation.BODY,
    seed_key="gadget_id",
    evidence=EvidenceStrategy.ECHO,
)
NOTE_PROBE = ReferenceProbe(
    method=NOTE_ROUTE.method,
    path=NOTE_ROUTE.path,
    body={},
    references=(GADGET_REFERENCE,),
)
NOTE_TARGET = ReferenceTarget(route=NOTE_ROUTE, field="gadget_id", reference=GADGET_REFERENCE)


def test_the_path_allowlist_ceiling_cannot_see_a_field_scoped_excuse() -> None:
    """The gap the reference ceiling exists to close, asserted rather than assumed.

    An entry scoped to one body property excuses no route, so it enters neither
    side of the path guard's fraction. Without a ceiling of its own the
    reference dimension could be excused entirely and every path count would
    look untouched.
    """
    classification = classify_routes(
        (NOTE_ROUTE,),
        seed_registry={},
        allowlist=(LIVE_FIELD_ENTRY,),
    )

    assert classification.allowlisted == ()


def test_reference_allowlist_bounded_trips_when_most_body_ids_are_excused() -> None:
    """Excusing the majority of the ids an application accepts is the same decoration."""
    failure = require_reference_allowlist_bounded(
        ALLOWLISTED_REFERENCE_MAJORITY,
        DISCOVERED_REFERENCES,
        max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION,
    )

    assert failure is not None
    assert failure.guard == "require_reference_allowlist_bounded"
    assert str(ALLOWLISTED_REFERENCE_MAJORITY) in failure.detail
    assert str(DISCOVERED_REFERENCES) in failure.detail


def test_reference_allowlist_bounded_is_silent_at_the_permitted_fraction() -> None:
    """Half is the same documented ceiling the path dimension uses."""
    assert (
        require_reference_allowlist_bounded(
            ALLOWLISTED_REFERENCE_MINORITY,
            DISCOVERED_REFERENCES,
            max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION,
        )
        is None
    )


def test_reference_allowlist_bounded_reports_rather_than_raises_on_an_empty_document() -> None:
    """Zero excused out of zero discovered is a report, not a division by zero."""
    assert (
        require_reference_allowlist_bounded(0, 0, max_fraction=DEFAULT_MAX_ALLOWLIST_FRACTION)
        is None
    )


def test_declared_references_classified_trips_when_a_declaration_vanished() -> None:
    """A registry entry naming a route the document no longer has must be said out loud.

    The classifier walks discovered fields, so the declaration falls out of
    every bucket rather than into ``uncovered``. Silence here is how a matrix
    shrinks to its floor with nobody noticing.
    """
    failure = require_declared_references_classified({VANISHED_REFERENCE_ROUTE: NOTE_PROBE}, ())

    assert failure is not None
    assert failure.guard == "require_declared_references_classified"
    assert "/vanished/" in failure.detail
    assert GADGET_REFERENCE.field in failure.detail


def test_declared_references_classified_is_silent_when_every_declaration_landed() -> None:
    """A declaration the classifier placed in any bucket is accounted for."""
    assert (
        require_declared_references_classified(
            {(NOTE_ROUTE.method, NOTE_ROUTE.path): NOTE_PROBE},
            (NOTE_TARGET,),
        )
        is None
    )


@pytest.mark.asyncio
async def test_a_run_that_excuses_most_of_its_references_is_a_harness_error(
    reference_deployment: StubDeployment,
    reference_client: AsyncClient,
) -> None:
    """Four field-scoped excuses over six references must fail the run by name.

    This is the wiring, not the arithmetic: the same four entries leave every
    path count untouched, so before the reference ceiling the run reported a
    clean sweep of the two references it had left.
    """
    report = await run_matrix(
        reference_client,
        bootstrap=make_stub_bootstrap(reference_deployment),
        config=reference_stub_config(
            min_references=REFERENCE_STUB_MIN_REFERENCES,
            allowlist=tuple(
                AllowlistEntry(
                    method=method,
                    path=path,
                    category="shared_catalog",
                    reason="any authenticated caller may name any approved gadget",
                    field=GADGET_REFERENCE.field,
                )
                for method, path in EXCUSED_STUB_REFERENCE_ROUTES
            ),
        ),
    )

    tripped = [failure.guard for failure in report.guard_failures]
    assert "require_reference_allowlist_bounded" in tripped, tripped
    assert "require_allowlist_bounded" not in tripped, tripped
    assert report.references_probed == STUB_REFERENCES_LEFT_PROBED
    assert report.exit_code == EXIT_HARNESS_ERROR


@pytest.mark.asyncio
async def test_a_run_whose_declared_reference_is_no_longer_published_is_a_harness_error(
    reference_deployment: StubDeployment,
    reference_client: AsyncClient,
) -> None:
    """A declared probe for a route this instance does not publish fails the run.

    Pointed at a stale deployment the registry silently loses references one at
    a time, and the coverage floor only notices once enough of them are gone.
    """
    report = await run_matrix(
        reference_client,
        bootstrap=make_stub_bootstrap(reference_deployment),
        config=reference_stub_config(
            reference_registry={**STUB_REFERENCE_REGISTRY, VANISHED_REFERENCE_ROUTE: NOTE_PROBE},
        ),
    )

    tripped = [failure.guard for failure in report.guard_failures]
    assert "require_declared_references_classified" in tripped, tripped
    assert report.exit_code == EXIT_HARNESS_ERROR
