refactor(habits): always render LG / CG / SG on a unified 0-100 progress bar

The marker logic disagreed with the progress fill: the bar's fill width
used ``stretch`` as 100% (additive) or ``low → stretch`` as the range
(subtractive), but ``getMarkerPositions`` collapsed CG and SG to the same
column (additive) and used a separate scale (subtractive).  The HabitTile
also gated the SG marker behind a ``hasCleared`` flag so users could not
see SG until they had already met CG.  Combined, the markers and the bar
fill could not even agree on what "X%" meant -- which is what the user
reported as "the implementation is too complicated".

Single contract for both habit kinds:
- **Additive** (``do at least X``):
    LG = lowTarget / stretchTarget × 100
    CG = clearTarget / stretchTarget × 100
    SG = 100
    fill = min(currentProgress / stretchTarget, 1) × 100
- **Subtractive** (``stay under X``, lower current = better):
    LG = 0  (the failure boundary)
    CG = (lowTarget − clearTarget) / (lowTarget − stretchTarget) × 100
    SG = 100  (at or under stretch)
    fill = clamp(100 − (current − stretch) / (low − stretch) × 100, 0, 100)

Frequency-unit normalization runs through ``getGoalTarget`` for every
target so a goal stated as "5 / per_week" is on the same scale as a goal
stated as "0.7 / per_day" -- the previous additive marker math read raw
``goal.target`` and would have placed markers wrong for any non-daily
goal.

Removed the ``getAdditiveSegmentPct`` / ``getSubtractiveProgressPct``
helpers and their thirds-weighting constants -- the unified scale derives
fill width from low/stretch directly so the per-tier weighting is gone.

HabitTile drops the ``hasCleared`` gating and always emits all three
markers when the corresponding goal exists (matches the GoalModal, which
already always rendered SG).

Tests
- ``HabitUtils.test.ts`` and ``HabitsScreen.test.ts`` updated for the new
  marker / progress contract; new assertions pin "all three markers sit
  on distinct columns" so a future regression that re-collapses CG and
  SG fails the suite.
- New ``HabitTile`` rendering tests cover the always-visible invariant at
  zero progress, full progress, and for subtractive goals.
