"""The harness must catch a BOLA whose id rode in a body, not merely fail to find one.

This is the positive control for the reference dimension, and it is the only
test in the package that could not pass against a harness which quietly probes
nothing. It drives the matrix at a genuine FastAPI app whose ``POST /notes/``
and ``POST /attachments/`` accept a gadget id from anybody and never ask who
owns it, and it asserts an explicit expected verdict for every cell -- never "no
findings were reported", which is the sentence a vacuous pass also satisfies.

Six properties are pinned here that nothing else pins:

* The cross cell on the echoing leaky route is ``LEAK``, and the store proves
  it: the note the intruder created is recorded against the intruder while the
  gadget it names still belongs to the owner.
* The silent leaky route is caught too, through a read-back issued as the
  object's owner. Its own 201 says nothing at all, so a harness that graded only
  what the probe returned would report it clean forever.
* The honest filtered listing stays silent. ``GET /gadgets/?gadget_id=`` applies
  its filter after scoping to the caller, so a foreign id is answered 200 with
  an empty list. Status-only grading calls that a leak; evidence grading calls
  it a pass, and only because the paired control demonstrated the filter
  surfaces an id it *can* see.
* A route whose entire answer is a boolean is graded on that boolean.
  ``POST /folds/`` names no id anywhere and offers no read surface, so before
  its declared witness the cell could only be graded on its status.
* Its honest twin, ``POST /guardedfolds/``, answers 200 whether it folded or
  not. Only the witness separates the two, and only the control makes its
  negative mean "it declined" rather than "we learned nothing".
* The correctly guarded route stays silent as well. A checker that cries wolf is
  discarded within a week, which is a slower path to the same false confidence.

The pure-helper section at the top pins the three decisions the loop is built
on: which value gets injected, what counts as evidence that it came back, and
what counts as evidence for a route that never mentions it.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
import pytest_asyncio
from httpx import AsyncClient, Response

from scripts.dast.references import (
    EvidenceStrategy,
    EvidenceWitness,
    ObjectReference,
    ReferenceLocation,
    ReferenceProbe,
    WitnessCondition,
    body_carries_id,
    build_reference_request,
    evidence_reaches_object,
    witness_fires,
)
from scripts.dast.report import EXIT_AUTHZ_FINDING, EXIT_HARNESS_ERROR, MatrixReport
from scripts.dast.runner import json_body, run_matrix
from scripts.dast.verdict import (
    REFERENCE_CELL_ORDER,
    Cell,
    Verdict,
)
from tests.scripts.dast.conftest import (
    REFERENCE_GADGET_LISTING_GET,
    REFERENCE_GUARDED_FOLD_POST,
    REFERENCE_GUARDED_NOTE_POST,
    REFERENCE_LEAKY_ATTACHMENT_POST,
    REFERENCE_LEAKY_FOLD_POST,
    REFERENCE_LEAKY_NOTE_POST,
    REFERENCE_STUB_REFERENCES,
    STUB_REPLAY_LABEL,
    StubDeployment,
    drive_reference_main,
    make_stub_bootstrap,
    reference_cells_for,
    reference_stub_config,
    stub_config,
)

BLIND_STUB_MIN_ROUTES = 1
BLIND_STUB_MIN_REFERENCES = 1
EXPECTED_REFERENCE_FINDINGS = 3

GADGET_FIELD = "gadget_id"
SEEDED_ID = "31"
LOOKALIKE_ID = 314

NOTE_PROBE = ReferenceProbe(
    method="POST",
    path="/notes/",
    body={"label": STUB_REPLAY_LABEL},
    references=(
        ObjectReference(
            field=GADGET_FIELD,
            location=ReferenceLocation.BODY,
            seed_key=GADGET_FIELD,
            evidence=EvidenceStrategy.ECHO,
        ),
    ),
)
LISTING_PROBE = ReferenceProbe(
    method="GET",
    path="/gadgets/",
    body={},
    references=(
        ObjectReference(
            field=GADGET_FIELD,
            location=ReferenceLocation.QUERY,
            seed_key=GADGET_FIELD,
            evidence=EvidenceStrategy.LISTING,
        ),
    ),
)


# --- The two pure decisions the probing loop is built on ---------------------


def test_an_integer_typed_body_reference_is_injected_as_a_number() -> None:
    """Seeded ids are text, but a body field declared ``integer`` must receive an int.

    Injection works today only because Pydantic coerces a numeric string in lax
    mode. The day any request model turns strict, a string would be answered 422
    -- which grades as a denial, so every reference probe in the suite would
    silently start passing for the wrong reason.
    """
    request = build_reference_request(
        NOTE_PROBE,
        NOTE_PROBE.references[0],
        object_id=SEEDED_ID,
        values={},
    )

    assert request.body is not None
    assert request.body[GADGET_FIELD] == int(SEEDED_ID)
    assert isinstance(request.body[GADGET_FIELD], int)
    assert not isinstance(request.body[GADGET_FIELD], str)


def test_the_base_body_survives_alongside_the_injected_reference() -> None:
    """The rest of the payload has to arrive intact, or the route 422s before the check."""
    request = build_reference_request(
        NOTE_PROBE,
        NOTE_PROBE.references[0],
        object_id=SEEDED_ID,
        values={},
    )

    assert request.body == {"label": STUB_REPLAY_LABEL, GADGET_FIELD: int(SEEDED_ID)}
    assert request.params == {}


def test_a_query_reference_travels_in_the_query_string_and_not_in_a_body() -> None:
    """A filter hung off the URL must not also be posted as JSON the route ignores."""
    request = build_reference_request(
        LISTING_PROBE,
        LISTING_PROBE.references[0],
        object_id=SEEDED_ID,
        values={},
    )

    assert request.params == {GADGET_FIELD: SEEDED_ID}
    assert request.body is None


def test_evidence_is_found_however_deeply_the_id_is_nested() -> None:
    """Responses wrap ids in pages, lists, and envelopes; the scan has to reach them."""
    body = {"items": [{"note": {"id": 9, GADGET_FIELD: int(SEEDED_ID)}}], "total": 1}

    assert body_carries_id(body, SEEDED_ID) is True


def test_evidence_is_absent_from_an_empty_page() -> None:
    """The correct filtered listing returns nothing, and nothing is not evidence."""
    assert body_carries_id({"items": [], "total": 0}, SEEDED_ID) is False


def test_a_longer_id_that_merely_starts_with_the_one_sought_is_not_evidence() -> None:
    """Substring matching would report a leak for id 31 whenever id 314 came back.

    A false LEAK is the fastest way to get a security gate switched off, so the
    scan compares whole values rather than searching serialized text.
    """
    assert body_carries_id({"items": [{GADGET_FIELD: LOOKALIKE_ID}]}, SEEDED_ID) is False


def test_an_id_returned_as_text_still_counts_as_evidence() -> None:
    """Some routes serialize ids as strings; the object was reached either way."""
    assert body_carries_id({GADGET_FIELD: SEEDED_ID}, SEEDED_ID) is True


# --- The third decision: what counts as evidence when there is no id ---------
#
# Some routes answer with no id anywhere -- not in the response, not in any
# listing, not through any follow-up read. Scanning those answers finds nothing
# on either cell, which leaves the cross cell graded on its status alone. A
# witness names the one field whose value only a landed write produces.

PENDING_WITNESS = EvidenceWitness(pointer=("pending",), condition=WitnessCondition.IS_FALSE)
STREAK_WITNESS = EvidenceWitness(pointer=("streak",), condition=WitnessCondition.AT_LEAST_ONE)
NESTED_WITNESS = EvidenceWitness(
    pointer=("result", "pending"),
    condition=WitnessCondition.IS_FALSE,
)

WITNESSED_REFERENCE = ObjectReference(
    field=GADGET_FIELD,
    location=ReferenceLocation.BODY,
    seed_key=GADGET_FIELD,
    evidence=EvidenceStrategy.ECHO,
    witness=PENDING_WITNESS,
)
SCANNED_REFERENCE = NOTE_PROBE.references[0]


def test_a_witness_fires_on_the_answer_a_landed_write_produces() -> None:
    """A flag the write clears is evidence the write happened, and no id is needed."""
    assert witness_fires(PENDING_WITNESS, {"pending": False}) is True


def test_a_witness_stays_silent_while_the_write_has_not_landed() -> None:
    """The same 200 with the flag still set is the honest route declining, not a leak."""
    assert witness_fires(PENDING_WITNESS, {"pending": True}) is False


def test_a_witness_whose_field_is_gone_stays_silent_rather_than_guessing() -> None:
    """A renamed field must make the witness go quiet on the control as well.

    Failing closed is what turns a rotted witness into a named guard failure --
    the control stops proving its mechanism -- instead of a reference that
    silently slides back to being graded on its status.
    """
    assert witness_fires(PENDING_WITNESS, {"folded": True}) is False
    assert witness_fires(PENDING_WITNESS, []) is False


def test_a_counting_witness_fires_only_once_the_count_has_moved() -> None:
    """A streak of zero is the answer a check-in that never landed gives."""
    assert witness_fires(STREAK_WITNESS, {"streak": 0}) is False
    assert witness_fires(STREAK_WITNESS, {"streak": 1}) is True


def test_a_counting_witness_refuses_to_read_a_flag_as_a_count() -> None:
    """``True == 1`` in Python, so an unrelated boolean would otherwise witness a write."""
    assert witness_fires(STREAK_WITNESS, {"streak": True}) is False


def test_a_witness_reaches_a_field_nested_inside_an_envelope() -> None:
    """Responses wrap their answer, and the pointer has to be able to follow."""
    assert witness_fires(NESTED_WITNESS, {"result": {"pending": False}}) is True


def test_a_witness_replaces_the_id_scan_rather_than_joining_it() -> None:
    """Otherwise a number that merely equals the id would be reported as a leak.

    The body below is the honest route declining: the write did not land, and
    the only reason the id appears at all is that some unrelated field happens
    to carry the same number. Scanning would call that a leak.
    """
    body = {"pending": True, "position": int(SEEDED_ID)}

    assert evidence_reaches_object(WITNESSED_REFERENCE, body, SEEDED_ID) is False
    assert evidence_reaches_object(SCANNED_REFERENCE, body, SEEDED_ID) is True


def test_a_reference_with_no_witness_still_scans_for_the_id() -> None:
    """The witness is the exception; the scan stays the default for everything else."""
    body = {GADGET_FIELD: int(SEEDED_ID)}

    assert evidence_reaches_object(SCANNED_REFERENCE, body, SEEDED_ID) is True
    assert body_carries_id(body, SEEDED_ID) is True


def test_a_response_that_is_not_json_carries_no_evidence_rather_than_empty_evidence() -> None:
    """An intercepting proxy's HTML is not a route saying the object was not reached.

    Both would read as an empty body, and the difference decides the cell: with
    a healthy control beside it, "the object was not reached" is graded a pass,
    which would be a pass over a response nobody could read.
    """
    assert json_body(Response(HTTPStatus.OK, text="<html><body>blocked</body></html>")) is None
    assert json_body(Response(HTTPStatus.NO_CONTENT)) is None


def test_a_json_response_is_returned_as_the_evidence_it_is() -> None:
    """The ordinary case still comes back parsed, including a legitimately empty one."""
    assert json_body(Response(HTTPStatus.OK, json={"id": 31})) == {"id": 31}
    assert json_body(Response(HTTPStatus.OK, json=[])) == []


# --- The whole matrix, driven at a genuinely leaky application ---------------


@pytest_asyncio.fixture
async def reference_report(
    reference_deployment: StubDeployment,
    reference_client: AsyncClient,
) -> MatrixReport:
    """Run the full matrix once against the body/query reference stub."""
    return await run_matrix(
        reference_client,
        bootstrap=make_stub_bootstrap(reference_deployment),
        config=reference_stub_config(),
    )


@pytest.mark.asyncio
async def test_a_body_reference_to_another_users_object_is_reported_as_a_leak(
    reference_report: MatrixReport,
    reference_deployment: StubDeployment,
) -> None:
    """The intruder posts a note naming the owner's gadget and the harness names it a LEAK.

    The store assertion is the part that cannot be faked: the note is recorded
    against the intruder while the gadget it names still belongs to the owner,
    so the 201 was genuinely a write across an ownership boundary.
    """
    cells = reference_cells_for(reference_report, REFERENCE_LEAKY_NOTE_POST, GADGET_FIELD)
    leak = cells[Cell.CROSS_REFERENCE]
    store = reference_deployment.store

    assert leak.verdict is Verdict.LEAK
    assert leak.status == HTTPStatus.CREATED
    assert leak.object_was_reached is True
    gadget_id = int(leak.object_id)
    assert store.gadgets[gadget_id] == reference_deployment.owner.email
    crossed = [
        note
        for note in store.notes
        if note[GADGET_FIELD] == gadget_id and note["actor"] == reference_deployment.intruder.email
    ]
    assert crossed, f"no note by the intruder names gadget {gadget_id}: {store.notes}"


@pytest.mark.asyncio
async def test_the_leaky_body_reference_control_proves_the_route_echoes_at_all(
    reference_report: MatrixReport,
    reference_deployment: StubDeployment,
) -> None:
    """The control sends the caller's own id and must see it come back.

    Without that, the cross cell's evidence would be unfalsifiable and the LEAK
    above would be an artefact of the grader rather than of the application.
    """
    cells = reference_cells_for(reference_report, REFERENCE_LEAKY_NOTE_POST, GADGET_FIELD)
    control = cells[Cell.REFERENCE_CONTROL]

    assert control.status == HTTPStatus.CREATED
    assert control.object_was_reached is True
    assert control.verdict is Verdict.PASS
    assert (
        reference_deployment.store.gadgets[int(control.object_id)]
        == reference_deployment.intruder.email
    )


@pytest.mark.asyncio
async def test_a_silent_route_is_caught_by_reading_the_object_back_as_its_owner(
    reference_report: MatrixReport,
    reference_deployment: StubDeployment,
) -> None:
    """The 201 echoes nothing, so the evidence is what the owner can now see.

    This is the strategy that makes the dimension complete rather than merely
    convenient: a route whose response says nothing is exactly the route an
    attacker would prefer, and grading it on its own silence would pass it
    forever.
    """
    cells = reference_cells_for(reference_report, REFERENCE_LEAKY_ATTACHMENT_POST, GADGET_FIELD)
    leak = cells[Cell.CROSS_REFERENCE]
    store = reference_deployment.store

    assert leak.status == HTTPStatus.CREATED
    assert leak.object_was_reached is True
    assert leak.verdict is Verdict.LEAK
    gadget_id = int(leak.object_id)
    assert store.gadgets[gadget_id] == reference_deployment.owner.email
    assert store.attachments[gadget_id], "the intruder's attachment never reached the owner's row"


@pytest.mark.asyncio
async def test_a_route_that_names_no_id_at_all_is_caught_by_its_declared_witness(
    reference_report: MatrixReport,
    reference_deployment: StubDeployment,
) -> None:
    """The whole response is ``pending: false``, and that is enough to name a leak.

    There is no id here for a scan to find and no read surface to find one in,
    so before the witness this cell could only be graded on its status -- which
    is the grading this dimension exists to replace. The store assertion is the
    part that cannot be faked: the fold was recorded against the intruder while
    the gadget it names still belongs to the owner.
    """
    cells = reference_cells_for(reference_report, REFERENCE_LEAKY_FOLD_POST, GADGET_FIELD)
    leak = cells[Cell.CROSS_REFERENCE]
    store = reference_deployment.store

    assert leak.status == HTTPStatus.OK
    assert leak.object_was_reached is True
    assert leak.verdict is Verdict.LEAK
    gadget_id = int(leak.object_id)
    assert store.gadgets[gadget_id] == reference_deployment.owner.email
    crossed = [
        fold
        for fold in store.folds
        if fold[GADGET_FIELD] == gadget_id and fold["actor"] == reference_deployment.intruder.email
    ]
    assert crossed, f"no fold by the intruder names gadget {gadget_id}: {store.folds}"


@pytest.mark.asyncio
async def test_a_witnessed_route_that_declines_in_a_200_is_not_a_finding(
    reference_report: MatrixReport,
    reference_deployment: StubDeployment,
) -> None:
    """The crying-wolf trap, in the dimension where only a witness can spring it.

    ``POST /guardedfolds/`` answers 200 whichever gadget it is handed; what
    changes is whether it folded. Status-only grading calls that a leak, and the
    id scan cannot tell the two answers apart because neither carries an id. The
    witness reads the one field that does differ, and the paired control -- the
    same request with the caller's own gadget, which does fold -- is what makes
    the negative mean "it declined" instead of "we learned nothing".
    """
    cells = reference_cells_for(reference_report, REFERENCE_GUARDED_FOLD_POST, GADGET_FIELD)
    cross = cells[Cell.CROSS_REFERENCE]
    control = cells[Cell.REFERENCE_CONTROL]
    store = reference_deployment.store

    assert cross.status == HTTPStatus.OK
    assert cross.object_was_reached is False
    assert cross.verdict is Verdict.PASS
    assert control.status == HTTPStatus.OK
    assert control.object_was_reached is True
    assert control.verdict is Verdict.PASS
    assert not [fold for fold in store.folds if fold[GADGET_FIELD] == int(cross.object_id)], (
        "the guarded route folded the owner's gadget for the intruder"
    )


@pytest.mark.asyncio
async def test_the_correctly_guarded_body_reference_produces_no_finding(
    reference_report: MatrixReport,
) -> None:
    """A route that 403s a foreign gadget passes both cells -- no crying wolf."""
    cells = reference_cells_for(reference_report, REFERENCE_GUARDED_NOTE_POST, GADGET_FIELD)

    assert cells[Cell.CROSS_REFERENCE].status == HTTPStatus.FORBIDDEN
    assert cells[Cell.CROSS_REFERENCE].verdict is Verdict.PASS
    assert cells[Cell.REFERENCE_CONTROL].status == HTTPStatus.CREATED
    assert cells[Cell.REFERENCE_CONTROL].object_was_reached is True
    assert cells[Cell.REFERENCE_CONTROL].verdict is Verdict.PASS


@pytest.mark.asyncio
async def test_a_filtered_listing_that_returns_an_empty_page_is_not_a_finding(
    reference_report: MatrixReport,
) -> None:
    """The trap this whole design exists to avoid, exercised end to end.

    The listing scopes to the caller first and applies the id filter second, so
    a foreign id is answered 200 with an empty list rather than a denial. Only
    the control -- the same request with the caller's own id, which does surface
    that id -- makes the empty answer mean "you saw nothing" instead of "we
    learned nothing".
    """
    cells = reference_cells_for(reference_report, REFERENCE_GADGET_LISTING_GET, GADGET_FIELD)
    cross = cells[Cell.CROSS_REFERENCE]
    control = cells[Cell.REFERENCE_CONTROL]

    assert cross.status == HTTPStatus.OK
    assert cross.object_was_reached is False
    assert cross.verdict is Verdict.PASS
    assert control.status == HTTPStatus.OK
    assert control.object_was_reached is True
    assert control.verdict is Verdict.PASS


@pytest.mark.asyncio
async def test_the_only_reference_findings_are_the_planted_leaks(
    reference_report: MatrixReport,
) -> None:
    """Exactly three cells fail, and they are the three the stub was built to leak."""
    reported = {
        (finding.route.method, finding.route.path, finding.reference.field, finding.verdict)
        for finding in reference_report.reference_findings
    }

    assert reported == {
        (*REFERENCE_LEAKY_NOTE_POST, GADGET_FIELD, Verdict.LEAK),
        (*REFERENCE_LEAKY_ATTACHMENT_POST, GADGET_FIELD, Verdict.LEAK),
        (*REFERENCE_LEAKY_FOLD_POST, GADGET_FIELD, Verdict.LEAK),
    }
    assert len(reference_report.reference_findings) == EXPECTED_REFERENCE_FINDINGS


@pytest.mark.asyncio
async def test_every_reference_is_probed_with_its_control_after_the_cross_request(
    reference_report: MatrixReport,
) -> None:
    """Cell order is part of the contract here too: the cross request runs first."""
    for route in (
        REFERENCE_LEAKY_NOTE_POST,
        REFERENCE_GUARDED_NOTE_POST,
        REFERENCE_LEAKY_ATTACHMENT_POST,
        REFERENCE_LEAKY_FOLD_POST,
        REFERENCE_GUARDED_FOLD_POST,
        REFERENCE_GADGET_LISTING_GET,
    ):
        method, path = route
        ordering = [
            result.cell
            for result in reference_report.reference_results
            if result.route.method == method and result.route.path == path
        ]
        assert tuple(ordering) == REFERENCE_CELL_ORDER, f"{method} {path} ran cells in {ordering}"


@pytest.mark.asyncio
async def test_the_cross_cell_and_its_control_address_different_owners_objects(
    reference_report: MatrixReport,
    reference_deployment: StubDeployment,
) -> None:
    """The foreign object belongs to A and the control's to B, or neither cell means anything.

    Seeding both as the same identity would make the "cross" request a call
    against the caller's own row, which every correct application answers 2xx --
    and which would then grade as a leak.
    """
    cells = reference_cells_for(reference_report, REFERENCE_LEAKY_NOTE_POST, GADGET_FIELD)
    store = reference_deployment.store
    foreign = int(cells[Cell.CROSS_REFERENCE].object_id)
    own = int(cells[Cell.REFERENCE_CONTROL].object_id)

    assert foreign != own
    assert store.gadgets[foreign] == reference_deployment.owner.email
    assert store.gadgets[own] == reference_deployment.intruder.email


@pytest.mark.asyncio
async def test_the_reference_run_is_graded_as_a_finding_with_no_guard_tripped(
    reference_report: MatrixReport,
) -> None:
    """Every reference was covered, so the exit code is a finding, not a harness error."""
    assert reference_report.guard_failures == ()
    assert len(reference_report.reference_results) == REFERENCE_STUB_REFERENCES * len(
        REFERENCE_CELL_ORDER,
    )
    assert reference_report.exit_code == EXIT_AUTHZ_FINDING


@pytest.mark.asyncio
async def test_a_server_that_401s_everything_never_reports_a_clean_reference_sweep(
    blind_deployment: StubDeployment,
    blind_client: AsyncClient,
) -> None:
    """The blind stub cannot probe a single reference, so it must not pass this dimension."""
    report = await run_matrix(
        blind_client,
        bootstrap=make_stub_bootstrap(blind_deployment),
        config=stub_config(
            min_routes=BLIND_STUB_MIN_ROUTES,
            min_references=BLIND_STUB_MIN_REFERENCES,
        ),
    )

    tripped = {failure.guard for failure in report.guard_failures}

    assert report.exit_code == EXIT_HARNESS_ERROR
    assert "require_minimum_reference_coverage" in tripped, f"guards tripped: {sorted(tripped)}"


def test_the_cli_exits_one_and_names_the_leaky_reference_route(
    reference_deployment: StubDeployment,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """End to end, a body-carried leak reaches the operator as an actionable line."""
    exit_code = drive_reference_main(reference_deployment)

    captured = capsys.readouterr()
    assert exit_code == EXIT_AUTHZ_FINDING, f"stdout={captured.out!r} stderr={captured.err!r}"
    assert captured.out == "", f"a failing run must not report on stdout: {captured.out!r}"
    assert "/notes/" in captured.err, captured.err
    assert "/attachments/" in captured.err, captured.err
    assert "/folds/" in captured.err, captured.err
    assert "/guardednotes/" not in captured.err, captured.err
    assert "/guardedfolds/" not in captured.err, captured.err
