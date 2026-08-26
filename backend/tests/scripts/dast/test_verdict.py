"""The oracle: every (cell, status) pair has one named verdict, and none of them is a shrug.

The temptation in a check like this is a two-way split — denied or not — which
collapses "the app correctly refused" together with "the request never reached
the ownership check". The distinctions below are the difference between a gate
that means something and one that reports clean when the credentials expired.

Four of them carry the weight:

* ``401`` on the cross-user cell is ``AUTH_BROKEN``, not a pass. The intruder's
  token is supposed to be valid; if it is not, the run learned nothing about
  authorization and only looked like it did.
* ``5xx`` is ``SERVER_ERROR``, not a denial. A handler that blew up mid-request
  reached the row before it checked who was asking.
* ``429`` is ``THROTTLED``, never a pass, because the rate limiter can turn an
  entire matrix into uniform "denials".
* Anything the table does not recognise — ``410``, ``422`` — is ``INCONCLUSIVE``.
  A status nobody thought about must never default to "fine".

The whole table is written out rather than derived, because a derivation would
share its bug with the implementation it is checking.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest

from scripts.dast.verdict import (
    CELL_ORDER,
    REFERENCE_CELL_ORDER,
    Cell,
    Verdict,
    judge,
    judge_reference,
)

EXPECTED_VERDICTS = {
    Verdict.PASS,
    Verdict.LEAK,
    Verdict.SERVER_ERROR,
    Verdict.AUTH_BROKEN,
    Verdict.THROTTLED,
    Verdict.INCONCLUSIVE,
}

ORACLE: list[tuple[Cell, int, Verdict]] = [
    # The intruder's token against the owner's object: 403 and 404 are the two
    # acceptable denials this codebase emits; everything else is a finding.
    (Cell.CROSS_USER, HTTPStatus.OK, Verdict.LEAK),
    (Cell.CROSS_USER, HTTPStatus.CREATED, Verdict.LEAK),
    (Cell.CROSS_USER, HTTPStatus.NO_CONTENT, Verdict.LEAK),
    (Cell.CROSS_USER, HTTPStatus.UNAUTHORIZED, Verdict.AUTH_BROKEN),
    (Cell.CROSS_USER, HTTPStatus.FORBIDDEN, Verdict.PASS),
    (Cell.CROSS_USER, HTTPStatus.NOT_FOUND, Verdict.PASS),
    (Cell.CROSS_USER, HTTPStatus.GONE, Verdict.INCONCLUSIVE),
    (Cell.CROSS_USER, HTTPStatus.UNPROCESSABLE_ENTITY, Verdict.INCONCLUSIVE),
    (Cell.CROSS_USER, HTTPStatus.TOO_MANY_REQUESTS, Verdict.THROTTLED),
    (Cell.CROSS_USER, HTTPStatus.INTERNAL_SERVER_ERROR, Verdict.SERVER_ERROR),
    (Cell.CROSS_USER, HTTPStatus.SERVICE_UNAVAILABLE, Verdict.SERVER_ERROR),
    # No token at all: the auth layer must reject before authorization matters.
    (Cell.UNAUTH, HTTPStatus.OK, Verdict.LEAK),
    (Cell.UNAUTH, HTTPStatus.CREATED, Verdict.LEAK),
    (Cell.UNAUTH, HTTPStatus.NO_CONTENT, Verdict.LEAK),
    (Cell.UNAUTH, HTTPStatus.UNAUTHORIZED, Verdict.PASS),
    (Cell.UNAUTH, HTTPStatus.FORBIDDEN, Verdict.INCONCLUSIVE),
    (Cell.UNAUTH, HTTPStatus.NOT_FOUND, Verdict.INCONCLUSIVE),
    (Cell.UNAUTH, HTTPStatus.GONE, Verdict.INCONCLUSIVE),
    (Cell.UNAUTH, HTTPStatus.UNPROCESSABLE_ENTITY, Verdict.INCONCLUSIVE),
    (Cell.UNAUTH, HTTPStatus.TOO_MANY_REQUESTS, Verdict.THROTTLED),
    (Cell.UNAUTH, HTTPStatus.INTERNAL_SERVER_ERROR, Verdict.SERVER_ERROR),
    (Cell.UNAUTH, HTTPStatus.SERVICE_UNAVAILABLE, Verdict.SERVER_ERROR),
    # A well-formed JWT signed with the wrong key: identical expectations.
    (Cell.FORGED_JWT, HTTPStatus.OK, Verdict.LEAK),
    (Cell.FORGED_JWT, HTTPStatus.CREATED, Verdict.LEAK),
    (Cell.FORGED_JWT, HTTPStatus.NO_CONTENT, Verdict.LEAK),
    (Cell.FORGED_JWT, HTTPStatus.UNAUTHORIZED, Verdict.PASS),
    (Cell.FORGED_JWT, HTTPStatus.FORBIDDEN, Verdict.INCONCLUSIVE),
    (Cell.FORGED_JWT, HTTPStatus.NOT_FOUND, Verdict.INCONCLUSIVE),
    (Cell.FORGED_JWT, HTTPStatus.GONE, Verdict.INCONCLUSIVE),
    (Cell.FORGED_JWT, HTTPStatus.UNPROCESSABLE_ENTITY, Verdict.INCONCLUSIVE),
    (Cell.FORGED_JWT, HTTPStatus.TOO_MANY_REQUESTS, Verdict.THROTTLED),
    (Cell.FORGED_JWT, HTTPStatus.INTERNAL_SERVER_ERROR, Verdict.SERVER_ERROR),
    (Cell.FORGED_JWT, HTTPStatus.SERVICE_UNAVAILABLE, Verdict.SERVER_ERROR),
    # The owner against their own object. Only 2xx proves the probe was capable
    # of succeeding, so every other status is inconclusive by construction --
    # including the 422 a mutating replay with an invalid body would return.
    (Cell.POSITIVE_CONTROL, HTTPStatus.OK, Verdict.PASS),
    (Cell.POSITIVE_CONTROL, HTTPStatus.CREATED, Verdict.PASS),
    (Cell.POSITIVE_CONTROL, HTTPStatus.NO_CONTENT, Verdict.PASS),
    (Cell.POSITIVE_CONTROL, HTTPStatus.UNAUTHORIZED, Verdict.INCONCLUSIVE),
    (Cell.POSITIVE_CONTROL, HTTPStatus.FORBIDDEN, Verdict.INCONCLUSIVE),
    (Cell.POSITIVE_CONTROL, HTTPStatus.NOT_FOUND, Verdict.INCONCLUSIVE),
    (Cell.POSITIVE_CONTROL, HTTPStatus.GONE, Verdict.INCONCLUSIVE),
    (Cell.POSITIVE_CONTROL, HTTPStatus.UNPROCESSABLE_ENTITY, Verdict.INCONCLUSIVE),
    (Cell.POSITIVE_CONTROL, HTTPStatus.TOO_MANY_REQUESTS, Verdict.INCONCLUSIVE),
    (Cell.POSITIVE_CONTROL, HTTPStatus.INTERNAL_SERVER_ERROR, Verdict.INCONCLUSIVE),
    (Cell.POSITIVE_CONTROL, HTTPStatus.SERVICE_UNAVAILABLE, Verdict.INCONCLUSIVE),
]


@pytest.mark.parametrize(("cell", "status", "expected"), ORACLE)
def test_the_oracle_maps_each_cell_and_status_to_one_verdict(
    cell: Cell,
    status: int,
    expected: Verdict,
) -> None:
    """Grading is a total function of the cell and the observed status."""
    assert judge(cell, status) is expected


def test_the_verdict_vocabulary_is_exactly_the_documented_set() -> None:
    """Each verdict names a distinct cause; adding one is a decision made here."""
    assert set(Verdict) == EXPECTED_VERDICTS


def test_the_cells_run_with_the_positive_control_last() -> None:
    """The owner's own call must run after the probes that might destroy its object.

    Running it first against a shared object would let a destructive cross-user
    cell inherit a live row and then read the resulting 404 as a clean denial.
    """
    assert CELL_ORDER == (
        Cell.CROSS_USER,
        Cell.UNAUTH,
        Cell.FORGED_JWT,
        Cell.POSITIVE_CONTROL,
    )


def test_every_cell_is_covered_by_the_oracle_table() -> None:
    """A new cell without an oracle row would grade as whatever the fallback is."""
    assert {cell for cell, _, _ in ORACLE} == set(CELL_ORDER)


def test_no_cell_treats_a_two_hundred_on_a_foreign_object_as_acceptable() -> None:
    """The single sentence the whole check exists to enforce, asserted directly."""
    for cell in (Cell.CROSS_USER, Cell.UNAUTH, Cell.FORGED_JWT):
        assert judge(cell, HTTPStatus.OK) is Verdict.LEAK


# --- Grading a reference probe on evidence rather than on status -------------
#
# A path probe can be graded on its status alone: reaching ``/journal/14`` at
# all is the leak. A reference probe cannot. ``GET /journal/?practice_session_id=``
# applies its filter *after* scoping to the caller, so a foreign id there is
# answered 200 with an empty page -- a correct route that status-only grading
# would call a LEAK.
#
# So the question asked of a 2xx is "did the foreign object appear in the
# evidence?", and every ambiguous answer grades toward RED. A 2xx with the
# foreign id in the evidence is the leak. A 2xx without it proves nothing on its
# own and is INCONCLUSIVE, until the paired control has demonstrated that this
# same request, pointed at the caller's own object, does surface it.

NO_CONTROL = False
CONTROL_PROVED = True
WITH_EVIDENCE = True
WITHOUT_EVIDENCE = False
EVIDENCE_READABLE = False
EVIDENCE_UNREADABLE = True

REFERENCE_ORACLE: list[tuple[Cell, int, bool, Verdict]] = [
    # The intruder's own call carrying somebody else's id.
    (Cell.CROSS_REFERENCE, HTTPStatus.OK, WITH_EVIDENCE, Verdict.LEAK),
    (Cell.CROSS_REFERENCE, HTTPStatus.CREATED, WITH_EVIDENCE, Verdict.LEAK),
    (Cell.CROSS_REFERENCE, HTTPStatus.OK, WITHOUT_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.CROSS_REFERENCE, HTTPStatus.CREATED, WITHOUT_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.CROSS_REFERENCE, HTTPStatus.NO_CONTENT, WITHOUT_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.CROSS_REFERENCE, HTTPStatus.UNAUTHORIZED, WITHOUT_EVIDENCE, Verdict.AUTH_BROKEN),
    (Cell.CROSS_REFERENCE, HTTPStatus.FORBIDDEN, WITHOUT_EVIDENCE, Verdict.PASS),
    (Cell.CROSS_REFERENCE, HTTPStatus.NOT_FOUND, WITHOUT_EVIDENCE, Verdict.PASS),
    (Cell.CROSS_REFERENCE, HTTPStatus.GONE, WITHOUT_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.CROSS_REFERENCE, HTTPStatus.UNPROCESSABLE_ENTITY, WITHOUT_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.CROSS_REFERENCE, HTTPStatus.TOO_MANY_REQUESTS, WITHOUT_EVIDENCE, Verdict.THROTTLED),
    (
        Cell.CROSS_REFERENCE,
        HTTPStatus.INTERNAL_SERVER_ERROR,
        WITHOUT_EVIDENCE,
        Verdict.SERVER_ERROR,
    ),
    (Cell.CROSS_REFERENCE, HTTPStatus.SERVICE_UNAVAILABLE, WITHOUT_EVIDENCE, Verdict.SERVER_ERROR),
    # The same request with the caller's own id. It is asked two questions, and
    # a control that succeeds without surfacing its own id has proven that the
    # absence of an id means nothing -- so it cannot pass.
    (Cell.REFERENCE_CONTROL, HTTPStatus.OK, WITH_EVIDENCE, Verdict.PASS),
    (Cell.REFERENCE_CONTROL, HTTPStatus.CREATED, WITH_EVIDENCE, Verdict.PASS),
    (Cell.REFERENCE_CONTROL, HTTPStatus.OK, WITHOUT_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.REFERENCE_CONTROL, HTTPStatus.NO_CONTENT, WITHOUT_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.REFERENCE_CONTROL, HTTPStatus.UNAUTHORIZED, WITH_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.REFERENCE_CONTROL, HTTPStatus.FORBIDDEN, WITH_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.REFERENCE_CONTROL, HTTPStatus.NOT_FOUND, WITH_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.REFERENCE_CONTROL, HTTPStatus.UNPROCESSABLE_ENTITY, WITH_EVIDENCE, Verdict.INCONCLUSIVE),
    (Cell.REFERENCE_CONTROL, HTTPStatus.TOO_MANY_REQUESTS, WITH_EVIDENCE, Verdict.THROTTLED),
    (
        Cell.REFERENCE_CONTROL,
        HTTPStatus.INTERNAL_SERVER_ERROR,
        WITH_EVIDENCE,
        Verdict.SERVER_ERROR,
    ),
]


@pytest.mark.parametrize(("cell", "status", "evidence", "expected"), REFERENCE_ORACLE)
def test_the_reference_oracle_grades_each_cell_status_and_evidence_pair(
    cell: Cell,
    status: int,
    evidence: bool,
    expected: Verdict,
) -> None:
    """With no control to lean on, grading is a total function of status and evidence."""
    assert (
        judge_reference(
            cell,
            status,
            object_was_reached=evidence,
            control_proved_mechanism=NO_CONTROL,
        )
        is expected
    )


def test_a_filtered_listing_that_returns_nothing_passes_once_its_control_proved_the_filter() -> (
    None
):
    """The empty-page case: a correct route answers 200 with none of the foreign rows.

    Calling that a leak would make the gate cry wolf on the most common correct
    shape in the application; calling it a pass without the control would let a
    route that ignores the filter entirely pass for the same reason.
    """
    assert (
        judge_reference(
            Cell.CROSS_REFERENCE,
            HTTPStatus.OK,
            object_was_reached=WITHOUT_EVIDENCE,
            control_proved_mechanism=CONTROL_PROVED,
        )
        is Verdict.PASS
    )


def test_evidence_of_the_foreign_object_is_a_leak_even_with_a_working_control() -> None:
    """A control can excuse an absence; it can never explain away a presence."""
    assert (
        judge_reference(
            Cell.CROSS_REFERENCE,
            HTTPStatus.OK,
            object_was_reached=WITH_EVIDENCE,
            control_proved_mechanism=CONTROL_PROVED,
        )
        is Verdict.LEAK
    )


def test_a_denial_passes_whether_or_not_a_control_ran() -> None:
    """403 and 404 are answers in themselves; no evidence is needed to read them."""
    for status in (HTTPStatus.FORBIDDEN, HTTPStatus.NOT_FOUND):
        for control in (NO_CONTROL, CONTROL_PROVED):
            assert (
                judge_reference(
                    Cell.CROSS_REFERENCE,
                    status,
                    object_was_reached=WITHOUT_EVIDENCE,
                    control_proved_mechanism=control,
                )
                is Verdict.PASS
            )


def test_the_reference_cells_run_with_the_control_after_the_probe() -> None:
    """The cross request goes first, exactly as it does in the path matrix."""
    assert REFERENCE_CELL_ORDER == (Cell.CROSS_REFERENCE, Cell.REFERENCE_CONTROL)


def test_the_reference_cells_do_not_join_the_path_matrix() -> None:
    """The path matrix is unchanged, so its cell order must not have grown.

    Folding the reference cells into ``CELL_ORDER`` would make every path route
    run two more probes it has no ids for.
    """
    assert CELL_ORDER == (
        Cell.CROSS_USER,
        Cell.UNAUTH,
        Cell.FORGED_JWT,
        Cell.POSITIVE_CONTROL,
    )
    assert set(CELL_ORDER).isdisjoint(REFERENCE_CELL_ORDER)


def test_every_reference_cell_is_covered_by_the_reference_oracle_table() -> None:
    """A new reference cell without an oracle row would grade as whatever the fallback is."""
    assert {cell for cell, _, _, _ in REFERENCE_ORACLE} == set(REFERENCE_CELL_ORDER)


def test_the_path_oracle_is_unchanged_by_the_reference_dimension() -> None:
    """``judge`` keeps grading the four path cells exactly as it did before."""
    assert judge(Cell.CROSS_USER, HTTPStatus.OK) is Verdict.LEAK
    assert judge(Cell.CROSS_USER, HTTPStatus.FORBIDDEN) is Verdict.PASS
    assert judge(Cell.POSITIVE_CONTROL, HTTPStatus.OK) is Verdict.PASS
    assert judge(Cell.UNAUTH, HTTPStatus.UNAUTHORIZED) is Verdict.PASS


def test_evidence_nobody_could_read_is_inconclusive_even_behind_a_healthy_control() -> None:
    """A 2xx whose evidence could not be read is not the same as a 2xx that showed nothing.

    A body that is not JSON at all, or a read-back the target refused, leaves
    the cell with no observation to grade. Folding that into "the object was not
    reached" is fail-open: the control is healthy on its own request, so the
    cross cell would inherit its licence and pass while nothing was ever looked
    at.
    """
    assert (
        judge_reference(
            Cell.CROSS_REFERENCE,
            HTTPStatus.CREATED,
            object_was_reached=WITHOUT_EVIDENCE,
            evidence_unavailable=EVIDENCE_UNREADABLE,
            control_proved_mechanism=CONTROL_PROVED,
        )
        is Verdict.INCONCLUSIVE
    )


def test_unreadable_evidence_cannot_turn_a_denial_into_a_finding() -> None:
    """A refused request has no evidence to read, and its status is the whole answer."""
    for status in (HTTPStatus.FORBIDDEN, HTTPStatus.NOT_FOUND):
        assert (
            judge_reference(
                Cell.CROSS_REFERENCE,
                status,
                object_was_reached=WITHOUT_EVIDENCE,
                evidence_unavailable=EVIDENCE_UNREADABLE,
                control_proved_mechanism=CONTROL_PROVED,
            )
            is Verdict.PASS
        )


def test_readable_evidence_is_the_default_so_the_whole_oracle_still_holds() -> None:
    """Omitting the flag grades exactly as the oracle table above says it does.

    The default is the readable case rather than the unreadable one because
    every caller that has evidence to report passes it; only the runner knows
    when there was none, and it says so explicitly.
    """
    implied = judge_reference(
        Cell.CROSS_REFERENCE,
        HTTPStatus.OK,
        object_was_reached=WITHOUT_EVIDENCE,
        control_proved_mechanism=CONTROL_PROVED,
    )
    spelled_out = judge_reference(
        Cell.CROSS_REFERENCE,
        HTTPStatus.OK,
        object_was_reached=WITHOUT_EVIDENCE,
        evidence_unavailable=EVIDENCE_READABLE,
        control_proved_mechanism=CONTROL_PROVED,
    )

    assert implied is Verdict.PASS
    assert spelled_out is implied
