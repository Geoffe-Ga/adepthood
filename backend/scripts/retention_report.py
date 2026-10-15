"""Print the retention registry and the owner's ratification worklist (#3063).

The report is generated on demand rather than committed, so it never reads as a
published retention schedule -- publishing one is the owner's decision
(#3063 AC16). It lists every table's lifetime, flags the rules nobody has
ratified with the lifetime proposed for each, and lists the non-database
stores with their deadlines and their ratified periods (or proposals). The
owner ratified every open lifetime on 2026-10-13; the decision record is
``docs/privacy/retention-proposal.md``. Each bounded period names the
scheduled sweep that applies it, and one that nothing applies is flagged.

Usage, from ``backend/``::

    PYTHONPATH=src python -m scripts.retention_report

Exit codes:
    0 -- the registry and the store inventory are complete; report printed.
    1 -- the registry has a gap, a conflict with the deletion policy, or an
         unratified rule without a proposal, or the store inventory has a
         finding. The findings go to stderr.
"""

from __future__ import annotations

import importlib
import sys
from collections.abc import Sequence

from sqlmodel import SQLModel

from domain.retention import (
    proposal_findings,
    retention_conflicts,
    retention_gaps,
    retention_report,
    unratified_rules,
)
from domain.retention_stores import (
    STORES,
    Days,
    Deadline,
    Hours,
    ProposedDeadline,
    Store,
    inventory_findings,
)

_FAILURE = 1


def _deadline(deadline: Deadline) -> str:
    """Render one store's deadline for the report."""
    if isinstance(deadline, Days):
        return f"{deadline.count} days"
    if isinstance(deadline, Hours):
        return f"{deadline.count} hours"
    return f"unknown -- {deadline.open_question}"


def _period(deadline: ProposedDeadline) -> str:
    """Render one store's ratified or proposed period for the report."""
    if deadline is None:
        return "no fixed period"
    return _deadline(deadline)


def _store_line(store: Store) -> str:
    """One store, its deadline today, and its ratified or proposed period."""
    line = f"  {store.key} [{store.controller.value}]: {_deadline(store.deadline)}"
    if store.ratified is not None:
        line += f" -- ratified: {_period(store.ratified.deadline)}"
    if store.proposal is not None:
        line += (
            f" -- proposed: {_period(store.proposal.deadline)}"
            f" [{store.proposal.compared_to_today.value} than today]"
        )
    return line


def main(argv: Sequence[str] | None = None) -> int:
    """Print the report; return non-zero when the registry is incomplete."""
    del argv  # no options today; accepted so the CLI shape can grow
    # Registers every table on the metadata; a bare ``import models`` would be
    # an unused name.
    importlib.import_module("models")
    findings = (
        *retention_gaps(SQLModel.metadata),
        *retention_conflicts(),
        *proposal_findings(),
        *inventory_findings(),
    )
    if findings:
        for finding in findings:
            sys.stderr.write(f"{finding}\n")
        return _FAILURE
    sys.stdout.write(f"Retention registry ({len(SQLModel.metadata.tables)} tables)\n")
    sys.stdout.write(retention_report() + "\n")
    sys.stdout.write("\n")
    sys.stdout.write("Unratified (owner decision required, #3063 AC15):\n")
    proposed = {line.split(":", 1)[0]: line for line in retention_report().splitlines()}
    unratified = unratified_rules()
    for name in unratified:
        proposal = proposed[name].split(" -- proposed: ", 1)[1]
        sys.stdout.write(f"  {name} -- proposed: {proposal}\n")
    if not unratified:
        sys.stdout.write("  none\n")
    sys.stdout.write("\n")
    sys.stdout.write("Stores outside the database:\n")
    for store in STORES:
        sys.stdout.write(_store_line(store) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
