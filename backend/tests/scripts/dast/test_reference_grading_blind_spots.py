"""What the reference grading cannot see, pinned so it is a known gap and not a surprise.

Grading a cross-user 2xx on the absence of the foreign id rests on one
assumption nobody had written down: **the response's rendering of the reference
is identity-independent** -- a persisted foreign id renders the way the caller's
own id would. The paired control cannot establish that. It proves only that the
route surfaces an id it *owns*, which is a different claim.

Two applications break the assumption while every cell looks healthy, and both
are driven here against the real matrix:

* the serializer resolves the reference through an owner-scoped lookup, so a
  foreign key that was written verbatim renders ``null`` -- indistinguishable
  from a reference that was never accepted;
* the ``READ_BACK`` surface is scoped to whoever created the row rather than to
  the object, so the owner cannot see a write somebody else made on their own
  object, while the control -- reading back its own write on its own object --
  sees it every time.

Both cells come back ``PASS`` today, the run exits clean, and the store proves
the row crossed the boundary anyway. The tests below assert exactly that. They
are not endorsements: closing the gap needs a third probe establishing that the
route surfaces a foreign id when it has one, which is a redesign of the cell
pair rather than a change to the grader. Until that lands these tests are the
executable record of the gap, and the day it lands they must fail and be
rewritten as findings.

The last two tests are the neighbouring case that *is* closed. A read-back that
answers 5xx on the cross cell while the control's stays healthy leaves the cross
request with no observation at all, and grading that absence as "the object was
not reached" was fail-open. It is now reported as unreadable evidence and graded
inconclusive.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
import pytest_asyncio
from httpx import AsyncClient

from scripts.dast.report import EXIT_AUTHZ_FINDING, EXIT_CLEAN, MatrixReport
from scripts.dast.runner import run_matrix
from scripts.dast.verdict import Cell, Verdict
from tests.scripts.dast.conftest import (
    MASKED_NOTE_POST,
    SCREENED_ATTACHMENT_POST,
    UNREADABLE_ATTACHMENT_POST,
    StubDeployment,
    make_stub_bootstrap,
    masked_stub_config,
    reference_cells_for,
    unreadable_stub_config,
)

GADGET_FIELD = "gadget_id"


@pytest_asyncio.fixture
async def masked_report(
    masked_deployment: StubDeployment,
    masked_client: AsyncClient,
) -> MatrixReport:
    """Run the full matrix once against the stub that masks what it persisted."""
    return await run_matrix(
        masked_client,
        bootstrap=make_stub_bootstrap(masked_deployment),
        config=masked_stub_config(),
    )


@pytest_asyncio.fixture
async def unreadable_report(
    unreadable_deployment: StubDeployment,
    unreadable_client: AsyncClient,
) -> MatrixReport:
    """Run the full matrix once against the stub whose read-back fails where it matters."""
    return await run_matrix(
        unreadable_client,
        bootstrap=make_stub_bootstrap(unreadable_deployment),
        config=unreadable_stub_config(),
    )


@pytest.mark.asyncio
async def test_a_persisted_reference_the_serializer_nulls_is_graded_as_a_pass(
    masked_report: MatrixReport,
    masked_deployment: StubDeployment,
) -> None:
    """The row keeps the foreign key, the response renders ``null``, and the cell passes.

    The store assertion is the part that cannot be argued with: the note is
    recorded against the intruder and names a gadget that still belongs to the
    owner. The harness has no way to see it, because the only response it is
    shown renders that persisted key exactly as it renders none.
    """
    cells = reference_cells_for(masked_report, MASKED_NOTE_POST, GADGET_FIELD)
    cross = cells[Cell.CROSS_REFERENCE]
    control = cells[Cell.REFERENCE_CONTROL]
    store = masked_deployment.store

    assert cross.status == HTTPStatus.CREATED
    assert cross.object_was_reached is False
    assert cross.evidence_unavailable is False
    assert cross.verdict is Verdict.PASS
    assert control.object_was_reached is True, "the control is what licenses that pass"

    gadget_id = int(cross.object_id)
    assert store.gadgets[gadget_id] == masked_deployment.owner.email
    crossed = [
        note
        for note in store.notes
        if note[GADGET_FIELD] == gadget_id and note["actor"] == masked_deployment.intruder.email
    ]
    assert crossed, f"no note by the intruder names gadget {gadget_id}: {store.notes}"


@pytest.mark.asyncio
async def test_a_write_its_owner_cannot_see_in_the_read_back_is_graded_as_a_pass(
    masked_report: MatrixReport,
    masked_deployment: StubDeployment,
) -> None:
    """A creator-scoped read surface hides the cross write and shows the control's.

    This is why a ``read_back_path`` carries an obligation the registry states
    rather than a convenience: the follow-up has to be a surface on which the
    object's owner sees writes made by anyone, or the strategy grades the one
    cell it exists to grade on an absence it manufactured itself.
    """
    cells = reference_cells_for(masked_report, SCREENED_ATTACHMENT_POST, GADGET_FIELD)
    cross = cells[Cell.CROSS_REFERENCE]
    control = cells[Cell.REFERENCE_CONTROL]
    store = masked_deployment.store

    assert cross.status == HTTPStatus.CREATED
    assert cross.object_was_reached is False
    assert cross.evidence_unavailable is False
    assert cross.verdict is Verdict.PASS
    assert control.object_was_reached is True, "the control read its own write back happily"

    gadget_id = int(cross.object_id)
    assert store.gadgets[gadget_id] == masked_deployment.owner.email
    landed = store.attachments.get(gadget_id, [])
    assert landed, "the intruder's attachment never reached the owner's row"
    assert all(
        store.attachment_authors[attachment] == masked_deployment.intruder.email
        for attachment in landed
    )


@pytest.mark.asyncio
async def test_the_masking_run_reports_clean_which_is_the_gap_these_tests_pin(
    masked_report: MatrixReport,
) -> None:
    """Two cross-tenant writes landed and the run exits zero with no guard tripped.

    Naming the outcome is the point. A green from this harness means "no
    reference leak was *observable* in the responses these routes give", not
    "no reference leak happened", and the scope note the report prints says so.
    """
    assert masked_report.reference_findings == ()
    assert masked_report.guard_failures == ()
    assert masked_report.exit_code == EXIT_CLEAN


@pytest.mark.asyncio
async def test_a_read_back_that_failed_is_inconclusive_rather_than_a_pass(
    unreadable_report: MatrixReport,
    unreadable_deployment: StubDeployment,
) -> None:
    """No evidence is not the same answer as evidence of nothing.

    The owner's read-back 5xxs on exactly the gadget the intruder wrote to, so
    the cross cell has nothing to grade. Reading that as "the object was not
    reached" let a healthy control license a pass over a request nobody ever
    looked at.
    """
    cells = reference_cells_for(unreadable_report, UNREADABLE_ATTACHMENT_POST, GADGET_FIELD)
    cross = cells[Cell.CROSS_REFERENCE]
    store = unreadable_deployment.store

    assert cross.status == HTTPStatus.CREATED
    assert cross.evidence_unavailable is True
    assert cross.object_was_reached is False
    assert cross.verdict is Verdict.INCONCLUSIVE

    gadget_id = int(cross.object_id)
    assert store.gadgets[gadget_id] == unreadable_deployment.owner.email
    assert store.attachments.get(gadget_id), "the intruder's write never reached the owner's row"


@pytest.mark.asyncio
async def test_the_control_beside_the_failed_read_back_stayed_healthy(
    unreadable_report: MatrixReport,
) -> None:
    """The control is fine, which is precisely what made the old grading fail open.

    A guard on the controls cannot catch this: the control reads its own write
    back on its own object and never meets the row that breaks the surface.
    """
    cells = reference_cells_for(unreadable_report, UNREADABLE_ATTACHMENT_POST, GADGET_FIELD)
    control = cells[Cell.REFERENCE_CONTROL]

    assert control.status == HTTPStatus.CREATED
    assert control.evidence_unavailable is False
    assert control.object_was_reached is True
    assert control.verdict is Verdict.PASS


@pytest.mark.asyncio
async def test_the_unreadable_run_is_a_finding_rather_than_a_clean_sweep(
    unreadable_report: MatrixReport,
) -> None:
    """The run has to end somewhere other than zero, or the grading changed nothing."""
    assert unreadable_report.guard_failures == ()
    assert unreadable_report.exit_code == EXIT_AUTHZ_FINDING
