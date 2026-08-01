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

from scripts.dast.verdict import CELL_ORDER, Cell, Verdict, judge

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
