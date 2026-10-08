"""Print the retention registry and the owner's ratification worklist (#3063).

The report is generated on demand rather than committed, so it never reads as a
published retention schedule -- publishing one is the owner's decision
(#3063 AC16). It lists every table's lifetime, flags the rules nobody has
ratified, and lists the non-database stores with their deadlines.

Usage, from ``backend/``::

    PYTHONPATH=src python -m scripts.retention_report

Exit codes:
    0 -- the registry and the store inventory are complete; report printed.
    1 -- the registry has a gap or a conflict with the deletion policy, or the
         store inventory has a finding. The findings go to stderr.
"""

from __future__ import annotations

import importlib
import sys
from collections.abc import Sequence

from sqlmodel import SQLModel

from domain.retention import (
    retention_conflicts,
    retention_gaps,
    retention_report,
    unratified_rules,
)
from domain.retention_stores import STORES, Days, Deadline, Hours, inventory_findings

_FAILURE = 1


def _deadline(deadline: Deadline) -> str:
    """Render one store's deadline for the report."""
    if isinstance(deadline, Days):
        return f"{deadline.count} days"
    if isinstance(deadline, Hours):
        return f"{deadline.count} hours"
    return f"unknown -- {deadline.open_question}"


def main(argv: Sequence[str] | None = None) -> int:
    """Print the report; return non-zero when the registry is incomplete."""
    del argv  # no options today; accepted so the CLI shape can grow
    # Registers every table on the metadata; a bare ``import models`` would be
    # an unused name.
    importlib.import_module("models")
    findings = (
        *retention_gaps(SQLModel.metadata),
        *retention_conflicts(),
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
    for name in unratified_rules():
        sys.stdout.write(f"  {name}\n")
    sys.stdout.write("\n")
    sys.stdout.write("Stores outside the database:\n")
    for store in STORES:
        sys.stdout.write(f"  {store.key} [{store.controller.value}]: {_deadline(store.deadline)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
