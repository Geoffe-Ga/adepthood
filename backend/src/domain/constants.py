"""Shared domain constants with no further domain imports.

Split from :mod:`domain.stage_progress` so Pydantic schemas can pull the
curriculum length without triggering a ``schemas <-> domain`` import cycle.
"""

from __future__ import annotations

# Number of stages in the APTITUDE curriculum, matching the rows seeded by
# :mod:`seed_stages` (stages 1..10).  Router-level stage mutations clamp
# their inputs to this range and callers use it to detect the
# "everything is done" boundary.  Re-exported as ``TOTAL_STAGES`` from
# :mod:`domain.stage_progress` and aliased as ``MAX_STAGE_NUMBER`` by the
# Pydantic schemas.  (Issue #386: the previous value, 36, conflated the
# 36-week calendar with the 10-stage curriculum.)
TOTAL_STAGES = 10

# Days each stage lasts, in stage order — eight 3-week stages followed by
# two 6-week integration stages.  CROSS-STACK CONTRACT (issue #386): this
# tuple mirrors ``STAGE_DURATIONS_DAYS`` in
# ``frontend/src/constants/program.ts`` literal-for-literal; both stacks
# pin it with tests, so a schedule change must touch both files together.
STAGE_DURATIONS_DAYS: tuple[int, ...] = (21, 21, 21, 21, 21, 21, 21, 21, 42, 42)

# 252 days — exactly the 36-week curriculum (sum of the stage durations).
TOTAL_PROGRAM_DAYS = sum(STAGE_DURATIONS_DAYS)
