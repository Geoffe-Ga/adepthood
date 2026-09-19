"""Shared domain constants with no further domain imports.

Split from :mod:`domain.stage_progress` so Pydantic schemas can pull the
curriculum length without triggering a ``schemas <-> domain`` import cycle.
"""

from __future__ import annotations

# Number of stages in the APTITUDE curriculum, matching the rows seeded by
# :mod:`seed_stages` (stages 1..10).  Router-level stage mutations clamp
# their inputs to this range and callers use it to detect the
# "everything is done" boundary.  Re-exported as ``TOTAL_STAGES`` from
# :mod:`domain.stage_progress` and used by :mod:`bounds` as the upper bound of
# every stage number the API accepts.  (Issue #386: the previous value, 36,
# conflated the 36-week calendar with the 10-stage curriculum.)
TOTAL_STAGES = 10

# Days each stage lasts, in stage order — eight 3-week stages followed by
# two 6-week integration stages.  CROSS-STACK CONTRACT (issue #386): this
# tuple mirrors ``STAGE_DURATIONS_DAYS`` in
# ``frontend/src/constants/program.ts`` literal-for-literal; both stacks
# pin it with tests, so a schedule change must touch both files together.
STAGE_DURATIONS_DAYS: tuple[int, ...] = (21, 21, 21, 21, 21, 21, 21, 21, 42, 42)

# 252 days — exactly the 36-week curriculum (sum of the stage durations).
TOTAL_PROGRAM_DAYS = sum(STAGE_DURATIONS_DAYS)

DAYS_PER_WEEK = 7

# Weeks each stage lasts, in stage order: (3, 3, 3, 3, 3, 3, 3, 3, 6, 6).
# Derived from the schedule above rather than written out again, because a
# second copy is what let a uniform three-weeks-per-stage tiling — and the
# two invented stages it needed to reach 36 weeks — survive review once.
# The stage count and the week count are different numbers on purpose: ten
# stages, thirty-six weeks.
WEEKS_PER_STAGE: tuple[int, ...] = tuple(
    duration // DAYS_PER_WEEK for duration in STAGE_DURATIONS_DAYS
)

# 36 — the program's length in weeks.
TOTAL_PROGRAM_WEEKS = sum(WEEKS_PER_STAGE)

# Three consecutive stages make one SECTION of the course — the Red, Green and
# Ultraviolet turns of the Archetypal Wavelength, each closing with a review of
# its own (issue #2866).  Grouping in threes is a curriculum design decision:
# it is NOT derivable from STAGE_DURATIONS_DAYS, which knows only how long each
# stage lasts.  CROSS-STACK CONTRACT: mirrored by ``STAGES_PER_SECTION`` in
# ``frontend/src/constants/program.ts``, where the section's colour name is
# derived from it, and pinned against this file by a frontend test.
STAGES_PER_SECTION = 3

# 3 — the number of sections.  The floor division is the point: ten stages do
# not divide by three, and that remainder is exactly WHY the tenth stage
# (Clear Light) stands outside every section and closes the whole course on its
# own.  A third named constant for "the leftover stage" would let the two drift.
SECTION_COUNT = TOTAL_STAGES // STAGES_PER_SECTION
