"""A finding is only useful if the reader can act on it without rerunning anything.

Every failure block therefore names the method, the path template, the exact id
that was sent, whose object it was, and the status the server actually returned
-- and then hands over a curl line that reproduces it in one paste. "IDOR on
/journal" is a ticket nobody can close.

Two quieter properties matter as much as the failure format. The summary block
prints how many routes were discovered, seeded, uncovered, and allow-listed, so
a green run is readable as "37 routes were genuinely probed" rather than as an
unqualified thumbs-up. And every report carries a scope note: this check reads
object references out of the *path*, so a clean result must never be mistaken
for "no BOLA anywhere in the app".

The exit-code precedence is pinned here too. A tripped vacuity guard outranks a
finding, because a run that proved nothing cannot also be trusted to have found
everything.
"""

from __future__ import annotations

from dataclasses import replace
from http import HTTPStatus

from scripts.dast.discovery import RouteSpec
from scripts.dast.references import (
    EvidenceStrategy,
    EvidenceWitness,
    ObjectReference,
    ReferenceLocation,
    WitnessCondition,
)
from scripts.dast.report import (
    EXIT_AUTHZ_FINDING,
    EXIT_CLEAN,
    EXIT_HARNESS_ERROR,
    EXIT_UNCOVERED,
    PASS_HEADLINE,
    SCOPE_NOTE,
    MatrixReport,
    render_curl,
    render_report,
)
from scripts.dast.verdict import (
    Cell,
    CellResult,
    GuardFailure,
    ReferenceCellResult,
    Verdict,
)

BASE_URL = "http://127.0.0.1:8000"

MARGINALIA_ROUTE = RouteSpec(
    method="GET",
    path="/journal/{entry_id}/marginalia",
    params=("entry_id",),
    requires_auth=True,
)
WIDGET_DELETE_ROUTE = RouteSpec(
    method="DELETE",
    path="/widgets/{widget_id}",
    params=("widget_id",),
    requires_auth=True,
)
WIDGET_GET_ROUTE = RouteSpec(
    method="GET",
    path="/widgets/{widget_id}",
    params=("widget_id",),
    requires_auth=True,
)
SLUG_ROUTE = RouteSpec(method="GET", path="/course/{slug}", params=("slug",), requires_auth=True)

MARGINALIA_LEAK = CellResult(
    route=MARGINALIA_ROUTE,
    cell=Cell.CROSS_USER,
    resolved_path="/journal/14/marginalia",
    object_ids=(("entry_id", "14"),),
    status=HTTPStatus.OK,
    verdict=Verdict.LEAK,
)
WIDGET_DELETE_LEAK = CellResult(
    route=WIDGET_DELETE_ROUTE,
    cell=Cell.CROSS_USER,
    resolved_path="/widgets/7",
    object_ids=(("widget_id", "7"),),
    status=HTTPStatus.NO_CONTENT,
    verdict=Verdict.LEAK,
)
WIDGET_UNAUTH_LEAK = CellResult(
    route=WIDGET_GET_ROUTE,
    cell=Cell.UNAUTH,
    resolved_path="/widgets/7",
    object_ids=(("widget_id", "7"),),
    status=HTTPStatus.OK,
    verdict=Verdict.LEAK,
)
WIDGET_PASS = CellResult(
    route=WIDGET_GET_ROUTE,
    cell=Cell.CROSS_USER,
    resolved_path="/widgets/7",
    object_ids=(("widget_id", "7"),),
    status=HTTPStatus.NOT_FOUND,
    verdict=Verdict.PASS,
)

THROTTLE_GUARD = GuardFailure(
    guard="require_no_throttling",
    detail="3 of 164 responses were 429; results are inconclusive",
)

SAMPLE_ELAPSED_SECONDS = 12.5
SAMPLE_DISCOVERED = 5
SAMPLE_SEEDED = 4
SAMPLE_ALLOWLISTED = 0


def build_report(
    *,
    results: tuple[CellResult, ...] = (),
    uncovered: tuple[str, ...] = (),
    guard_failures: tuple[GuardFailure, ...] = (),
    reference_results: tuple[ReferenceCellResult, ...] = (),
) -> MatrixReport:
    """Assemble a report with everything but the field under test held constant."""
    return MatrixReport(
        base_url=BASE_URL,
        discovered=SAMPLE_DISCOVERED,
        seeded=SAMPLE_SEEDED,
        uncovered=uncovered,
        allowlisted=SAMPLE_ALLOWLISTED,
        results=results,
        guard_failures=guard_failures,
        elapsed_seconds=SAMPLE_ELAPSED_SECONDS,
        reference_results=reference_results,
    )


def test_the_exit_codes_are_the_documented_shell_contract() -> None:
    """CI reads these numbers, so they are as much a contract as the report text."""
    assert EXIT_CLEAN == 0
    assert EXIT_AUTHZ_FINDING == 1
    assert EXIT_UNCOVERED == 2
    assert EXIT_HARNESS_ERROR == 3


def test_the_summary_block_quantifies_what_was_actually_probed() -> None:
    """A green run has to state its own coverage, or it is just an unqualified claim."""
    report = MatrixReport(
        base_url=BASE_URL,
        discovered=41,
        seeded=37,
        uncovered=(),
        allowlisted=4,
        results=(),
        guard_failures=(),
        elapsed_seconds=SAMPLE_ELAPSED_SECONDS,
    )

    assert (
        "  routes discovered from /openapi.json : 41 object-scoped\n"
        "  seeded as user A                     : 37\n"
        "  UNCOVERED (no seed strategy)         : 0\n"
        "  allow-listed                         : 4\n"
    ) in render_report(report)


def test_a_cross_user_leak_names_the_route_the_id_the_owner_and_the_status() -> None:
    """Everything needed to triage the finding sits in the block itself."""
    rendered = render_report(build_report(results=(MARGINALIA_LEAK,)))

    assert (
        "  FAIL  GET    /journal/{entry_id}/marginalia\n"
        "        user B token + user A entry_id=14  ->  200 OK   (expected 403/404)\n"
        '        repro: curl -H "Authorization: Bearer $B_TOKEN" \\\n'
        "                    http://127.0.0.1:8000/journal/14/marginalia\n"
    ) in rendered


def test_a_mutating_leak_renders_the_verb_in_both_the_headline_and_the_repro() -> None:
    """A DELETE finding that reproduces as a GET wastes the reader's first attempt."""
    rendered = render_report(build_report(results=(WIDGET_DELETE_LEAK,)))

    assert (
        "  FAIL  DELETE /widgets/{widget_id}\n"
        "        user B token + user A widget_id=7  ->  204 No Content   (expected 403/404)\n"
        '        repro: curl -X DELETE -H "Authorization: Bearer $B_TOKEN" \\\n'
        "                    http://127.0.0.1:8000/widgets/7\n"
    ) in rendered


def test_an_unauthenticated_leak_states_that_no_token_was_sent() -> None:
    """The cell has to be legible from the text; "user B token" here would mislead."""
    rendered = render_report(build_report(results=(WIDGET_UNAUTH_LEAK,)))

    assert (
        "  FAIL  GET    /widgets/{widget_id}\n"
        "        no token + user A widget_id=7  ->  200 OK   (expected 401)\n"
        "        repro: curl \\\n"
        "                    http://127.0.0.1:8000/widgets/7\n"
    ) in rendered


def test_render_curl_builds_a_single_pasteable_command() -> None:
    """The wrapped repro and the one-line command must stay the same command."""
    assert render_curl(MARGINALIA_LEAK, base_url=BASE_URL) == (
        'curl -H "Authorization: Bearer $B_TOKEN" http://127.0.0.1:8000/journal/14/marginalia'
    )
    assert render_curl(WIDGET_DELETE_LEAK, base_url=BASE_URL) == (
        'curl -X DELETE -H "Authorization: Bearer $B_TOKEN" http://127.0.0.1:8000/widgets/7'
    )
    assert render_curl(WIDGET_UNAUTH_LEAK, base_url=BASE_URL) == (
        "curl http://127.0.0.1:8000/widgets/7"
    )


def test_every_report_carries_the_scope_note() -> None:
    """The note has to describe the check that actually ran, in every report.

    It used to disclaim body- and query-carried ids as out of scope. Leaving
    that sentence in place once they are probed would understate a green run as
    badly as overstating it, and the next reader would go looking for a gap that
    is no longer there.
    """
    assert "path" in SCOPE_NOTE
    assert "body" in SCOPE_NOTE or "bodies" in SCOPE_NOTE
    assert "query" in SCOPE_NOTE
    assert "not covered" not in SCOPE_NOTE
    assert f"  {SCOPE_NOTE}\n" in render_report(build_report())
    assert f"  {SCOPE_NOTE}\n" in render_report(build_report(results=(MARGINALIA_LEAK,)))


def test_a_run_with_only_passing_cells_is_clean_and_says_so() -> None:
    """The passing report states what was proven rather than staying silent."""
    report = build_report(results=(WIDGET_PASS,))
    rendered = render_report(report)

    assert report.findings == ()
    assert report.exit_code == EXIT_CLEAN
    assert f"  {PASS_HEADLINE}\n" in rendered
    assert "FAIL" not in rendered


def test_findings_are_exactly_the_cells_that_did_not_pass() -> None:
    """Passing cells are counted, not printed; findings are the report's payload."""
    report = build_report(results=(WIDGET_PASS, MARGINALIA_LEAK, WIDGET_DELETE_LEAK))

    assert report.findings == (MARGINALIA_LEAK, WIDGET_DELETE_LEAK)
    assert report.exit_code == EXIT_AUTHZ_FINDING


def test_uncovered_routes_are_listed_and_fail_with_their_own_exit_code() -> None:
    """A route with no seed strategy and no allow-list entry is unfinished work."""
    report = build_report(uncovered=(f"{SLUG_ROUTE.method} {SLUG_ROUTE.path}",))
    rendered = render_report(report)

    assert report.exit_code == EXIT_UNCOVERED
    assert "  UNCOVERED  GET    /course/{slug}\n" in rendered


def test_a_tripped_guard_is_a_harness_error_even_with_nothing_else_wrong() -> None:
    """Zero findings plus a tripped guard is the false pass, so it must exit 3.

    This is the single most important line in the module: a run that could not
    prove anything has to be louder than a run that proved everything was fine.
    """
    report = build_report(guard_failures=(THROTTLE_GUARD,))
    rendered = render_report(report)

    assert report.findings == ()
    assert report.exit_code == EXIT_HARNESS_ERROR
    assert report.exit_code != EXIT_CLEAN
    assert (
        "  HARNESS ERROR  require_no_throttling: "
        "3 of 164 responses were 429; results are inconclusive\n"
    ) in rendered


def test_a_guard_failure_outranks_a_finding_in_the_exit_code() -> None:
    """When the run is untrustworthy, "we found one leak" is not the headline."""
    report = build_report(results=(MARGINALIA_LEAK,), guard_failures=(THROTTLE_GUARD,))

    assert report.exit_code == EXIT_HARNESS_ERROR


def test_a_finding_outranks_an_uncovered_route_in_the_exit_code() -> None:
    """A proven leak is more urgent than a gap in coverage, and both are reported."""
    report = build_report(
        results=(MARGINALIA_LEAK,),
        uncovered=(f"{SLUG_ROUTE.method} {SLUG_ROUTE.path}",),
    )
    rendered = render_report(report)

    assert report.exit_code == EXIT_AUTHZ_FINDING
    assert "  FAIL  GET    /journal/{entry_id}/marginalia\n" in rendered
    assert "  UNCOVERED  GET    /course/{slug}\n" in rendered


# --- Rendering a finding whose id never appeared in the path ------------------
#
# A reference finding has one fact more than a path finding: which field carried
# the id. Without it the reader cannot reproduce the request, because the path
# alone does not say what to send.

JOURNAL_CREATE_ROUTE = RouteSpec(
    method="POST",
    path="/journal/",
    params=(),
    requires_auth=True,
    body_id_refs=("practice_session_id",),
)
SESSION_LISTING_ROUTE = RouteSpec(
    method="GET",
    path="/journal/",
    params=(),
    requires_auth=True,
    query_id_refs=("practice_session_id",),
)

SESSION_REFERENCE = ObjectReference(
    field="practice_session_id",
    location=ReferenceLocation.BODY,
    seed_key="practice_session_id",
    evidence=EvidenceStrategy.ECHO,
)
LISTING_REFERENCE = ObjectReference(
    field="practice_session_id",
    location=ReferenceLocation.QUERY,
    seed_key="practice_session_id",
    evidence=EvidenceStrategy.LISTING,
)

REFERENCE_LEAK = ReferenceCellResult(
    route=JOURNAL_CREATE_ROUTE,
    reference=SESSION_REFERENCE,
    cell=Cell.CROSS_REFERENCE,
    resolved_path="/journal/",
    object_id="31",
    status=HTTPStatus.CREATED,
    object_was_reached=True,
    verdict=Verdict.LEAK,
)
# A route whose whole answer is a flag: no id to scan for, so the finding has to
# report what the declared witness read instead.
WITNESSED_REFERENCE = ObjectReference(
    field="included_in_entry_id",
    location=ReferenceLocation.BODY,
    seed_key="reflection_entry_id",
    evidence=EvidenceStrategy.ECHO,
    witness=EvidenceWitness(pointer=("pending",), condition=WitnessCondition.IS_FALSE),
)

WITNESSED_LEAK = ReferenceCellResult(
    route=JOURNAL_CREATE_ROUTE,
    reference=WITNESSED_REFERENCE,
    cell=Cell.CROSS_REFERENCE,
    resolved_path="/journal/",
    object_id="31",
    status=HTTPStatus.OK,
    object_was_reached=True,
    verdict=Verdict.LEAK,
)
REFERENCE_PASS = ReferenceCellResult(
    route=SESSION_LISTING_ROUTE,
    reference=LISTING_REFERENCE,
    cell=Cell.CROSS_REFERENCE,
    resolved_path="/journal/",
    object_id="31",
    status=HTTPStatus.OK,
    object_was_reached=False,
    verdict=Verdict.PASS,
)


def test_a_reference_leak_names_the_route_the_field_the_id_and_the_status() -> None:
    """Everything needed to reproduce the request sits in the block itself.

    The field name is the part a path finding never needs and a reference
    finding cannot do without: "IDOR on POST /journal/" does not say what to put
    in the body.
    """
    rendered = render_report(build_report(reference_results=(REFERENCE_LEAK,)))

    assert "FAIL" in rendered
    assert "POST" in rendered
    assert "/journal/" in rendered
    assert "practice_session_id=31" in rendered
    assert "201 Created" in rendered


def test_a_witnessed_finding_says_which_field_it_read_and_what_it_found() -> None:
    """An operator has to be able to check the claim against the route by eye.

    A witnessed cell carries no id in its evidence, so "the referenced object
    came back in the response" would be a sentence about something nobody can
    look at. Naming the field and the reading is what makes the finding
    triageable without rerunning the harness.
    """
    rendered = render_report(build_report(reference_results=(WITNESSED_LEAK,)))

    assert "pending false" in rendered
    assert "only a landed write produces" in rendered


def test_an_inconclusive_scan_says_the_object_never_appeared() -> None:
    """A cell that learned nothing has to read differently from one that saw nothing.

    An id-scanned cell that answered 2xx while showing no trace of the object,
    with no control to explain the silence, is the run's most misleading
    outcome. The block has to say that the evidence was empty rather than imply
    the route was clean.
    """
    unexplained = replace(REFERENCE_LEAK, object_was_reached=False, verdict=Verdict.INCONCLUSIVE)

    rendered = render_report(build_report(reference_results=(unexplained,)))

    assert "never appeared in the response" in rendered


def test_a_witnessed_cell_that_did_not_fire_says_the_write_never_landed() -> None:
    """The negative reading has to be as legible as the positive one."""
    quiet = replace(WITNESSED_LEAK, object_was_reached=False, verdict=Verdict.INCONCLUSIVE)

    rendered = render_report(build_report(reference_results=(quiet,)))

    assert "without pending false" in rendered
    assert "the write never landed" in rendered


def test_a_passing_reference_cell_is_counted_and_not_printed() -> None:
    """Passing cells are the majority; printing them would bury the findings."""
    report = build_report(reference_results=(REFERENCE_PASS,))
    rendered = render_report(report)

    assert report.reference_findings == ()
    assert report.exit_code == EXIT_CLEAN
    assert "FAIL" not in rendered
    assert f"  {PASS_HEADLINE}\n" in rendered


def test_reference_findings_are_exactly_the_reference_cells_that_did_not_pass() -> None:
    """The same rule as the path dimension, applied to the parallel one."""
    report = build_report(reference_results=(REFERENCE_PASS, REFERENCE_LEAK))

    assert report.reference_findings == (REFERENCE_LEAK,)


def test_a_reference_leak_alone_is_enough_to_fail_the_build() -> None:
    """A body-carried leak is a leak; nothing about the path dimension may excuse it."""
    report = build_report(reference_results=(REFERENCE_LEAK,))

    assert report.findings == ()
    assert report.exit_code == EXIT_AUTHZ_FINDING


def test_a_guard_failure_still_outranks_a_reference_finding() -> None:
    """A run that proved nothing stays louder than one that proved something wrong."""
    report = build_report(
        reference_results=(REFERENCE_LEAK,),
        guard_failures=(THROTTLE_GUARD,),
    )

    assert report.exit_code == EXIT_HARNESS_ERROR


UNREADABLE_EVIDENCE_CELL = ReferenceCellResult(
    route=JOURNAL_CREATE_ROUTE,
    reference=SESSION_REFERENCE,
    cell=Cell.CROSS_REFERENCE,
    resolved_path="/journal/",
    object_id="31",
    status=HTTPStatus.CREATED,
    object_was_reached=False,
    verdict=Verdict.INCONCLUSIVE,
    evidence_unavailable=True,
)


def test_a_cell_with_no_readable_evidence_says_so_rather_than_reporting_an_absence() -> None:
    """An unreadable answer and an absent object are different findings.

    They have different fixes -- a broken read surface against an authorization
    bug -- so a block that rendered the first as the second would send its
    reader hunting in the wrong file.
    """
    rendered = render_report(build_report(reference_results=(UNREADABLE_EVIDENCE_CELL,)))

    assert "no readable evidence" in rendered
    assert "never appeared in the response" not in rendered


def test_the_scope_note_names_the_shapes_a_reference_probe_cannot_see() -> None:
    """A green has to be readable as what it is, so the note states both known gaps.

    Grading a cross-user 2xx on the absence of the foreign id assumes the
    response renders a reference it persisted the same way whoever owns the
    object it names. And the body heuristic looks for a singular ``*_id``, so a
    plural collection of them is never probed at all. Both are real, both are
    invisible from a passing run, and a note that omitted either would let the
    green claim more than it proved.
    """
    assert "*_ids" in SCOPE_NOTE
    assert "owner-scoped" in SCOPE_NOTE
    assert "creator-scoped" in SCOPE_NOTE
