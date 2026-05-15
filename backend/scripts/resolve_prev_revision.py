"""Resolve the previous Alembic revision for a (possibly merged) head.

``alembic downgrade -1`` is ambiguous when the head is a merge migration
(``down_revision`` is a tuple of two prior heads). This script resolves the
chosen parent explicitly so the ``migration-drift`` CI job can exercise
each branch of the merge, not just the default first parent.

Usage:

    python -m scripts.resolve_prev_revision <alembic.ini>          # first parent
    python -m scripts.resolve_prev_revision <alembic.ini> --branch 1  # second parent

Prints the resolved revision identifier (or ``-1`` for a transient
multi-head state) to stdout so a shell can capture it via ``$(...)``.

Exit codes:
    0 — resolved a revision (or fell back to ``-1`` for an empty / multi-head graph).
    2 — requested ``--branch`` index does not exist (e.g. branch 1 on a linear
        head). The CI workflow treats this as "expected skip — no branch here"
        and distinguishes it from any other non-zero exit which signals an
        unexpected script failure.
    1 — argparse usage error (set by argparse).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError


def resolve_prev_revision(alembic_ini: Path, *, branch: int = 0) -> str:
    """Return the revision identifier to feed to ``alembic downgrade``.

    Args:
        alembic_ini: Path to the project's ``alembic.ini``.
        branch: Index into the ``down_revision`` tuple when the head is a
            merge migration. Defaults to 0 (first parent) for backward
            compatibility with the inline CI heredoc this script replaced.

    Returns:
        The chosen parent revision, or the literal string ``"-1"`` when the
        graph is in a transient state with no single head (in which case the
        caller should fall back to alembic's own ``-1`` resolution).

    Raises:
        IndexError: ``branch`` is out of range for the merge head's parents.
    """
    script_dir = ScriptDirectory.from_config(Config(str(alembic_ini)))
    try:
        head = script_dir.get_current_head()
    except CommandError:
        # Multiple unmerged heads — alembic refuses to pick one. Defer to its
        # own ``-1`` resolution so the CI step's error surfaces, not ours.
        return "-1"
    if head is None:
        # Empty script directory; nothing to resolve.
        return "-1"

    revision = script_dir.get_revision(head)
    parent = revision.down_revision
    if parent is None:
        # Root revision — there is no previous to downgrade to.
        return "-1"
    if isinstance(parent, list | tuple):
        if branch >= len(parent):
            raise IndexError(
                f"branch index {branch} is out of range for merge head with "
                f"{len(parent)} parents: {parent!r}"
            )
        return parent[branch]
    if branch > 0:
        # Linear head (single string parent) but caller asked for branch N>0.
        # CI uses this signal to "expected-skip" branch-1 round-trips when the
        # current head isn't a merge migration.
        raise IndexError(
            f"branch index {branch} requested but head has a single linear parent: {parent!r}"
        )
    return parent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "alembic_ini",
        type=Path,
        help="Path to alembic.ini (e.g. ./alembic.ini)",
    )
    parser.add_argument(
        "--branch",
        type=int,
        default=0,
        help=(
            "Which parent to follow when the head is a merge migration. "
            "Defaults to 0 (first parent)."
        ),
    )
    args = parser.parse_args(argv)
    try:
        revision = resolve_prev_revision(args.alembic_ini, branch=args.branch)
    except IndexError as exc:
        # "Expected skip" path — exit 2 so CI can tell this apart from an
        # unexpected failure (which would exit non-zero with stderr noise
        # the workflow has no business silently swallowing).
        sys.stderr.write(f"{exc}\n")
        return 2
    sys.stdout.write(revision + "\n")
    return 0


if __name__ == "__main__":  # pragma: no cover — exercised via tests/CLI
    sys.exit(main())
